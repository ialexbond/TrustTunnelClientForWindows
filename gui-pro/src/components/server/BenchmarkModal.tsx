/**
 * BenchmarkModal — simplified state-machine Modal for Server Benchmark Check.Place.
 *
 * State machine:
 *   idle → running → completed | cancelled | error
 *   running → cancelling → cancelled
 *   completed → running  (re-run without unmounting)
 *
 * Key invariants:
 *  - T-03: Modal always rendered — no early null return before <Modal>. Parent passes isOpen as-is.
 *  - D-1.1: closeOnBackdrop=false + closeOnEscape=false while running/cancelling.
 *  - B7: invoke uses camelCase keys (keyPath / keyData) — Tauri 2 auto-renames to snake_case.
 *  - W1: cancel useConfirm uses variant:"warning" (non-destructive — can re-run).
 *  - D-29: activityLog NEVER receives raw_stdout content or sshParams.password or reportLink.
 *
 * UAT 2026-05-20 round 4:
 *  - Real percent progress bar via benchmark-progress Tauri event (fallback to indeterminate after 5s idle).
 *  - Cancel button centered under bar (no gap).
 *  - CompletedView: Accordion «Сырой вывод» removed, history dropdown removed.
 *  - Cancel fix: server_cancel_benchmark now receives SSH params to kill process group.
 *  - history.ts: saveLast/loadLast API (single record per host).
 */
import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { ExternalLink } from "lucide-react";
import { Modal } from "../../shared/ui/Modal";
import { Button } from "../../shared/ui/Button";
import { useConfirm } from "../../shared/ui/useConfirm";
import { useSnackBar } from "../../shared/ui/SnackBarContext";
import { useActivityLog } from "../../shared/hooks/useActivityLog";
import { formatError } from "../../shared/utils/formatError";
import {
  parseBenchmarkOutput,
  type ParsedSections,
} from "./benchmark/parser";
import {
  saveLast,
  loadLast,
  type BenchmarkRecord,
} from "./benchmark/history";

// ── State machine type ──
type BenchmarkModalState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "cancelling" }
  | { kind: "completed"; record: BenchmarkRecord; parsed: ParsedSections }
  | { kind: "cancelled" }
  | { kind: "error"; message: string };

// ── Props ──
export interface BenchmarkModalProps {
  isOpen: boolean;
  onClose: () => void;
  sshParams: {
    host: string;
    port: number;
    user: string;
    password: string;
    keyPath?: string;
    keyData?: string;
  };
  /** Storybook escape hatch — overrides initial state. NEVER use in production. */
  _forceState?: BenchmarkModalState;
}

// ── Subcomponents ──

interface IdleViewProps {
  onStart: () => void;
}
function IdleView({ onStart }: IdleViewProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4 py-4">
      <p className="text-body" style={{ color: "var(--color-text-secondary)" }}>
        {t("server.utilities.benchmark.empty_hint")}
      </p>
      <div className="flex justify-end">
        <Button variant="primary" onClick={onStart}>
          {t("server.utilities.benchmark.start_button")}
        </Button>
      </div>
    </div>
  );
}

