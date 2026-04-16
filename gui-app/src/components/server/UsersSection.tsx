import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { cn } from "../../shared/lib/cn";
import { save } from "@tauri-apps/plugin-dialog";
import {
  Users,
  UserPlus,
  ChevronRight,
  Loader2,
  X,
  Shuffle,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { Card, CardHeader } from "../../shared/ui/Card";
import { Button } from "../../shared/ui/Button";
import { ActionInput } from "../../shared/ui/ActionInput";
import { ActionPasswordInput } from "../../shared/ui/ActionPasswordInput";
import { useConfirm } from "../../shared/ui/useConfirm";
import { Modal } from "../../shared/ui/Modal";
import { OverflowMenu } from "../../shared/ui/OverflowMenu";
import { formatError } from "../../shared/utils/formatError";
import { Tooltip } from "../../shared/ui/Tooltip";
import { generateUsername, generatePassword } from "../../shared/utils/credentialGenerator";
import type { ServerState } from "./useServerState";

interface Props {
  state: ServerState;
}

export function UsersSection({ state }: Props) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const {
    serverInfo,
    selectedUser,
    setSelectedUser,
    newUsername,
    setNewUsername,
    newPassword,
    setNewPassword,
    exportingUser,
    setExportingUser,
    setDeleteLoading,
    continueLoading,
    setContinueLoading,
    actionLoading,
    sshParams,
    usernameError,
    onConfigExported,
    setActionResult,
  } = state;

  const isAdding = !!actionLoading?.startsWith("add_user");

  // QR popup state
  const [qrUser, setQrUser] = useState<string | null>(null);
  const [qrLink, setQrLink] = useState("");
  const [qrLoading, setQrLoading] = useState(false);

  // Link copy loading per user
  const [linkLoadingUser, setLinkLoadingUser] = useState<string | null>(null);

  if (!serverInfo) return null;

  // ── Generate deeplink for a user ──
  const getDeeplink = async (username: string): Promise<string> => {
    return invoke<string>("server_export_config_deeplink", {
      ...sshParams,
      clientName: username,
    });
  };

  // ── QR: show fullscreen popup ──
  const handleShowQR = async (username: string) => {
    setQrUser(username);
    setQrLink("");
    setQrLoading(true);
    try {
      const link = await getDeeplink(username);
      setQrLink(link);
    } catch (e) {
      setActionResult({ type: "error", message: formatError(e) });
      setQrUser(null);
    } finally {
      setQrLoading(false);
    }
  };

  // ── Link: copy to clipboard ──
  const handleCopyLink = async (username: string) => {
    setLinkLoadingUser(username);
    try {
      const link = await getDeeplink(username);
      await navigator.clipboard.writeText(link);
      state.pushSuccess(t("server.users.link_copied"));
    } catch (e) {
      setActionResult({ type: "error", message: formatError(e) });
    } finally {
      setLinkLoadingUser(null);
    }
  };

  // ── Download config (save to file dialog) ──
  const handleDownloadConfig = async (username: string) => {
    setExportingUser(username);
    try {
      const path = await invoke<string>("fetch_server_config", {
        ...sshParams,
        clientName: username,
      });
      const dest = await save({
        defaultPath: `trusttunnel_${username}.toml`,
        filters: [{ name: "TOML Config", extensions: ["toml"] }],
      });
      if (dest) {
        try {
          await invoke("copy_file", { source: path, destination: dest });
          state.pushSuccess(t("server.users.config_saved", { user: username }));
        } catch {
          state.pushSuccess(t("server.users.config_saved", { user: username }));
        }
      }
    } catch (e) {
      setActionResult({ type: "error", message: t("server.users.config_export_error", { error: formatError(e) }) });
    } finally {
      setExportingUser(null);
    }
  };

  // ── Continue as user ──
  const handleContinueAsUser = async () => {
    if (!selectedUser) return;
    setContinueLoading(true);
    try {
      const path = await invoke<string>("fetch_server_config", {
        ...sshParams,
        clientName: selectedUser,
      });
      onConfigExported(path);
    } catch (e) {
      setActionResult({ type: "error", message: formatError(e) });
    } finally {
      setContinueLoading(false);
    }
  };

  const { addUserToState, removeUserFromState, setActionLoading } = state;

  // ── Delete user ──
  const handleDeleteUser = async (user: string) => {
    const ok = await confirm({
      title: t("server.users.confirm_delete_title"),
      message: t("server.users.confirm_delete_message", { user }),
      variant: "danger",
      confirmText: t("buttons.confirm_delete"),
      cancelText: t("buttons.cancel"),
    });
    if (!ok) return;
    setDeleteLoading(true);
    try {
      await invoke("server_remove_user", {
        ...sshParams,
        vpnUsername: user,
      });
      removeUserFromState(user);
      state.pushSuccess(t("server.users.user_deleted", { user }));
    } catch (e) {
      setActionResult({ type: "error", message: formatError(e) });
    } finally {
      setDeleteLoading(false);
    }
  };

  // ── Add user ──
  const handleAddUser = async () => {
    if (!newUsername.trim() || !newPassword.trim() || usernameError) return;
    const username = newUsername.trim();
    const password = newPassword.trim();
    setActionLoading("add_user");
    try {
      await invoke("add_server_user", {
        ...sshParams,
        vpnUsername: username,
        vpnPassword: password,
      });
      addUserToState(username);
      setNewUsername("");
      setNewPassword("");
      state.pushSuccess(t("server.users.user_added", { user: username }));
    } catch (e) {
      setActionResult({ type: "error", message: formatError(e) });
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <>
      <Card>
        <CardHeader
          title={t("server.users.title")}
          icon={<Users className="w-3.5 h-3.5" />}
        />

        {/* User list */}
        <div className="mb-3">
          {serverInfo.users.map((u, idx) => {
            const isSelected = selectedUser === u;
            const isLast = idx === serverInfo.users.length - 1;
            return (
              <div key={u}>
                <div
                  onClick={() => setSelectedUser(u)}
                  className={cn(
                    "flex items-center justify-between px-3 py-2 rounded-[var(--radius-md)] transition-all duration-200 cursor-pointer",
                    isSelected
                      ? "bg-[var(--color-accent-tint-08)]"
                      : "hover:bg-[var(--color-bg-hover)]"
                  )}
                >
                  <div className="flex items-center gap-2.5">
                    <div
                      className="w-4 h-4 rounded-full flex items-center justify-center shrink-0"
                      style={{ border: `2px solid ${isSelected ? "var(--color-accent-500)" : "var(--color-border)"}` }}
                    >
                      {isSelected && (
                        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: "var(--color-accent-500)" }} />
                      )}
                    </div>
                    <span className="text-xs" style={{ color: "var(--color-text-primary)" }}>{u}</span>
                  </div>
                  <div onClick={(e) => e.stopPropagation()}>
                    <OverflowMenu
                      triggerAriaLabel={t("users.actions_menu")}
                      items={[
                        { label: t("server.users.qr_tooltip"), onSelect: () => handleShowQR(u), loading: qrLoading && qrUser === u },
                        { label: t("server.users.link_tooltip"), onSelect: () => handleCopyLink(u), loading: linkLoadingUser === u },
                        { label: t("server.users.export_tooltip"), onSelect: () => handleDownloadConfig(u), loading: exportingUser === u },
                        { label: t("server.users.delete_tooltip"), onSelect: () => { void handleDeleteUser(u); }, destructive: true, disabled: serverInfo.users.length <= 1 },
                      ]}
                    />
                  </div>
                </div>
                {!isLast && <div className="mx-3 my-1" style={{ borderBottom: "1px solid var(--color-border)" }} />}
              </div>
            );
          })}
          {serverInfo.users.length === 0 && (
            <p className="text-xs text-center py-2" style={{ color: "var(--color-text-muted)" }}>
              {t("server.users.no_users")}
            </p>
          )}
        </div>

        {/* Connect as user button */}
        {serverInfo.users.length > 0 && (
          <div className="mb-3">
            <Button
              variant={selectedUser ? "primary" : "ghost"}
              fullWidth
              icon={continueLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ChevronRight className="w-3.5 h-3.5" />}
              loading={continueLoading}
              disabled={!selectedUser}
              onClick={handleContinueAsUser}
            >
              {selectedUser ? t("server.users.continue_as", { user: selectedUser }) : t("server.users.select_user")}
            </Button>
          </div>
        )}

        {/* Add user form */}
        <div className="space-y-1.5">
          <div className="flex gap-1.5">
            <div className="flex-1">
              <ActionInput
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value.replace(/[^a-zA-Z0-9._-]/g, ""))}
                placeholder={t("server.users.username_placeholder")}
                error={usernameError ? t(usernameError) : undefined}
                disabled={isAdding}
                actions={[
                  <Tooltip key="gen" text={t("common.generate_username")}>
                    <button
                      type="button"
                      onClick={() => setNewUsername(generateUsername())}
                      disabled={isAdding}
                      className="transition-colors hover:opacity-70 disabled:opacity-30 disabled:cursor-not-allowed"
                      style={{ color: "var(--color-text-muted)" }}
                    >
                      <Shuffle className="w-3.5 h-3.5" />
                    </button>
                  </Tooltip>,
                ]}
              />
            </div>
            <div className="flex-1">
              <ActionPasswordInput
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value.replace(/[^a-zA-Z0-9!@#$%^&*()_+\-=[\]{};':"|,./<>?`~\\]/g, ""))}
                placeholder={t("server.users.password_placeholder")}
                disabled={isAdding}
                showLockIcon={false}
                actions={[
                  <Tooltip key="gen" text={t("common.generate_password")}>
                    <button
                      type="button"
                      onClick={() => setNewPassword(generatePassword())}
                      disabled={isAdding}
                      className="transition-colors hover:opacity-70 disabled:opacity-30 disabled:cursor-not-allowed"
                      style={{ color: "var(--color-text-muted)" }}
                    >
                      <Shuffle className="w-3.5 h-3.5" />
                    </button>
                  </Tooltip>,
                ]}
              />
            </div>
            <Button
              variant="primary"
              size="sm"
              icon={<UserPlus className="w-3.5 h-3.5" />}
              loading={isAdding}
              disabled={!newUsername.trim() || !newPassword.trim() || !!usernameError}
              onClick={handleAddUser}
              className="shrink-0"
            >
              {t("server.users.add_user")}
            </Button>
          </div>
        </div>
      </Card>

      {/* QR Code fullscreen popup */}
      <Modal isOpen={!!qrUser} onClose={() => setQrUser(null)} closeOnBackdrop>
        <div
          className="max-w-xs w-full mx-4 p-6 rounded-2xl shadow-2xl text-center"
          style={{ backgroundColor: "var(--color-bg-elevated)" }}
        >
          {qrLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-8 h-8 animate-spin" style={{ color: "var(--color-accent-500)" }} />
            </div>
          ) : qrLink ? (
            <>
              <div className="flex justify-center mb-4">
                <QRCodeSVG
                  value={qrLink}
                  size={200}
                  bgColor="transparent"
                  fgColor="currentColor"
                  level="M"
                  style={{ color: "var(--color-text-primary)", opacity: 0.85 }}
                />
              </div>
              <p className="text-xs mb-1" style={{ color: "var(--color-text-primary)" }}>{qrUser}</p>
              <p className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>
                {t("server.export.scan_qr")}
              </p>
            </>
          ) : null}
          <button
            onClick={() => setQrUser(null)}
            className="absolute top-3 right-3 p-1 rounded-full transition-opacity hover:opacity-70"
            style={{ color: "var(--color-text-muted)" }}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </Modal>

    </>
  );
}
