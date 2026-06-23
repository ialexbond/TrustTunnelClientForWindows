import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import { Button } from "../../shared/ui/Button";
import { ProgressBar } from "../../shared/ui/ProgressBar";
import { StepBar } from "./StepBar";
import { STEPS_ORDER, getStepLabels } from "./types";
import type { WizardState } from "./useWizardState";

/**
 * UAT 2026-05-20 — DeployingStep no longer feels "frozen" during long apt-get
 * spans. Two signals layered on top of the existing step list:
 *
 *  1) Overall progress bar — completed_steps / total_steps. The in-flight
 *     step counts as half (50% of its slice) so progress feels continuous.
 *
 *  2) Per-step percent rendered next to the active step (e.g. "60%").
 *     Source: latest `N%` token in the live deploy log — apt / dpkg /
 *     certbot already print progress like "(Reading database ... 25%" and
 *     "Unpacking systemd ... 60%" into stdout. We parse the freshest
 *     percent from `w.deployLogs` and display it. Percent is sticky inside
 *     a single step (Math.max with previous) so it never goes backwards
 *     when dpkg restarts its 0–100% cycle on the next package.
 *
 *  3) Live tail of the last info/warn deploy log line, in muted mono
 *     under the active step. Lets the user see real activity (which
 *     package is unpacking right now) instead of a bare spinner.
 */