interface RunningViewProps {
  isCancelling: boolean;
  percent: number | null;
  onCancel: () => void;
}
function RunningView({ isCancelling, percent, onCancel }: RunningViewProps) {
  const { t } = useTranslation();
  const hasPercent = percent !== null && percent > 0;

  return (
    <div className="flex flex-col gap-4 py-6">
      {/* Running text */}
      <div className="flex flex-col items-center gap-2 text-center">
        <p className="text-body font-medium" style={{ color: "var(--color-text-primary)" }}>
          {t("server.utilities.benchmark.running_text")}
        </p>
        <p className="text-caption" style={{ color: "var(--color-text-muted)" }}>
          {t("server.utilities.benchmark.hint_running")}
        </p>
      </div>

      {/* Progress bar — real percent when available, indeterminate otherwise */}
      <div className="flex flex-col gap-1">
        <div
          className="relative w-full overflow-hidden rounded-full"
          role="progressbar"
          aria-busy={!hasPercent}
          aria-valuenow={hasPercent ? percent! : undefined}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={t("server.utilities.benchmark.running_text")}
          style={{
            height: 8,
            background: "var(--color-bg-surface)",
            border: "1px solid var(--color-border)",
          }}
        >
          {hasPercent ? (
            /* Real percent bar */
            <span
              className="absolute top-0 bottom-0 left-0 transition-all duration-500"
              style={{
                width: `${percent!}%`,
                background: "var(--color-accent-interactive)",
                borderRadius: "inherit",
              }}
            />
          ) : (
            /* Indeterminate animation — two stripes */
            <>
              <span
                className="absolute top-0 bottom-0"
                style={{
                  background: "var(--color-accent-interactive)",
                  animation: "progress-indeterminate 2s ease-in-out infinite",
                  borderRadius: "inherit",
                }}
              />
              <span
                className="absolute top-0 bottom-0"
                style={{
                  background: "var(--color-accent-interactive)",
                  opacity: 0.5,
                  animation: "progress-indeterminate-short 2s ease-in-out 1s infinite",
                  borderRadius: "inherit",
                }}
              />
            </>
          )}
        </div>
        {/* Percent label — right-aligned, only when we have a real value */}
        {hasPercent && (
          <p
            className="text-caption text-right"
            style={{ color: "var(--color-text-muted)" }}
          >
            {percent!}%
          </p>
        )}
      </div>

      {/* Cancel button — Modal footer convention: right-aligned with gap-2 mt-4 */}
      <div className="flex justify-end gap-2 mt-2">
        <Button
          variant="danger-outline"
          onClick={onCancel}
          disabled={isCancelling}
        >
          {isCancelling
            ? t("server.utilities.benchmark.cancelling_button")
            : t("server.utilities.benchmark.cancel_button")}
        </Button>
      </div>
    </div>
  );
}

interface CompletedViewProps {
  record: BenchmarkRecord;
  parsed: ParsedSections;
  onRerun: () => void;
  onClose: () => void;
}
function CompletedView({ record, parsed, onRerun, onClose }: CompletedViewProps) {
  const { t } = useTranslation();

  const handleReportLink = async () => {
    if (parsed.reportLink) {
      try {
        await shellOpen(parsed.reportLink);
      } catch {
        // silent
      }
    }
  };

  const hasReportLink = !!parsed.reportLink;

  return (
    <div className="flex flex-col gap-4 py-2">
      {/* Duration */}
      <p className="text-mono-sm" style={{ color: "var(--color-text-muted)" }}>
        {t("server.utilities.benchmark.duration_label", {
          seconds: record.duration_seconds,
        })}
      </p>

      {/* Report link button — big primary button when link present */}
      {hasReportLink && (
        <Button
          variant="primary"
          onClick={() => void handleReportLink()}
          data-testid="report-link-button"
        >
          <ExternalLink className="w-4 h-4" />
          {t("server.utilities.benchmark.report_link")}
        </Button>
      )}

      {/* No-link fallback banner — no raw output accordion */}
      {!hasReportLink && (
        <div
          className="rounded-[var(--radius-md)] p-3 text-body-sm"
          style={{
            background: "var(--color-status-warning-bg)",
            color: "var(--color-text-primary)",
          }}
        >
          {t("server.utilities.benchmark.no_report_link_banner")}
        </div>
      )}

      {/* Action row */}
      <div className="flex justify-between gap-2 pt-2">
        <Button variant="primary" onClick={onRerun}>
          {t("server.utilities.benchmark.rerun_button")}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t("server.utilities.benchmark.close_button")}
        </Button>
      </div>
    </div>
  );
}

interface CancelledViewProps {
  onRestart: () => void;
  onClose: () => void;
}
function CancelledView({ onRestart, onClose }: CancelledViewProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4 py-4">
      <p className="text-body" style={{ color: "var(--color-text-secondary)" }}>
        {t("server.utilities.benchmark.cancelled_message")}
      </p>
      <div className="flex justify-between gap-2">
        <Button variant="primary" onClick={onRestart}>
          {t("server.utilities.benchmark.restart_button")}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t("server.utilities.benchmark.close_button")}
        </Button>
      </div>
    </div>
  );
}

