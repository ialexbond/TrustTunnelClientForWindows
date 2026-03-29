import { useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { Server, Plug, Key, FileKey, Lock } from "lucide-react";
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
      <div className="flex-1 flex items-center justify-center py-8">
        <div className="w-full max-w-md">
          {/* Header */}
          <div className="text-center mb-6">
            <div
              className="w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-3"
              style={{ backgroundColor: "rgba(99, 102, 241, 0.15)" }}
            >
              <Server className="w-6 h-6" style={{ color: "var(--color-accent-400)" }} />
            </div>
            <h2 className="text-lg font-bold mb-1" style={{ color: "var(--color-text-primary)" }}>
              {t('wizard.server.title')}
            </h2>
            <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
              {t('wizard.server.description')}
            </p>
          </div>

          {/* Form card */}
          <div
            className="rounded-[var(--radius-xl)] p-5 space-y-4"
            style={{ backgroundColor: "var(--color-bg-surface)", border: "1px solid var(--color-border)" }}
          >
            {/* Host + Port */}
            <div className="flex gap-3 items-end">
              <div className="flex-1">
                <Input
                  label={t('labels.server_ip')}
                  value={w.host}
                  onChange={(e) => w.setHost(e.target.value)}
                  placeholder="123.45.67.89"
                  autoFocus
                />
              </div>
              <div className="w-20">
                <Input
                  label={t('labels.port')}
                  value={w.port}
                  onChange={(e) => w.setPort(e.target.value.replace(/\D/g, ""))}
                  placeholder="22"
                />
              </div>
            </div>

            {/* Username */}
            <Input
              label={t('labels.username')}
              value={w.sshUser}
              onChange={(e) => w.setSshUser(e.target.value)}
              placeholder="root"
            />

            {/* Auth mode toggle */}
            <div>
              <label className="block text-xs font-medium mb-2" style={{ color: "var(--color-text-secondary)" }}>
                {t("control.auth_method")}
              </label>
              <div className="grid grid-cols-2 gap-1.5">
                <Button
                  variant={authMode === "password" ? "primary" : "secondary"}
                  size="sm"
                  icon={<Key className="w-3.5 h-3.5" />}
                  onClick={() => setAuthMode("password")}
                >
                  {t("control.auth_password")}
                </Button>
                <Button
                  variant={authMode === "key" ? "primary" : "secondary"}
                  size="sm"
                  icon={<FileKey className="w-3.5 h-3.5" />}
                  onClick={() => setAuthMode("key")}
                >
                  {t("control.auth_key")}
                </Button>
              </div>
            </div>

            {/* Password or Key selector */}
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
                    className="flex-1 flex items-center px-3 h-8 rounded-[var(--radius-lg)] text-sm truncate cursor-pointer"
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

            {/* Action buttons */}
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

            {/* Security note */}
            <div className="flex items-center justify-center gap-1.5">
              <Lock className="w-3 h-3" style={{ color: "var(--color-text-muted)" }} />
              <span className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>
                {t("control.remember")}
              </span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
