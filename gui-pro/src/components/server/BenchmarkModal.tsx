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
 * UAT 2026-05-19 round 3: Simplified — spinner only during running, report link button on complete.
 * No StepProgress, no HorizontalProgressBar, no BenchmarkLiveTail, no parsed sections.
 */
import { useState, useEffect, useRef, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { Copy, Check, ExternalLink } from "lucide-react";
import { Modal } from "../../shared/ui/Modal";
import { Button } from "../../shared/ui/Button";
import { Accordion } from "../../shared/ui/Accordion";
import { useConfirm } from "../../shared/ui/useConfirm";
import { useSnackBar } from "../../shared/ui/SnackBarContext";
import { useActivityLog } from "../../shared/hooks/useActivityLog";
import { formatError } from "../../shared/utils/formatError";
import {
  parseBenchmarkOutput,
  type ParsedSections,
} from "./benchmark/parser";
import {
  pushHistory,
  loadHistory,
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
  onCancel: () => void;
}
function RunningView({ isCancelling, onCancel }: RunningViewProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-5 py-6">
      {/* Running text */}
      <div className="flex flex-col items-center gap-2 text-center">
        <p className="text-body font-medium" style={{ color: "var(--color-text-primary)" }}>
          {t("server.utilities.benchmark.running_text")}
        </p>
        <p className="text-caption" style={{ color: "var(--color-text-muted)" }}>
          {t("server.utilities.benchmark.hint_running")}
        </p>
      </div>

      {/* Indeterminate progress bar — sliding stripe (no real percent available since
          backend no longer emits progress events). Visual signal that work is happening. */}
      <div
        className="relative w-full overflow-hidden rounded-full"
        role="progressbar"
        aria-busy="true"
        aria-label={t("server.utilities.benchmark.running_text")}
        style={{
          height: 8,
          background: "var(--color-bg-surface)",
          border: "1px solid var(--color-border)",
        }}
      >
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
      </div>

      {/* Cancel button */}
      <div className="flex justify-end w-full">
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
  initialParsed: ParsedSections;
  host: string;
  onRerun: () => void;
  onClose: () => void;
}
function CompletedView({ record, initialParsed, host, onRerun, onClose }: CompletedViewProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [displayRecord, setDisplayRecord] = useState<BenchmarkRecord>(record);

  // Parse the currently displayed record — re-parse only when switching history records
  const parsed: ParsedSections = useMemo(
    () =>
      displayRecord === record
        ? initialParsed // use already-parsed result for current record (no re-parse)
        : parseBenchmarkOutput(displayRecord.raw_stdout),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [displayRecord]
  );

  const history = loadHistory(host);

  const handleCopyRaw = async () => {
    try {
      await navigator.clipboard.writeText(displayRecord.raw_stdout);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // silent
    }
  };

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

  const rawOutputAccordion = [
    {
      id: "raw-output",
      title: (
        <span className="flex items-center gap-2 text-body-sm font-medium">
          {t("server.utilities.benchmark.raw_output_title")}
          <button
            type="button"
            className="flex items-center gap-1 text-caption"
            style={{ color: "var(--color-text-muted)", background: "none", border: "none", cursor: "pointer" }}
            onClick={(e) => { e.stopPropagation(); void handleCopyRaw(); }}
            aria-label={t("server.utilities.benchmark.copy_raw")}
          >
            {copied ? (
              <Check className="w-3 h-3" style={{ color: "var(--color-status-connected)" }} />
            ) : (
              <Copy className="w-3 h-3" />
            )}
            <span>{copied ? t("server.utilities.benchmark.copied_raw") : t("server.utilities.benchmark.copy_raw")}</span>
          </button>
        </span>
      ),
      content: (
        <pre
          className="text-mono-sm whitespace-pre-wrap overflow-auto"
          style={{ maxHeight: "40vh", color: "var(--color-text-secondary)" }}
        >
          {displayRecord.raw_stdout}
        </pre>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4 py-2">
      {/* History dropdown */}
      {history.length > 1 && (
        <div className="flex items-center gap-2">
          <label
            className="text-caption shrink-0"
            style={{ color: "var(--color-text-muted)" }}
          >
            {t("server.utilities.benchmark.history.dropdown_label")}:
          </label>
          <select
            className="text-body-sm border border-[var(--color-border)] rounded-[var(--radius-sm)] px-2 py-1"
            style={{
              background: "var(--color-bg-input)",
              color: "var(--color-text-primary)",
            }}
            value={history.indexOf(displayRecord)}
            onChange={(e) => {
              const idx = Number(e.target.value);
              if (history[idx]) setDisplayRecord(history[idx]);
            }}
          >
            {history.map((rec, i) => {
              const d = new Date(rec.timestamp);
              const pad = (n: number) => String(n).padStart(2, "0");
              const time = `${pad(d.getHours())}:${pad(d.getMinutes())} ${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
              const isLast = i === history.length - 1;
              return (
                <option key={i} value={i}>
                  {isLast
                    ? t("server.utilities.benchmark.history.current", { time })
                    : time}
                </option>
              );
            })}
          </select>
        </div>
      )}

      {/* Duration */}
      <p className="text-mono-sm" style={{ color: "var(--color-text-muted)" }}>
        {t("server.utilities.benchmark.duration_label", {
          seconds: displayRecord.duration_seconds,
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

      {/* No-link fallback banner */}
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

      {/* Raw output accordion — auto-open when no report link */}
      <Accordion
        items={rawOutputAccordion}
        defaultOpen={!hasReportLink ? ["raw-output"] : []}
      />

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

  // Initial state: from _forceState (Storybook) or loadHistory
  const [state, setState] = useState<BenchmarkModalState>(() => {
    if (_forceState) return _forceState;
    const hist = loadHistory(sshParams.host);
    if (hist.length > 0) {
      const lastRecord = hist[hist.length - 1];
      const parsed = parseBenchmarkOutput(lastRecord.raw_stdout);
      return { kind: "completed", record: lastRecord, parsed };
    }
    return { kind: "idle" };
  });

  // stateRef for reading current state inside async closures (avoids stale captures)
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

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

      // D-1.4: push on completion ONLY (not cancel/error)
      pushHistory(sshParams.host, record);
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
      await invoke("server_cancel_benchmark");
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
          onCancel={() => void handleCancel()}
        />
      )}
      {state.kind === "completed" && (
        <CompletedView
          record={state.record}
          initialParsed={state.parsed}
          host={sshParams.host}
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
