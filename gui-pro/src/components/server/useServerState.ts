import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { translateSshError } from "../../shared/utils/translateSshError";
import { formatError } from "../../shared/utils/formatError";
import { useSnackBar } from "../../shared/ui/SnackBarContext";
import { useActivityLog } from "../../shared/hooks/useActivityLog";
import { useUsersState, type UsersState } from "./useUsersState";
import { useVersionsState, type VersionsState } from "./useVersionsState";
import { useLogsState, type LogsState } from "./useLogsState";
import { useDangerZoneState, type DangerZoneState } from "./useDangerZoneState";

// ═══════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════

export interface ServerPanelProps {
  host: string;
  port: string;
  sshUser: string;
  sshPassword: string;
  sshKeyPath?: string;
  onSwitchToSetup: () => void;
  onClearConfig: () => void;
  onDisconnect: () => void;
  onConfigExported: (configPath: string) => void;
  onPortChanged?: (newPort: number) => void;
}

export interface ServerInfo {
  installed: boolean;
  version: string;
  serviceActive: boolean;
  users: string[];
  protocol?: string;
  listenPort?: number;
}

export type ActionResult = { type: "ok" | "error"; message: string } | null;

// ═══════════════════════════════════════════════════════
// Hook
// ═══════════════════════════════════════════════════════

/**
 * useServerState (Phase 12.5 refactor):
 * Core SSH state only — serverInfo, loading/error, sshParams, panel data,
 * loadServerInfo, runAction, optimistic update helpers.
 *
 * Domain slices moved to dedicated hooks and re-exposed on the returned
 * ServerState so existing sections continue to read via `state.X`:
 *   - useUsersState      (selectedUser, newUsername, newPassword, etc.)
 *   - useVersionsState   (availableVersions, selectedVersion, ...)
 *   - useLogsState       (serverLogs, showLogs, logsLoading)
 *   - useDangerZoneState (rebooting, uninstallLoading)
 *
 * This keeps ServerPanelProps stable (D-06) while collapsing useServerState
 * from 293 lines to ~160.
 */
