import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";
import { Button } from "../../shared/ui/Button";
import { StepBar } from "./StepBar";
import { STEPS_ORDER, getStepLabels } from "./types";
import type { WizardState } from "./useWizardState";

/**
 * UAT 2026-05-20 — DeployingStep no longer feels "frozen" during long apt-get
 * spans. Three new signals layered on top of the existing step list:
 *
 *  1) Overall progress bar — completed_steps / total_steps. The in-flight
 *     step counts as half (50% of its slice) so progress feels continuous
 *     instead of jumping in discrete chunks.
 *
 *  2) Elapsed timer on the in-flight step ("Обновляем систему · 42с"). Resets
 *     when the active step changes; updates every 1s via a single interval.
 *
 *  3) Live tail of the last `info`/`warn` deploy log line, rendered under
 *     the current step in muted mono. apt-get / certbot output already
 *     reaches `w.deployLogs` via the backend's emit_log — we just surface
 *     the freshest line so the user can see the install is actually moving.
 */
export function DeployingStep(w: WizardState) {
  const { t } = useTranslation();
  const stepLabels = getStepLabels(t);

  // ── In-flight step ──
  const inFlightStepId = useMemo(
    () => STEPS_ORDER.find((id) => w.deploySteps[id]?.status === "progress") ?? null,
    [w.deploySteps],
  );

  // ── Overall progress percent ──
  const percent = useMemo(() => {
    const total = STEPS_ORDER.length;
    const done = STEPS_ORDER.filter((id) => w.deploySteps[id]?.status === "ok").length;
    const inFlight = inFlightStepId ? 0.5 : 0;
    return Math.round(((done + inFlight) / total) * 100);
  }, [w.deploySteps, inFlightStepId]);

  // ── Elapsed timer on active step (reset when step changes) ──
  const [elapsed, setElapsed] = useState(0);
  const stepStartedAt = useRef<number>(Date.now());
  const prevStepId = useRef<string | null>(null);
  useEffect(() => {
    if (inFlightStepId !== prevStepId.current) {
      prevStepId.current = inFlightStepId;
      stepStartedAt.current = Date.now();
      setElapsed(0);
    }
    if (!inFlightStepId) return;
    const tick = setInterval(() => {
      setElapsed(Math.floor((Date.now() - stepStartedAt.current) / 1000));
    }, 1000);
    return () => clearInterval(tick);
  }, [inFlightStepId]);

  // ── Last info/warn log line (live tail) ──
  const lastLogLine = useMemo(() => {
    for (let i = w.deployLogs.length - 1; i >= 0; i -= 1) {
      const entry = w.deployLogs[i];
      if (entry.level === "info" || entry.level === "warn") {
        return entry.message.trim();
      }
    }
    return "";
  }, [w.deployLogs]);

  return (
    <>
      <StepBar step={w.step} isFetchMode={w.isFetchMode} />
      <div className="flex-1 flex flex-col items-center justify-center p-6">
        <div className="max-w-md w-full space-y-4">
          <div className="text-center space-y-1">
            <h2 className="text-lg font-bold">{t('wizard.deploying.title')}</h2>
            <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>{t('wizard.deploying.description')}</p>
          </div>

          {/* Overall progress bar */}
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between text-xs" style={{ color: "var(--color-text-muted)" }}>
              <span>{t('wizard.deploying.overall_progress')}</span>
              <span className="font-mono" style={{ color: "var(--color-text-secondary)" }}>{percent}%</span>
            </div>
            <div
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              className="relative w-full overflow-hidden rounded-full"
              style={{
                height: 6,
                background: "var(--color-bg-surface)",
                border: "1px solid var(--color-border)",
              }}
            >
              <span
                className="absolute top-0 bottom-0 left-0 transition-all duration-500"
                style={{
                  width: `${percent}%`,
                  background: "var(--color-accent-interactive)",
                  borderRadius: "inherit",
                }}
              />
            </div>
          </div>

          <div className="glass-card p-4 space-y-2">
            {STEPS_ORDER.map((stepId) => {
              const step = w.deploySteps[stepId];
              const isActive = stepId === inFlightStepId;
              if (!step) {
                return (
                  <div key={stepId} className="flex items-center gap-2.5" style={{ color: "var(--color-text-muted)" }}>
                    <div className="w-4 h-4 rounded-full shrink-0" style={{ border: "1px solid var(--color-border)" }} />
                    <span className="text-xs">{stepLabels[stepId]}</span>
                  </div>
                );
              }
              return (
                <div key={stepId} className="space-y-1">
                  <div className="flex items-center gap-2.5">
                    {step.status === "progress" && (
                      <Loader2 className="w-4 h-4 animate-spin shrink-0" style={{ color: "var(--color-warning-500)" }} />
                    )}
                    {step.status === "ok" && (
                      <CheckCircle2 className="w-4 h-4 shrink-0" style={{ color: "var(--color-success-500)" }} />
                    )}
                    {step.status === "error" && (
                      <XCircle className="w-4 h-4 shrink-0" style={{ color: "var(--color-danger-500)" }} />
                    )}
                    <span
                      className="text-xs flex-1"
                      style={{
                        color: step.status === "progress"
                          ? "var(--color-warning-500)"
                          : step.status === "ok"
                          ? "var(--color-success-500)"
                          : "var(--color-danger-500)"
                      }}
                    >
                      {step.status === "error" ? step.message : stepLabels[stepId]}
                    </span>
                    {isActive && (
                      <span className="text-xs font-mono shrink-0" style={{ color: "var(--color-text-muted)" }}>
                        {elapsed}s
                      </span>
                    )}
                  </div>
                  {/* Live tail of the most recent backend log — only under the active step,
                      truncated to one line, mono+muted so it reads as ambient activity. */}
                  {isActive && lastLogLine && (
                    <p
                      className="text-mono-sm pl-6 truncate"
                      style={{ color: "var(--color-text-muted)" }}
                      title={lastLogLine}
                    >
                      {lastLogLine}
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex justify-center">
            <Button
              variant="ghost"
              size="sm"
              onClick={w.handleCancelDeploy}
              loading={w.cancellingDeploy}
            >
              {w.cancellingDeploy ? t('wizard.deploying.cancelling') : t('buttons.cancel')}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
