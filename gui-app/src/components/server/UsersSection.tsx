import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { cn } from "../../shared/lib/cn";
import { Users, FileText, Trash2, Settings } from "lucide-react";
import { Card } from "../../shared/ui/Card";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Divider } from "../../shared/ui/Divider";
import { Tooltip } from "../../shared/ui/Tooltip";
import { Button } from "../../shared/ui/Button";
import { useConfirm } from "../../shared/ui/useConfirm";
import { useActivityLog } from "../../shared/hooks/useActivityLog";
import { formatError } from "../../shared/utils/formatError";
import { UserConfigModal } from "./UserConfigModal";
import { UserModal } from "./UserModal";
import type { ServerState } from "./useServerState";

interface Props {
  state: ServerState;
}

/**
 * UsersSection — Phase 14.1 redesign.
 *
 * Changes from Phase 14:
 * - D-2: UsersAddForm removed. Plus-icon button added to CardHeader «Добавить пользователя».
 * - D-3: 3 inline icons per row: FileText (config) + Settings/Gear (edit) + Trash (delete).
 * - UserModal integration: Add mode (plus-icon) + Edit mode (gear-icon per row).
 * - UserConfigModal remains for FileText (show QR deeplink — unchanged).
 *
 * D-21: Trash disabled when users.length === 1.
 * D-29: Passwords never in activity log payloads.
 */
