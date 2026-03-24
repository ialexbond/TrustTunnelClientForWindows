import { useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { Server, Globe, Hash, User, Plug, Key, FileKey } from "lucide-react";
import { StepBar } from "./StepBar";
import { Input } from "../../shared/ui/Input";
import { PasswordInput } from "../../shared/ui/PasswordInput";
import { Button } from "../../shared/ui/Button";
import type { WizardState } from "./useWizardState";

type AuthMode = "password" | "key";

export function ServerStep(w: WizardState) {
  const { t } = useTranslation();
  const [authMode, setAuthMode] = useState<AuthMode>(w.sshKeyPath ? "key" : "password");

  const handleSelectKey = async () => {
    try {
      const selected = await open({
        title: t("control.select_key_title"),
        filters: [
          { name: "SSH Keys", extensions: ["pem", "key", "ppk", "id_rsa", "id_ed25519", ""] },
          { name: "All Files", extensions: ["*"] },
        ],
        multiple: false,
      });
      if (selected) {
        w.setSshKeyPath(typeof selected === "string" ? selected : selected);
      }
    } catch {
      // user cancelled
    }
  };

  return (
    <>
      <StepBar step={w.step} isFetchMode={w.isFetchMode} />
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-sm w-full space-y-4">
          <div className="text-center space-y-1">
            <div className="mx-auto w-10 h-10 rounded-xl flex items-center justify-center" style={{ backgroundColor: "rgba(99, 102, 241, 0.1)" }}>
              <Server className="w-5 h-5" style={{ color: "var(--color-accent-500)" }} />
            </div>
            <h2 className="text-lg font-bold">{t('wizard.server.title')}</h2>
            <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>{t('wizard.server.description')}</p>
          </div>

          <div className="space-y-3">
            <div className="flex gap-2 items-end">
              <div className="flex-1">
                <Input
                  label={t('wizard.server.server_ip_label')}
                  icon={<Globe className="w-3.5 h-3.5" />}
                  value={w.host}
                  onChange={(e) => w.setHost(e.target.value)}
                  placeholder="123.45.67.89"
                  autoFocus
                />
              </div>
              <div className="w-24">
                <Input
                  label={t('labels.port')}
                  icon={<Hash className="w-3.5 h-3.5" />}
                  value={w.port}
                  onChange={(e) => w.setPort(e.target.value)}
                  placeholder="22"
                />
              </div>
            </div>

            <Input
              label={t('labels.username')}
              icon={<User className="w-3.5 h-3.5" />}
              value={w.sshUser}
              onChange={(e) => w.setSshUser(e.target.value)}
              placeholder="root"
            />

            {/* Auth mode toggle */}
            <div>
              <label className="block text-xs font-medium mb-2" style={{ color: "var(--color-text-secondary)" }}>
                {t("control.auth_method")}
              </label>
              <div className="flex gap-2">
                <button
                  onClick={() => setAuthMode("password")}
                  className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-[var(--radius-md)] text-xs font-medium transition-all duration-200"
                  style={{
                    backgroundColor: authMode === "password" ? "var(--color-accent-500)" : "var(--color-bg-elevated)",
                    color: authMode === "password" ? "white" : "var(--color-text-secondary)",
                    border: `1px solid ${authMode === "password" ? "var(--color-accent-500)" : "var(--color-border)"}`,
                  }}
                >
                  <Key className="w-3.5 h-3.5" />
                  {t("control.auth_password")}
                </button>
                <button
                  onClick={() => setAuthMode("key")}
                  className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-[var(--radius-md)] text-xs font-medium transition-all duration-200"
                  style={{
                    backgroundColor: authMode === "key" ? "var(--color-accent-500)" : "var(--color-bg-elevated)",
                    color: authMode === "key" ? "white" : "var(--color-text-secondary)",
                    border: `1px solid ${authMode === "key" ? "var(--color-accent-500)" : "var(--color-border)"}`,
                  }}
                >
                  <FileKey className="w-3.5 h-3.5" />
                  {t("control.auth_key")}
                </button>
              </div>
            </div>

            {authMode === "password" ? (
              <PasswordInput
                label={t('labels.ssh_password')}
                value={w.sshPassword}
                onChange={(e) => w.setSshPassword(e.target.value)}
                placeholder="••••••••"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && w.canGoToEndpoint) w.handleCheckServer();
                }}
              />
            ) : (
              <div>
                <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--color-text-secondary)" }}>
                  {t("control.key_file")}
                </label>
                <div className="flex gap-2">
                  <div
                    className="flex-1 flex items-center px-3 py-2.5 rounded-[var(--radius-lg)] text-sm truncate cursor-pointer"
                    style={{
                      backgroundColor: "var(--color-input-bg)",
                      border: "1px solid var(--color-input-border)",
                      color: w.sshKeyPath ? "var(--color-text-primary)" : "var(--color-text-muted)",
                    }}
                    onClick={handleSelectKey}
                  >
                    <FileKey className="w-4 h-4 shrink-0 mr-2" style={{ color: "var(--color-text-muted)" }} />
                    <span className="truncate text-xs">
                      {w.sshKeyPath ? w.sshKeyPath.split(/[/\\]/).pop() : t("control.select_key")}
                    </span>
                  </div>
                  <Button variant="secondary" size="sm" onClick={handleSelectKey}>
                    {t("control.browse")}
                  </Button>
                </div>
                {w.sshKeyPath && (
                  <p className="text-[10px] mt-1 truncate" style={{ color: "var(--color-text-muted)" }}>
                    {w.sshKeyPath}
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="flex gap-2 pt-1">
            <Button
              variant="ghost"
              onClick={() => { w.saveField("wizardMode", ""); w.setWizardStep("welcome"); }}
            >
              {t('buttons.back')}
            </Button>
            <Button
              variant="primary"
              fullWidth
              icon={<Plug className="w-4 h-4" />}
              onClick={w.handleCheckServer}
              disabled={!w.canGoToEndpoint}
            >
              {t('wizard.server.check_connection')}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
