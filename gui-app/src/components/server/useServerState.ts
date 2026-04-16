import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { translateSshError } from "../../shared/utils/translateSshError";
import { formatError } from "../../shared/utils/formatError";
import { useSnackBar } from "../../shared/ui/SnackBarContext";
import { useUsersState, type UsersState } from "./useUsersState";
import { useVersionsState, type VersionsState } from "./useVersionsState";
import { useLogsState, type LogsState } from "./useLogsState";
import { useDiagnosticsState, type DiagnosticsState } from "./useDiagnosticsState";
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
 *   - useDiagnosticsState (diagResult, showDiag, diagLoading)
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<ActionResult>(null);
  const pushSuccess = useSnackBar();

  // ─── Panel data (config + cert) ───
  const [configRaw, setConfigRaw] = useState<string | null>(null);
  const [certRaw, setCertRaw] = useState<unknown>(null);
  const [panelDataLoaded, setPanelDataLoaded] = useState(false);

  // ─── Domain slices ───
  const users = useUsersState();
  const versions = useVersionsState(serverInfo);
  const logs = useLogsState();
  const diagnostics = useDiagnosticsState();
  const dangerZone = useDangerZoneState();

  // ─── SSH params shorthand ───
  const sshParams = {
    host,
    port: parseInt(port),
    user: sshUser,
    password: sshPassword,
    keyPath: sshKeyPath || undefined,
  };

  // ─── Load server info + panel data ───
  const loadServerInfo = useCallback(async (silent = false) => {
    if (!host || (!sshPassword && !sshKeyPath)) return;
    if (!silent) {
      setLoading(true);
      setError("");
    }
    try {
      const info = await invoke<ServerInfo>("check_server_installation", sshParams);
      setServerInfo(info);
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
        setPanelDataLoaded(true);
      }
    } catch (e) {
      if (!silent) {
        const errStr = formatError(e);
        if (errStr.includes("HOST_KEY_CHANGED") || errStr.includes("Unknown server key")) {
          await invoke("forget_ssh_host_key", { host, port: parseInt(port) || 22 }).catch(() => {});
          setError(t("sshErrors.hostKeyReset", "Host key was reset. Please retry."));
        } else {
          setError(translateSshError(errStr, t));
        }
        setServerInfo(null);
      }
    } finally {
      if (!silent) setLoading(false);
    }
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
  }, []);

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
    ...diagnostics,
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
export type { UsersState, VersionsState, LogsState, DiagnosticsState, DangerZoneState };