export function UsersSection({ state }: Props) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { log: activityLog } = useActivityLog();
  const {
    serverInfo,
    setDeleteLoading,
    actionLoading,
    sshParams,
    setActionResult,
    addUserToState,
    removeUserFromState,
  } = state;

  // Disable all row actions when any mutation is in-flight.
  const isBusy = !!actionLoading || state.deleteLoading;

  // ── UserConfigModal state (FileText icon — shows QR deeplink) ──────────
  const [configModalUsername, setConfigModalUsername] = useState<string | null>(null);
  const [pendingExportUsername, setPendingExportUsername] = useState<string | null>(null);

  // ── UserModal state (Plus icon = Add, Gear icon = Edit) ────────────────
  const [userModalMode, setUserModalMode] = useState<"add" | "edit">("add");
  const [userModalOpen, setUserModalOpen] = useState(false);
  const [editingUsername, setEditingUsername] = useState<string | undefined>(undefined);

  // Auto-open UserConfigModal after successful add (same pattern as Phase 14)
  useEffect(() => {
    if (pendingExportUsername) {
      activityLog("USER", `user.config.modal_opened user=${pendingExportUsername} source=add`);
      setConfigModalUsername(pendingExportUsername);
      setPendingExportUsername(null);
    }
  }, [pendingExportUsername, activityLog]);

  // ── All handlers defined before any conditional return (hooks rules) ────

  const handleShowConfig = useCallback(
    (user: string) => {
      activityLog("USER", `user.config.modal_opened user=${user} source=inline_icon`);
      setConfigModalUsername(user);
    },
    [activityLog],
  );

  const handleOpenAdd = useCallback(() => {
    activityLog("USER", "user.modal.open_add");
    setUserModalMode("add");
    setEditingUsername(undefined);
    setUserModalOpen(true);
  }, [activityLog]);

  const handleOpenEdit = useCallback(
    (user: string) => {
      activityLog("USER", `user.modal.open_edit user=${user}`);
      setUserModalMode("edit");
      setEditingUsername(user);
      setUserModalOpen(true);
    },
    [activityLog],
  );

  const handleUserModalClose = useCallback(() => {
    setUserModalOpen(false);
  }, []);

  const handleUserAdded = useCallback(
    (username: string) => {
      addUserToState(username);
      activityLog("STATE", `user.add_advanced.state_updated user=${username}`);
      state.pushSuccess(t("server.users.user_added_advanced", { user: username }));
      setPendingExportUsername(username);
    },
    [addUserToState, activityLog, state, t],
  );

  const handleUserUpdated = useCallback(
    (username: string) => {
      activityLog("STATE", `user.update.state_updated user=${username}`);
    },
    [activityLog],
  );

  const handleDeleteUser = useCallback(
    async (user: string) => {
      activityLog("USER", `user.remove.initiated user=${user}`);
      let actionRan = false;
      const ok = await confirm({
        title: t("server.users.confirm_delete_title"),
        message: t("server.users.confirm_delete_message", { user }),
        variant: "danger",
        confirmText: t("buttons.confirm_delete"),
        cancelText: t("buttons.cancel"),
        action: async () => {
          actionRan = true;
          activityLog("USER", `user.remove.confirmed user=${user}`);
          setDeleteLoading(true);
          try {
            await invoke("server_remove_user", {
              ...sshParams,
              vpnUsername: user,
            });
            removeUserFromState(user);
            activityLog("STATE", `user.remove.completed user=${user}`);
            state.pushSuccess(t("server.users.user_deleted", { user }));
          } catch (e) {
            activityLog("ERROR", `user.remove.failed user=${user} err=${formatError(e)}`);
            setActionResult({ type: "error", message: formatError(e) });
            throw e;
          } finally {
            setDeleteLoading(false);
          }
        },
      });
      if (!ok && !actionRan) {
        activityLog("USER", `user.remove.cancelled user=${user}`);
      }
    },
    [activityLog, confirm, t, sshParams, setDeleteLoading, removeUserFromState, setActionResult, state],
  );

  // ── Guard: nothing to render without server info ────────────────────────
  if (!serverInfo) return null;

  return (
    <>
      <Card>
        {/* Users list OR EmptyState */}
        {serverInfo.users.length === 0 ? (
          <EmptyState
            icon={<Users className="w-10 h-10" />}
            heading={t("server.users.empty_heading")}
            body={t("server.users.empty_body")}
          />
        ) : (
          <ul className="mb-3" aria-label={t("tabs.users")}>
            {serverInfo.users.map((u, idx) => {
              const isLast = serverInfo.users.length === 1;
              const isRowLast = idx === serverInfo.users.length - 1;

              return (
                <li key={u}>
                  <div
                    className={cn(
                      "flex items-center justify-between px-3 py-2 rounded-[var(--radius-md)]",
                      "transition-colors duration-[var(--transition-fast)]",
                      isBusy
                        ? "opacity-[var(--opacity-disabled)]"
                        : "hover:bg-[var(--color-bg-hover)]",
                    )}
                  >
                    {/* Username — left */}
                    <span
                      className="text-sm overflow-hidden text-ellipsis whitespace-nowrap flex-1 text-[var(--color-text-primary)]"
                      title={u}
                    >
                      {u}
                    </span>

                    {/* 3-icon cluster: FileText + Gear + Trash (D-3) */}
                    <div className="flex items-center gap-[var(--space-0\.5)] shrink-0 ml-2">
                      {/* FileText — show config QR */}
                      <Tooltip text={t("server.users.show_config_tooltip")}>
                        <button
                          type="button"
                          aria-label={t("server.users.show_config_tooltip")}
                          disabled={isBusy}
                          onClick={() => handleShowConfig(u)}
                          className={cn(
                            "h-8 w-8 flex items-center justify-center rounded-[var(--radius-md)]",
                            "transition-colors",
                            "text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]",
                            "focus-visible:shadow-[var(--focus-ring)] outline-none",
                            "disabled:opacity-[var(--opacity-disabled)] disabled:cursor-not-allowed disabled:hover:text-[var(--color-text-secondary)]",
                          )}
                        >
                          <FileText className="w-3.5 h-3.5" />
                        </button>
                      </Tooltip>

                      {/* Settings/Gear — edit user (D-3) */}
                      <Tooltip text={t("server.users.edit_tooltip")}>
                        <button
                          type="button"
                          aria-label={t("server.users.edit_tooltip")}
                          disabled={isBusy}
                          onClick={() => handleOpenEdit(u)}
                          className={cn(
                            "h-8 w-8 flex items-center justify-center rounded-[var(--radius-md)]",
                            "transition-colors",
                            "text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]",
                            "focus-visible:shadow-[var(--focus-ring)] outline-none",
                            "disabled:opacity-[var(--opacity-disabled)] disabled:cursor-not-allowed disabled:hover:text-[var(--color-text-secondary)]",
                          )}
                          data-testid={`gear-btn-${u}`}
                        >
                          <Settings className="w-3.5 h-3.5" />
                        </button>
                      </Tooltip>

                      {/* Trash — delete (D-21: disabled when last user) */}
                      <Tooltip
                        text={
                          isLast
                            ? t("server.users.cant_delete_last")
                            : t("server.users.delete_tooltip")
                        }
                      >
                        <button
                          type="button"
                          aria-label={
                            isLast
                              ? t("server.users.cant_delete_last")
                              : t("server.users.delete_tooltip")
                          }
                          aria-disabled={isLast || isBusy}
                          disabled={isLast || isBusy}
                          onClick={() => {
                            if (isLast) {
                              activityLog(
                                "USER",
                                `user.remove.blocked reason=last-user user=${u}`,
                              );
                              return;
                            }
                            if (isBusy) return;
                            void handleDeleteUser(u);
                          }}
                          className={cn(
                            "h-8 w-8 flex items-center justify-center rounded-[var(--radius-md)]",
                            "transition-colors",
                            "focus-visible:shadow-[var(--focus-ring)] outline-none",
                            isLast || isBusy
                              ? "opacity-[var(--opacity-disabled)] cursor-not-allowed text-[var(--color-text-muted)]"
                              : "text-[var(--color-text-secondary)] hover:text-[var(--color-destructive)]",
                          )}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </Tooltip>
                    </div>
                  </div>

                  {!isRowLast && (
                    <div
                      className="mx-3 my-1"
                      style={{ borderBottom: "1px solid var(--color-border)" }}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {/* Divider */}
        <Divider className="my-3" />

        {/* Add button at bottom (secondary entry point) */}
        <Button
          type="button"
          variant="secondary"
          fullWidth
          onClick={handleOpenAdd}
          disabled={isBusy}
          data-testid="users-add-btn-bottom"
        >
          {t("server.users.add_title")}
        </Button>
      </Card>

      {/* UserConfigModal — FileText icon → QR deeplink (unchanged from Phase 14) */}
      <UserConfigModal
        isOpen={!!configModalUsername}
        username={configModalUsername}
        sshParams={sshParams}
        onClose={() => setConfigModalUsername(null)}
      />

      {/* UserModal — Add/Edit modal (D-1..D-9) */}
      <UserModal
        isOpen={userModalOpen}
        mode={userModalMode}
        editUsername={editingUsername}
        existingUsers={serverInfo.users}
        sshParams={sshParams}
        onClose={handleUserModalClose}
        onUserAdded={handleUserAdded}
        onUserUpdated={handleUserUpdated}
      />
    </>
  );
}
