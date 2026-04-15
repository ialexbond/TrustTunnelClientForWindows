import { useTranslation } from "react-i18next";
import { CheckCircle2, ChevronRight, Download, Plug } from "lucide-react";
import { Button } from "../../shared/ui/Button";
import type { WizardState } from "./useWizardState";

export function DoneStep(w: WizardState) {
  const { t } = useTranslation();
  const isFetch = w.isFetchMode;

  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <div className="max-w-sm w-full text-center space-y-5">
        <div className="mx-auto w-16 h-16 rounded-2xl flex items-center justify-center" style={{ backgroundColor: "var(--color-success-500)", boxShadow: "0 8px 24px var(--color-success-tint-25)" }}>
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
          <Button
            variant="primary"
            size="sm"
            fullWidth
            icon={<ChevronRight className="w-4 h-4" />}
            onClick={() => { w.setWizardStep("welcome"); w.onSetupComplete(w.configPath); }}
          >
            {t('wizard.done.go_to_panel')}
          </Button>
          {w.configPath && (
            <Button
              variant="success"
              size="sm"
              fullWidth
              icon={<Plug className="w-4 h-4" />}
              onClick={() => {
                localStorage.setItem("tt_navigate_after_setup", "settings");
                w.setWizardStep("welcome");
                w.onSetupComplete(w.configPath);
              }}
            >
              {t('wizard.done.go_to_connection')}
            </Button>
          )}
          {w.configPath && (
            <Button
              variant="secondary"
              size="sm"
              fullWidth
              icon={<Download className="w-4 h-4" />}
              onClick={w.handleSaveAs}
            >
              {t('buttons.save_as')}
            </Button>
          )}
          <Button variant="ghost" size="sm" fullWidth onClick={() => w.setWizardStep("welcome")}>
            {t('wizard.done.to_home')}
          </Button>
        </div>
      </div>
    </div>
  );
}
