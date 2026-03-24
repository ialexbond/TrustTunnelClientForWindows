import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { StepBar } from "./StepBar";
import type { WizardState } from "./useWizardState";

export function CheckingStep(w: WizardState) {
  const { t } = useTranslation();

  return (
    <>
      <StepBar step={w.step} isFetchMode={w.isFetchMode} />
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-sm w-full text-center space-y-5">
          <Loader2 className="w-10 h-10 animate-spin mx-auto" style={{ color: "var(--color-accent-500)" }} />
          <div className="space-y-1">
            <h2 className="text-lg font-bold">{t('wizard.checking.title')}</h2>
            <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
              {t('wizard.checking.description')}
            </p>
          </div>
          <button
            onClick={() => w.setWizardStep("server")}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm transition-all active:scale-[0.97]"
            style={{ color: "var(--color-text-secondary)" }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--color-bg-hover)"}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
          >
            {t('buttons.cancel')}
          </button>
        </div>
      </div>
    </>
  );
}
