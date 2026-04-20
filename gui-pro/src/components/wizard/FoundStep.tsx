import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  User, Download, XCircle, Server, ChevronRight,
  PackageCheck, FolderOpen, RefreshCw, Trash2,
  QrCode, Link2,
} from "lucide-react";
import { Button } from "../../shared/ui/Button";
import { useConfirm } from "../../shared/ui/useConfirm";
import { translateSshError } from "../../shared/utils/translateSshError";
import { IconButton } from "../../shared/ui/IconButton";
import { useSnackBar } from "../../shared/ui/SnackBarContext";
import { UserQRModal } from "./UserQRModal";
import { AddUserForm } from "./AddUserForm";
import { StepBar } from "./StepBar";
import type { WizardState } from "./useWizardState";

// ─── Fetch mode: show users only, save config ──────────────
function FoundFetchMode(w: WizardState & { pushSuccess: (msg: string) => void }) {
  const { t } = useTranslation();
  const isInstalled = w.serverInfo?.installed;
  const users = w.serverInfo?.users || [];

  if (isInstalled && users.length > 0) {
    return (
      <>
        <div className="mx-auto w-14 h-14 rounded-2xl flex items-center justify-center" style={{ backgroundColor: "var(--color-status-connected-bg)" }}>
          <User className="w-7 h-7" style={{ color: "var(--color-success-500)" }} />
        </div>
        <div className="space-y-1.5">
          <h2 className="text-lg font-bold">{t('wizard.found.users_on_server')}</h2>
          <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
            {t('wizard.found.select_user_for_config')}
          </p>
        </div>

        <div className="text-left space-y-1 p-3 rounded-xl" style={{ backgroundColor: "var(--color-bg-surface)", border: "1px solid var(--color-border)" }}>
          {users.map((u) => (
            <div key={u} className="flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg transition-colors cursor-default"
              style={{ backgroundColor: "transparent" }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--color-bg-hover)"}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
            >
              <span className="text-sm font-mono" style={{ color: "var(--color-text-primary)" }}>{u}</span>
              <Button
                variant="primary"
                size="sm"
                onClick={async () => { await w.handleSaveConfigDirect(u); w.pushSuccess(t("wizard.config_saved", "Конфиг сохранён")); }}
                disabled={!!w.savingConfigFor}
                loading={w.savingConfigFor === u}
                icon={<Download className="w-3 h-3" />}
              >
                {w.savingConfigFor === u ? t('wizard.found.saving_config') : t('wizard.found.save_config')}
              </Button>
            </div>
          ))}
        </div>

        {w.errorMessage && (
          <p className="text-xs" style={{ color: "var(--color-danger-500)" }}>{translateSshError(w.errorMessage, t)}</p>
        )}

        <Button variant="ghost" size="sm" fullWidth onClick={() => w.setWizardStep("welcome")}>
          {t('wizard.found.to_home')}
        </Button>
      </>
    );
  }

  if (isInstalled && users.length === 0) {
    return (
      <>
        <div className="mx-auto w-14 h-14 rounded-2xl flex items-center justify-center" style={{ backgroundColor: "var(--color-status-connecting-bg)" }}>
          <User className="w-7 h-7" style={{ color: "var(--color-warning-500)" }} />
        </div>
        <div className="space-y-1.5">
          <h2 className="text-lg font-bold">{t('wizard.found.no_users_title')}</h2>
          <p className="text-xs" style={{ color: "var(--color-text-secondary)" }}>
            {t('wizard.found.no_users_description')}
          </p>
        </div>
        <div className="flex gap-2 w-full">
          <Button variant="ghost" size="sm" onClick={() => w.setWizardStep("server")}>
            {t('buttons.back')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            className="flex-1"
            icon={<ChevronRight className="w-4 h-4" />}
            onClick={() => { w.saveField("wizardMode", ""); w.setWizardStep("server"); }}
          >
            {t('wizard.found.setup_server')}
          </Button>
        </div>
      </>
    );
  }

  // Not installed or error in fetch mode
  return (
    <>
      <div className="mx-auto w-14 h-14 rounded-2xl flex items-center justify-center" style={{ backgroundColor: "var(--color-status-error-bg)" }}>
        <XCircle className="w-7 h-7" style={{ color: "var(--color-danger-500)" }} />
      </div>
      <div className="space-y-1.5">
        <h2 className="text-lg font-bold" style={{ color: "var(--color-danger-500)" }}>
          {w.checkError ? t('wizard.found.server_unreachable') : t('wizard.found.not_installed_title')}
        </h2>
        <p className="text-xs" style={{ color: "var(--color-text-secondary)" }}>
          {w.checkError
            ? t('wizard.found.ssh_error_fetch_description')
            : t('wizard.found.not_installed_fetch_description')}
        </p>
        {w.checkError && (
          <div className="max-h-20 overflow-y-auto rounded-lg p-2 mt-2" style={{ backgroundColor: "var(--color-bg-elevated)" }}>
            <p className="text-xs leading-relaxed select-text cursor-text break-words" style={{ color: "var(--color-danger-500)", opacity: 0.8 }}>
              {translateSshError(w.checkError, t)}
            </p>
          </div>
        )}
      </div>
      <div className="flex gap-2 w-full">
        <Button variant="ghost" size="sm" onClick={() => w.setWizardStep("server")}>
          {t('buttons.back')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          className="flex-1"
          icon={<ChevronRight className="w-4 h-4" />}
          onClick={() => { w.saveField("wizardMode", ""); w.setWizardStep("server"); }}
        >
          {t('wizard.found.setup_server')}
        </Button>
      </div>
    </>
  );
}

// ─── Setup mode: TT installed or not ──────────────
function FoundSetupMode(w: WizardState & { pushSuccess: (msg: string) => void }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const isInstalled = w.serverInfo?.installed;

  // QR popup state
  const [qrUser, setQrUser] = useState<string | null>(null);
  const [qrLink, setQrLink] = useState("");
  const [qrLoading, setQrLoading] = useState(false);
  const [linkLoadingUser, setLinkLoadingUser] = useState<string | null>(null);

  const handleDeleteUserPrompt = async (u: string) => {
    const ok = await confirm({
      title: t("wizard.found.confirm_delete_title"),
      message: t("wizard.found.confirm_delete_message", { user: u }),
      variant: "danger",
      confirmText: t("buttons.confirm_delete"),
      cancelText: t("buttons.cancel"),
    });
    if (!ok) return;
    await w.handleDeleteUser(u);
    w.pushSuccess(t("wizard.user_deleted", "Пользователь удалён"));
  };

  const handleUninstallPrompt = async () => {
    const ok = await confirm({
      title: t("wizard.found.confirm_uninstall_title"),
      message: t("wizard.found.uninstall_consequences"),
      variant: "danger",
      confirmText: t("buttons.confirm_delete"),
      cancelText: t("buttons.cancel"),
    });
    if (!ok) return;
    w.handleUninstall();
  };

  const sshParams = {
    host: w.host,
    port: parseInt(w.port),
    user: w.sshUser,
    password: w.sshPassword,
    keyPath: w.sshKeyPath || undefined,
  };

  const getDeeplink = async (username: string): Promise<string> => {
    return invoke<string>("server_export_config_deeplink", { ...sshParams, clientName: username });
  };

  const handleShowQR = async (username: string) => {
    setQrUser(username);
    setQrLink("");
    setQrLoading(true);
    try {
      const link = await getDeeplink(username);
      setQrLink(link);
    } catch { setQrUser(null); }
    finally { setQrLoading(false); }
  };

  const handleCopyLink = async (username: string) => {
    setLinkLoadingUser(username);
    try {
      const link = await getDeeplink(username);
      await navigator.clipboard.writeText(link);
      w.pushSuccess(t("wizard.link_copied", "Скопировано"));
    } catch { /* ignore */ }
    finally { setLinkLoadingUser(null); }
  };

  if (isInstalled) {
    const users = w.serverInfo?.users ?? [];
    return (
      <>
        <div className="mx-auto w-14 h-14 rounded-2xl flex items-center justify-center" style={{ backgroundColor: "var(--color-status-connecting-bg)" }}>
          <PackageCheck className="w-7 h-7" style={{ color: "var(--color-warning-500)" }} />
        </div>
        <div className="space-y-1.5">
          <h2 className="text-lg font-bold" style={{ color: "var(--color-warning-500)" }}>
            {t('wizard.found.already_installed')}
          </h2>
          {w.serverInfo?.version && (
            <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
              {t('wizard.found.version_label', { version: w.serverInfo.version })}
            </p>
          )}
          <p className="text-xs" style={{ color: "var(--color-text-secondary)" }}>
            {t('wizard.found.service_label')} {w.serverInfo?.serviceActive ? (
              <span style={{ color: "var(--color-success-500)" }}>{t('wizard.found.service_running')}</span>
            ) : (
              <span style={{ color: "var(--color-text-muted)" }}>{t('wizard.found.service_stopped')}</span>
            )}
          </p>
        </div>

        {/* ── Users (same layout as UsersSection in dashboard) ── */}
        {users.length > 0 && (
          <div className="text-left space-y-2 p-3 rounded-xl" style={{ backgroundColor: "var(--color-bg-surface)", border: "1px solid var(--color-border)" }}>
            <p className="text-xs font-semibold flex items-center gap-1.5" style={{ color: "var(--color-text-primary)" }}>
              <User className="w-3.5 h-3.5" />
              {t('wizard.found.added_users')}
            </p>
            <div>
              {users.map((u, idx) => {
                const isSelected = w.selectedUser === u;
                const isLast = idx === users.length - 1;
                return (
                  <div key={u}>
                    <div
                      onClick={() => w.setSelectedUser(u)}
                      className="flex items-center justify-between px-3 py-2 rounded-[var(--radius-md)] transition-all duration-200 cursor-pointer"
                      style={{ backgroundColor: isSelected ? "var(--color-accent-tint-08)" : "transparent" }}
                      onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.backgroundColor = "var(--color-bg-hover)"; }}
                      onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.backgroundColor = "transparent"; }}
                    >
                      <div className="flex items-center gap-2.5">
                        <div className="w-4 h-4 rounded-full flex items-center justify-center shrink-0"
                          style={{ border: `2px solid ${isSelected ? "var(--color-accent-500)" : "var(--color-border)"}` }}
                        >
                          {isSelected && <div className="w-2 h-2 rounded-full" style={{ backgroundColor: "var(--color-accent-500)" }} />}
                        </div>
                        <span className="text-xs font-medium font-mono" style={{ color: "var(--color-text-primary)" }}>{u}</span>
                      </div>
                      <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                        <IconButton aria-label={t("server.users.qr_tooltip")} tooltip={t("server.users.qr_tooltip")} onClick={() => handleShowQR(u)} loading={qrLoading && qrUser === u}>
                          <QrCode className="w-3.5 h-3.5" />
                        </IconButton>
                        <IconButton aria-label={t("server.users.link_tooltip")} tooltip={t("server.users.link_tooltip")} onClick={() => handleCopyLink(u)} loading={linkLoadingUser === u}>
                          <Link2 className="w-3.5 h-3.5" />
                        </IconButton>
                        <IconButton aria-label={t("server.users.export_tooltip")} tooltip={t("server.users.export_tooltip")} onClick={async () => { await w.handleSaveConfigDirect(u); w.pushSuccess(t("wizard.config_saved", "Конфиг сохранён")); }} loading={w.savingConfigFor === u}>
                          <Download className="w-3.5 h-3.5" />
                        </IconButton>
                        <IconButton
                          aria-label={users.length <= 1 ? t("server.users.cant_delete_last") : t("server.users.delete_tooltip")}
                          tooltip={users.length <= 1 ? t("server.users.cant_delete_last") : t("server.users.delete_tooltip")}
                          onClick={() => { void handleDeleteUserPrompt(u); }}
                          disabled={users.length <= 1 || !!w.deletingUser}
                          loading={w.deletingUser === u}
                          color="var(--color-danger-400)"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </IconButton>
                      </div>
                    </div>
                    {!isLast && <div className="mx-3 my-1" style={{ borderBottom: "1px solid var(--color-border)" }} />}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* QR Code popup */}
        <UserQRModal qrUser={qrUser} qrLink={qrLink} qrLoading={qrLoading} onClose={() => setQrUser(null)} />

        {/* ── Add new user ── */}
        <AddUserForm w={w} onUserAdded={() => w.pushSuccess(t("wizard.user_added", "Пользователь добавлен"))} />

        {/* Continue as user button */}
        <Button
          variant={w.selectedUser ? "primary" : "secondary"}
          size="sm"
          fullWidth
          onClick={() => { if (w.selectedUser) w.handleFetchConfig(w.selectedUser); }}
          disabled={!w.selectedUser}
          icon={<ChevronRight className="w-4 h-4" />}
        >
          {w.selectedUser ? t('wizard.found.continue_as', { user: w.selectedUser }) : t('wizard.found.select_user_prompt')}
        </Button>

        <div className="space-y-2 pt-1">
          <Button variant="secondary" size="sm" fullWidth icon={<FolderOpen className="w-4 h-4" />} onClick={w.handleSkip}>
            {t('wizard.found.skip_have_config')}
          </Button>
          <Button variant="secondary" size="sm" fullWidth icon={<RefreshCw className="w-3.5 h-3.5" />} onClick={() => { w.setCameFromFound(true); w.setWizardStep("endpoint"); }}>
            {t('wizard.found.reinstall_tt')}
          </Button>
          <Button variant="danger-outline" size="sm" fullWidth icon={<Trash2 className="w-3.5 h-3.5" />} onClick={handleUninstallPrompt}>
            {t('wizard.found.delete_tt')}
          </Button>
        </div>
      </>
    );
  }

  // Host key was reset — show success message and back button
  if (w.checkError === "HOST_KEY_RESET") {
    return (
      <>
        <div className="mx-auto w-14 h-14 rounded-2xl flex items-center justify-center" style={{ backgroundColor: "var(--color-accent-tint-10)" }}>
          <Server className="w-7 h-7" style={{ color: "var(--color-accent-500)" }} />
        </div>
        <div className="space-y-1.5">
          <h2 className="text-lg font-bold" style={{ color: "var(--color-text-primary)" }}>{t('sshErrors.hostKeyReset', 'Host key was reset. Press Connect again.')}</h2>
          <p className="text-xs" style={{ color: "var(--color-text-secondary)" }}>
            {t('wizard.found.host_key_reset_help')}
          </p>
        </div>
        <Button variant="ghost" size="sm" fullWidth onClick={() => w.setWizardStep("server")}>
          {t('buttons.back')}
        </Button>
      </>
    );
  }

  // Not installed
  if (w.checkError) {
    return (
      <>
        <div className="mx-auto w-14 h-14 rounded-2xl flex items-center justify-center" style={{ backgroundColor: "var(--color-status-error-bg)" }}>
          <XCircle className="w-7 h-7" style={{ color: "var(--color-danger-500)" }} />
        </div>
        <div className="space-y-1.5">
          <h2 className="text-lg font-bold" style={{ color: "var(--color-danger-500)" }}>{t('wizard.found.server_unreachable')}</h2>
          <p className="text-xs" style={{ color: "var(--color-text-secondary)" }}>
            {t('wizard.found.connection_error_help')}
          </p>
          <div className="max-h-20 overflow-y-auto rounded-lg p-2 mt-2" style={{ backgroundColor: "var(--color-bg-elevated)" }}>
            <p className="text-xs leading-relaxed select-text cursor-text break-words" style={{ color: "var(--color-danger-500)", opacity: 0.8 }}>
              {translateSshError(w.checkError, t)}
            </p>
          </div>
        </div>
        <Button variant="ghost" size="sm" fullWidth onClick={() => w.setWizardStep("server")}>
          {t('buttons.back')}
        </Button>
      </>
    );
  }

  // Server ready, TT not installed
  return (
    <>
      <div className="mx-auto w-14 h-14 rounded-2xl flex items-center justify-center" style={{ backgroundColor: "var(--color-accent-tint-10)" }}>
        <Server className="w-7 h-7" style={{ color: "var(--color-accent-500)" }} />
      </div>
      <div className="space-y-1.5">
        <h2 className="text-lg font-bold">{t('wizard.found.server_ready')}</h2>
        <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
          {t('wizard.found.not_found_can_install')}
        </p>
      </div>
      <div className="flex gap-2 w-full">
        <Button variant="ghost" size="sm" onClick={() => w.setWizardStep("server")}>
          {t('buttons.back')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          className="flex-1"
          icon={<ChevronRight className="w-4 h-4" />}
          onClick={() => w.setWizardStep("endpoint")}
        >
          {t('wizard.found.continue_setup')}
        </Button>
      </div>
    </>
  );
}

// ─── Main FoundStep ──────────────
export function FoundStep(w: WizardState) {
  const { t } = useTranslation();
  const isInstalled = w.serverInfo?.installed;
  const pushSuccess = useSnackBar();

  return (
    <>
      <StepBar step={w.step} isFetchMode={w.isFetchMode} />
      <div className="flex-1 flex items-center justify-center p-6 overflow-y-auto">
        <div className="max-w-sm w-full text-center space-y-5 my-auto">
          {w.isFetchMode ? (
            <FoundFetchMode {...w} pushSuccess={pushSuccess} />
          ) : (
            <>
              <FoundSetupMode {...w} pushSuccess={pushSuccess} />
              {isInstalled && (
                <Button variant="ghost" size="sm" fullWidth onClick={() => w.setWizardStep("server")}>
                  {t('buttons.back')}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
