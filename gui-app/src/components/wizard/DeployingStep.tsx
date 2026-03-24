import { useTranslation } from "react-i18next";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";
import { StepBar } from "./StepBar";
import { STEPS_ORDER, getStepLabels } from "./types";
import type { WizardState } from "./useWizardState";

export function DeployingStep(w: WizardState) {
  const { t } = useTranslation();
  const stepLabels = getStepLabels(t);

  return (
    <>
      <StepBar step={w.step} isFetchMode={w.isFetchMode} />
      <div className="flex-1 flex flex-col items-center justify-center p-6">
        <div className="max-w-md w-full space-y-4">
          <div className="text-center space-y-1">
            <h2 className="text-lg font-bold">{t('wizard.deploying.title')}</h2>
            <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>{t('wizard.deploying.description')}</p>
          </div>

          <div className="glass-card p-4 space-y-2">
            {STEPS_ORDER.map((stepId) => {
              const step = w.deploySteps[stepId];
              if (!step) {
                return (
                  <div key={stepId} className="flex items-center gap-2.5" style={{ color: "var(--color-text-muted)" }}>
                    <div className="w-4 h-4 rounded-full shrink-0" style={{ border: "1px solid var(--color-border)" }} />
                    <span className="text-xs">{stepLabels[stepId]}</span>
                  </div>
                );
              }
              return (
                <div key={stepId} className="flex items-center gap-2.5">
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
                    className="text-xs"
                    style={{
                      color: step.status === "progress"
                        ? "var(--color-warning-500)"
                        : step.status === "ok"
                        ? "var(--color-success-500)"
                        : "var(--color-danger-500)"
                    }}
                  >
                    {step.message}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}
