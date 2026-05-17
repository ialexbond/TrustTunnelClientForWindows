/**
 * BenchmarkModal — compound state-machine Modal for Server Benchmark IP.Check.Place.
 *
 * State machine:
 *   idle → running → completed | cancelled | error
 *   running → cancelling → cancelled
 *   completed → running  (re-run without unmounting)
 *
 * Key invariants:
 *  - T-03: NEVER `if (!isOpen) return null` before <Modal>. Parent passes isOpen as-is.
 *  - D-1.1: closeOnBackdrop=false + closeOnEscape=false while running/cancelling.
 *  - D-1.2: Stage labels LOCKED (2026-05-18) — backend emits stage in [0,4] via Strategy A.
 *  - B5: parseBenchmarkOutput called on raw_stdout in frontend ONLY.
 *  - B7: invoke uses camelCase keys (keyPath / keyData) — Tauri 2 auto-renames to snake_case.
 *  - W1: cancel useConfirm uses variant:"warning" (non-destructive — can re-run).
 *  - D-29: activityLog NEVER receives raw_stdout content or sshParams.password.
 */
import { useState, useEffect, useRef, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Modal } from "../../shared/ui/Modal";
import { Button } from "../../shared/ui/Button";
import { StepProgress } from "./StepProgress";
import { Accordion } from "../../shared/ui/Accordion";
import { StatusIndicator } from "../../shared/ui/StatusIndicator";
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
import { Copy, Check } from "lucide-react";

// ── Stage labels — B1 LOCKED 2026-05-18 under D-1.2 mapping ──
// Five stages [0..4]. Backend (Plan 17-01) emits stage already in [0,4]
// via Strategy A Risk merge. Frontend trusts the value — NO mapping here.
// OLD labels («Проверяем сеть» / «Замеряем скорость» / «Завершаем») are REMOVED from canon.
const STAGE_KEYS = [
  "server.utilities.benchmark.stages.ip",       // 0: «Получаем IP»  (section 1 Basic Information)
  "server.utilities.benchmark.stages.type",     // 1: «Определяем тип» (section 2 IP Type)
  "server.utilities.benchmark.stages.risk",     // 2: «Оцениваем риск» (sections 3+4 Risk Score+Factors merged)
  "server.utilities.benchmark.stages.services", // 3: «Проверяем доступность сервисов» (section 5)
  "server.utilities.benchmark.stages.email",    // 4: «Проверяем email» (section 6)
] as const;