interface ErrorViewProps {
  message: string;
  onRetry: () => void;
  onClose: () => void;
}
function ErrorView({ message, onRetry, onClose }: ErrorViewProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4 py-4">
      <p className="text-body-sm" style={{ color: "var(--color-status-error)" }}>
        {t("server.utilities.benchmark.error_prefix")} {message}
      </p>
      <div className="flex justify-between gap-2">
        <Button variant="primary" onClick={onRetry}>
          {t("server.utilities.benchmark.retry_button")}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t("server.utilities.benchmark.close_button")}
        </Button>
      </div>
    </div>
  );
}

// ── Main BenchmarkModal component ──
export function BenchmarkModal({
  isOpen,
  onClose,
  sshParams,
  _forceState,
}: BenchmarkModalProps) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const pushSnack = useSnackBar();
  const { log: activityLog } = useActivityLog();

  // Initial state: from _forceState (Storybook) or loadLast
  const [state, setState] = useState<BenchmarkModalState>(() => {
    if (_forceState) return _forceState;
    const last = loadLast(sshParams.host);
    if (last) {
      const parsed = parseBenchmarkOutput(last.raw_stdout);
      return { kind: "completed", record: last, parsed };
    }
    return { kind: "idle" };
  });

  // stateRef for reading current state inside async closures (avoids stale captures)
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // ── Real percent progress tracking ──
  // null = no progress received yet → indeterminate animation
  // number = last received percent → real bar width
  const [percent, setPercent] = useState<number | null>(null);
  // Timer ref for 5s indeterminate fallback
  const progressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Subscribe to benchmark-progress events when running
  useEffect(() => {
    if (state.kind !== "running") return;

    let unlistenFn: (() => void) | undefined;
    let mounted = true;

    void listen<{ percent: number }>("benchmark-progress", (event) => {
      if (!mounted) return;
      const incoming = event.payload.percent;
      setPercent((prev) => {
        // Monotonic: only increase
        if (prev === null) return incoming;
        return Math.max(prev, incoming);
      });
      // Reset the 5s indeterminate-fallback timer on each received event
      if (progressTimerRef.current) clearTimeout(progressTimerRef.current);
      progressTimerRef.current = setTimeout(() => {
        // 5s without progress → revert to indeterminate
        setPercent(null);
      }, 5000);
    }).then((fn) => {
      unlistenFn = fn;
    });

    return () => {
      mounted = false;
      if (unlistenFn) unlistenFn();
      if (progressTimerRef.current) clearTimeout(progressTimerRef.current);
    };
  }, [state.kind]);

  // ── T-03 delayed cleanup — reset running/cancelling state after Modal closes ──
  // 200ms delay matches Modal exit animation duration.
  useEffect(() => {
    if (isOpen) return;
    const timer = setTimeout(() => {
      if (
        stateRef.current.kind === "running" ||
        stateRef.current.kind === "cancelling"
      ) {
        setState({ kind: "idle" });
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [isOpen]);

  // ── handleStart — invoke server_run_benchmark (B7: camelCase keys) ──
  const handleStart = async () => {
    // D-29: log ONLY metadata — no password, no raw_stdout content
    activityLog("USER", `benchmark.start host=${sshParams.host}`);
    setPercent(null);
    setState({ kind: "running" });
    try {
      // B7: camelCase keys — Tauri 2 auto-renames to snake_case in Rust (key_path / key_data)
      // B5: BenchmarkResult has only 2 fields (raw_stdout + duration_seconds)
      const result = await invoke<{ raw_stdout: string; duration_seconds: number }>(
        "server_run_benchmark",
        {
          host: sshParams.host,
          port: sshParams.port,
          user: sshParams.user,
          password: sshParams.password,
          keyPath: sshParams.keyPath,
          keyData: sshParams.keyData,
        }
      );

      // Frontend parses raw_stdout (B5 — sole Phase 17 parser)
      const parsed: ParsedSections = parseBenchmarkOutput(result.raw_stdout);
      const record: BenchmarkRecord = {
        timestamp: new Date().toISOString(),
        parsed_sections: parsed as unknown as Record<string, unknown>,
        raw_stdout: result.raw_stdout,
        duration_seconds: result.duration_seconds,
      };

      // D-1.4: save last on completion ONLY (not cancel/error)
      saveLast(sshParams.host, record);
      setState({ kind: "completed", record, parsed });
      // D-29: log only metadata — no raw_stdout, no reportLink
      activityLog(
        "STATE",
        `benchmark.complete host=${sshParams.host} dur=${record.duration_seconds}s`
      );
      pushSnack(t("server.utilities.benchmark.snack.completed"));
    } catch (e) {
      const msg = formatError(e);
      // Handles BOTH plain `BENCHMARK_CANCELLED|dur=N` AND B8 watchdog `BENCHMARK_CANCELLED|dur=N|forced`
      if (msg.includes("BENCHMARK_CANCELLED")) {
        setState({ kind: "cancelled" });
        activityLog(
          "USER",
          `benchmark.cancelled host=${sshParams.host}${msg.includes("|forced") ? " forced=true" : ""}`
        );
      } else {
        setState({ kind: "error", message: msg });
        activityLog("ERROR", `benchmark.failed host=${sshParams.host} err=${msg}`);
        pushSnack(t("server.utilities.benchmark.snack.failed", { error: msg }), "error");
      }
    }
  };

  // ── handleCancel — W1: warning variant (non-destructive — can re-run) ──
  // Contrast: Stop service uses 'danger' (disconnects all clients).
  const handleCancel = async () => {
    if (state.kind !== "running") return;
    // W1: Cancel benchmark is non-destructive — warning variant (not danger)
    const ok = await confirm({
      title: t("server.utilities.benchmark.cancel_confirm_title"),
      message: t("server.utilities.benchmark.cancel_confirm_message"),
      variant: "warning",
      confirmText: t("buttons.confirm"),
      cancelText: t("buttons.cancel"),
    });
    if (!ok) return;
    setState({ kind: "cancelling" });
    try {
      // Pass SSH params so backend can open second channel for kill-pgroup
      await invoke("server_cancel_benchmark", {
        host: sshParams.host,
        port: sshParams.port,
        user: sshParams.user,
        password: sshParams.password,
        keyPath: sshParams.keyPath,
        keyData: sshParams.keyData,
      });
    } catch (e) {
      activityLog("ERROR", `benchmark.cancel_call_failed err=${formatError(e)}`);
    }
  };

  // ── D-1.1: Block Modal closing during running / cancelling ──
  const isBlocking = state.kind === "running" || state.kind === "cancelling";
  const closeOnBackdrop = !isBlocking;
  const closeOnEscape = !isBlocking;
  const onCloseGuarded = isBlocking ? () => { /* no-op during running/cancelling */ } : onClose;

  return (
    // T-03 invariant: Modal always rendered — no early null return.
    <Modal
      isOpen={isOpen}
      onClose={onCloseGuarded}
      closeOnBackdrop={closeOnBackdrop}
      closeOnEscape={closeOnEscape}
      size="lg"
    >
      <h2 className="text-title" style={{ color: "var(--color-text-primary)" }}>
        {t("server.utilities.benchmark.modal_title")}
      </h2>

      {state.kind === "idle" && (
        <IdleView onStart={() => void handleStart()} />
      )}
      {(state.kind === "running" || state.kind === "cancelling") && (
        <RunningView
          isCancelling={state.kind === "cancelling"}
          percent={percent}
          onCancel={() => void handleCancel()}
        />
      )}
      {state.kind === "completed" && (
        <CompletedView
          record={state.record}
          parsed={state.parsed}
          onRerun={() => void handleStart()}
          onClose={onClose}
        />
      )}
      {state.kind === "cancelled" && (
        <CancelledView
          onRestart={() => setState({ kind: "idle" })}
          onClose={onClose}
        />
      )}
      {state.kind === "error" && (
        <ErrorView
          message={state.message}
          onRetry={() => setState({ kind: "idle" })}
          onClose={onClose}
        />
      )}
    </Modal>
  );
}