export function useServerState(props: ServerPanelProps) {
  const { t } = useTranslation();
  const { host, port, sshUser, sshPassword, sshKeyPath, onSwitchToSetup, onClearConfig, onConfigExported, onPortChanged } = props;

  // ─── Core Server Info ───
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
  // R2-F08 (Plan 09-37, REVISED after adversarial review): "users known" sentinel.
  // The Overview Users card renders `serverInfo.users?.length ?? 0`, which cannot
  // tell "users not yet probed" from "genuinely zero" — both render 0. On a fresh
  // auto-connect the panel load can settle with `users:[]` even on the NON-SILENT
  // mount load: the backend creds grep fail-softs to an empty Vec WITHOUT throwing
  // (server_install.rs:138 `... || echo ''`), so the throw-only cold-start retry
  // never fires and the empty result is accepted. The FIRST sentinel attempt keyed
  // off `|| !silent`, but that flipped usersKnown=true on exactly that racy mount
  // load → the card flashed a false «0» (the symptom this was meant to suppress).
  //
  // Corrected producer (frontend-only — owner locked R2-F08 to a minimal frontend
  // fix; no backend present/probed flag):
  //   • POPULATED list (length > 0) → set true immediately (unambiguous proof).
  //   • NOT installed → set true immediately (the Users card isn't shown on a
  //     non-installed server; don't strand the sentinel on the skeleton).
  //   • installed + EMPTY + still unknown → fire EXACTLY ONE confirming SILENT
  //     re-probe after a short delay (confirmRef gates it to once per connect):
  //       – re-probe now populated → set true;
  //       – re-probe STILL empty → accept as a CONFIRMED zero, set true (so a
  //         genuinely-zero server resolves to «0» after one extra round-trip
  //         instead of being stranded on the skeleton forever).
  // See 09-UAT-2-DIAGNOSIS.md (R2-F08) and the review-fix note in 09-37-SUMMARY.md.
  const [usersKnown, setUsersKnown] = useState(false);
  // usersKnownRef mirrors usersKnown so the loadServerInfo callback (whose deps are
  // only the connection params — see the eslint-disable on its dep array) reads the
  // CURRENT value, not a stale closure capture. confirmInFlightRef: one-shot gate so
  // the empty-installed re-probe fires at most once per connect (reset on host change
  // / disconnect). confirmTimeoutRef: id of the pending re-probe timer so a host
  // switch can cancel it before a stale timer re-probes the old host (loadServerInfo
  // already early-returns on empty host, but cancel anyway to be safe).
  const usersKnownRef = useRef(false);
  const setUsersKnownSynced = useCallback((v: boolean) => {
    usersKnownRef.current = v;
    setUsersKnown(v);
  }, []);
  const usersConfirmInFlightRef = useRef(false);
  const usersConfirmTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<ActionResult>(null);
  const pushSuccess = useSnackBar();
  const { log: activityLog } = useActivityLog();

  // ─── Panel data (config + cert) ───
  const [configRaw, setConfigRaw] = useState<string | null>(null);
  const [certRaw, setCertRaw] = useState<unknown>(null);
  const [panelDataLoaded, setPanelDataLoaded] = useState(false);

  // ─── Configuration-tab refresh signal (UAT-F01) ───
  // configEpoch is bumped on user add/delete so the Configuration tab re-reads
  // credentials.toml + rules.toml live (silently) — without it, ConfigurationTab
  // kept showing a stale bundle until the operator manually reconnected.
  const [configEpoch, setConfigEpoch] = useState(0);
  const bumpConfigEpoch = useCallback(() => setConfigEpoch((n) => n + 1), []);

  // ─── Domain slices ───
  const users = useUsersState();
  const versions = useVersionsState(serverInfo);
  const logs = useLogsState();
  const dangerZone = useDangerZoneState();

  // ─── SSH params shorthand ───
  // WR-03 fix: memoize so referential equality holds across renders.
  // Downstream hooks (useSecurityState, useMtProtoState) destructure primitives
  // and are stable on their own, but consumers that pass sshParams object into
  // invoke() or other hooks benefit from referential stability.
  const sshParams = useMemo(
    () => ({
      host,
      port: parseInt(port, 10),
      user: sshUser,
      password: sshPassword,
      keyPath: sshKeyPath || undefined,
    }),
    [host, port, sshUser, sshPassword, sshKeyPath],
  );

  // ─── Load server info + panel data ───
  const loadServerInfo = useCallback(async (silent = false) => {
    if (!host || (!sshPassword && !sshKeyPath)) return;
    if (!silent) {
      setLoading(true);
      setError("");
      // Phase 13.UAT G-07: log panel load start для трассировки "skeleton hangs"
      // и "неверный пароль" edge cases. Включает host для мульти-сервера.
      activityLog("STATE", `panel.load.start host=${host}`, "useServerState.loadServerInfo");
    }
    const loadStartMs = Date.now();
    try {
      // Cold-start transient guard (UAT 2026-06-19; BROADENED 06-review): when the panel
      // auto-connects on launch it races with the concurrent sidecar-version probe — two
      // fresh SSH handshakes to the same sshd at once. The first one frequently fails
      // transiently, and open_session_with_retry can't recover it (it re-opens a channel
      // on an already-dead handle). A FRESH reconnect — exactly what «Повторить» does —
      // succeeds. We used to retry ONLY when the raw error contained "SSH_CHANNEL_FAILED",
      // but that race surfaces under MANY russh wordings (Disconnected, ChannelOpenFailure,
      // broken pipe, timeouts), and translateSshError reclassifies several of them as
      // «Неверный SSH логин или пароль» (G-07) — so the narrow test let a SPURIOUS auth-error
      // screen through on cold start. Retry ONCE on ANY first-probe failure EXCEPT a changed
      // host key (deterministic + security-sensitive — it has its own reset flow in the outer
      // catch and must never be silently retried). A genuine auth failure simply fails the
      // retry too and surfaces normally (~400ms later), so broadening costs nothing real.
      let info: ServerInfo;
      try {
        info = await invoke<ServerInfo>("check_server_installation", sshParams);
      } catch (firstErr) {
        const firstStr = formatError(firstErr);
        const hostKeyChanged =
          firstStr.includes("HOST_KEY_CHANGED") || firstStr.includes("Unknown server key");
        if (hostKeyChanged) {
          throw firstErr;
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
        info = await invoke<ServerInfo>("check_server_installation", sshParams);
      }
      setServerInfo(info);
      // R2-F08 (Plan 09-37, REVISED): authoritative-read producer for usersKnown.
      // The defect was `|| !silent`, which flipped true on the racy NON-SILENT mount
      // load (where the creds grep fail-softs to []). Corrected rules:
      if (!info.installed) {
        // Users card is not shown on a non-installed server — never strand the
        // sentinel; resolve immediately so the install screen isn't blocked.
        setUsersKnownSynced(true);
      } else if (info.users.length > 0) {
        // Populated list is unambiguous proof the count is known.
        setUsersKnownSynced(true);
      } else {
        // installed + empty: could be the cold-start race OR a genuine zero. Don't
        // flip yet. Arm EXACTLY ONE confirming SILENT re-probe (gated by the ref).
        // The re-probe's own settle runs this branch again: populated → set true
        // above; STILL empty → the confirm-in-flight ref is set, so we accept it as
        // a CONFIRMED zero here instead of looping.
        if (usersConfirmInFlightRef.current) {
          // This IS the confirming re-probe and it's still empty → confirmed zero.
          setUsersKnownSynced(true);
        } else if (!usersKnownRef.current) {
          // First empty installed settle → schedule the single confirming re-probe.
          usersConfirmInFlightRef.current = true;
          if (usersConfirmTimeoutRef.current) clearTimeout(usersConfirmTimeoutRef.current);
          usersConfirmTimeoutRef.current = setTimeout(() => {
            usersConfirmTimeoutRef.current = null;
            // Silent so it doesn't toggle loading/skeleton or re-log; loadServerInfo
            // early-returns if host is empty (e.g. after a disconnect).
            void loadServerInfo(true);
          }, 1200);
        }
      }
      if (!silent) setError("");

      // If installed, load config + cert in parallel
      if (info.installed && !silent) {
        const [cfgResult, certResult] = await Promise.allSettled([
          invoke<string>("server_get_config", sshParams),
          invoke<unknown>("server_get_cert_info", sshParams),
        ]);
        if (cfgResult.status === "fulfilled") {
          const val = cfgResult.value;
          setConfigRaw(typeof val === "string" ? val : JSON.stringify(val));
        }
        if (certResult.status === "fulfilled") setCertRaw(certResult.value);
      }
      // Phase 13.UAT G-02: panelDataLoaded=true даже если server NOT installed.
      // Иначе ControlPanelPage skeleton overlay не снимается (isFirstConnect стоит
      // ждёт onPanelReady), пользователь видит вечный skeleton вместо install screen.
      if (!silent) {
        setPanelDataLoaded(true);
        const dur = Date.now() - loadStartMs;
        activityLog(
          "STATE",
          `panel.load.completed installed=${info.installed} version=${info.version || "-"} dur=${dur}ms`,
          "useServerState.loadServerInfo",
        );
      }
    } catch (e) {
      if (!silent) {
        const errStr = formatError(e);
        // G-07: log RAW error до translateSshError — чтобы видеть настоящую причину
        // даже если UI показывает "неверный пароль" (translateSshError может
        // переклассифицировать SSH timeout / network / broken pipe как auth fail).
        const dur = Date.now() - loadStartMs;
        activityLog(
          "ERROR",
          `panel.load.failed dur=${dur}ms raw="${errStr.replace(/"/g, "'").slice(0, 300)}"`,
          "useServerState.loadServerInfo",
        );
        if (errStr.includes("HOST_KEY_CHANGED") || errStr.includes("Unknown server key")) {
          await invoke("forget_ssh_host_key", { host, port: parseInt(port) || 22 }).catch(() => {});
          setError(t("sshErrors.hostKeyReset", "Host key was reset. Please retry."));
        } else {
          setError(translateSshError(errStr, t));
        }
        setServerInfo(null);
        // Также при ошибке — снимаем skeleton, ServerPanel покажет error UI с retry.
        setPanelDataLoaded(true);
      }
    } finally {
      if (!silent) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, port, sshUser, sshPassword, sshKeyPath]);

  // R2-F08 (Plan 09-37, REVISED): reset the users sentinel whenever the connection
  // target changes (server switch) or disconnects. Without this a freshly-selected
  // server would inherit the previous server's usersKnown=true and skip the skeleton
  // (showing a stale/0 count for a moment). We key on the same connection identity
  // the load effect uses. The cleanup also cancels any pending confirm re-probe so a
  // stale timer can't silently re-probe the OLD host after the user switched servers.
  useEffect(() => {
    setUsersKnownSynced(false);
    usersConfirmInFlightRef.current = false;
    if (usersConfirmTimeoutRef.current) {
      clearTimeout(usersConfirmTimeoutRef.current);
      usersConfirmTimeoutRef.current = null;
    }
    return () => {
      // On host change / unmount: clear the pending confirm timer (loadServerInfo
      // early-returns on empty host, but cancel anyway so no stale re-probe fires).
      if (usersConfirmTimeoutRef.current) {
        clearTimeout(usersConfirmTimeoutRef.current);
        usersConfirmTimeoutRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, port, sshUser, sshPassword, sshKeyPath]);

  useEffect(() => {
    loadServerInfo();
  }, [loadServerInfo]);

  // ─── Action helper ───
  const runAction = useCallback(
    async (name: string, fn: () => Promise<unknown>, successMessage?: string) => {
      setActionLoading(name);
      setActionResult(null);
      try {
        await fn();
        // Refresh state first, then show snackbar
        await loadServerInfo(true);
        pushSuccess(successMessage || t("server.actions.success_generic"));
      } catch (e) {
        setActionResult({ type: "error", message: translateSshError(formatError(e), t) });
      } finally {
        setActionLoading(null);
      }
    },
    [loadServerInfo, t, pushSuccess]
  );

  // ─── Auto-dismiss action result after 5 seconds (errors only) ───
  useEffect(() => {
    if (!actionResult || actionResult.type === "ok") return;
    const timer = setTimeout(() => setActionResult(null), 5000);
    return () => clearTimeout(timer);
  }, [actionResult]);

  // ─── Optimistic user state updates ───
  const addUserToState = useCallback((username: string) => {
    setServerInfo((prev) => (prev ? { ...prev, users: [...prev.users, username] } : prev));
    // R2-F08 (Plan 09-37): an optimistic add means the user list is now populated,
    // so users are unambiguously known — flip the sentinel even if a populating
    // load hasn't landed yet (keeps the Users card off the skeleton). Use the synced
    // setter so usersKnownRef stays accurate for the loadServerInfo producer.
    setUsersKnownSynced(true);
  }, [setUsersKnownSynced]);

  const removeUserFromState = useCallback((username: string) => {
    setServerInfo((prev) => (prev ? { ...prev, users: prev.users.filter((u) => u !== username) } : prev));
  }, []);

  // ─── Username validation (depends on users domain + serverInfo) ───
  const usernameError = (() => {
    const trimmed = users.newUsername.trim();
    if (!trimmed) return "";
    if (/\s/.test(trimmed)) return "server.users.username_spaces";
    if (serverInfo?.users.includes(trimmed)) return "server.users.username_exists";
    return "";
  })();

  return {
    // Core
    serverInfo,
    // R2-F08 (Plan 09-37): consumed by OverviewSection's Users card to show the
    // loading skeleton until the user count is authoritatively known.
    usersKnown,
    loading,
    error,
    actionLoading,
    actionResult,
    setActionResult,
    pushSuccess,

    // Panel data (preloaded)
    configRaw,
    setConfigRaw,
    certRaw,
    setCertRaw,
    panelDataLoaded,

    // Domain slices — flattened onto ServerState for backward compat (D-06).
    ...users,
    ...versions,
    ...logs,
    ...dangerZone,

    // Helpers
    sshParams,
    loadServerInfo,
    runAction,
    usernameError,

    // Optimistic updates
    addUserToState,
    removeUserFromState,
    setServerInfo,
    setActionLoading,

    // Configuration-tab refresh signal (UAT-F01)
    configEpoch,
    bumpConfigEpoch,

    // Props pass-through
    host,
    port,
    onDisconnect: props.onDisconnect,
    onSwitchToSetup,
    onClearConfig,
    onConfigExported,
    onPortChanged,
  };
}

export type ServerState = ReturnType<typeof useServerState>;

// Re-export domain state types for consumers that want to depend on slices.
export type { UsersState, VersionsState, LogsState, DangerZoneState };
