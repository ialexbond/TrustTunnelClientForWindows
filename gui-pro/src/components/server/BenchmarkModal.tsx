/**
 * BenchmarkModal — simplified state-machine Modal for Server Benchmark Check.Place.
 *
 * State machine:
 *   idle → running → completed | error
 *   running → cancelling → (close)
 *   completed → running  (re-run without unmounting)
 *
 * Key invariants:
 *  - T-03: Modal always rendered — no early null return before <Modal>. Parent passes isOpen as-is.
 *  - D-1.1: closeOnBackdrop=false + closeOnEscape=false while running/cancelling.
 *  - B7: invoke uses camelCase keys (keyPath / keyData) — Tauri 2 auto-renames to snake_case.
 *  - W1: cancel useConfirm uses variant:"warning" (non-destructive — can re-run).
 *  - D-29: activityLog NEVER receives raw_stdout content or sshParams.password or reportLink.
 *
 * UAT-F17 (09-32): 2-action flow — start-on-open (autoStart) + cancel-and-close.
 *  - autoStart: opening for a fresh check (no prior result) starts the run
 *    immediately; there is no idle «Запустить проверку» gate to click.
 *  - Real Отменяем (owner 6.4): cancel runs server_cancel_benchmark and the
 *    modal closes ONLY when the run actually resolves to BENCHMARK_CANCELLED —
 *    mirroring the protocol-install cancel. The cancelled interstitial (the
 *    «Проверка отменена / Запустить снова» window) is removed.
 * UAT-F16 display half (09-32): a BENCHMARK_TIMEOUT (300s overall timeout from
 *  09-31) shows a DISTINCT timeout message (error_timeout), not the cancel path.
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
  initialProgress,
  computeProgress,
  deriveEstimatedPercent,
  combineProgress,
  type ProgressState,
  type ProgressMarker,
} from "./benchmark/progress";
import {
  saveLast,
  loadLast,
  type BenchmarkRecord,
} from "./benchmark/history";

// ── State machine type ──
// F17 (09-32): the "cancelled" interstitial state was removed — a real cancel
// (server_cancel_benchmark) closes the modal on completion instead of parking
// it on a «Проверка отменена» window.
type BenchmarkModalState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "cancelling" }
  // R5-F01: a brief post-success interstitial where the bar visibly fills to
  // 100% before the results view replaces the running view. Holds record/parsed
  // so the timed flip to "completed" carries them through.
  | { kind: "finishing"; record: BenchmarkRecord; parsed: ParsedSections }
  | { kind: "completed"; record: BenchmarkRecord; parsed: ParsedSections }
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
  /**
   * F17 (09-32): start-on-open. When true and the modal opens in the idle
   * state, the benchmark run begins immediately (no «Запустить проверку» gate).
   * The parent (BenchmarkSection) sets this when the user pressed «Проверить
   * качество» with no prior result. A prior result opens the completed view
   * with autoStart=false (re-run is a deliberate action).
   */
  autoStart?: boolean;
  /** Storybook escape hatch — overrides initial state. NEVER use in production. */
  _forceState?: BenchmarkModalState;
  /** Storybook escape hatch — forces progress percent in running state. NEVER use in production. */
  _forcePercent?: number;
}

// ── Subcomponents ──

interface IdleViewProps {
  onStart: () => void;
}
function IdleView({ onStart }: IdleViewProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      <p className="text-body" style={{ color: "var(--color-text-secondary)" }}>
        {t("server.service.benchmark.empty_hint")}
      </p>
      <div className="flex justify-end">
        <Button variant="primary" size="sm" onClick={onStart}>
          {t("server.service.benchmark.start_button")}
        </Button>
      </div>
    </div>
  );
}

