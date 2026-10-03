import { useTranslation } from "react-i18next";
import type { WizardStep } from "./types";

interface StepBarProps {
  step: WizardStep;
}

// 06-uat: the install wizard is now a single flow — настройки → установка. The old
// `server` (SSH auth) and `checking` (probe) screens and the `fetch` flow were removed,
// so the step bar no longer has a 4-step (server→checking→endpoint→deploying) arm or a
// fetch arm — it would otherwise SHOW «сервер»/«проверка» labels for screens that no
// longer exist. SSH authorization lives only in the Control Panel.
export function StepBar({ step }: StepBarProps) {
  const { t } = useTranslation();

  // done/error are terminal and recovery is an out-of-flow fork (05-03) — no progress
  // bar. Legacy server/checking/welcome are unreachable but guarded to render nothing.
  if (
    step === "welcome" ||
    step === "server" ||
    step === "checking" ||
    step === "fetching" ||
    step === "done" ||
    step === "error" ||
    step === "recovery"
  ) {
    return null;
  }

  const stepNumbers: { key: WizardStep; label: string }[] = [
    { key: "endpoint", label: t('wizard.progress.settings') },
    { key: "deploying", label: t('wizard.progress.installation') },
  ];

  // found (server already installed → reinstall) and uninstalling map onto the two
  // visible stages so the bar stays sensible on those screens.
  const stepMap: Record<string, string> = {
    endpoint: "endpoint",
    found: "endpoint",
    uninstalling: "deploying",
    deploying: "deploying",
  };

  const mapped = stepMap[step] || step;
  const currentIdx = stepNumbers.findIndex((s) => s.key === mapped);

  // Softened per D-03 / D-05: the loud numbered 1-2-3-4 circles are replaced with the
  // calm dot indicator from welcome/WelcomeDotIndicator.tsx so the wizard reads as one
  // family with the onboarding tour. The `total` is computed from stepNumbers.length.
  return (
    <div
      role="group"
      aria-label={`Шаг ${currentIdx + 1} из ${stepNumbers.length}`}
      className="flex items-center justify-center gap-2 px-6 pt-4 pb-1"
    >
      {stepNumbers.map((s, i) => {
        const isActive = i === currentIdx;
        const isPast = i < currentIdx;
        const dotColor =
          isActive || isPast ? "var(--color-accent-interactive)" : "var(--color-border)";
        // The connector PRECEDING the active dot is also lit accent — the "путь пройден"
        // metaphor from WelcomeDotIndicator (i <= currentIdx).
        const connectorColor =
          i <= currentIdx ? "var(--color-accent-interactive)" : "var(--color-border)";
        return (
          <div key={s.key} className="flex items-center gap-2">
            {i > 0 && (
              <div
                aria-hidden="true"
                style={{
                  width: 32,
                  height: 2,
                  backgroundColor: connectorColor,
                  transition: "background-color var(--transition-fast)",
                }}
              />
            )}
            <div
              aria-hidden="true"
              data-active={isActive ? "true" : "false"}
              style={{
                width: isActive ? 24 : 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: dotColor,
                transition:
                  "width 300ms cubic-bezier(0.4, 0, 0.2, 1), background-color 300ms ease",
              }}
            />
            <span
              className="text-xs"
              style={{
                color: isActive ? "var(--color-text-primary)" : "var(--color-text-muted)",
              }}
            >
              {s.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
