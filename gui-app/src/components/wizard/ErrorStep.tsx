import { useTranslation } from "react-i18next";
import {
  XCircle, AlertTriangle, ChevronUp, ChevronDown, Copy, ClipboardCheck,
} from "lucide-react";
import { Button } from "../../shared/ui/Button";
import { colors } from "../../shared/ui/colors";
import { translateSshError } from "../../shared/utils/translateSshError";
import type { WizardState } from "./useWizardState";

export function ErrorStep(w: WizardState) {
  const { t } = useTranslation();
  const showReinstallPrompt = w.isFetchMode && w.fetchRetryCount >= 2;

  // Smart error hints based on error message and deploy logs
  const allText = [w.errorMessage, ...w.deployLogs.map(l => l.message)].join("\n").toLowerCase();
  const hints: string[] = [];
  if (allText.includes("nxdomain") || (allText.includes("dns") && allText.includes("domain"))) {
    hints.push(t('wizard.error.hint_dns'));
  }
  if (allText.includes("certbot") || allText.includes("letsencrypt") || allText.includes("let's encrypt")) {
    if (!hints.length) hints.push(t('wizard.error.hint_letsencrypt'));
  }
  if (allText.includes("port 80")) {
    hints.push(t('wizard.error.hint_port_80'));
  }
  if (allText.includes("connection refused") || allText.includes("connection timed out") || allText.includes("os error 10054") || allText.includes("os error 10060")) {
    hints.push(t('wizard.error.hint_unreachable'));
  }
  if (allText.includes("authentication") || allText.includes("auth failed") || allText.includes("permission denied")) {
    hints.push(t('wizard.error.hint_auth_failed'));
  }

  return (
    <div className="flex-1 flex flex-col items-center overflow-y-auto p-6">
      <div className="max-w-sm w-full text-center space-y-4 my-auto">
        <div className="mx-auto w-16 h-16 rounded-2xl flex items-center justify-center shrink-0" style={{ backgroundColor: "var(--color-danger-500)", boxShadow: "0 8px 24px rgba(239, 68, 68, 0.25)" }}>
          <XCircle className="w-8 h-8 text-white" />
        </div>

        <div className="space-y-1.5">
          <h2 className="text-xl font-bold" style={{ color: "var(--color-danger-500)" }}>{t('wizard.error.title')}</h2>
          <div className="max-h-32 overflow-y-auto rounded-lg p-2" style={{ backgroundColor: "var(--color-bg-elevated)" }}>
            <p className="text-xs leading-relaxed select-text cursor-text break-words" style={{ color: "var(--color-text-secondary)" }}>
              {w.errorMessage ? translateSshError(w.errorMessage, t) : t('wizard.error.unknown')}
            </p>
          </div>
        </div>

        {hints.length > 0 && (
          <div className="text-left space-y-1.5 p-3 rounded-xl" style={{ backgroundColor: "rgba(245, 158, 11, 0.05)", border: `1px solid ${colors.warningBorder}` }}>
            <p className="text-[11px] font-semibold flex items-center gap-1.5" style={{ color: "var(--color-warning-500)" }}>
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              {t('wizard.error.possible_cause')}
            </p>
            {hints.map((hint, i) => (
              <p key={i} className="text-[11px] leading-relaxed" style={{ color: "var(--color-text-secondary)" }}>{hint}</p>
            ))}
          </div>
        )}

        {w.deployLogs.length > 0 && (
          <div>
            <button
              onClick={() => w.setShowLogs(!w.showLogs)}
              className="flex items-center gap-1.5 text-[11px] transition-colors mx-auto" style={{ color: "var(--color-text-muted)" }}
            >
              {w.showLogs ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              {w.showLogs ? t('wizard.error.hide_logs') : t('wizard.error.show_logs')}
            </button>
            {w.showLogs && (
              <div className="mt-1.5 glass-card p-2.5 max-h-36 overflow-y-auto font-mono text-[10px] space-y-0.5 text-left select-text cursor-text relative group">
                <button
                  onClick={w.copyLogsToClipboard}
                  className="absolute top-1.5 right-1.5 p-1 rounded-lg hover:opacity-80 transition-colors opacity-0 group-hover:opacity-100" style={{ backgroundColor: "var(--color-bg-hover)", color: "var(--color-text-secondary)" }}
                  title={t('wizard.error.copy_logs_tooltip')}
                >
                  {w.copied ? <ClipboardCheck className="w-3 h-3" style={{ color: "var(--color-success-500)" }} /> : <Copy className="w-3 h-3" />}
                </button>
                {w.deployLogs.map((log, i) => (
                  <div
                    key={i}
                    style={{ color: log.level === "error" ? "var(--color-danger-500)" : "var(--color-text-muted)" }}
                  >
                    {log.message}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {showReinstallPrompt ? (
          <div className="p-3 rounded-xl space-y-2.5" style={{ backgroundColor: colors.warningBg, border: "1px solid rgba(245, 158, 11, 0.2)" }}>
            <p className="text-xs font-medium" style={{ color: "var(--color-warning-500)" }}>
              {t('wizard.error.reinstall_prompt')}
            </p>
            <p className="text-xs leading-relaxed" style={{ color: "var(--color-text-secondary)" }}>
              {t('wizard.error.reinstall_description')}
            </p>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => w.setWizardStep("server")}>
                {t('buttons.cancel')}
              </Button>
              <button
                onClick={() => { w.setFetchRetryCount(0); w.saveField("wizardMode", ""); w.setWizardStep("endpoint"); }}
                className="flex-1 px-3 py-2 rounded-xl text-xs font-medium transition-all"
                style={{ backgroundColor: colors.warningBg, border: "1px solid rgba(245, 158, 11, 0.3)", color: "var(--color-warning-500)" }}
              >
                {t('buttons.confirm_reinstall')}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2 justify-center">
            <Button variant="ghost" size="sm" onClick={() => w.setWizardStep(w.isFetchMode ? "server" : "endpoint")}>
              {w.isFetchMode ? t('buttons.back') : t('wizard.error.back_to_settings')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={w.isFetchMode ? () => w.handleFetchConfig() : w.handleDeploy}
            >
              {t('buttons.retry')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