interface RunningViewProps {
  isCancelling: boolean;
  percent: number | null;
  onCancel: () => void;
  // R5-F01: during the "finishing" 100% hold the Cancel button is hidden — the
  // run already succeeded and is one tick from showing results, so there is
  // nothing left to cancel.
  hideCancel?: boolean;
}
function RunningView({ isCancelling, percent, onCancel, hideCancel }: RunningViewProps) {
  const { t } = useTranslation();
  const hasPercent = percent !== null && percent > 0;

  // R4-F05 (09-42): the per-step «{family} · {section}» caption was removed. The
  // section markers arrive BATCHED at the very end of the run (they do not
  // stream), so the label only ever popped the LAST marker right before
  // completion — confusing. Only the generic running text + the single time
  // caption + the time-based bar remain. The bar's forward-only marker anchor
  // stays (harmless); only the LABEL text is gone.

  // No outer py — Modal primitive already provides p-[var(--space-6)] = 24px
  // around the entire dialog. Adding py here doubles the bottom gap under Cancel.
  return (
    <div className="flex flex-col gap-4">
      {/* Running text — left-aligned (matches IdleView empty_hint), gap-2 between paragraphs */}
      <div className="flex flex-col gap-2">
        <p className="text-body font-medium" style={{ color: "var(--color-text-primary)" }}>
          {t("server.service.benchmark.running_text")}
        </p>
        {/* R4-F04 (09-42): a SINGLE time caption. 09-40 added a second
            «Оценка: ~1-3 минуты» (estimate_caption) alongside this one — a
            duplicate. Keep only «Это займёт 1-3 минуты» (hint_running). */}
        <p className="text-caption" style={{ color: "var(--color-text-muted)" }}>
          {t("server.service.benchmark.hint_running")}
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
          aria-label={t("server.service.benchmark.running_text")}
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
        {/* Percent only — right-aligned. R4-F05 (09-42): the left step caption
            («IPv4 · Риск-скоринг») was removed (markers batch at the end of the
            run, so it only ever popped the last marker right before completion). */}
        {hasPercent && (
          <div className="flex items-center justify-end">
            <p
              className="text-caption text-right"
              style={{ color: "var(--color-text-muted)" }}
            >
              {percent!}%
            </p>
          </div>
        )}
      </div>

      {/* Cancel button — Modal footer convention: right-aligned, gap-2.
          Default size matches CompletedView "Закрыть" / "Проверить ещё раз".
          R5-F01: hidden during the finishing 100% hold (run already succeeded). */}
      {!hideCancel && (
        <div className="flex justify-end gap-2">
          <Button
            variant="danger-outline"
            size="sm"
            onClick={onCancel}
            disabled={isCancelling}
          >
            {isCancelling
              ? t("server.service.benchmark.cancelling_button")
              : t("server.service.benchmark.cancel_button")}
          </Button>
        </div>
      )}
    </div>
  );
}

// Module-level render helper for a labeled report link (F01-e). Kept OUT of
// CompletedView's body so it is not re-created on every render
// (react-hooks/static-components). D-29: the URL only flows to the OS shell —
// never to the log channel.
function renderReportLink(
  url: string,
  label: string,
  testId: string,
  openLink: (url?: string) => void | Promise<void>,
) {
  return (
    <button
      type="button"
      onClick={() => void openLink(url)}
      data-testid={testId}
      className="self-start inline-flex items-center gap-1.5 text-body-sm underline underline-offset-2 hover:opacity-80 transition-opacity"
      style={{
        color: "var(--color-accent-interactive)",
        background: "none",
        border: "none",
        padding: 0,
        cursor: "pointer",
      }}
    >
      <ExternalLink className="w-3.5 h-3.5" />
      {label}
    </button>
  );
}

interface CompletedViewProps {
  record: BenchmarkRecord;
  parsed: ParsedSections;
  onRerun: () => void;
}
function CompletedView({ record, parsed, onRerun }: CompletedViewProps) {
  const { t } = useTranslation();

  // record.duration_seconds is intentionally NOT rendered anymore (F01-d) — it
  // stays in the saved record for history/diagnostics. Reference it once so the
  // prop is not flagged unused while documenting the deliberate keep.
  void record.duration_seconds;

  // D-29: the report link URL is NEVER logged — it only flows to the OS shell.
  const openLink = async (url?: string) => {
    if (!url) return;
    try {
      await shellOpen(url);
    } catch {
      // silent
    }
  };

  // F01-e: classify-by-header-IP links. A dual-stack run yields both; a
  // single-stack run yields exactly one (reportLinkV4 for a dotted-IP block).
  const v4 = parsed.reportLinkV4;
  const v6 = parsed.reportLinkV6;
  const hasAnyLink = !!v4 || !!v6;

  return (
    <div className="flex flex-col gap-4">
      {/* Report links — up to two, each labeled by IP family (F01-e) */}
      {hasAnyLink && (
        <div className="flex flex-col gap-2">
          {v4 &&
            renderReportLink(
              v4,
              t("server.service.benchmark.report_link_v4"),
              "report-link-button-v4",
              openLink
            )}
          {v6 &&
            renderReportLink(
              v6,
              t("server.service.benchmark.report_link_v6"),
              "report-link-button-v6",
              openLink
            )}
        </div>
      )}

      {/* No-link fallback banner — no raw output accordion */}
      {!hasAnyLink && (
        <div
          className="rounded-[var(--radius-md)] p-3 text-body-sm"
          style={{
            background: "var(--color-status-warning-bg)",
            color: "var(--color-text-primary)",
          }}
        >
          {t("server.service.benchmark.no_report_link_banner")}
        </div>
      )}

      {/* Action row — Modal standard (F01-a): right-aligned, primary LAST. The
          labeled «Закрыть» is gone — the corner × is the canonical close. */}
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="primary" size="sm" onClick={onRerun}>
          {t("server.service.benchmark.rerun_button")}
        </Button>
      </div>
    </div>
  );
}

