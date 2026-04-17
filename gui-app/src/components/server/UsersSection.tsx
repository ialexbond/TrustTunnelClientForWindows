import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { cn } from "../../shared/lib/cn";
import {
  Users,
  ChevronRight,
  Loader2,
  FileText,
  Trash2,
} from "lucide-react";
import { Card, CardHeader } from "../../shared/ui/Card";
import { Button } from "../../shared/ui/Button";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Divider } from "../../shared/ui/Divider";
import { Tooltip } from "../../shared/ui/Tooltip";
import { useConfirm } from "../../shared/ui/useConfirm";
import { useActivityLog } from "../../shared/hooks/useActivityLog";
import { formatError } from "../../shared/utils/formatError";
import {
  generateUsername,
  generatePassword,
} from "../../shared/utils/credentialGenerator";
import { UserConfigModal } from "./UserConfigModal";
import { UsersAddForm } from "./UsersAddForm";
import type { ServerState } from "./useServerState";

interface Props {
  state: ServerState;
}

/**
 * D-14: collision-check helper.
 * Generates a unique username against the `existing` list.
 * Retries up to `attempts` times (default 10). If still colliding after
 * attempts — returns the last generated candidate; backend will surface a
 * protocol-level duplicate and UI's `usernameError` will reflect it.
 */
function generateUniqueUsername(existing: string[], attempts = 10): string {
  const taken = new Set(existing);
  let name = generateUsername();
  let i = 0;
  while (taken.has(name) && i < attempts) {
    name = generateUsername();
    i++;
  }
  return name;
}

/**
 * UsersSection — Phase 14 redesign per UI-SPEC §Surface 1.
 *
 * Changes from pre-Phase-14 implementation:
 * - Removed the legacy overflow trigger + radio-circle (D-03). Rows now show
 *   the user name left-aligned and a 2-icon action cluster right-aligned:
 *   FileText (open UserConfigModal) + Trash (delete with confirmation).
 * - Inline add-form extracted to UsersAddForm (D-20). Pre-filled on mount
 *   (D-13) via generateUniqueUsername (D-14 collision-check).
 * - Successful user_add auto-opens UserConfigModal for the new user (D-07).
 * - Trash is disabled when users.length === 1 (D-21 — protocol requires >=1).
 * - Full activity-log coverage (D-28); password never logged (D-29).
 */