// ── State machine type ──
type BenchmarkModalState =
  | { kind: "idle" }
  | { kind: "running"; stage: number; lastLine: string; rawBuf: string }
  | { kind: "cancelling"; rawBuf: string }
  | { kind: "completed"; record: BenchmarkRecord }
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
  state: { kind: "running"; stage: number; lastLine: string; rawBuf: string } | { kind: "cancelling"; rawBuf: string };
  onCancel: () => void;
}
function RunningView({ state, onCancel }: RunningViewProps) {
  const { t } = useTranslation();
  const isCancelling = state.kind === "cancelling";
  const stage = state.kind === "running" ? state.stage : 4;

  const steps = STAGE_KEYS.map((key, i) => ({ key: String(i), label: t(key) }));

  return (
    <div className="flex flex-col gap-5 py-4">
      <StepProgress
        steps={steps}
        currentStep={stage}
        status={isCancelling ? "active" : "active"}
      />
      {state.kind === "running" && state.lastLine && (
        <p
          className="text-mono-sm truncate"
          style={{ color: "var(--color-text-muted)", maxWidth: "100%" }}
          title={state.lastLine}
        >
          {state.lastLine.length > 80
            ? state.lastLine.slice(0, 80) + "…"
            : state.lastLine}
        </p>
      )}
      <p className="text-caption" style={{ color: "var(--color-text-muted)" }}>
        {t("server.utilities.benchmark.hint_running")}
      </p>
      <div className="flex justify-end">
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
  host: string;
  onRerun: () => void;
  onClose: () => void;
}
function CompletedView({ record, host, onRerun, onClose }: CompletedViewProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [displayRecord, setDisplayRecord] = useState<BenchmarkRecord>(record);

  // Parse the raw_stdout of the currently displayed record (B5 — frontend owns parsing)
  const parsed = useMemo(
    () => parseBenchmarkOutput(displayRecord.raw_stdout),
    [displayRecord.raw_stdout]
  );
  const parsedKeyCount = Object.keys(parsed).length;
  const parserFailed = parsedKeyCount < 3;

  // History for dropdown
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

  // Stream status → StatusIndicator variant
  const streamingStatusVariant = (
    status: string
  ): "success" | "warning" | "danger" | "info" => {
    const s = status.toLowerCase();
    if (s.includes("yes") || s.includes("available")) return "success";
    if (s.includes("restricted") || s.includes("originals only")) return "warning";
    if (s.includes("no") || s.includes("blocked")) return "danger";
    return "info";
  };

  const streamingStatusLabel = (status: string): string => {
    const v = streamingStatusVariant(status);
    if (v === "success") return t("server.utilities.benchmark.streaming_status.available");
    if (v === "warning") return t("server.utilities.benchmark.streaming_status.restricted");
    if (v === "danger") return t("server.utilities.benchmark.streaming_status.blocked");
    return t("server.utilities.benchmark.streaming_status.unknown");
  };

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

      {/* Parser fail banner */}
      {parserFailed && (
        <div
          className="rounded-[var(--radius-md)] p-3 text-body-sm"
          style={{
            background: "var(--color-status-warning-bg)",
            color: "var(--color-text-primary)",
          }}
        >
          {t("server.utilities.benchmark.parser_fail_banner")}
        </div>
      )}

      {/* Parsed sections — only render when parser succeeded */}
      {!parserFailed && (
        <div className="flex flex-col gap-3">
          {/* Basic */}
          {parsed.basic && (
            <SectionCard title={t("server.utilities.benchmark.section.basic")}>
              <KVTable data={parsed.basic} />
            </SectionCard>
          )}

          {/* IP Type */}
          {parsed.ip_type && (
            <SectionCard title={t("server.utilities.benchmark.section.ip_type")}>
              <KVTable data={parsed.ip_type} />
            </SectionCard>
          )}

          {/* Risk */}
          {parsed.risk && (
            <SectionCard title={t("server.utilities.benchmark.section.risk")}>
              <KVTable data={parsed.risk} />
            </SectionCard>
          )}

          {/* Streaming */}
          {parsed.streaming && parsed.streaming.length > 0 && (
            <SectionCard title={t("server.utilities.benchmark.section.streaming")}>
              <div className="flex flex-col gap-1">
                {parsed.streaming.map((item, i) => (
                  <div key={i} className="flex items-center justify-between gap-2">
                    <span className="text-body-sm" style={{ color: "var(--color-text-primary)" }}>
                      {item.service}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <StatusIndicator
                        status={streamingStatusVariant(item.status)}
                        size="sm"
                        label={streamingStatusLabel(item.status)}
                      />
                      <span
                        className="text-caption"
                        style={{ color: "var(--color-text-secondary)" }}
                      >
                        {streamingStatusLabel(item.status)}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </SectionCard>
          )}

          {/* Email */}
          {parsed.email && (
            <SectionCard title={t("server.utilities.benchmark.section.email")}>
              <KVTable data={parsed.email} />
            </SectionCard>
          )}
        </div>
      )}

      {/* Raw output accordion */}
      <Accordion
        items={rawOutputAccordion}
        defaultOpen={parserFailed ? ["raw-output"] : []}
      />

      {/* Sticky action row */}
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

// Helper: bordered card for a parsed section
function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-3"
      style={{ background: "var(--color-bg-surface)" }}
    >
      <h4 className="text-body-sm font-semibold mb-2" style={{ color: "var(--color-text-primary)" }}>
        {title}
      </h4>
      {children}
    </div>
  );
}

// Helper: key-value table
function KVTable({ data }: { data: Record<string, string> }) {
  return (
    <div className="flex flex-col gap-1">
      {Object.entries(data).map(([k, v]) => (
        <div key={k} className="flex items-start gap-2">
          <span
            className="text-caption shrink-0"
            style={{ color: "var(--color-text-muted)", minWidth: 100 }}
          >
            {k}:
          </span>
          <span className="text-mono-sm" style={{ color: "var(--color-text-primary)" }}>
            {v}
          </span>
        </div>
      ))}
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
    if (hist.length > 0) return { kind: "completed", record: hist[hist.length - 1] };
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

  // ── Listen for benchmark-progress events (race-safe — Pitfall 8) ──
  useEffect(() => {
    if (state.kind !== "running") return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    listen<{ stage: number; label: string; current_line: string }>(
      "benchmark-progress",
      (event) => {
        // Backend emits stage already in [0,4] per Strategy A — NO mapping here (D-1.2)
        const { stage, current_line } = event.payload;
        setState((prev) => {
          if (prev.kind !== "running") return prev;
          return { ...prev, stage, lastLine: current_line ?? "" };
        });
      }
    ).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.kind === "running"]);

  // ── Listen for benchmark-stdout-chunk events (race-safe) ──
  useEffect(() => {
    if (state.kind !== "running" && state.kind !== "cancelling") return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    listen<string>("benchmark-stdout-chunk", (event) => {
      setState((prev) => {
        if (prev.kind === "running") {
          return { ...prev, rawBuf: prev.rawBuf + event.payload };
        }
        if (prev.kind === "cancelling") {
          return { ...prev, rawBuf: prev.rawBuf + event.payload };
        }
        return prev;
      });
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.kind === "running" || state.kind === "cancelling"]);

  // ── handleStart — invoke server_run_benchmark (B7: camelCase keys) ──
  const handleStart = async () => {
    // D-29: log ONLY metadata — no password, no raw_stdout content
    activityLog("USER", `benchmark.start host=${sshParams.host}`);
    setState({ kind: "running", stage: 0, lastLine: "", rawBuf: "" });
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
        parsed_sections: parsed as Record<string, unknown>,
        raw_stdout: result.raw_stdout,
        duration_seconds: result.duration_seconds,
      };

      // D-1.4: push on completion ONLY (not cancel/error)
      pushHistory(sshParams.host, record);
      setState({ kind: "completed", record });
      // D-29: log only metadata — no raw_stdout, no duration that reveals content
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
  // Contrast: Stop service (Plan 17-06) uses 'danger' (disconnects all clients).
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
    setState({ kind: "cancelling", rawBuf: state.rawBuf });
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
    // T-03 invariant: Modal always rendered. Never `if (!isOpen) return null` before Modal.
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
        <RunningView state={state} onCancel={() => void handleCancel()} />
      )}
      {state.kind === "completed" && (
        <CompletedView
          record={state.record}
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
