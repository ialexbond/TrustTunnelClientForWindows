import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  User, XCircle, Server, ChevronRight,
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

// FoundStep — re-skinned onto the v3.0 onboarding hero language (D-05; UI-SPEC
// "Found" row + §Accessibility). This is the largest wizard screen (user list +
// choice rows). The migration is PRESENTATION-ONLY: every branch keeps the same
// handlers it already called — only the visual shell + the icon-only-control
// aria-labels change.
//
// Hero squares: the old 56px (`w-14 h-14`) squares become the 64px (`w-16 h-16`)
// onboarding square + a 32px (`w-8 h-8`) glyph; headings move from `text-lg
// font-bold` to the `.text-display-sm`/`.text-title-sm` token classes (token color
// classes, no inline `style` for color). The icon-only `IconButton` user-row actions
// keep their handlers but gain explicit `aria-label`s naming the action AND its
// target (UI-SPEC §A11y: the row text alone is not a sufficient accessible name for
// an icon-only control). Destructive delete-user / uninstall stay behind
// `useConfirm`/`ConfirmDialog` (PATTERNS §D — never a bare destructive click).

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
    w.pushSuccess(t("server.users.user_deleted", { user: u }));
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

  const getDeeplink = async (username: string): Promise<string> => {
    // D-06: the deeplink/QR export carries SSH creds, so it MUST go through
    // buildAuthArgs() like every other IPC handler — sending authMethod + exactly
    // one credential. The previous hand-rolled sshParams omitted authMethod and
    // sent BOTH password and keyPath, dropping the backend into its legacy
    // both-then-prefer-key heuristic (the exact auth-bleed D-06 closes).
    return invoke<string>("server_export_config_deeplink", {
      host: w.host,
      port: parseInt(w.port),
      user: w.sshUser,
      ...w.buildAuthArgs(),
      clientName: username,
    });
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
      w.pushSuccess(t("server.users.link_copied"));
    } catch { /* ignore */ }
    finally { setLinkLoadingUser(null); }
  };

  if (isInstalled) {
    const users = w.serverInfo?.users ?? [];
    return (
      <>
        <div className="mx-auto w-16 h-16 rounded-[var(--radius-xl)] flex items-center justify-center bg-[var(--color-status-connecting-bg)]">
          <PackageCheck className="w-8 h-8 text-[var(--color-warning-fg)]" />
        </div>
        <div className="space-y-1.5">
          <h2 id="wizard-heading" className="text-display-sm text-[var(--color-warning-fg)]">
            {t('wizard.found.already_installed')}
          </h2>
          {w.serverInfo?.version && (
            <p className="text-body-sm text-[var(--color-text-muted)]">
              {t('wizard.found.version_label', { version: w.serverInfo.version })}
            </p>
          )}
          <p className="text-body-sm text-[var(--color-text-secondary)]">
            {t('wizard.found.service_label')} {w.serverInfo?.serviceActive ? (
              <span className="text-[var(--color-success-fg)]">{t('wizard.found.service_running')}</span>
            ) : (
              <span className="text-[var(--color-text-muted)]">{t('wizard.found.service_stopped')}</span>
            )}
          </p>
        </div>

        {/* ── Users (same layout as UsersSection in dashboard) ── */}
        {users.length > 0 && (
          <div className="text-left space-y-2 p-3 rounded-[var(--radius-lg)] bg-[var(--color-bg-surface)] border border-[var(--color-border)]">
            <p className="text-body-sm font-semibold flex items-center gap-1.5 text-[var(--color-text-primary)]">
              <User className="w-4 h-4" />
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
                      className={`flex items-center justify-between px-3 py-2 rounded-[var(--radius-md)] transition-colors duration-200 cursor-pointer ${isSelected ? "bg-[var(--color-accent-tint-08)]" : "hover:bg-[var(--color-bg-hover)]"}`}
                    >
                      <div className="flex items-center gap-2">
                        <div className={`w-4 h-4 rounded-full flex items-center justify-center shrink-0 border-2 ${isSelected ? "border-[var(--color-accent-fg)]" : "border-[var(--color-border)]"}`}>
                          {isSelected && <div className="w-2 h-2 rounded-full bg-[var(--color-accent-500)]" />}
                        </div>
                        <span className="text-body-sm font-medium font-mono text-[var(--color-text-primary)]">{u}</span>
                      </div>
                      <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                        {/* Icon-only controls: explicit aria-label names action + target
                            (UI-SPEC §A11y). tooltip stays the short generic label. */}
                        <IconButton aria-label={t("wizard.found.qr_aria", { user: u })} tooltip={t("server.users.qr_tooltip")} onClick={() => handleShowQR(u)} loading={qrLoading && qrUser === u}>
                          <QrCode className="w-4 h-4" />
                        </IconButton>
                        <IconButton aria-label={t("wizard.found.link_aria", { user: u })} tooltip={t("server.users.link_tooltip")} onClick={() => handleCopyLink(u)} loading={linkLoadingUser === u}>
                          <Link2 className="w-4 h-4" />
                        </IconButton>
                        {/* 06-uat: the per-user «save config to this PC» action used the
                            fetch flow (handleSaveConfigDirect) that was removed with the
                            wizard SSH/fetch surface. QR + Link export (deeplink) stay. */}
                        <IconButton
                          aria-label={users.length <= 1 ? t("server.users.cant_delete_last") : t("wizard.found.delete_aria", { user: u })}
                          tooltip={users.length <= 1 ? t("server.users.cant_delete_last") : t("server.users.delete_tooltip")}
                          onClick={() => { void handleDeleteUserPrompt(u); }}
                          disabled={users.length <= 1 || !!w.deletingUser}
                          loading={w.deletingUser === u}
                        >
                          <Trash2 className="w-4 h-4" />
                        </IconButton>
                      </div>
                    </div>
                    {!isLast && <div className="mx-3 my-1 border-b border-[var(--color-border)]" />}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* QR Code popup */}
        <UserQRModal qrUser={qrUser} qrLink={qrLink} qrLoading={qrLoading} onClose={() => setQrUser(null)} />

        {/* ── Add new user ── */}
        <AddUserForm w={w} onUserAdded={(username) => w.pushSuccess(t("server.users.user_added", { user: username }))} />

        {/* 06-uat: the «Continue as user» button drove the fetch flow (handleFetchConfig)
            that was removed. Importing an existing user's config to this PC is done via
            the per-user QR/Link export above or «У меня уже есть конфиг» on Connection. */}
        <div className="space-y-2 pt-1">
          <Button variant="secondary" size="sm" fullWidth icon={<FolderOpen className="w-4 h-4" />} onClick={w.handleSkip}>
            {t('wizard.found.skip_have_config')}
          </Button>
          {/* C-05: cameFromFound=true is the carrier the EndpointStep install button
              reads as the consent to overwrite a diverging vpn.toml/hosts.toml on the
              subsequent install (overwriteConfig=cameFromFound). credentials.toml stays
              preserved regardless (D-02). No separate flag — reuse cameFromFound. */}
          <Button variant="secondary" size="sm" fullWidth icon={<RefreshCw className="w-4 h-4" />} onClick={() => { w.setCameFromFound(true); w.setWizardStep("endpoint"); }}>
            {t('wizard.found.reinstall_tt')}
          </Button>
          <Button variant="danger-outline" size="sm" fullWidth icon={<Trash2 className="w-4 h-4" />} onClick={handleUninstallPrompt}>
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
        <div className="mx-auto w-16 h-16 rounded-[var(--radius-xl)] flex items-center justify-center bg-[var(--color-accent-tint-10)]">
          <Server className="w-8 h-8 text-[var(--color-accent-fg)]" />
        </div>
        <div className="space-y-1.5">
          <h2 id="wizard-heading" className="text-display-sm text-[var(--color-text-primary)]">{t('sshErrors.hostKeyReset', 'Host key was reset. Press Connect again.')}</h2>
          <p className="text-body text-[var(--color-text-secondary)]">
            {t('wizard.found.host_key_reset_help')}
          </p>
        </div>
        <Button variant="ghost" size="sm" fullWidth onClick={() => w.onClose?.()}>
          {t('buttons.back')}
        </Button>
      </>
    );
  }

  // Not installed
  if (w.checkError) {
    return (
      <>
        <div className="mx-auto w-16 h-16 rounded-[var(--radius-xl)] flex items-center justify-center bg-[var(--color-status-error-bg)]">
          <XCircle className="w-8 h-8 text-[var(--color-danger-fg)]" />
        </div>
        <div className="space-y-1.5">
          <h2 id="wizard-heading" className="text-display-sm text-[var(--color-danger-fg)]">{t('wizard.found.server_unreachable')}</h2>
          <p className="text-body text-[var(--color-text-secondary)]">
            {t('wizard.found.connection_error_help')}
          </p>
          <div className="max-h-20 overflow-y-auto rounded-[var(--radius-lg)] p-2 mt-2 bg-[var(--color-bg-elevated)]">
            <p className="text-mono-sm leading-relaxed select-text cursor-text break-words text-[var(--color-danger-fg)]">
              {translateSshError(w.checkError, t)}
            </p>
          </div>
        </div>
        <Button variant="ghost" size="sm" fullWidth onClick={() => w.onClose?.()}>
          {t('buttons.back')}
        </Button>
      </>
    );
  }

  // Server ready, TT not installed
  return (
    <>
      <div className="mx-auto w-16 h-16 rounded-[var(--radius-xl)] flex items-center justify-center bg-[var(--color-accent-tint-10)]">
        <Server className="w-8 h-8 text-[var(--color-accent-fg)]" />
      </div>
      <div className="space-y-1.5">
        <h2 id="wizard-heading" className="text-display-sm text-[var(--color-text-primary)]">{t('wizard.found.server_ready')}</h2>
        <p className="text-body text-[var(--color-text-muted)]">
          {t('wizard.found.not_found_can_install')}
        </p>
      </div>
      <div className="flex gap-2 w-full">
        {/* 06-uat: «Назад» closes the wizard overlay — there is no SSH-connect screen to
            return to (SSH auth lives only in the Control Panel). */}
        <Button variant="ghost" size="sm" onClick={() => w.onClose?.()}>
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
      <StepBar step={w.step} />
      <div className="flex-1 flex items-center justify-center p-6 overflow-y-auto">
        <div className="max-w-sm w-full text-center space-y-5 my-auto">
          <FoundSetupMode {...w} pushSuccess={pushSuccess} />
          {isInstalled && (
            // 06-uat: «Назад» closes the wizard overlay (there is no SSH-connect screen
            // to go back to — SSH auth lives only in the Control Panel).
            <Button variant="ghost" size="sm" fullWidth onClick={() => w.onClose?.()}>
              {t('buttons.back')}
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
