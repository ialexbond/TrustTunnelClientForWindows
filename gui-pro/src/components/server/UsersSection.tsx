import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { cn } from "../../shared/lib/cn";
import { Users, FileText, Trash2, Settings } from "lucide-react";
import { Card } from "../../shared/ui/Card";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Divider } from "../../shared/ui/Divider";
import { IconButton } from "../../shared/ui/IconButton";
import { ICON } from "../../shared/ui/iconScale";
import { Button } from "../../shared/ui/Button";
import { useConfirm } from "../../shared/ui/useConfirm";
import { useActivityLog } from "../../shared/hooks/useActivityLog";
import { formatError } from "../../shared/utils/formatError";
import { UserConfigModal } from "./UserConfigModal";
import { UserModal } from "./UserModal";
import { parseCertInfo } from "./certUtils";
import type { ServerState } from "./useServerState";
import type { ServerTabId } from "../../shared/types";

interface Props {
  state: ServerState;
  /**
   * M-04: активная вкладка серверной панели. UsersSection перерисовывает
   * список пользователей (loadServerInfo + refreshDisplayNames) когда таб
   * становится `"users"` — это даёт оператору свежий список без отдельной
   * кнопки Refresh. Cross-fade между табами не unmount'ит секцию, поэтому
   * без этого сигнала юзер видит кэшированное состояние пока не передёрнет
   * коннект.
   *
   * Phase 19 rename: `"utilities"` → `"service"` via shared `ServerTabId`.
   */
  activeServerTab?: ServerTabId;
}

/**
 * UsersSection — Phase 14.1 redesign.
 *
 * Changes from Phase 14:
 * - D-2: UsersAddForm removed. The add action is a full-width secondary Button
 *   («Добавить пользователя») rendered at the BOTTOM of the card (below the user
 *   list + Divider), not a plus-icon in a header — there is no CardHeader here.
 * - D-3: 3 inline icons per row: FileText (config) + Settings/Gear (edit) + Trash (delete).
 * - UserModal integration: Add mode (bottom button) + Edit mode (gear-icon per row).
 * - UserConfigModal remains for FileText (show QR deeplink — unchanged).
 *
 * D-21: Trash disabled when users.length === 1.
 * D-29: Passwords never in activity log payloads.
 */