export function UsersSection({ state }: Props) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { log: activityLog } = useActivityLog();
  const {
    serverInfo,
    selectedUser,
    setSelectedUser,
    newUsername,
    setNewUsername,
    newPassword,
    setNewPassword,
    setDeleteLoading,
    continueLoading,
    setContinueLoading,
    actionLoading,
    sshParams,
    usernameError,
    onConfigExported,
    setActionResult,
    addUserToState,
    removeUserFromState,
    setActionLoading,
  } = state;

  const isAdding = !!actionLoading?.startsWith("add_user");
  // Disable ALL row-level actions when anything is in flight (add/delete/continue)
  // — prevents stray clicks during the 1-3s SSH round-trip.
  const isBusy = !!actionLoading || state.deleteLoading || continueLoading;

  // Modal state — single source of truth for the UserConfigModal.
  const [modalUsername, setModalUsername] = useState<string | null>(null);
  // After successful add — processed via useEffect to let setActionLoading(null)
  // and the pre-fill state writes apply before the modal opens (Pitfall 4).
  const [pendingExportUsername, setPendingExportUsername] = useState<string | null>(null);

  // D-14: handler for UsersAddForm onRegenerateName — closure captures current serverInfo.users.
  const handleRegenerateUniqueName = useCallback((): string => {
    const existing = serverInfo?.users ?? [];
    return generateUniqueUsername(existing, 10);
  }, [serverInfo]);

  // Pre-fill credentials on first mount (D-13) with D-14 collision-check.
  // We deliberately run only once; subsequent pre-fill happens after add.
  useEffect(() => {
    const existing = serverInfo?.users ?? [];
    setNewUsername(generateUniqueUsername(existing, 10));
    setNewPassword(generatePassword());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-open modal after add (D-07). Drained via an effect so state writes
  // from handleAddUser flush before modal mounts.
  useEffect(() => {
    if (pendingExportUsername) {
      activityLog("USER", `user.config.modal_opened user=${pendingExportUsername} source=add`);
      setModalUsername(pendingExportUsername);
      setPendingExportUsername(null);
    }
  }, [pendingExportUsername, activityLog]);

  if (!serverInfo) return null;

  // ── Continue as selected user ──
  const handleContinueAsUser = async () => {
    if (!selectedUser) return;
    activityLog("USER", `user.continue_as.clicked user=${selectedUser}`);
    setContinueLoading(true);
    try {
      const path = await invoke<string>("fetch_server_config", {
        ...sshParams,
        clientName: selectedUser,
      });
      activityLog("STATE", `user.continue_as.completed user=${selectedUser}`);
      onConfigExported(path);
    } catch (e) {
      activityLog(
        "ERROR",
        `user.continue_as.failed user=${selectedUser} err=${formatError(e)}`
      );
      setActionResult({ type: "error", message: formatError(e) });
    } finally {
      setContinueLoading(false);
    }
  };

  // ── Show config modal for a user (inline FileText icon trigger) ──
  const handleShowConfig = (user: string) => {
    activityLog("USER", `user.config.modal_opened user=${user} source=inline_icon`);
    setModalUsername(user);
  };

  // ── Delete user (destructive, confirm-guarded) ──
  // The ConfirmDialog stays open for the whole SSH round-trip via the
  // `action` prop (new ConfirmOptions API). Modal closes only when the
  // user is actually removed from state — matches the user's mental
  // model: «модалка закрывается в момент, когда пользователь исчезает».
  const handleDeleteUser = async (user: string) => {
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
          // D-26: SnackBar «Пользователь «{user}» удалён»
          state.pushSuccess(t("server.users.user_deleted", { user }));
        } catch (e) {
          activityLog("ERROR", `user.remove.failed user=${user} err=${formatError(e)}`);
          setActionResult({ type: "error", message: formatError(e) });
          // Rethrow so ConfirmDialogProvider closes modal with false and the
          // outer `await confirm()` resolves false (caller already handled error).
          throw e;
        } finally {
          setDeleteLoading(false);
        }
      },
    });
    // Disambiguate the three outcomes:
    //   ok=true  → success (user.remove.completed already logged)
    //   ok=false + actionRan → action threw (user.remove.failed already logged)
    //   ok=false + !actionRan → user dismissed dialog (cancel button / Escape / backdrop)
    if (!ok && !actionRan) {
      activityLog("USER", `user.remove.cancelled user=${user}`);
    }
  };

  // ── Add user (Pitfall 4 ordering: unlock → pre-fill → pending modal) ──
  const handleAddUser = async () => {
    if (!newUsername.trim() || !newPassword.trim() || usernameError) return;
    const username = newUsername.trim();
    const password = newPassword.trim();
    activityLog("USER", "user.add.clicked"); // D-29: no password in payload
    setActionLoading("add_user");
    try {
      await invoke("add_server_user", {
        ...sshParams,
        vpnUsername: username,
        vpnPassword: password,
      });
      addUserToState(username);
      activityLog("STATE", `user.add.completed user=${username}`);
      state.pushSuccess(t("server.users.user_added", { user: username }));
      // CRITICAL ORDER (Pitfall 4):
      // 1. Unlock form first
      setActionLoading(null);
      // 2. Pre-fill next pair with collision-check (D-14) — include just-added name
      const nextExisting = [...(serverInfo?.users ?? []), username];
      setNewUsername(generateUniqueUsername(nextExisting, 10));
      setNewPassword(generatePassword());
      // 3. Trigger modal via pending state (useEffect drains on next tick)
      setPendingExportUsername(username);
    } catch (e) {
      activityLog("ERROR", `user.add.failed err=${formatError(e)}`);
      setActionResult({ type: "error", message: formatError(e) });
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

        {/* Users list OR EmptyState */}
        {serverInfo.users.length === 0 ? (
          <EmptyState
            icon={<Users className="w-10 h-10" />}
            heading={t("server.users.empty_heading")}
            body={t("server.users.empty_body")}
          />
        ) : (
          <div
            role="listbox"
            aria-label={t("tabs.users")}
            className="mb-3"
          >
            {serverInfo.users.map((u, idx) => {
              const isSelected = selectedUser === u;
              // D-21: Trash disabled when only one user remains.
              const isLast = serverInfo.users.length === 1;
              const isRowLast = idx === serverInfo.users.length - 1;

              return (
                <div key={u}>
                  {/* Row */}
                  <div
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={isBusy}
                    tabIndex={isSelected && !isBusy ? 0 : -1}
                    onClick={() => {
                      if (isBusy) return;
                      if (!isSelected) activityLog("USER", `user.row.selected user=${u}`);
                      setSelectedUser(u);
                    }}
                    onKeyDown={(e) => {
                      if (isBusy) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        if (!isSelected) activityLog("USER", `user.row.selected user=${u} via=keyboard`);
                        setSelectedUser(u);
                      }
                    }}
                    className={cn(
                      "flex items-center justify-between px-3 py-2 rounded-[var(--radius-md)]",
                      "transition-colors duration-[var(--transition-fast)]",
                      "focus-visible:shadow-[var(--focus-ring)] outline-none",
                      isBusy
                        ? "opacity-[var(--opacity-disabled)] cursor-not-allowed"
                        : "cursor-pointer",
                      isSelected
                        ? "bg-[var(--color-accent-tint-08)]"
                        : !isBusy && "hover:bg-[var(--color-bg-hover)]"
                    )}
                  >
                    {/* Username — left, truncates with ellipsis */}
                    <span
                      className="text-sm overflow-hidden text-ellipsis whitespace-nowrap flex-1"
                      style={{ color: "var(--color-text-primary)" }}
                      title={u}
                    >
                      {u}
                    </span>

                    {/* Inline icon cluster — 2 icons (D-03). stopPropagation
                        prevents row selection when clicking icons. */}
                    <div
                      className="flex items-center gap-[var(--space-1)] shrink-0 ml-2"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      {/* FileText — show config (D-03). Disabled during any in-flight action. */}
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
                            "disabled:opacity-[var(--opacity-disabled)] disabled:cursor-not-allowed disabled:hover:text-[var(--color-text-secondary)]"
                          )}
                        >
                          <FileText className="w-3.5 h-3.5" />
                        </button>
                      </Tooltip>

                      {/* Trash — delete. Disabled if last user (D-21) OR any action in-flight. */}
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
                              activityLog("USER", `user.remove.blocked reason=last-user user=${u}`);
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
                              : "text-[var(--color-text-secondary)] hover:text-[var(--color-destructive)]"
                          )}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </Tooltip>
                    </div>
                  </div>

                  {/* Divider between rows (not after last) */}
                  {!isRowLast && (
                    <div
                      className="mx-3 my-1"
                      style={{ borderBottom: "1px solid var(--color-border)" }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Continue as selected user button — only when users exist */}
        {serverInfo.users.length > 0 && (
          <div className="mb-3">
            <Button
              variant={selectedUser ? "primary" : "ghost"}
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

        {/* Divider before inline add form (D-20) */}
        <Divider className="my-3" />

        {/* Inline add-user form (D-20). Always visible so first add works.
             D-14: onRegenerateName delegates collision-check to this component. */}
        <UsersAddForm
          newUsername={newUsername}
          setNewUsername={setNewUsername}
          newPassword={newPassword}
          setNewPassword={setNewPassword}
          isAdding={isAdding}
          usernameError={usernameError}
          onAdd={handleAddUser}
          onRegenerateName={handleRegenerateUniqueName}
        />
      </Card>

      {/* UserConfigModal — controlled by modalUsername state.
           Opens on FileText click OR auto-after-add via pendingExportUsername. */}
      <UserConfigModal
        isOpen={!!modalUsername}
        username={modalUsername}
        sshParams={sshParams}
        onClose={() => setModalUsername(null)}
      />
    </>
  );
}
