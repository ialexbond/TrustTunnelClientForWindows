import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { translateSshError } from "../../shared/utils/translateSshError";
import { formatError } from "../../shared/utils/formatError";
import { useSnackBar } from "../../shared/ui/SnackBarContext";

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

export function useServerState(props: ServerPanelProps) {
  const { t } = useTranslation();
  const { host, port, sshUser, sshPassword, sshKeyPath, onSwitchToSetup, onClearConfig, onConfigExported, onPortChanged } = props;

  // ─── State: Server Info ───
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<ActionResult>(null);
  const pushSuccess = useSnackBar();

  // ─── State: Users ───
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [showNewPw, setShowNewPw] = useState(false);
  const [exportingUser, setExportingUser] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [continueLoading, setContinueLoading] = useState(false);

  // ─── State: Versions ───
  const [availableVersions, setAvailableVersions] = useState<string[]>([]);
  const [selectedVersion, setSelectedVersion] = useState("");
  const [showVersions, setShowVersions] = useState(false);

  // ─── State: Panel data (config + cert) ───
  const [configRaw, setConfigRaw] = useState<string | null>(null);
  const [certRaw, setCertRaw] = useState<unknown>(null);
  const [panelDataLoaded, setPanelDataLoaded] = useState(false);

  // ─── State: Logs ───
  const [serverLogs, setServerLogs] = useState("");
  const [showLogs, setShowLogs] = useState(false);
  const [logsLoading, setLogsLoading] = useState(false);

  // ─── State: Diagnostics ───
  const [diagResult, setDiagResult] = useState<string | null>(null);
  const [showDiag, setShowDiag] = useState(false);
  const [diagLoading, setDiagLoading] = useState(false);

  // ─── State: Reboot ───
  const [rebooting, setRebooting] = useState(false);

  // ─── State: Danger Zone ───
  const [uninstallLoading, setUninstallLoading] = useState(false);

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
      } else if (info.installed && silent) {
        // Silent refresh — don't reload config/cert
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
        pushSuccess(successMessage || t('server.actions.success_generic'));
      } catch (e) {
        setActionResult({ type: "error", message: translateSshError(formatError(e), t) });
      } finally {
        setActionLoading(null);
      }
    },
    [loadServerInfo, t, pushSuccess]
  );

  // ─── Auto-dismiss action result after 5 seconds (errors only, success goes to snackbar queue) ───
  useEffect(() => {
    if (!actionResult || actionResult.type === "ok") return;
    const timer = setTimeout(() => setActionResult(null), 5000);
    return () => clearTimeout(timer);
  }, [actionResult]);

  // ─── Load available versions ───
  useEffect(() => {
    invoke<string[]>("server_get_available_versions")
      .then((versions) => {
        setAvailableVersions(versions);
        if (versions.length > 0) setSelectedVersion(versions[0]);
      })
      .catch(() => {});
  }, []);

  // Once server info loads, switch selection to current installed version
  useEffect(() => {
    if (!serverInfo?.version || availableVersions.length === 0) return;
    const currentV = serverInfo.version.replace(/^v/, "");
    const match = availableVersions.find(v => v.replace(/^v/, "") === currentV);
    if (match) setSelectedVersion(match);
  }, [serverInfo?.version, availableVersions]);

  // ─── Optimistic user state updates ───
  const addUserToState = useCallback((username: string) => {
    setServerInfo(prev => prev ? { ...prev, users: [...prev.users, username] } : prev);
  }, []);

  const removeUserFromState = useCallback((username: string) => {
    setServerInfo(prev => prev ? { ...prev, users: prev.users.filter(u => u !== username) } : prev);
  }, []);

  // ─── Username validation ───
  const usernameError = (() => {
    const trimmed = newUsername.trim();
    if (!trimmed) return "";
    if (/\s/.test(trimmed)) return "server.users.username_spaces";
    if (serverInfo?.users.includes(trimmed)) return "server.users.username_exists";
    return "";
  })();

  return {
    // Server info
    serverInfo,
    loading,
    error,
    actionLoading,
    actionResult,
    setActionResult,
    pushSuccess,

    // Users
    selectedUser,
    setSelectedUser,
    newUsername,
    setNewUsername,
    newPassword,
    setNewPassword,
    showNewPw,
    setShowNewPw,
    exportingUser,
    setExportingUser,
    deleteLoading,
    setDeleteLoading,
    continueLoading,
    setContinueLoading,

    // Panel data (preloaded)
    configRaw,
    setConfigRaw,
    certRaw,
    setCertRaw,
    panelDataLoaded,

    // Versions
    availableVersions,
    selectedVersion,
    setSelectedVersion,
    showVersions,
    setShowVersions,

    // Logs
    serverLogs,
    setServerLogs,
    showLogs,
    setShowLogs,
    logsLoading,
    setLogsLoading,

    // Diagnostics
    diagResult,
    setDiagResult,
    showDiag,
    setShowDiag,
    diagLoading,
    setDiagLoading,

    // Reboot
    rebooting,
    setRebooting,

    // Danger zone
    uninstallLoading,
    setUninstallLoading,

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