export function UsersSection({ state, activeServerTab }: Props) {
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

  // M-04: когда пользователь переключается на таб «Пользователи», делаем
  // full reload — и credentials.toml через loadServerInfo, и
  // users-advanced.toml через refreshDisplayNames. Это единственный
  // discoverable «обновить» на этом экране (отдельной кнопки в дизайне
  // нет). Пропускаем первый рендер c undefined, первый mount и так уже
  // загружен через panel bootstrap.
  //
  // WR-02 (14.1-REVIEW deep pass): эффект зависит ТОЛЬКО от activeServerTab,
  // но внутри читает sshParams / state.loadServerInfo / refreshDisplayNames /
  // activityLog. Без ref-based stable handle callback'и ссылаются на stale
  // closures: если SSH-port меняется через security tab (pool invalidates,
  // sshParams перезаписывается) пока activeServerTab==='users', эффект не
  // перезапускается и продолжает дёргать старый port до следующего деактива/
  // реактива. Паттерн скопирован с OverviewSection.rebootRefs (lines 262-312):
  // ref обновляется на каждом рендере, эффект читает refs.current — всегда
  // актуальные значения без лишних перезапусков.
  const tabRefs = useRef({
    sshParams,
    loadServerInfo: state.loadServerInfo,
    refreshDisplayNames,
    activityLog,
  });
  tabRefs.current = {
    sshParams,
    loadServerInfo: state.loadServerInfo,
    refreshDisplayNames,
    activityLog,
  };
  const firstTabActivationRef = useRef(true);
  useEffect(() => {
    if (activeServerTab !== "users") return;
    if (firstTabActivationRef.current) {
      firstTabActivationRef.current = false;
      return;
    }
    const refs = tabRefs.current;
    refs.activityLog("USER", "users.tab.activated refresh=triggered");
    // M-04 fix: silent=true — НЕ триггерим state.loading, иначе
    // ServerPanel раскрывает «Checking server...» loader и весь экран
    // блокируется при каждом клике на таб. Silent refresh меняет
    // serverInfo в background, кэшированные user-rows остаются видимы.
    refs.loadServerInfo(true).catch(() => {
      /* loadServerInfo sets state.error — UI показывает baner */
    });
    void refs.refreshDisplayNames();
    // M-11: fire-and-forget reconcile users-advanced.toml — best-effort
    // hygiene, результат логируется в activity.log но не влияет на UI.
    void invoke<number>("server_reconcile_users_advanced", refs.sshParams)
      .then((removed) => {
        if (typeof removed === "number" && removed > 0) {
          refs.activityLog(
            "STATE",
            `users.advanced.reconciled removed=${removed}`,
          );
        }
      })
      .catch((err) => {
        refs.activityLog(
          "ERROR",
          `users.advanced.reconcile_failed err=${formatError(err).slice(0, 80)}`,
        );
      });
  }, [activeServerTab]);

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
      // UAT-F01: bump the Configuration-tab refresh signal so the freshly added
      // user shows up live in credentials.toml + rules.toml without a reconnect.
      state.bumpConfigEpoch();
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
            // WR-01 (14.1-REVIEW deep pass): the fire-and-forget was wrapped
            // in `Promise.resolve(invoke(...)).catch(...)` to defend against
            // unit-test mocks returning undefined (bare `.catch` would throw
            // synchronously). Swapped to an async IIFE — `await invoke(...)`
            // safely handles both real Promises and mock-undefined values,
            // and the try/catch surfaces SSH write failures via activity log
            // so the operator sees them instead of silent fire-and-forget.
            void (async () => {
              try {
                await invoke("server_delete_user_advanced", {
                  ...sshParams,
                  username: user,
                });
              } catch (err) {
                activityLog(
                  "ERROR",
                  `user.advanced.cleanup_failed user=${user} err=${formatError(err)}`,
                );
              }
            })();
            removeUserFromState(user);
            // UAT-F01 (owner clarification): deletion must trigger the SAME
            // live Configuration refresh as add — bump the epoch so the removed
            // user disappears from credentials.toml + rules.toml immediately.
            state.bumpConfigEpoch();
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
                        users-advanced.toml если задан; username рядом
                        muted. Native `title` атрибут убран — пользователь
                        не хотел hover-tooltip'а на строке. */}
                    {(() => {
                      const label = displayNames.get(u) || u;
                      const hasAlias = label !== u;
                      return (
                        <span className="text-sm overflow-hidden text-ellipsis whitespace-nowrap flex-1 text-[var(--color-text-primary)]">
                          {label}
                          {hasAlias && (
                            <span className="ml-1.5 text-xs text-[var(--color-text-muted)]">
                              {u}
                            </span>
                          )}
                        </span>
                      );
                    })()}

                    {/* 3-icon cluster: FileText + Gear + Trash (D-3).
                        A-1 (09-24): adopted the shared IconButton — it renders its
                        OWN Tooltip (via `tooltip`), so the old hand-rolled outer
                        <Tooltip> wrappers were deleted (Pitfall 3: double-wrap). The
                        row tint (text-secondary, not the IconButton default muted)
                        and the per-action hover are passed via `className`, which
                        IconButton merges with cn. Icon sizes use ICON.sm (14px ===
                        the previous w-3.5 h-3.5 — pixel-identical, ICON-01). */}
                    <div className="flex items-center gap-[var(--space-0-5)] shrink-0 ml-2">
                      {/* FileText — show config QR */}
                      <IconButton
                        aria-label={t("server.users.show_config_tooltip")}
                        tooltip={t("server.users.show_config_tooltip")}
                        disabled={isBusy}
                        onClick={() => handleShowConfig(u)}
                        className="text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:hover:text-[var(--color-text-secondary)]"
                        icon={<FileText size={ICON.sm} />}
                      />

                      {/* Settings/Gear — edit user (D-3) */}
                      <IconButton
                        aria-label={t("server.users.edit_tooltip")}
                        tooltip={t("server.users.edit_tooltip")}
                        disabled={isBusy}
                        onClick={() => handleOpenEdit(u)}
                        className="text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:hover:text-[var(--color-text-secondary)]"
                        data-testid={`gear-btn-${u}`}
                        icon={<Settings size={ICON.sm} />}
                      />

                      {/* Trash — delete (D-21: disabled when last user) */}
                      <IconButton
                        aria-label={
                          isLast
                            ? t("server.users.cant_delete_last")
                            : t("server.users.delete_tooltip")
                        }
                        tooltip={
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
                          isLast || isBusy
                            ? "text-[var(--color-text-muted)]"
                            : "text-[var(--color-text-secondary)] hover:text-[var(--color-destructive)]",
                        )}
                        icon={<Trash2 size={ICON.sm} />}
                      />
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

      {/* UserModal — Add/Edit modal (D-1..D-9).
          `serverCertType` поступает из useServerState.certRaw (уже загружен
          при panel load). UserModal использует его чтобы disable'ить
          Pin Certificate + Skip Verification toggles когда сервер на
          Let's Encrypt — для него pin/skip противоречат spec. */}
      <UserModal
        isOpen={userModalOpen}
        mode={userModalMode}
        editUsername={editingUsername}
        existingUsers={serverInfo.users}
        sshParams={sshParams}
        serverCertType={parseCertInfo(state.certRaw).certType}
        onClose={handleUserModalClose}
        onUserAdded={handleUserAdded}
        onUserUpdated={handleUserUpdated}
      />
    </>
  );
}