export function DeployingStep(w: WizardState) {
  const { t } = useTranslation();
  const stepLabels = getStepLabels(t);

  // post-UAT: the "security" (firewall/Fail2ban provision) step only exists when the
  // user enabled at least one toggle. With both off nothing is provisioned, so the
  // step would be misleading — drop it from the rendered list AND the progress total
  // (the backend emits no "security" event when both toggles are off).
  const steps = useMemo(
    () => (w.enableFirewall || w.enableFail2ban) ? STEPS_ORDER : STEPS_ORDER.filter((id) => id !== "security"),
    [w.enableFirewall, w.enableFail2ban],
  );

  // ── In-flight step ──
  const inFlightStepId = useMemo(
    () => steps.find((id) => w.deploySteps[id]?.status === "progress") ?? null,
    [steps, w.deploySteps],
  );

  // ── Overall progress percent ──
  const percent = useMemo(() => {
    const total = steps.length;
    // "warn" counts as resolved: the only warn-capable step is "security" (a
    // non-blocking firewall/Fail2ban provision hiccup, D-04) — it must not hold the
    // bar below 100% when everything that matters finished.
    const done = steps.filter((id) => {
      const st = w.deploySteps[id]?.status;
      return st === "ok" || st === "warn";
    }).length;
    const inFlight = inFlightStepId ? 0.5 : 0;
    return Math.round(((done + inFlight) / total) * 100);
  }, [steps, w.deploySteps, inFlightStepId]);

  // ── Last info/warn log line (live tail) ──
  // No manual useMemo — React Compiler memoizes automatically and complains
  // when an existing useMemo can't be preserved (`react-hooks/preserve-manual-memoization`).
  let lastLogLine = "";
  for (let i = w.deployLogs.length - 1; i >= 0; i -= 1) {
    const entry = w.deployLogs[i];
    if (entry.level !== "info" && entry.level !== "warn") continue;
    const msg = entry.message.trim();
    // Skip internal existence-probe sentinels (`… TT_EXISTS` / `… TT_MISSING`, e.g.
    // "CERT TT_MISSING") — they are machine markers the backend parses, NOT user-facing
    // activity, and surfaced as a raw error-looking code in the live tail under a step.
    if (msg.includes("TT_EXISTS") || msg.includes("TT_MISSING")) continue;
    lastLogLine = msg;
    break;
  }

  // ── Per-step percent (real % parse + pseudo-progress fallback) ──
  //
  // Two-source progress for the active step:
  //
  //   (A) REAL — scan the last 20 log lines for the freshest `N%` token.
  //       apt/dpkg/certbot stream "Reading database ... 25%", "Unpacking
  //       systemd ... 60%" into deployLogs. When found, this is the source
  //       of truth.
  //
  //   (B) PSEUDO — for steps where backend doesn't print %% (tarball
  //       download/unpack, config writes, systemd setup) — count how many
  //       log lines the backend has emitted SINCE the step started, and
  //       map that to a 5-95% pseudo-progress (5% per line, clamped).
  //       Each new log line bumps the bar a bit. Capped at 95% to avoid
  //       showing 100% before the step actually flips to status="ok".
  //
  //   Display = max(real, pseudo, previous). Monotonic inside a step —
  //   dpkg resets 0→100% on every package, so without sticky we'd flicker
  //   99→5→30→5→60.
  //
  // State (`stepPercent`) holds the displayed value; ref (`stepBaselineRef`)
  // remembers the step entry baseline (stepId + log-count at that moment).
  // All mutation lives in an effect so render itself reads no refs and the
  // React 19 `react-hooks/refs` lint stays happy.
  const [stepPercent, setStepPercent] = useState<number | null>(null);
  const stepBaselineRef = useRef<{ stepId: string | null; baseCount: number }>({
    stepId: null,
    baseCount: 0,
  });
  useEffect(() => {
    // No active step → clear display.
    if (!inFlightStepId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- derived from inFlightStepId; reset is the whole point
      setStepPercent(null);
      return;
    }

    // Step changed — reset baseline so pseudo math is relative to step entry.
    const stepChanged = stepBaselineRef.current.stepId !== inFlightStepId;
    if (stepChanged) {
      stepBaselineRef.current = {
        stepId: inFlightStepId,
        baseCount: w.deployLogs.length,
      };
    }

    // (A) Real % from latest 20 log lines.
    // IN-04: named `recentLogs` (was `window`) — the old name shadowed the DOM `window`
    // global, a footgun if anything in this scope ever needs the real global.
    let realParsed: number | null = null;
    const recentLogs = w.deployLogs.slice(-20);
    for (let i = recentLogs.length - 1; i >= 0; i -= 1) {
      const m = recentLogs[i].message.match(/\b(\d{1,3})\s*%/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n >= 0 && n <= 100) {
          realParsed = Math.min(n, 99); // never 100 until status flips to "ok"
          break;
        }
      }
    }

    // (B) Pseudo-progress = 5% per log line since step start, clamped 5-95.
    const linesSinceStart = Math.max(
      0,
      w.deployLogs.length - stepBaselineRef.current.baseCount,
    );
    const pseudo = Math.min(95, Math.max(5, linesSinceStart * 5));

    const candidate = Math.max(realParsed ?? 0, pseudo);

    // Single functional setState — reset to candidate on step change, merge
    // monotonically otherwise. Computed deterministically from deployLogs +
    // inFlightStepId; never produces a value smaller than the previous so
    // no oscillation.
    setStepPercent((prev) =>
      stepChanged ? candidate : Math.max(prev ?? 0, candidate),
    );
  }, [w.deployLogs, inFlightStepId]);

  return (
    <>
      <StepBar step={w.step} />
      <div className="flex-1 flex flex-col items-center justify-center p-6">
        <div className="max-w-md w-full space-y-4">
          {/* Onboarding hero language (D-05 / UI-SPEC "Deploying" row): heading → display-sm
              with a stable id matching the shared per-screen aria convention (same as
              ServerStep/CheckingStep); the overlay aria-labelledby resolves to App's own
              sr-only #wizard-dialog-title (Plan 06-03), independent of this id. */}
          <div className="text-center space-y-1">
            <h2 id="wizard-heading" className="text-display-sm text-[var(--color-text-primary)]">{t('wizard.deploying.title')}</h2>
            {/* User-facing screen description = prose, so text-body (16px), not text-xs
                (06-UI-REVIEW typography finding: text-xs is reserved for meta — step-row
                labels, log tail, counters below — not the description sentence). */}
            <p className="text-body text-[var(--color-text-muted)]">{t('wizard.deploying.description')}</p>
          </div>

          {/* Overall progress bar — swapped the hand-rolled role="progressbar" div for the
              shared ProgressBar primitive (UI-SPEC §A11y / PATTERNS Pattern 2: it carries its
              own role + aria-valuenow/min/max + aria-label, so the a11y contract comes for free
              and stays consistent with the rest of the app). The percent source is unchanged. */}
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between text-xs text-[var(--color-text-muted)]">
              <span>{t('wizard.deploying.overall_progress')}</span>
              <span className="font-mono text-[var(--color-text-secondary)]">{percent}%</span>
            </div>
            <ProgressBar
              value={percent}
              max={100}
              size="sm"
              label={t('wizard.deploying.overall_progress')}
            />
          </div>

          <div className="glass-card p-4 space-y-2">
            {steps.map((stepId) => {
              const step = w.deploySteps[stepId];
              const isActive = stepId === inFlightStepId;
              if (!step) {
                return (
                  <div key={stepId} className="flex items-center gap-2 text-[var(--color-text-muted)]">
                    <div className="w-4 h-4 rounded-full shrink-0 border border-[var(--color-border)]" />
                    <span className="text-xs">{stepLabels[stepId]}</span>
                  </div>
                );
              }
              // Step-row label color tracks status via token utility classes (UI-SPEC §Color:
              // active deploy step → warning, done → success, error → danger). 16px icons.
              const labelColor =
                step.status === "progress"
                  ? "text-[var(--color-warning-500)]"
                  : step.status === "ok"
                  ? "text-[var(--color-success-500)]"
                  : step.status === "warn"
                  ? "text-[var(--color-warning-500)]"
                  : "text-[var(--color-danger-500)]";
              return (
                <div key={stepId} className="space-y-1">
                  <div className="flex items-center gap-2">
                    {step.status === "progress" && (
                      <Loader2 className="w-4 h-4 animate-spin shrink-0 text-[var(--color-warning-500)]" />
                    )}
                    {step.status === "ok" && (
                      <CheckCircle2 className="w-4 h-4 shrink-0 text-[var(--color-success-500)]" />
                    )}
                    {step.status === "error" && (
                      <XCircle className="w-4 h-4 shrink-0 text-[var(--color-danger-500)]" />
                    )}
                    {/* "warn" — a non-blocking step (only "security": firewall/Fail2ban
                        provision hiccup, D-04). Yellow triangle, NOT a fatal red X; the
                        install succeeded and the wizard continues to "done". */}
                    {step.status === "warn" && (
                      <AlertTriangle className="w-4 h-4 shrink-0 text-[var(--color-warning-500)]" />
                    )}
                    <span className={`text-xs flex-1 ${labelColor}`}>
                      {step.status === "error" ? step.message : stepLabels[stepId]}
                    </span>
                    {isActive && stepPercent != null && (
                      <span className="text-xs font-mono shrink-0 text-[var(--color-text-secondary)]">
                        {stepPercent}%
                      </span>
                    )}
                  </div>
                  {/* Live tail of the most recent backend log — only under the active step,
                      truncated to one line, --text-mono-sm + muted so it reads as ambient
                      activity (T-06-07: same backend-sanitized stream, no new source). */}
                  {isActive && lastLogLine && (
                    <p
                      className="text-mono-sm pl-6 truncate text-[var(--color-text-muted)]"
                      title={lastLogLine}
                    >
                      {lastLogLine}
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          {/* #23 + cancel-lifecycle (06-uat / 06-review): the action BUTTON is the SINGLE
              in-progress indicator. It has a STRICT lifecycle so «Отмена» is only offered
              while a cancel is actually meaningful:
                • install actively running (no terminal `done` yet) → active «Отмена установки»,
                  clickable — this is the ONLY window where cancelling can still roll back;
                • cancelling (w.cancellingDeploy) → disabled + spinner, «Отмена установки…»;
                • install COMPLETE (`deploySteps.done.status === "ok"`) OR the post-deploy
                  finalize re-export (w.finalizing) → DISABLED + spinner, «Завершаем настройку…».
              `installDone` is the keystone: the moment the terminal `done` step lands there is
              nothing left to cancel, so the button locks into the disabled finalize state and
              STAYS there until the screen flips to «Всё готово». Previously it briefly reverted
              to an active «Отмена» in the gap between `finalizing` flipping false and the done
              transition firing — that half-second flash is gone. The Button's `loading` prop
              renders the spinner and disables the button. */}
          {(() => {
            const installDone = w.deploySteps.done?.status === "ok";
            // No cancel possible once we're cancelling, finalizing, or the install already
            // finished — all collapse to the disabled "finishing" affordance.
            const inProgress = w.cancellingDeploy || w.finalizing || installDone;
            const label = w.cancellingDeploy
              ? t('wizard.deploying.cancelling')
              : w.finalizing || installDone
              ? t('wizard.deploying.finalizing')
              : t('buttons.cancel');
            return (
              <div className="flex justify-center">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={w.handleCancelDeploy}
                  loading={inProgress}
                >
                  {label}
                </Button>
              </div>
            );
          })()}
        </div>
      </div>
    </>
  );
}
