import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { WizardStep, DeployStep, DeployLog, ServerInfo } from "./types";

// ─── localStorage helpers ──────────────────────────
const STORAGE_KEY = "trusttunnel_wizard";
const OBFUSCATED_FIELDS = ["sshPassword", "vpnPassword"];

function loadSaved<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const obj = JSON.parse(raw);
    return obj[key] !== undefined ? obj[key] : fallback;
  } catch {
    return fallback;
  }
}

function saveField(key: string, value: unknown) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    if (OBFUSCATED_FIELDS.includes(key) && typeof value === "string" && value) {
      obj[key] = "b64:" + btoa(unescape(encodeURIComponent(value)));
    } else {
      obj[key] = value;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch { /* ignore */ }
}

function deobfuscate(val: string): string {
  if (val.startsWith("b64:")) {
    try { return decodeURIComponent(escape(atob(val.slice(4)))); } catch { return val; }
  }
  return val;
}

// ─── Hook ──────────────────────────────────────────
interface UseWizardStateParams {
  onSetupComplete: (configPath: string) => void;
  resetToWelcomeRef?: React.MutableRefObject<(() => void) | null>;
}

export function useWizardState({ onSetupComplete, resetToWelcomeRef }: UseWizardStateParams) {
  // ── Wizard navigation — persisted so tab switches don't reset ──
  const [step, setWizardStepRaw] = useState<WizardStep>(() => {
    const saved = loadSaved("wizardStep", "welcome") as WizardStep;
    const hasConfig = !!localStorage.getItem("tt_config_path");
    if ((saved === "done" || saved === "deploying" || saved === "fetching") && !hasConfig) return "welcome";
    const restorable: WizardStep[] = ["welcome", "server", "found", "endpoint", "done", "error"];
    if (restorable.includes(saved)) return saved;
    if (saved === "deploying" || saved === "fetching") return "endpoint";
    if (saved === "checking" || saved === "uninstalling") return "server";
    return "welcome";
  });
  const setWizardStep = useCallback((s: WizardStep) => {
    setWizardStepRaw(s);
    saveField("wizardStep", s);
  }, []);

  // ── SSH credentials (persisted) ──
  const [host, setHost] = useState(() => loadSaved("host", ""));
  const [port, setPort] = useState(() => loadSaved("port", "22"));
  const [sshUser, setSshUser] = useState(() => loadSaved("sshUser", "root"));
  const [sshPassword, setSshPassword] = useState(() => deobfuscate(loadSaved("sshPassword", "")));
  const [sshKeyPath, setSshKeyPath] = useState(() => loadSaved("sshKeyPath", ""));
  const [showSshPassword, setShowSshPassword] = useState(false);

  // ── Endpoint settings (persisted) ──
  const [listenAddress, setListenAddress] = useState(() => loadSaved("listenAddress", "0.0.0.0:443"));
  const [vpnUsername, setVpnUsername] = useState(() => loadSaved("vpnUsername", ""));
  const [vpnPassword, setVpnPassword] = useState(() => deobfuscate(loadSaved("vpnPassword", "")));
  const [showVpnPassword, setShowVpnPassword] = useState(false);
  const [certType, setCertType] = useState<"selfsigned" | "letsencrypt" | "provided">(() => loadSaved("certType", "letsencrypt"));
  const [domain, setDomain] = useState(() => loadSaved("domain", ""));
  const [email, setEmail] = useState(() => loadSaved("email", ""));
  const [certChainPath, setCertChainPath] = useState(() => loadSaved("certChainPath", ""));
  const [certKeyPath, setCertKeyPath] = useState(() => loadSaved("certKeyPath", ""));
  const [showAdvanced, setShowAdvanced] = useState(false);

  // ── Server features toggles ──
  const [pingEnable, setPingEnable] = useState(() => loadSaved("pingEnable", false));
  const [speedtestEnable, setSpeedtestEnable] = useState(() => loadSaved("speedtestEnable", false));
  const [ipv6Available, setIpv6Available] = useState(() => loadSaved("ipv6Available", true));

  // ── Fetch retry count ──
  const [fetchRetryCount, setFetchRetryCount] = useState(0);

  // ── Server check state ──
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
  const [checkError, setCheckError] = useState("");
  const [confirmUninstall, setConfirmUninstall] = useState(false);

  // ── Add user form ──
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [addingUser, setAddingUser] = useState(false);
  const [deletingUser, setDeletingUser] = useState<string | null>(null);
  const [confirmDeleteUser, setConfirmDeleteUser] = useState<string | null>(null);
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [cameFromFound, setCameFromFound] = useState(false);

  // ── Deploy state — persisted ──
  const [deploySteps, setDeploySteps] = useState<Record<string, DeployStep>>(() => {
    try { return JSON.parse(loadSaved("deploySteps", "{}") as string); } catch { return {}; }
  });
  const [deployLogs, setDeployLogs] = useState<DeployLog[]>(() => {
    try { return JSON.parse(loadSaved("deployLogs", "[]") as string) as DeployLog[]; } catch { return []; }
  });
  const [showLogs, setShowLogs] = useState(false);
  const [errorMessage, setErrorMessage] = useState(() => loadSaved("errorMessage", ""));
  const [configPath, setConfigPath] = useState(() => loadSaved("configPath", ""));
  const [copied, setCopied] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // Tracks current operation so the event listener only reacts to relevant events
  const operationRef = useRef<"deploy" | "fetch" | "uninstall" | null>(null);
  const checkCancelledRef = useRef(false);

  // ── Save config for a user — fetch + save dialog without leaving current screen ──
  const [savingConfigFor, setSavingConfigFor] = useState<string | null>(null);

  // ── Fetch mode ──
  const isFetchMode = (loadSaved("wizardMode", "") as string) === "fetch";

  // ── Expose reset-to-welcome function for sidebar navigation ──
  useEffect(() => {
    if (resetToWelcomeRef) {
      resetToWelcomeRef.current = () => setWizardStep("welcome");
    }
    return () => { if (resetToWelcomeRef) resetToWelcomeRef.current = null; };
  }, [resetToWelcomeRef, setWizardStep]);

  // ── Persist form fields on change ──
  useEffect(() => { saveField("host", host); }, [host]);
  useEffect(() => { saveField("port", port); }, [port]);
  useEffect(() => { saveField("sshUser", sshUser); }, [sshUser]);
  useEffect(() => { saveField("sshPassword", sshPassword); }, [sshPassword]);
  useEffect(() => { saveField("sshKeyPath", sshKeyPath); }, [sshKeyPath]);
  useEffect(() => { saveField("listenAddress", listenAddress); }, [listenAddress]);
  useEffect(() => { saveField("vpnUsername", vpnUsername); }, [vpnUsername]);
  useEffect(() => { saveField("vpnPassword", vpnPassword); }, [vpnPassword]);
  useEffect(() => { saveField("certType", certType); }, [certType]);
  useEffect(() => { saveField("domain", domain); }, [domain]);
  useEffect(() => { saveField("email", email); }, [email]);
  useEffect(() => { saveField("certChainPath", certChainPath); }, [certChainPath]);
  useEffect(() => { saveField("certKeyPath", certKeyPath); }, [certKeyPath]);
  useEffect(() => { saveField("pingEnable", pingEnable); }, [pingEnable]);
  useEffect(() => { saveField("speedtestEnable", speedtestEnable); }, [speedtestEnable]);
  useEffect(() => { saveField("ipv6Available", ipv6Available); }, [ipv6Available]);

  // ── Persist deploy state ──
  useEffect(() => { saveField("deploySteps", JSON.stringify(deploySteps)); }, [deploySteps]);
  useEffect(() => { saveField("deployLogs", JSON.stringify(deployLogs.slice(-200))); }, [deployLogs]);
  useEffect(() => { saveField("configPath", configPath); }, [configPath]);
  useEffect(() => { saveField("errorMessage", errorMessage); }, [errorMessage]);

  // ── Copy logs to clipboard ──
  const copyLogsToClipboard = () => {
    const text = deployLogs.map((l) => `[${l.level}] ${l.message}`).join("\n");
    const full = errorMessage ? `ERROR: ${errorMessage}\n\n${text}` : text;
    navigator.clipboard.writeText(full).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  // ── Auto-scroll logs ──
  useEffect(() => {
    if (logsEndRef.current && showLogs) {
      logsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [deployLogs, showLogs]);

  // ── Tauri event listeners ──
  useEffect(() => {
    const unlistenStep = listen<DeployStep>("deploy-step", (event) => {
      const { step: s, status, message } = event.payload;
      setDeploySteps((prev) => ({ ...prev, [s]: { step: s, status, message } }));

      const op = operationRef.current;
      if (op !== "deploy" && op !== "fetch") return;

      if (s === "done" && status === "ok") {
        setTimeout(() => setWizardStep("done"), 600);
      }
      if (status === "error") {
        setErrorMessage(message);
        setWizardStep("error");
      }
    });

    const unlistenLog = listen<DeployLog>("deploy-log", (event) => {
      setDeployLogs((prev) => [...prev.slice(-300), event.payload]);
    });

    return () => {
      unlistenStep.then((f) => f());
      unlistenLog.then((f) => f());
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Action handlers ──

  const handleCheckServer = async () => {
    checkCancelledRef.current = false;
    setWizardStep("checking");
    setCheckError("");
    setServerInfo(null);
    try {
      const result = await invoke<ServerInfo>("check_server_installation", {
        host,
        port: parseInt(port),
        user: sshUser,
        password: sshPassword,
        keyPath: sshKeyPath || undefined,
      });
      if (checkCancelledRef.current) return;
      setServerInfo(result);
      if (result.installed) {
        setWizardStep("found");
      } else if (isFetchMode) {
        setWizardStep("found");
      } else {
        setWizardStep("endpoint");
      }
    } catch (e) {
      if (checkCancelledRef.current) return;
      setCheckError(String(e));
      setWizardStep("found");
      setServerInfo({ installed: false, version: "", serviceActive: false, users: [] });
    }
  };

  const cancelCheck = () => {
    checkCancelledRef.current = true;
    setWizardStep("server");
  };

  const handleUninstall = async () => {
    operationRef.current = "uninstall";
    setWizardStep("uninstalling");
    setDeploySteps({});
    setDeployLogs([]);
    setErrorMessage("");
    try {
      try { await invoke("vpn_disconnect"); } catch { /* already disconnected */ }
      await invoke("uninstall_server", {
        host,
        port: parseInt(port),
        user: sshUser,
        password: sshPassword,
        keyPath: sshKeyPath || undefined,
      });
      operationRef.current = null;
      setServerInfo(null);
      setWizardStep("server");
    } catch (e) {
      operationRef.current = null;
      setErrorMessage(String(e));
      setWizardStep("error");
    }
  };

  const [cancellingDeploy, setCancellingDeploy] = useState(false);

  const handleCancelDeploy = async () => {
    setCancellingDeploy(true);
    try {
      await invoke("uninstall_server", {
        host,
        port: parseInt(port),
        user: sshUser,
        password: sshPassword,
        keyPath: sshKeyPath || undefined,
      });
    } catch {
      // Uninstall failed (e.g. no internet) — just go back anyway
    }
    operationRef.current = null;
    setCancellingDeploy(false);
    setServerInfo(null);
    setWizardStep("server");
  };

  const handleDeploy = async () => {
    operationRef.current = "deploy";
    setWizardStep("deploying");
    setDeploySteps({});
    setDeployLogs([]);
    setErrorMessage("");

    try {
      const result = await invoke<string>("deploy_server", {
        host,
        port: parseInt(port),
        user: sshUser,
        password: sshPassword,
        keyPath: sshKeyPath || undefined,
        settings: {
          listenAddress,
          vpnUsername,
          vpnPassword,
          certType,
          domain: certType === "letsencrypt" ? domain : "",
          clientName: vpnUsername,
          email: certType === "letsencrypt" ? email : "",
          pingEnable,
          speedtestEnable,
          ipv6Available,
          certChainPath: certType === "provided" ? certChainPath : "",
          certKeyPath: certType === "provided" ? certKeyPath : "",
        },
      });
      setConfigPath(result);
    } catch (e) {
      setErrorMessage((prev) => prev || String(e));
      setWizardStep("error");
    } finally {
      operationRef.current = null;
    }
  };

  const handleSkip = async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "TrustTunnel Config", extensions: ["toml"] }],
    });
    if (selected) {
      // Import → go to VPN settings, not control panel
      localStorage.setItem("tt_navigate_after_setup", "settings");
      try {
        const copied = await invoke<string>("copy_config_to_app_dir", { sourcePath: selected as string });
        onSetupComplete(copied);
      } catch {
        onSetupComplete(selected as string);
      }
    }
  };

  const handleFetchConfig = async (forUser?: string) => {
    operationRef.current = "fetch";
    setWizardStep("fetching");
    setDeploySteps({});
    setDeployLogs([]);
    setErrorMessage("");

    try {
      const result = await invoke<string>("fetch_server_config", {
        host,
        port: parseInt(port),
        user: sshUser,
        password: sshPassword,
        keyPath: sshKeyPath || undefined,
        clientName: forUser || vpnUsername || "",
      });
      setConfigPath(result);
      setFetchRetryCount(0);
    } catch (e) {
      setFetchRetryCount((c) => c + 1);
      setErrorMessage((prev) => prev || String(e));
      setWizardStep("error");
    } finally {
      operationRef.current = null;
    }
  };

  const handleSaveConfigDirect = async (forUser: string) => {
    setSavingConfigFor(forUser);
    try {
      const result = await invoke<string>("fetch_server_config", {
        host,
        port: parseInt(port),
        user: sshUser,
        password: sshPassword,
        keyPath: sshKeyPath || undefined,
        clientName: forUser,
      });
      const fileName = `trusttunnel_${forUser}.toml`;
      const dest = await save({
        defaultPath: fileName,
        filters: [{ name: "TOML Config", extensions: ["toml"] }],
      });
      if (dest) {
        try {
          await invoke("copy_file", { source: result, destination: dest });
        } catch { /* fallback: config already saved to app dir */ }
      }
    } catch (e) {
      setErrorMessage(String(e));
    } finally {
      setSavingConfigFor(null);
    }
  };

  const handleAddUser = async () => {
    if (!newUsername.trim() || !newPassword.trim()) return;
    setAddingUser(true);
    setErrorMessage("");

    try {
      await invoke<string>("add_server_user", {
        host,
        port: parseInt(port),
        user: sshUser,
        password: sshPassword,
        keyPath: sshKeyPath || undefined,
        vpnUsername: newUsername.trim(),
        vpnPassword: newPassword.trim(),
      });
      try {
        const result = await invoke<ServerInfo>("check_server_installation", {
          host,
          port: parseInt(port),
          user: sshUser,
          password: sshPassword,
        keyPath: sshKeyPath || undefined,
        });
        setServerInfo(result);
      } catch { /* keep current serverInfo */ }
      setNewUsername("");
      setNewPassword("");
    } catch (e) {
      setErrorMessage(String(e));
    } finally {
      setAddingUser(false);
    }
  };

  const handleDeleteUser = async (username: string) => {
    setDeletingUser(username);
    setConfirmDeleteUser(null);
    try {
      await invoke("server_remove_user", {
        host,
        port: parseInt(port),
        user: sshUser,
        password: sshPassword,
        keyPath: sshKeyPath || undefined,
        vpnUsername: username,
      });
      try {
        const result = await invoke<ServerInfo>("check_server_installation", {
          host,
          port: parseInt(port),
          user: sshUser,
          password: sshPassword,
        keyPath: sshKeyPath || undefined,
        });
        setServerInfo(result);
      } catch { /* keep current */ }
    } catch (e) {
      setErrorMessage(String(e));
    } finally {
      setDeletingUser(null);
    }
  };

  const handleSaveAs = async () => {
    const fileName = configPath.split(/[/\\]/).pop() || "trusttunnel_client.toml";
    const dest = await save({
      defaultPath: fileName,
      filters: [{ name: "TOML Config", extensions: ["toml"] }],
    });
    if (dest) {
      try {
        await invoke("copy_file", { source: configPath, destination: dest });
      } catch (e) {
        console.error("Save As failed:", e);
      }
    }
  };

  // ── Derived state ──
  const canGoToEndpoint = host.trim().length > 0 && (sshPassword.length > 0 || sshKeyPath.length > 0);
  const isValidEmail = (e: string) => !e.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
  const canDeploy =
    vpnUsername.trim().length > 0 &&
    vpnPassword.length > 0 &&
    (certType === "selfsigned" ||
     (certType === "letsencrypt" && domain.trim().length > 0 && isValidEmail(email)) ||
     (certType === "provided" && certChainPath.trim().length > 0 && certKeyPath.trim().length > 0));

  return {
    // Current step
    step,
    setWizardStep,
    isFetchMode,

    // SSH
    host, setHost,
    port, setPort,
    sshUser, setSshUser,
    sshPassword, setSshPassword,
    sshKeyPath, setSshKeyPath,
    showSshPassword, setShowSshPassword,

    // Endpoint settings
    listenAddress, setListenAddress,
    vpnUsername, setVpnUsername,
    vpnPassword, setVpnPassword,
    showVpnPassword, setShowVpnPassword,
    certType, setCertType,
    domain, setDomain,
    email, setEmail,
    certChainPath, setCertChainPath,
    certKeyPath, setCertKeyPath,
    showAdvanced, setShowAdvanced,
    pingEnable, setPingEnable,
    speedtestEnable, setSpeedtestEnable,
    ipv6Available, setIpv6Available,

    // Server check
    serverInfo,
    checkError,
    confirmUninstall, setConfirmUninstall,

    // Add user
    newUsername, setNewUsername,
    newPassword, setNewPassword,
    showNewPassword, setShowNewPassword,
    addingUser,
    deletingUser,
    confirmDeleteUser, setConfirmDeleteUser,
    selectedUser, setSelectedUser,
    cameFromFound, setCameFromFound,

    // Deploy state
    deploySteps,
    deployLogs,
    showLogs, setShowLogs,
    errorMessage,
    configPath,
    copied,
    logsEndRef,

    // Fetch
    fetchRetryCount, setFetchRetryCount,
    savingConfigFor,

    // Derived
    canGoToEndpoint,
    isValidEmail,
    canDeploy,

    // Actions
    handleCheckServer,
    cancelCheck,
    handleUninstall,
    handleCancelDeploy,
    cancellingDeploy,
    handleDeploy,
    handleSkip,
    handleFetchConfig,
    handleSaveConfigDirect,
    handleAddUser,
    handleDeleteUser,
    handleSaveAs,
    copyLogsToClipboard,
    saveField,
    onSetupComplete,
  };
}

export type WizardState = ReturnType<typeof useWizardState>;
