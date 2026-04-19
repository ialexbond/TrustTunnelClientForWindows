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

  // Disable all row actions when a mutation is in-flight.
  //
  // FIX-JJ: deliberately NOT including `state.deleteLoading`. The delete flow
  // goes through a ConfirmDialog whose backdrop already blocks every click
  // until the async action finishes, so adding `deleteLoading` here just made
  // the background icons look disabled while the dialog was up — exactly
  // what the user said shouldn't happen («кнопки на фоне не должны переходить
  // в состояние disable»). The ConfirmDialog owns its own loading state
  // (variant/danger + its own buttons disabled + backdrop). Nothing else
  // needs to know.
  const isBusy = !!actionLoading;

  // ── UserConfigModal state (FileText icon — shows QR deeplink) ──────────
  const [configModalUsername, setConfigModalUsername] = useState<string | null>(null);
  const [pendingExportUsername, setPendingExportUsername] = useState<string | null>(null);
  // FIX-W: regenerated deeplink from the most recent Edit save. Preloaded
  // into UserConfigModal so the user sees the fresh deeplink with the edited
  // TLV params (server doesn't persist these, so they exist only here).
  const [preloadedDeeplink, setPreloadedDeeplink] = useState<string | null>(null);

  // ── UserModal state (Plus icon = Add, Gear icon = Edit) ────────────────
  const [userModalMode, setUserModalMode] = useState<"add" | "edit">("add");
  const [userModalOpen, setUserModalOpen] = useState(false);
  const [editingUsername, setEditingUsername] = useState<string | undefined>(undefined);

  // A: map username → display_name from users-advanced.toml. One SSH roundtrip
  // when the list renders; refetched after Add / Edit / Delete (callbacks
  // below call `refreshDisplayNames`). Empty display_name / missing entry →
  // fall back to username so the list is never blank.
  const [displayNames, setDisplayNames] = useState<Map<string, string>>(new Map());
  const refreshDisplayNames = useCallback(async () => {
    try {
      const list = await invoke<Array<{ username: string; display_name?: string | null }>>(
        "server_list_user_advanced",
        sshParams,
      );
      const next = new Map<string, string>();
      for (const u of list ?? []) {
        if (u.display_name && u.display_name.trim()) {
          next.set(u.username, u.display_name.trim());
        }
      }
      setDisplayNames(next);
    } catch (err) {
      // Non-fatal — list continues to render usernames alone.
      activityLog(
        "ERROR",
        `users.displayname_fetch_failed err=${formatError(err).slice(0, 80)}`,
      );
    }
  }, [sshParams, activityLog]);
  // `serverInfo` is nullable until the first check_server_installation
  // roundtrip resolves; derive a stable count so the dep array stays simple.
  const userCount = serverInfo?.users.length ?? 0;
  useEffect(() => {
    void refreshDisplayNames();
  }, [refreshDisplayNames, userCount]);

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
    (username: string, generatedDeeplink: string) => {
      addUserToState(username);
      activityLog(
        "STATE",
        `user.add_advanced.state_updated user=${username} deeplink_len=${generatedDeeplink.length}`,
      );
      state.pushSuccess(t("server.users.user_added_advanced", { user: username }));
      // FIX-KK: preload the freshly-generated deeplink so UserConfigModal
      // shows it verbatim instead of re-fetching a stripped basic deeplink.
      setPreloadedDeeplink(generatedDeeplink);
      setPendingExportUsername(username);
    },
    [addUserToState, activityLog, state, t],
  );

  const handleUserUpdated = useCallback(
    (username: string, regeneratedDeeplink: string | null) => {
      activityLog("STATE", `user.update.state_updated user=${username}`);
      // A: display_name may have been changed in Edit → list must reflect it
      // without waiting for a user count change (refreshDisplayNames in the
      // useEffect above is keyed on users.length, which Edit doesn't bump).
      void refreshDisplayNames();
      // FIX-W: when the Edit modal regenerated the deeplink (deeplink section
      // was dirty), preload it into UserConfigModal and auto-open — otherwise
      // the user's edits to display_name / custom_sni / DNS / etc. would be
      // baked into a deeplink nobody ever sees.
      if (regeneratedDeeplink) {
        setPreloadedDeeplink(regeneratedDeeplink);
        setConfigModalUsername(username);
        activityLog(
          "USER",
          `user.config.modal_opened user=${username} source=edit_regenerated`,
        );
      }
    },
    [activityLog, refreshDisplayNames],
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
            // FIX-NN: backend `server_remove_user` already runs the
            // advanced-file cleanup internally. This second invoke is
            // belt-and-braces for the case where that best-effort write
            // errored silently. Swallowed — credentials.toml is the
            // source of truth for "user exists", so a dangling entry in
            // users-advanced.toml is harmless (next Add overwrites it).
            //
            // Promise.resolve wrap: `invoke` may be a plain non-Promise
            // value in unit tests (vi.fn default); bare `.catch` on it
            // throws synchronously and breaks the surrounding try/catch.
            Promise.resolve(
              invoke("server_delete_user_advanced", {
                ...sshParams,
                username: user,
              }),
            ).catch((err) => {
              activityLog(
                "ERROR",
                `user.advanced.cleanup_failed user=${user} err=${formatError(err)}`,
              );
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
                    {/* Username — left. A: показываем display_name из
                        users-advanced.toml если задан. Username виден в
                        title-атрибуте при наведении — чтобы оператор мог
                        сопоставить метку с реальным клиентским именем. */}
                    {(() => {
                      const label = displayNames.get(u) || u;
                      const hasAlias = label !== u;
                      return (
                        <span
                          className="text-sm overflow-hidden text-ellipsis whitespace-nowrap flex-1 text-[var(--color-text-primary)]"
                          title={hasAlias ? `${label} · ${u}` : u}
                        >
                          {label}
                          {hasAlias && (
                            <span className="ml-1.5 text-xs text-[var(--color-text-muted)]">
                              {u}
                            </span>
                          )}
                        </span>
                      );
                    })()}

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

      {/* UserConfigModal — FileText icon → QR deeplink. FIX-W: also opens
          with `preloadedDeeplink` after an Edit that regenerated the deeplink,
          so the user sees the edited TLV params in the QR before they vanish. */}
      <UserConfigModal
        isOpen={!!configModalUsername}
        username={configModalUsername}
        sshParams={sshParams}
        preloadedDeeplink={preloadedDeeplink ?? undefined}
        onClose={() => {
          setConfigModalUsername(null);
          setPreloadedDeeplink(null);
        }}
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
