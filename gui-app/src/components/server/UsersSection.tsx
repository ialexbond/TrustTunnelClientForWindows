import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  Users,
  UserPlus,
  Trash2,
  Download,
  ChevronRight,
  Loader2,
} from "lucide-react";
import { Card, CardHeader } from "../../shared/ui/Card";
import { Button } from "../../shared/ui/Button";
import { Input } from "../../shared/ui/Input";
import { PasswordInput } from "../../shared/ui/PasswordInput";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { Tooltip } from "../../shared/ui/Tooltip";
import type { ServerState } from "./useServerState";

interface Props {
  state: ServerState;
}

export function UsersSection({ state }: Props) {
  const { t } = useTranslation();
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
    confirmDeleteUser,
    setConfirmDeleteUser,
    deleteLoading,
    setDeleteLoading,
    continueLoading,
    setContinueLoading,
    actionLoading,
    sshParams,
    usernameError,
    onConfigExported,
    setActionResult,
  } = state;

  if (!serverInfo) return null;

  const handleExportConfig = async (username: string) => {
    setExportingUser(username);
    try {
      const path = await invoke<string>("fetch_server_config", {
        ...sshParams,
        clientName: username,
      });
      onConfigExported(path);
    } catch (e) {
      setActionResult({ type: "error", message: t("server.users.config_export_error", { error: String(e) }) });
    } finally {
      setExportingUser(null);
    }
  };

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
      setActionResult({ type: "error", message: String(e) });
    } finally {
      setContinueLoading(false);
    }
  };

  const { addUserToState, removeUserFromState, setActionLoading } = state;

  const handleDeleteUser = async () => {
    if (!confirmDeleteUser) return;
    const deletingUser = confirmDeleteUser;
    setDeleteLoading(true);
    try {
      await invoke("server_remove_user", {
        ...sshParams,
        vpnUsername: deletingUser,
      });
      removeUserFromState(deletingUser);
      setConfirmDeleteUser(null);
      setActionResult({ type: "ok", message: t("server.users.user_deleted", { user: deletingUser }) });
    } catch (e) {
      setActionResult({ type: "error", message: String(e) });
      setConfirmDeleteUser(null);
    } finally {
      setDeleteLoading(false);
    }
  };

  const handleAddUser = async () => {
    if (!newUsername.trim() || !newPassword.trim() || usernameError) return;
    const username = newUsername.trim();
    const password = newPassword.trim();
    setActionLoading(`Добавление ${username}`);
    try {
      await invoke("add_server_user", {
        ...sshParams,
        vpnUsername: username,
        vpnPassword: password,
      });
      addUserToState(username);
      setNewUsername("");
      setNewPassword("");
      setActionResult({ type: "ok", message: t("server.actions.success", { action: `Добавление ${username}` }) });
    } catch (e) {
      setActionResult({ type: "error", message: String(e) });
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <>
      <Card>
        <CardHeader
          title={t("server.users.title", { count: serverInfo.users.length })}
          icon={<Users className="w-3.5 h-3.5" />}
        />

        {/* User list with radio-select and accent left-border */}
        <div className="space-y-1.5 mb-3">
          {serverInfo.users.map((u) => {
            const isSelected = selectedUser === u;
            return (
              <div
                key={u}
                onClick={() => setSelectedUser(u)}
                className="flex items-center justify-between px-3 py-2 rounded-[var(--radius-md)] transition-all duration-200 cursor-pointer"
                style={{
                  backgroundColor: isSelected
                    ? "rgba(99, 102, 241, 0.08)"
                    : "var(--color-bg-elevated)",
                  borderLeft: isSelected
                    ? "4px solid var(--color-accent-500)"
                    : "4px solid transparent",
                  borderTop: `1px solid ${isSelected ? "rgba(99, 102, 241, 0.3)" : "var(--color-border)"}`,
                  borderRight: `1px solid ${isSelected ? "rgba(99, 102, 241, 0.3)" : "var(--color-border)"}`,
                  borderBottom: `1px solid ${isSelected ? "rgba(99, 102, 241, 0.3)" : "var(--color-border)"}`,
                }}
                onMouseEnter={(e) => {
                  if (!isSelected)
                    (e.currentTarget as HTMLDivElement).style.backgroundColor =
                      "var(--color-bg-hover)";
                }}
                onMouseLeave={(e) => {
                  if (!isSelected)
                    (e.currentTarget as HTMLDivElement).style.backgroundColor =
                      "var(--color-bg-elevated)";
                }}
              >
                <div className="flex items-center gap-2.5">
                  {/* Radio circle */}
                  <div
                    className="w-4 h-4 rounded-full flex items-center justify-center shrink-0"
                    style={{
                      border: `2px solid ${isSelected ? "var(--color-accent-500)" : "var(--color-border)"}`,
                    }}
                  >
                    {isSelected && (
                      <div
                        className="w-2 h-2 rounded-full"
                        style={{ backgroundColor: "var(--color-accent-500)" }}
                      />
                    )}
                  </div>
                  <span
                    className="text-xs font-medium"
                    style={{ color: "var(--color-text-primary)" }}
                  >
                    {u}
                  </span>
                </div>
                <div
                  className="flex items-center gap-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Tooltip text={t("server.users.export_tooltip")}>
                    <button
                      onClick={() => handleExportConfig(u)}
                      disabled={exportingUser === u}
                      className="p-1 rounded transition-colors hover:opacity-70"
                      style={{ color: "var(--color-text-muted)" }}
                    >
                      {exportingUser === u ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <Download className="w-3 h-3" />
                      )}
                    </button>
                  </Tooltip>
                  <Tooltip text={t("server.users.delete_tooltip")}>
                    <button
                      onClick={() => setConfirmDeleteUser(u)}
                      disabled={!!actionLoading?.startsWith("Удаление")}
                      className="p-1 rounded transition-colors hover:opacity-70"
                      style={{ color: "var(--color-danger-400)" }}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </Tooltip>
                </div>
              </div>
            );
          })}
          {serverInfo.users.length === 0 && (
            <p
              className="text-xs text-center py-2"
              style={{ color: "var(--color-text-muted)" }}
            >
              {t("server.users.no_users")}
            </p>
          )}
        </div>

        {/* Continue button */}
        {serverInfo.users.length > 0 && (
          <div className="mb-3">
            <Button
              variant={selectedUser ? "primary" : "secondary"}
              fullWidth
              icon={
                continueLoading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5" />
                )
              }
              loading={continueLoading}
              disabled={!selectedUser}
              onClick={handleContinueAsUser}
            >
              {selectedUser
                ? t("server.users.continue_as", { user: selectedUser })
                : t("server.users.select_user")}
            </Button>
          </div>
        )}

        {/* Add user form */}
        <div className="space-y-1.5">
          <div className="flex gap-1.5">
            <Input
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value.replace(/\s/g, ""))}
              placeholder={t("server.users.username_placeholder")}
              error={usernameError ? t(usernameError) : undefined}
              className="text-[11px] !py-1.5"
            />
            <PasswordInput
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder={t("server.users.password_placeholder")}
              showIcon={false}
              className="text-[11px] !py-1.5"
            />
            <Button
              variant="success"
              size="sm"
              icon={<UserPlus className="w-3.5 h-3.5" />}
              loading={!!actionLoading?.startsWith("Добавление")}
              disabled={!newUsername.trim() || !newPassword.trim() || !!usernameError}
              onClick={handleAddUser}
              className="shrink-0"
            >
              {t("server.users.add_user")}
            </Button>
          </div>
        </div>
      </Card>

      {/* Delete user confirmation */}
      <ConfirmDialog
        open={!!confirmDeleteUser}
        title={t("server.users.confirm_delete_title")}
        message={t("server.users.confirm_delete_message", { user: confirmDeleteUser ?? "" })}
        confirmLabel={t("buttons.confirm_delete")}
        cancelLabel={t("buttons.cancel")}
        variant="danger"
        loading={deleteLoading}
        onCancel={() => setConfirmDeleteUser(null)}
        onConfirm={handleDeleteUser}
      />
    </>
  );
}
