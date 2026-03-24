import { useTranslation } from "react-i18next";
import { CheckCircle2, ChevronRight, Download, Plug } from "lucide-react";
import type { WizardState } from "./useWizardState";

export function DoneStep(w: WizardState) {
  const { t } = useTranslation();
  const isFetch = w.isFetchMode;

  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <div className="max-w-sm w-full text-center space-y-5">
        <div className="mx-auto w-16 h-16 rounded-2xl flex items-center justify-center" style={{ backgroundColor: "var(--color-success-500)", boxShadow: "0 8px 24px rgba(16, 185, 129, 0.25)" }}>
          <CheckCircle2 className="w-8 h-8 text-white" />
        </div>

        <div className="space-y-1.5">
          <h2 className="text-xl font-bold" style={{ color: "var(--color-success-500)" }}>{t('wizard.done.title')}</h2>
          <p className="text-sm" style={{ color: "var(--color-text-secondary)" }}>
            {isFetch
              ? t('wizard.done.fetch_description')
              : t('wizard.done.deploy_description')}
          </p>
        </div>

        {w.configPath && (
          <div className="glass-card p-3 text-left">
            <p className="text-[11px] mb-0.5" style={{ color: "var(--color-text-muted)" }}>{t('wizard.done.config_file_label')}</p>
            <p className="text-xs font-mono break-all" style={{ color: "var(--color-text-primary)" }}>{w.configPath}</p>
          </div>
        )}

        <div className="space-y-2 w-full">
          <button
            onClick={() => { w.setWizardStep("welcome"); w.onSetupComplete(w.configPath); }}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-medium transition-all active:scale-95"
            style={{ backgroundColor: "var(--color-accent-500)", color: "white" }}
          >
            {t('wizard.done.go_to_panel')}
            <ChevronRight className="w-4 h-4" />
          </button>
          {w.configPath && (
            <button
              onClick={() => {
                localStorage.setItem("tt_navigate_after_setup", "settings");
                w.setWizardStep("welcome");
                w.onSetupComplete(w.configPath);
              }}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-medium transition-all active:scale-95"
              style={{ backgroundColor: "var(--color-success-500)", color: "white" }}
            >
              <Plug className="w-4 h-4" />
              {t('wizard.done.go_to_connection')}
            </button>
          )}
          {w.configPath && (
            <button
              onClick={w.handleSaveAs}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm transition-all active:scale-[0.97] hover:opacity-80"
              style={{ backgroundColor: "var(--color-bg-hover)", border: "1px solid var(--color-border)", color: "var(--color-text-secondary)" }}
            >
              <Download className="w-4 h-4" />
              {t('buttons.save_as')}
            </button>
          )}
          <button
            onClick={() => w.setWizardStep("welcome")}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm transition-all active:scale-[0.97]"
            style={{ color: "var(--color-text-secondary)" }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--color-bg-hover)"}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
          >
            {t('wizard.done.to_home')}
          </button>
        </div>
      </div>
    </div>
  );
}
