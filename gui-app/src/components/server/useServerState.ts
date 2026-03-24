import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";

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
  onConfigExported: (configPath: string) => void;
}

export interface ServerInfo {
  installed: boolean;
  version: string;
  serviceActive: boolean;
  users: string[];
}

export type ActionResult = { type: "ok" | "error"; message: string } | null;

// ═══════════════════════════════════════════════════════
// Hook
// ═══════════════════════════════════════════════════════

export function useServerState(props: ServerPanelProps) {
  const { t } = useTranslation();
  const { host, port, sshUser, sshPassword, sshKeyPath, onSwitchToSetup, onClearConfig, onConfigExported } = props;

  // ─── State: Server Info ───
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<ActionResult>(null);

  // ─── State: Users ───
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [showNewPw, setShowNewPw] = useState(false);
  const [exportingUser, setExportingUser] = useState<string | null>(null);
  const [confirmDeleteUser, setConfirmDeleteUser] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [continueLoading, setContinueLoading] = useState(false);

  // ─── State: Versions ───
  const [availableVersions, setAvailableVersions] = useState<string[]>([]);
  const [selectedVersion, setSelectedVersion] = useState("");
  const [showVersions, setShowVersions] = useState(false);

  // ─── State: Logs ───
  const [serverLogs, setServerLogs] = useState("");
  const [showLogs, setShowLogs] = useState(false);
  const [logsLoading, setLogsLoading] = useState(false);

  // ─── State: Diagnostics ───
  const [diagResult, setDiagResult] = useState<string | null>(null);
  const [showDiag, setShowDiag] = useState(false);
  const [diagLoading, setDiagLoading] = useState(false);

  // ─── State: Danger Zone Confirms ───
  const [confirmReboot, setConfirmReboot] = useState(false);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const [uninstallLoading, setUninstallLoading] = useState(false);

  // ─── SSH params shorthand ───
  const sshParams = {
    host,
    port: parseInt(port),
    user: sshUser,
    password: sshPassword,
    keyPath: sshKeyPath || undefined,
  };

  // ─── Load server info ───
  const loadServerInfo = useCallback(async () => {
    if (!host || (!sshPassword && !sshKeyPath)) return;
    setLoading(true);
    setError("");
    try {
      const info = await invoke<ServerInfo>("check_server_installation", sshParams);
      setServerInfo(info);
    } catch (e) {
      setError(String(e));
      setServerInfo(null);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, port, sshUser, sshPassword, sshKeyPath]);

  useEffect(() => {
    loadServerInfo();
  }, [loadServerInfo]);

  // ─── Action helper ───
  const runAction = useCallback(
    async (name: string, fn: () => Promise<unknown>) => {
      setActionLoading(name);
      setActionResult(null);
      try {
        await fn();
        setActionResult({ type: "ok", message: t('server.actions.success', { action: name }) });
        setTimeout(() => loadServerInfo(), 1500);
      } catch (e) {
        setActionResult({ type: "error", message: String(e) });
      } finally {
        setActionLoading(null);
      }
    },
    [loadServerInfo, t]
  );

  // ─── Auto-dismiss action result after 5 seconds ───
  useEffect(() => {
    if (!actionResult) return;
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
    confirmDeleteUser,
    setConfirmDeleteUser,
    deleteLoading,
    setDeleteLoading,
    continueLoading,
    setContinueLoading,

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

    // Danger zone
    confirmReboot,
    setConfirmReboot,
    confirmUninstall,
    setConfirmUninstall,
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
    onSwitchToSetup,
    onClearConfig,
    onConfigExported,
  };
}

export type ServerState = ReturnType<typeof useServerState>;
