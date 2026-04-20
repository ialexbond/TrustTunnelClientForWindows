import { useTranslation } from "react-i18next";
import type { WizardStep } from "./types";

interface StepBarProps {
  step: WizardStep;
  isFetchMode: boolean;
}

export function StepBar({ step, isFetchMode }: StepBarProps) {
  const { t } = useTranslation();

  if (step === "welcome" || step === "done" || step === "error") return null;

  const stepNumbers: { key: WizardStep; label: string }[] = isFetchMode
    ? [
        { key: "server", label: t('wizard.progress.server') },
        { key: "checking", label: t('wizard.progress.checking') },
        { key: "fetching", label: t('wizard.progress.saving_config') },
      ]
    : [
        { key: "server", label: t('wizard.progress.server') },
        { key: "checking", label: t('wizard.progress.checking') },
        { key: "endpoint", label: t('wizard.progress.settings') },
        { key: "deploying", label: t('wizard.progress.installation') },
      ];

  const stepMap: Record<string, string> = isFetchMode
    ? {
        server: "server",
        checking: "checking",
        found: "checking",
        fetching: "fetching",
      }
    : {
        server: "server",
        checking: "checking",
        found: "checking",
        uninstalling: "checking",
        endpoint: "endpoint",
        deploying: "deploying",
        fetching: "fetching",
      };

  const mapped = stepMap[step] || step;
  const currentIdx = stepNumbers.findIndex((s) => s.key === mapped);

  return (
    <div className="flex items-center justify-center gap-2 px-6 pt-4 pb-1">
      {stepNumbers.map((s, i) => (
        <div key={s.key} className="flex items-center gap-2">
          <div
            className="w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold transition-colors"
            style={
              i < currentIdx
                ? { backgroundColor: "var(--color-status-connected-bg)", color: "var(--color-success-500)" }
                : i === currentIdx
                ? { backgroundColor: "transparent", color: "var(--color-accent-500)", boxShadow: "0 0 0 2px var(--color-accent-tint-50)" }
                : { backgroundColor: "var(--color-bg-hover)", color: "var(--color-text-muted)" }
            }
          >
            {i < currentIdx ? "\u2713" : i + 1}
          </div>
          <span
            className="text-[11px]"
            style={{ color: i === currentIdx ? "var(--color-text-primary)" : "var(--color-text-muted)" }}
          >
            {s.label}
          </span>
          {i < stepNumbers.length - 1 && (
            <div
              className="w-8 h-px"
              style={{ backgroundColor: i < currentIdx ? "var(--color-success-tint-30)" : "var(--color-border)" }}
            />
          )}
        </div>
      ))}
    </div>
  );
}