interface ErrorViewProps {
  message: string;
  onRetry: () => void;
}
function ErrorView({ message, onRetry }: ErrorViewProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      <p className="text-body-sm" style={{ color: "var(--color-status-error)" }}>
        {t("server.service.benchmark.error_prefix")} {message}
      </p>
      {/* Modal standard (F01-a): right-aligned, primary «Повторить» LAST; the
          labeled «Закрыть» is gone (the corner × closes). */}
      <div className="flex justify-end gap-2">
        <Button variant="primary" size="sm" onClick={onRetry}>
          {t("server.service.benchmark.retry_button")}
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
  autoStart,
  _forceState,
  _forcePercent,
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

  // ── Honest section-based progress (09-38 F01-b) ──
  // The reducer (computeProgress) folds the benchmark-progress MARKER events
  // (block/section, no fabricated percent) into a monotonic determinate state.
  // The derived `percent` drives the bar; {currentFamily, currentSection} drive
  // the Russian step caption. initialProgress() = indeterminate (percent 0).
  const [progress, setProgress] = useState<ProgressState>(initialProgress);

  // ── R3-F02 (09-40): time-based ESTIMATED bar position ──
  // The section markers batch at the END of the run (they do not stream), so a
  // determinate section bar cannot animate. Instead the bar is driven by an
  // ELAPSED-TIME estimate (deriveEstimatedPercent) combined FORWARD with the
  // marker-reduced state (combineProgress = Math.max → snap to a real marker
  // when it arrives, never backward). This `displayPercent` holds the combined
  // value; the interval below ticks it forward while running. progress.ts stays
  // pure — the timer lives HERE, in the component.
  const [displayPercent, setDisplayPercent] = useState(0);
  // Keep a live ref to the marker-reduced progress so the interval's tick reads
  // the latest marker state without re-subscribing the interval on every marker.
  const progressRef = useRef(progress);
  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  // Subscribe to benchmark-progress marker events when running.
  useEffect(() => {
    if (state.kind !== "running") return;

    let unlistenFn: (() => void) | undefined;
    let mounted = true;

    // The Rust emitter sends a discriminated marker: { kind: "block", family }
    // or { kind: "section", section }. We feed it straight into the reducer.
    // E-19: progress never reverts to indeterminate mid-run — the reducer is
    // monotonic and HOLDS the last percent across inter-section gaps; the bar's
    // pulse/transition animation signals liveness.
    void listen<ProgressMarker>("benchmark-progress", (event) => {
      if (!mounted) return;
      setProgress((prev) => {
        const next = computeProgress(prev, event.payload);
        // Snap the displayed bar FORWARD to the marker immediately (don't wait
        // for the next interval tick) — combineProgress(0, next) yields the
        // marker-implied percent. Math.max keeps the bar monotonic if the time
        // estimate was already ahead. R3-F02 "anchor forward, never backward".
        setDisplayPercent((cur) => Math.max(cur, combineProgress(0, next)));
        return next;
      });
    }).then((fn) => {
      unlistenFn = fn;
    });

    return () => {
      mounted = false;
      if (unlistenFn) unlistenFn();
    };
  }, [state.kind]);

  // ── R3-F02: the interval that ticks the time estimate forward while running ──
  // BenchmarkModal OWNS the timer (progress.ts stays pure). On each tick we
  // recompute the combined estimate from elapsed seconds + the latest marker
  // state and advance the bar monotonically (Math.max). The interval is cleared
  // on unmount AND whenever the state leaves "running" (cleanup → clearInterval),
  // so no leaked timer keeps ticking after cancel / error / completion, and no
  // setState fires on an unmounted component (T-09-40b mitigation). When
  // _forcePercent is supplied (Storybook) the timer is skipped — the override wins.
  useEffect(() => {
    if (state.kind !== "running") return;
    if (_forcePercent !== undefined) return;

    const startedAt = Date.now();
    // Seed the first frame immediately so the bar starts moving without waiting
    // a full tick (combine with any marker already reduced).
    setDisplayPercent((cur) =>
      Math.max(cur, combineProgress(deriveEstimatedPercent(0), progressRef.current))
    );
    const id = setInterval(() => {
      const elapsedSeconds = (Date.now() - startedAt) / 1000;
      const timePercent = deriveEstimatedPercent(elapsedSeconds);
      setDisplayPercent((cur) =>
        Math.max(cur, combineProgress(timePercent, progressRef.current))
      );
    }, 300);

    return () => clearInterval(id);
  }, [state.kind, _forcePercent]);

  // ── R3-F02: completion owns 100 ──
  // The time estimate caps at 95 and markers cap at 99; only the resolved run
  // (completed) snaps the bar to 100. On cancel/error the interval above is
  // already cleared and the bar simply holds its last value (no jump to 100).
  useEffect(() => {
    if (state.kind === "completed") {
      setDisplayPercent(100);
    }
    // Reset the bar when a fresh run starts from idle (re-run / autoStart).
    if (state.kind === "idle") {
      setDisplayPercent(0);
    }
  }, [state.kind]);

  // ── R5-F01: brief 100% hold before results ──
  // On success the run enters "finishing" with the bar pinned at 100% (set in
  // handleStart). Hold ~600ms — longer than the bar's 500ms width transition
  // (transition-all duration-500) so the 95→100% fill is visibly completed —
  // then flip to "completed" to reveal the results view. The timeout is cleared
  // on cleanup so a close/unmount during the hold can't fire a late setState
  // (mirrors the interval-cleanup discipline above). Entered ONLY on success;
  // cancel/timeout/error never pass through finishing, so they still never reach
  // 100% (R3-F02 cancel/error "no jump to 100" invariants stay intact).
  useEffect(() => {
    if (state.kind !== "finishing") return;
    const { record, parsed } = state;
    const id = setTimeout(() => {
      setState({ kind: "completed", record, parsed });
    }, 600);
    return () => clearTimeout(id);
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
    setProgress(initialProgress());
    // Reset the estimate bar to 0 on every fresh run (re-run goes completed→
    // running directly, so the idle-reset effect would not fire here).
    setDisplayPercent(0);
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
      // R5-F01: pin the bar to 100% and enter a brief "finishing" hold so the
      // bar visibly FILLS to 100% before the results view replaces it (it used
      // to cut from the ~95% time cap straight to results). The timed flip to
      // "completed" lives in the effect below. The interval that ticks the
      // estimate stops here too (its effect is keyed on state.kind === running).
      setDisplayPercent(100);
      setState({ kind: "finishing", record, parsed });
      // D-29: log only metadata — no raw_stdout, no reportLink
      activityLog(
        "STATE",
        `benchmark.complete host=${sshParams.host} dur=${record.duration_seconds}s`
      );
      pushSnack(t("server.service.benchmark.snack.completed"));
    } catch (e) {
      const msg = formatError(e);
      // F17 / owner 6.4: a cancel that actually resolved (the real Отменяем
      // running server_cancel_benchmark has completed) CLOSES the modal — there
      // is no cancelled interstitial. The during-run/cancelling close-block in
      // RunningView held the window open until exactly this point.
      // Handles BOTH plain `BENCHMARK_CANCELLED|dur=N` AND B8 watchdog `...|forced`.
      if (msg.includes("BENCHMARK_CANCELLED")) {
        activityLog(
          "USER",
          `benchmark.cancelled host=${sshParams.host}${msg.includes("|forced") ? " forced=true" : ""}`
        );
        onClose();
      } else if (msg.includes("BENCHMARK_TIMEOUT")) {
        // F16 display half: the 300s overall timeout (09-31) is DISTINCT from a
        // user cancel. Show the dedicated timeout message, not the cancel path.
        setState({ kind: "error", message: t("server.service.benchmark.error_timeout") });
        activityLog("ERROR", `benchmark.timeout host=${sshParams.host}`);
      } else {
        setState({ kind: "error", message: msg });
        activityLog("ERROR", `benchmark.failed host=${sshParams.host} err=${msg}`);
        pushSnack(t("server.service.benchmark.snack.failed", { error: msg }), "error");
      }
    }
  };

  // ── handleCancel — W1: warning variant (non-destructive — can re-run) ──
  // Contrast: Stop service uses 'danger' (disconnects all clients).
  const handleCancel = async () => {
    if (state.kind !== "running") return;
    // W1: Cancel benchmark is non-destructive — warning variant (not danger)
    const ok = await confirm({
      title: t("server.service.benchmark.cancel_confirm_title"),
      message: t("server.service.benchmark.cancel_confirm_message"),
      variant: "warning",
      // §K CTA-04: distinct, unambiguous action labels. The generic
      // buttons.confirm/buttons.cancel («Подтвердить»/«Отмена») both read as
      // "cancel" on a "cancel the benchmark?" question — a double-negative the
      // user cannot parse. Spell out each side's outcome instead.
      confirmText: t("server.service.benchmark.cancel_confirm_yes"),
      cancelText: t("server.service.benchmark.cancel_confirm_no"),
    });
    if (!ok) return;
    // E-18 cancel race: the run can FINISH while the async confirm dialog is open.
    // `state.kind` here is the stale closure value ("running") — re-read the LIVE
    // state via stateRef. If the run already completed (or otherwise left the
    // running state) while the user was deciding, do NOT force `cancelling`:
    // that would clobber the completed result and stick on «Отменяем…» forever.
    if (stateRef.current.kind !== "running") return;
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

  // ── F17: start-on-open (autoStart) ──
  // When the modal opens for a fresh check (idle + autoStart), start the run
  // immediately — there is no idle gate to click. The ref guards that we fire
  // exactly once per open-edge (true→ render), not on every re-render while
  // open. We reset the guard when the modal closes so the next open re-arms it.
  const autoStartFiredRef = useRef(false);
  useEffect(() => {
    if (!isOpen) {
      autoStartFiredRef.current = false;
      return;
    }
    if (
      autoStart &&
      !autoStartFiredRef.current &&
      stateRef.current.kind === "idle"
    ) {
      autoStartFiredRef.current = true;
      void handleStart();
    }
    // handleStart is stable enough for this once-per-open guard; depending on
    // isOpen/autoStart only keeps the effect from re-running on unrelated state
    // changes. eslint-disable to avoid an exhaustive-deps loop on handleStart.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, autoStart]);

  // ── D-1.1: Block Modal closing during running / cancelling / finishing ──
  // R5-F01: the finishing 100% hold also blocks close so the user can't dismiss
  // the modal mid-fill (the corner ×, backdrop and escape stay disabled).
  const isBlocking =
    state.kind === "running" ||
    state.kind === "cancelling" ||
    state.kind === "finishing";
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
      // F01-a: canonical corner × is the standard close affordance. Disabled
      // while a run is in progress (isBlocking) — same guard as backdrop/escape,
      // so a half-finished check can't be dismissed mid-run.
      showCloseButton
      closeButtonDisabled={isBlocking}
      size="lg"
    >
      <h2
        className="text-title mb-4"
        style={{ color: "var(--color-text-primary)" }}
      >
        {t("server.service.benchmark.modal_title")}
      </h2>

      {state.kind === "idle" && (
        <IdleView onStart={() => void handleStart()} />
      )}
      {(state.kind === "running" ||
        state.kind === "cancelling" ||
        state.kind === "finishing") && (
        <RunningView
          isCancelling={state.kind === "cancelling"}
          // R5-F01: during the finishing hold the run is done — hide Cancel and
          // pin the bar to 100% so it visibly fills before results appear.
          hideCancel={state.kind === "finishing"}
          // _forcePercent (Storybook) overrides the live bar; when absent the
          // time-based estimate (combined forward with markers via the interval
          // above) drives the bar. A displayPercent of 0 means the very first
          // frame before the first tick → indeterminate (mapped to null).
          percent={
            state.kind === "finishing"
              ? 100
              : _forcePercent ?? (displayPercent > 0 ? displayPercent : null)
          }
          onCancel={() => void handleCancel()}
        />
      )}
      {state.kind === "completed" && (
        <CompletedView
          record={state.record}
          parsed={state.parsed}
          onRerun={() => void handleStart()}
        />
      )}
      {state.kind === "error" && (
        <ErrorView
          message={state.message}
          onRetry={() => setState({ kind: "idle" })}
        />
      )}
    </Modal>
  );
}
