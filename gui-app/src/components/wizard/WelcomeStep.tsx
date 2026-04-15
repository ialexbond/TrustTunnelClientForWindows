import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Shield, Server, Download, FileText, Info } from "lucide-react";
import { Card } from "../../shared/ui/Card";
import { ImportConfigModal } from "./ImportConfigModal";
import type { WizardState } from "./useWizardState";

export function WelcomeStep({ setWizardStep, handleSkip: _handleSkip, saveField, onSetupComplete }: WizardState) {
  const [importOpen, setImportOpen] = useState(false);
  const { t } = useTranslation();

  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <div className="max-w-md w-full space-y-6">
        {/* Header */}
        <div className="text-center space-y-3">
          <div
            className="mx-auto w-16 h-16 rounded-2xl flex items-center justify-center relative"
            style={{
              backgroundColor: "var(--color-accent-500)",
              boxShadow: "0 8px 32px rgba(99, 102, 241, 0.3), 0 0 64px rgba(99, 102, 241, 0.15)",
            }}
          >
            <Shield className="w-8 h-8 text-white" />
          </div>
          <div className="space-y-1">
            <h1 className="text-2xl font-bold" style={{ color: "var(--color-text-primary)" }}>
              TrustTunnel VPN
            </h1>
            <p className="text-sm leading-relaxed" style={{ color: "var(--color-text-secondary)" }}>
              {t('wizard.welcome.tagline')}
              <br />
              {t('wizard.welcome.description')}
            </p>
          </div>
        </div>

        {/* Option Cards */}
        <div className="space-y-2.5">
          {/* Card 1: Set Up Server (primary) */}
          <Card
            hover
            padding="md"
            className="cursor-pointer group active:scale-[0.98] transition-all duration-200"
            onClick={() => { saveField("wizardMode", ""); setWizardStep("server"); }}
            style={{
              backgroundColor: "rgba(99, 102, 241, 0.06)",
              borderColor: "rgba(99, 102, 241, 0.2)",
            }}
          >
            <div className="flex items-start gap-3">
              <div
                className="shrink-0 w-9 h-9 rounded-xl flex items-center justify-center mt-0.5"
                style={{ backgroundColor: "var(--color-accent-500)" }}
              >
                <Server className="w-4.5 h-4.5 text-white" />
              </div>
              <div className="min-w-0">
                <h3 className="text-sm font-[var(--font-weight-semibold)]" style={{ color: "var(--color-text-primary)" }}>
                  {t('wizard.welcome.setup_new')}
                </h3>
                <p className="text-xs mt-0.5 leading-relaxed" style={{ color: "var(--color-text-muted)" }}>
                  {t('wizard.welcome.setup_description')}
                </p>
              </div>
            </div>
          </Card>

          {/* Card 2: Fetch Config */}
          <Card
            hover
            padding="md"
            className="cursor-pointer group active:scale-[0.98] transition-all duration-200"
            onClick={() => { saveField("wizardMode", "fetch"); setWizardStep("server"); }}
          >
            <div className="flex items-start gap-3">
              <div
                className="shrink-0 w-9 h-9 rounded-xl flex items-center justify-center mt-0.5"
                style={{ backgroundColor: "rgba(99, 102, 241, 0.1)" }}
              >
                <Download className="w-4.5 h-4.5" style={{ color: "var(--color-accent-500)" }} />
              </div>
              <div className="min-w-0">
                <h3 className="text-sm font-[var(--font-weight-semibold)]" style={{ color: "var(--color-text-primary)" }}>
                  {t('wizard.welcome.fetch_config')}
                </h3>
                <p className="text-xs mt-0.5 leading-relaxed" style={{ color: "var(--color-text-muted)" }}>
                  {t('wizard.welcome.fetch_description')}
                </p>
              </div>
            </div>
          </Card>

          {/* Card 3: Import Config */}
          <Card
            hover
            padding="md"
            className="cursor-pointer group active:scale-[0.98] transition-all duration-200"
            onClick={() => setImportOpen(true)}
          >
            <div className="flex items-start gap-3">
              <div
                className="shrink-0 w-9 h-9 rounded-xl flex items-center justify-center mt-0.5"
                style={{ backgroundColor: "var(--color-bg-hover)" }}
              >
                <FileText className="w-4.5 h-4.5" style={{ color: "var(--color-text-secondary)" }} />
              </div>
              <div className="min-w-0">
                <h3 className="text-sm font-[var(--font-weight-semibold)]" style={{ color: "var(--color-text-primary)" }}>
                  {t('wizard.welcome.import_config')}
                </h3>
                <p className="text-xs mt-0.5 leading-relaxed" style={{ color: "var(--color-text-muted)" }}>
                  {t('wizard.welcome.import_description')}
                </p>
              </div>
            </div>
          </Card>

          <ImportConfigModal
            open={importOpen}
            onClose={() => setImportOpen(false)}
            onImported={(path) => onSetupComplete(path)}
          />
        </div>

        {/* Requirements info banner */}
        <div
          className="flex gap-2 rounded-xl px-3.5 py-3"
          style={{
            backgroundColor: "var(--color-bg-hover)",
            border: "1px solid var(--color-border)",
          }}
        >
          <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: "var(--color-text-muted)" }} />
          <div className="space-y-0.5">
            <p className="text-[11px] font-medium" style={{ color: "var(--color-text-muted)" }}>
              {t('wizard.welcome.requirements_header')}
            </p>
            <p className="text-[11px]" style={{ color: "var(--color-text-muted)" }}>
              {t('wizard.welcome.requirement_linux')}
            </p>
            <p className="text-[11px]" style={{ color: "var(--color-text-muted)" }}>
              {t('wizard.welcome.requirement_resources')}
            </p>
            <p className="text-[11px]" style={{ color: "var(--color-text-muted)" }}>
              {t('wizard.welcome.requirement_root_domain')}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
