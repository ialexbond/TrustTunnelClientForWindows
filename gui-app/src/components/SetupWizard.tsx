import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  Shield,
  Server,
  Settings,
  Loader2,
  CheckCircle2,
  XCircle,
  Eye,
  EyeOff,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Rocket,
  Globe,
  Lock,
  User,
  Copy,
  ClipboardCheck,
  FolderOpen,
  AlertTriangle,
  Mail,
  Trash2,
  RefreshCw,
  PackageCheck,
  Download,
  UserPlus,
} from "lucide-react";

interface DeployStep {
  step: string;
  status: string;
  message: string;
}

interface DeployLog {
  message: string;
  level: string;
}

type WizardStep = "welcome" | "server" | "checking" | "found" | "uninstalling" | "endpoint" | "deploying" | "fetching" | "done" | "error";

interface SetupWizardProps {
  onSetupComplete: (configPath: string) => void;
  resetToWelcomeRef?: React.MutableRefObject<(() => void) | null>;
}

const STEPS_ORDER = [
  "connect", "auth", "check", "update", "install", "configure", "service", "export", "save", "done",
];
const STEP_LABELS: Record<string, string> = {
  connect: "Подключение к серверу",
  auth: "Авторизация",
  check: "Проверка окружения",
  update: "Обновление системы",
  install: "Установка TrustTunnel",
  configure: "Настройка Endpoint",
  service: "Запуск сервиса",
  export: "Экспорт конфига",
  save: "Сохранение",
  done: "Готово",
};

// localStorage helpers
const STORAGE_KEY = "trusttunnel_wizard";

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
    // Obfuscate password fields with base64
    if (OBFUSCATED_FIELDS.includes(key) && typeof value === "string" && value) {
      obj[key] = "b64:" + btoa(unescape(encodeURIComponent(value)));
    } else {
      obj[key] = value;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch { /* ignore */ }
}

const OBFUSCATED_FIELDS = ["sshPassword", "vpnPassword"];

function deobfuscate(val: string): string {
  if (val.startsWith("b64:")) {
    try { return decodeURIComponent(escape(atob(val.slice(4)))); } catch { return val; }
  }
  return val;
}

function ConfirmDialog({ open, title, message, onConfirm, onCancel, loading }: {
  open: boolean; title: string; message: string;
  onConfirm: () => void; onCancel: () => void; loading?: boolean;
}) {
  if (!open) return null;
  return createPortal(
    <div className="flex items-center justify-center"
      style={{ position: "fixed", top: "-50px", left: "-50px", right: "-50px", bottom: "-50px", zIndex: 9999, backgroundColor: "rgba(0,0,0,0.4)", backdropFilter: "blur(6px)" }}>
      <div className="max-w-sm w-full mx-4 p-6 rounded-2xl space-y-4 shadow-2xl" style={{ backgroundColor: "var(--color-bg-elevated)" }}>
        <h3 className="text-base font-semibold text-center" style={{ color: "var(--color-danger-500)" }}>{title}</h3>
        <p className="text-xs text-center leading-relaxed" style={{ color: "var(--color-text-secondary)" }}>{message}</p>
        <div className="flex gap-3">
          <button onClick={onCancel} disabled={loading}
            className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium transition-all active:scale-[0.97] hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ backgroundColor: "var(--color-bg-hover)", color: "var(--color-text-secondary)" }}>
            Отмена
          </button>
          <button onClick={onConfirm} disabled={loading}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all active:scale-[0.97] hover:opacity-80 disabled:opacity-70 disabled:cursor-not-allowed"
            style={{ backgroundColor: "var(--color-danger-500)", color: "white" }}>
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Удаление...
              </>
            ) : "Да, удалить"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function SetupWizard({ onSetupComplete, resetToWelcomeRef }: SetupWizardProps) {
  // Wizard navigation — persisted so tab switches don't reset
  const [wizardStep, setWizardStepRaw] = useState<WizardStep>(() => {
    const saved = loadSaved("wizardStep", "welcome") as WizardStep;
    // "done"/"deploying"/"fetching" only make sense if a config file was actually saved
    const hasConfig = !!localStorage.getItem("tt_config_path");
    if ((saved === "done" || saved === "deploying" || saved === "fetching") && !hasConfig) return "welcome";
    // Restore only stable steps; transient steps fall back to safe defaults
    const restorable: WizardStep[] = ["welcome", "server", "found", "endpoint", "done", "error"];
    if (restorable.includes(saved)) return saved;
    // "deploying"/"fetching" are dead after restart — go back to endpoint so user can retry
    if (saved === "deploying" || saved === "fetching") return "endpoint";
    if (saved === "checking" || saved === "uninstalling") return "server";
    return "welcome";
  });
  const setWizardStep = useCallback((step: WizardStep) => {
    setWizardStepRaw(step);
    saveField("wizardStep", step);
  }, []);

  // SSH credentials (persisted)
  const [host, setHost] = useState(() => loadSaved("host", ""));
  const [port, setPort] = useState(() => loadSaved("port", "22"));
  const [sshUser, setSshUser] = useState(() => loadSaved("sshUser", "root"));
  const [sshPassword, setSshPassword] = useState(() => deobfuscate(loadSaved("sshPassword", "")));
  const [showSshPassword, setShowSshPassword] = useState(false);

  // Endpoint settings (persisted)
  const [listenAddress, setListenAddress] = useState(() => loadSaved("listenAddress", "0.0.0.0:443"));
  const [vpnUsername, setVpnUsername] = useState(() => loadSaved("vpnUsername", ""));
  const [vpnPassword, setVpnPassword] = useState(() => deobfuscate(loadSaved("vpnPassword", "")));
  const [showVpnPassword, setShowVpnPassword] = useState(false);
  const [certType, setCertType] = useState<"selfsigned" | "letsencrypt">(() => loadSaved("certType", "letsencrypt"));
  const [domain, setDomain] = useState(() => loadSaved("domain", ""));
  const [email, setEmail] = useState(() => loadSaved("email", ""));
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Fetch retry count — tracks consecutive fetch failures for reinstall prompt
  const [fetchRetryCount, setFetchRetryCount] = useState(0);

  // Server check state
  const [serverInfo, setServerInfo] = useState<{
    installed: boolean;
    version: string;
    serviceActive: boolean;
    users: string[];
  } | null>(null);
  const [checkError, setCheckError] = useState("");
  const [confirmUninstall, setConfirmUninstall] = useState(false);

  // Add user form
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [_addingUser, setAddingUser] = useState(false);
  const [_deletingUser, setDeletingUser] = useState<string | null>(null);
  const [confirmDeleteUser, setConfirmDeleteUser] = useState<string | null>(null);
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  // Track if we came from "found" screen to know where Back should go
  const [cameFromFound, setCameFromFound] = useState(false);

  // Deploy state — persisted
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

  // Expose reset-to-welcome function for sidebar navigation
  useEffect(() => {
    if (resetToWelcomeRef) {
      resetToWelcomeRef.current = () => setWizardStep("welcome");
    }
    return () => { if (resetToWelcomeRef) resetToWelcomeRef.current = null; };
  }, [resetToWelcomeRef, setWizardStep]);

  // Persist form fields on change
  useEffect(() => { saveField("host", host); }, [host]);
  useEffect(() => { saveField("port", port); }, [port]);
  useEffect(() => { saveField("sshUser", sshUser); }, [sshUser]);
  useEffect(() => { saveField("sshPassword", sshPassword); }, [sshPassword]);
  useEffect(() => { saveField("listenAddress", listenAddress); }, [listenAddress]);
  useEffect(() => { saveField("vpnUsername", vpnUsername); }, [vpnUsername]);
  useEffect(() => { saveField("vpnPassword", vpnPassword); }, [vpnPassword]);
  useEffect(() => { saveField("certType", certType); }, [certType]);
  useEffect(() => { saveField("domain", domain); }, [domain]);
  useEffect(() => { saveField("email", email); }, [email]);

  // Persist deploy state
  useEffect(() => { saveField("deploySteps", JSON.stringify(deploySteps)); }, [deploySteps]);
  useEffect(() => { saveField("deployLogs", JSON.stringify(deployLogs.slice(-200))); }, [deployLogs]);
  useEffect(() => { saveField("configPath", configPath); }, [configPath]);
  useEffect(() => { saveField("errorMessage", errorMessage); }, [errorMessage]);

  const copyLogsToClipboard = () => {
    const text = deployLogs.map((l) => `[${l.level}] ${l.message}`).join("\n");
    const full = errorMessage ? `ERROR: ${errorMessage}\n\n${text}` : text;
    navigator.clipboard.writeText(full).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  useEffect(() => {
    if (logsEndRef.current && showLogs) {
      logsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [deployLogs, showLogs]);

  useEffect(() => {
    const unlistenStep = listen<DeployStep>("deploy-step", (event) => {
      const { step, status, message } = event.payload;
      setDeploySteps((prev) => ({ ...prev, [step]: { step, status, message } }));

      // Only react to deploy/fetch operations, not uninstall or add_user
      const op = operationRef.current;
      if (op !== "deploy" && op !== "fetch") return;

      if (step === "done" && status === "ok") {
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

  const handleCheckServer = async () => {
    setWizardStep("checking");
    setCheckError("");
    setServerInfo(null);
    try {
      const result = await invoke<{
        installed: boolean;
        version: string;
        serviceActive: boolean;
        users: string[];
      }>("check_server_installation", {
        host,
        port: parseInt(port),
        user: sshUser,
        password: sshPassword,
      });
      setServerInfo(result);
      if (result.installed) {
        setWizardStep("found");
      } else if (isFetchMode) {
        // In fetch mode, show "not installed" screen instead of endpoint settings
        setWizardStep("found");
      } else {
        setWizardStep("endpoint");
      }
    } catch (e) {
      setCheckError(String(e));
      setWizardStep("found");
      setServerInfo({ installed: false, version: "", serviceActive: false, users: [] });
    }
  };

  const handleUninstall = async () => {
    operationRef.current = "uninstall";
    setWizardStep("uninstalling");
    setDeploySteps({});
    setDeployLogs([]);
    setErrorMessage("");
    try {
      // Disconnect VPN FIRST — if VPN routes all traffic through the server,
      // SSH will break when we stop the TrustTunnel service during uninstall
      try { await invoke("vpn_disconnect"); } catch { /* already disconnected */ }

      await invoke("uninstall_server", {
        host,
        port: parseInt(port),
        user: sshUser,
        password: sshPassword,
      });
      // Always go to endpoint settings so user can review/change params before deploying
      operationRef.current = null;
      setWizardStep("endpoint");
    } catch (e) {
      operationRef.current = null;
      setErrorMessage(String(e));
      setWizardStep("error");
    }
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
        settings: {
          listenAddress,
          vpnUsername,
          vpnPassword,
          certType,
          domain: certType === "letsencrypt" ? domain : "",
          clientName: vpnUsername,
          email: certType === "letsencrypt" ? email : "",
        },
      });
      setConfigPath(result);
    } catch (e) {
      // Only set error if the event listener hasn't already done so
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

  // Save config for a user — fetch + save dialog without leaving current screen
  const [savingConfigFor, setSavingConfigFor] = useState<string | null>(null);
  const handleSaveConfigDirect = async (forUser: string) => {
    setSavingConfigFor(forUser);
    try {
      const result = await invoke<string>("fetch_server_config", {
        host,
        port: parseInt(port),
        user: sshUser,
        password: sshPassword,
        clientName: forUser,
      });
      // Open save dialog
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
    const addedName = newUsername.trim();

    try {
      await invoke<string>("add_server_user", {
        host,
        port: parseInt(port),
        user: sshUser,
        password: sshPassword,
        vpnUsername: addedName,
        vpnPassword: newPassword.trim(),
      });
      // Re-check server to refresh user list BEFORE clearing fields
      try {
        const result = await invoke<{
          installed: boolean;
          version: string;
          serviceActive: boolean;
          users: string[];
        }>("check_server_installation", {
          host,
          port: parseInt(port),
          user: sshUser,
          password: sshPassword,
        });
        setServerInfo(result);
      } catch { /* keep current serverInfo */ }
      // Only clear fields AFTER user list is updated
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
    setConfirmDeleteUser(null); // Close dialog immediately
    try {
      await invoke("server_remove_user", {
        host,
        port: parseInt(port),
        user: sshUser,
        password: sshPassword,
        vpnUsername: username,
      });
      // Re-check server to refresh user list
      try {
        const result = await invoke<{
          installed: boolean;
          version: string;
          serviceActive: boolean;
          users: string[];
        }>("check_server_installation", {
          host,
          port: parseInt(port),
          user: sshUser,
          password: sshPassword,
        });
        setServerInfo(result);
      } catch { /* keep current */ }
    } catch (e) {
      setErrorMessage(String(e));
    } finally {
      setDeletingUser(null);
    }
  };

  const canGoToEndpoint = host.trim().length > 0 && sshPassword.length > 0;
  const isValidEmail = (e: string) => !e.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
  const canDeploy =
    vpnUsername.trim().length > 0 &&
    vpnPassword.length > 0 &&
    (certType !== "letsencrypt" || (domain.trim().length > 0 && isValidEmail(email)));

  // ─── Step indicator (top bar) ───────────────────
  const isFetchMode = (loadSaved("wizardMode", "") as string) === "fetch";
  const stepNumbers: { key: WizardStep; label: string }[] = isFetchMode
    ? [
        { key: "server", label: "Сервер" },
        { key: "checking", label: "Проверка" },
        { key: "fetching", label: "Сохранение конфига" },
      ]
    : [
        { key: "server", label: "Сервер" },
        { key: "checking", label: "Проверка" },
        { key: "endpoint", label: "Настройки" },
        { key: "deploying", label: "Установка" },
      ];

  const renderStepBar = () => {
    if (wizardStep === "welcome" || wizardStep === "done" || wizardStep === "error")
      return null;
    const stepMap: Record<string, string> = isFetchMode
      ? {
          server: "server",
          checking: "checking",
          found: "checking",
          fetching: "fetching",
        }
      : {
          server: "server",
          checking: "checking",
          found: "checking",
          uninstalling: "checking",
          endpoint: "endpoint",
          deploying: "deploying",
          fetching: "fetching",
        };
    const mapped = stepMap[wizardStep] || wizardStep;
    const currentIdx = stepNumbers.findIndex((s) => s.key === mapped);
    return (
      <div className="flex items-center justify-center gap-2 px-6 pt-4 pb-1">
        {stepNumbers.map((s, i) => (
          <div key={s.key} className="flex items-center gap-2">
            <div
              className="w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold transition-colors"
              style={
                i < currentIdx
                  ? { backgroundColor: "rgba(16, 185, 129, 0.1)", color: "var(--color-success-500)" }
                  : i === currentIdx
                  ? { backgroundColor: "rgba(99, 102, 241, 0.15)", color: "var(--color-accent-500)", boxShadow: "0 0 0 2px rgba(99, 102, 241, 0.5)" }
                  : { backgroundColor: "var(--color-bg-hover)", color: "var(--color-text-muted)" }
              }
            >
              {i < currentIdx ? "✓" : i + 1}
            </div>
            <span
              className="text-[11px]"
              style={{ color: i === currentIdx ? "var(--color-text-primary)" : "var(--color-text-muted)" }}
            >
              {s.label}
            </span>
            {i < stepNumbers.length - 1 && (
              <div
                className="w-8 h-px"
                style={{ backgroundColor: i < currentIdx ? "rgba(16, 185, 129, 0.3)" : "var(--color-border)" }}
              />
            )}
          </div>
        ))}
      </div>
    );
  };

  // ─── Welcome ────────────────────────────────────
  if (wizardStep === "welcome") {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-sm w-full text-center space-y-6">
          <div
            className="mx-auto w-16 h-16 rounded-2xl flex items-center justify-center"
            style={{ backgroundColor: "var(--color-accent-500)", boxShadow: "0 8px 24px rgba(99, 102, 241, 0.25)" }}
          >
            <Shield className="w-8 h-8 text-white" />
          </div>

          <div className="space-y-2">
            <h1 className="text-2xl font-bold" style={{ color: "var(--color-text-primary)" }}>
              TrustTunnel VPN
            </h1>
            <p className="text-sm leading-relaxed" style={{ color: "var(--color-text-secondary)" }}>
              Быстрый и защищённый VPN-протокол.
              <br />
              Настройте сервер за пару минут или используйте готовый конфиг.
            </p>
          </div>

          <div className="space-y-3">
            <button
              onClick={() => { saveField("wizardMode", ""); setWizardStep("server"); }}
              className="w-full flex items-center justify-center gap-2 py-3 px-6 rounded-xl font-semibold text-white text-sm active:scale-95 transition-all"
              style={{ backgroundColor: "var(--color-accent-500)", boxShadow: "0 4px 12px rgba(99, 102, 241, 0.3)" }}
            >
              <Server className="w-4 h-4" />
              Настроить сервер
            </button>
            <button
              onClick={() => { saveField("wizardMode", "fetch"); setWizardStep("server"); }}
              className="w-full px-6 py-3 rounded-xl text-sm transition-all flex items-center justify-center gap-2 active:scale-95"
              style={{
                backgroundColor: "rgba(99, 102, 241, 0.08)",
                border: "1px solid rgba(99, 102, 241, 0.25)",
                color: "var(--color-accent-500)",
              }}
            >
              <Download className="w-4 h-4" />
              Сохранить конфиг с сервера
            </button>
            <button
              onClick={handleSkip}
              className="w-full px-6 py-3 rounded-xl text-sm transition-all flex items-center justify-center gap-2 active:scale-95"
              style={{
                backgroundColor: "var(--color-bg-hover)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text-secondary)",
              }}
            >
              <FolderOpen className="w-4 h-4" />
              У меня есть конфиг
            </button>
          </div>

          <div className="space-y-0.5 pt-2">
            <p className="text-[11px]" style={{ color: "var(--color-text-muted)" }}>Для настройки сервера потребуется:</p>
            <p className="text-[11px]" style={{ color: "var(--color-text-muted)" }}>• Linux-сервер (Ubuntu 22+, Debian 11+) с SSH-доступом</p>
            <p className="text-[11px]" style={{ color: "var(--color-text-muted)" }}>• Минимум 1 ядро CPU и 512 МБ RAM (рекомендуется 1 ГБ)</p>
            <p className="text-[11px]" style={{ color: "var(--color-text-muted)" }}>• Права root • Домен, направленный на IP сервера</p>
          </div>
        </div>
      </div>
    );
  }

  // ─── Server Details (SSH) ───────────────────────
  if (wizardStep === "server") {
    return (
      <>
        {renderStepBar()}
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-sm w-full space-y-4">
            <div className="text-center space-y-1">
              <div className="mx-auto w-10 h-10 rounded-xl flex items-center justify-center" style={{ backgroundColor: "rgba(99, 102, 241, 0.1)" }}>
                <Server className="w-5 h-5" style={{ color: "var(--color-accent-500)" }} />
              </div>
              <h2 className="text-lg font-bold">Подключение к серверу</h2>
              <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>SSH-данные для доступа к вашему серверу</p>
            </div>

            <div className="space-y-3">
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="block text-[11px] mb-1" style={{ color: "var(--color-text-muted)" }}>IP-адрес сервера</label>
                  <input
                    type="text"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="123.45.67.89"
                    className="wizard-input !py-2"
                    autoFocus
                  />
                </div>
                <div className="w-20">
                  <label className="block text-[11px] mb-1" style={{ color: "var(--color-text-muted)" }}>Порт</label>
                  <input
                    type="text"
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    placeholder="22"
                    className="wizard-input !py-2"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] mb-1" style={{ color: "var(--color-text-muted)" }}>Имя пользователя</label>
                <input
                  type="text"
                  value={sshUser}
                  onChange={(e) => setSshUser(e.target.value)}
                  placeholder="root"
                  className="wizard-input !py-2"
                />
              </div>

              <div>
                <label className="block text-[11px] mb-1" style={{ color: "var(--color-text-muted)" }}>Пароль SSH</label>
                <div className="relative">
                  <input
                    type={showSshPassword ? "text" : "password"}
                    value={sshPassword}
                    onChange={(e) => setSshPassword(e.target.value)}
                    placeholder="••••••••"
                    className="wizard-input !py-2 pr-10"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && canGoToEndpoint) handleCheckServer();
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowSshPassword(!showSshPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 transition-colors" style={{ color: "var(--color-text-muted)" }}
                  >
                    {showSshPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>
            </div>

            <div className="flex gap-2 pt-1">
              <button
                onClick={() => { saveField("wizardMode", ""); setWizardStep("welcome"); }}
                className="px-4 py-2.5 rounded-xl text-sm transition-all active:scale-[0.97]"
                style={{ color: "var(--color-text-secondary)" }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--color-bg-hover)"}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
              >
                Назад
              </button>
              <button
                onClick={handleCheckServer}
                disabled={!canGoToEndpoint}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ backgroundColor: "var(--color-accent-500)", color: "white" }}
              >
                Далее
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </>
    );
  }

  // ─── Checking Server ────────────────────────────
  if (wizardStep === "checking") {
    return (
      <>
        {renderStepBar()}
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-sm w-full text-center space-y-5">
            <Loader2 className="w-10 h-10 animate-spin mx-auto" style={{ color: "var(--color-accent-500)" }} />
            <div className="space-y-1">
              <h2 className="text-lg font-bold">Проверяем сервер...</h2>
              <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                Подключение по SSH и проверка установленного TrustTunnel
              </p>
            </div>
            <button
              onClick={() => setWizardStep("server")}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm transition-all active:scale-[0.97]"
              style={{ color: "var(--color-text-secondary)" }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--color-bg-hover)"}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
            >
              Отмена
            </button>
          </div>
        </div>
      </>
    );
  }

  // ─── Found (Fetch mode): show users only, save config ──────────────
  if (wizardStep === "found" && isFetchMode) {
    const isInstalled = serverInfo?.installed;
    const users = serverInfo?.users || [];
    return (
      <>
        {renderStepBar()}
        <div className="flex-1 flex items-center justify-center p-6 overflow-y-auto">
          <div className="max-w-sm w-full text-center space-y-5 my-auto">
            {isInstalled && users.length > 0 ? (
              <>
                <div className="mx-auto w-14 h-14 rounded-2xl flex items-center justify-center" style={{ backgroundColor: "rgba(16, 185, 129, 0.1)" }}>
                  <User className="w-7 h-7" style={{ color: "var(--color-success-500)" }} />
                </div>
                <div className="space-y-1.5">
                  <h2 className="text-lg font-bold">Пользователи на сервере</h2>
                  <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                    Выберите пользователя для сохранения конфига
                  </p>
                </div>

                <div className="text-left space-y-1 p-3 rounded-xl" style={{ backgroundColor: "var(--color-bg-surface)", border: "1px solid var(--color-border)" }}>
                  {users.map((u) => (
                    <div key={u} className="flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg transition-colors cursor-default"
                      style={{ backgroundColor: "transparent" }}
                      onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--color-bg-hover)"}
                      onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
                    >
                      <span className="text-sm" style={{ color: "var(--color-text-primary)" }}>{u}</span>
                      <button
                        onClick={() => handleSaveConfigDirect(u)}
                        disabled={!!savingConfigFor}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:opacity-80 disabled:opacity-40"
                        style={{ backgroundColor: "var(--color-accent-500)", color: "white" }}
                      >
                        {savingConfigFor === u ? (
                          <>
                            <Loader2 className="w-3 h-3 animate-spin" />
                            Сохранение...
                          </>
                        ) : (
                          <>
                            <Download className="w-3 h-3" />
                            Сохранить
                          </>
                        )}
                      </button>
                    </div>
                  ))}
                </div>

                {errorMessage && (
                  <p className="text-xs" style={{ color: "var(--color-danger-500)" }}>{errorMessage}</p>
                )}

                <button
                  onClick={() => setWizardStep("welcome")}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm transition-all active:scale-[0.97]"
                  style={{ color: "var(--color-text-secondary)" }}
                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--color-bg-hover)"}
                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
                >
                  На главную
                </button>
              </>
            ) : isInstalled && users.length === 0 ? (
              <>
                <div className="mx-auto w-14 h-14 rounded-2xl flex items-center justify-center" style={{ backgroundColor: "rgba(245, 158, 11, 0.1)" }}>
                  <User className="w-7 h-7" style={{ color: "var(--color-warning-500)" }} />
                </div>
                <div className="space-y-1.5">
                  <h2 className="text-lg font-bold">Нет пользователей</h2>
                  <p className="text-xs" style={{ color: "var(--color-text-secondary)" }}>
                    TrustTunnel установлен на сервере, но пользователи не настроены. Настройте сервер, чтобы добавить пользователей.
                  </p>
                </div>
                <div className="flex gap-2 w-full">
                  <button
                    onClick={() => setWizardStep("server")}
                    className="px-4 py-2.5 rounded-xl text-sm transition-all active:scale-[0.97]"
                    style={{ color: "var(--color-text-secondary)" }}
                    onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--color-bg-hover)"}
                    onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
                  >
                    Назад
                  </button>
                  <button
                    onClick={() => { saveField("wizardMode", ""); setWizardStep("server"); }}
                    className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium transition-all active:scale-95"
                    style={{ backgroundColor: "var(--color-accent-500)", color: "white" }}
                  >
                    Настроить сервер
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="mx-auto w-14 h-14 rounded-2xl flex items-center justify-center" style={{ backgroundColor: "rgba(239, 68, 68, 0.08)" }}>
                  <XCircle className="w-7 h-7" style={{ color: "var(--color-danger-500)" }} />
                </div>
                <div className="space-y-1.5">
                  <h2 className="text-lg font-bold" style={{ color: "var(--color-danger-500)" }}>
                    {checkError ? "Сервер недоступен" : "TrustTunnel не установлен"}
                  </h2>
                  <p className="text-xs" style={{ color: "var(--color-text-secondary)" }}>
                    {checkError
                      ? "Не удалось подключиться к серверу по SSH. Проверьте данные подключения."
                      : "На сервере не найден TrustTunnel. Сначала настройте сервер."}
                  </p>
                  {checkError && (
                    <div className="max-h-20 overflow-y-auto rounded-lg p-2 mt-2" style={{ backgroundColor: "var(--color-bg-elevated)" }}>
                      <p className="text-[10px] leading-relaxed select-text cursor-text break-words" style={{ color: "var(--color-danger-500)", opacity: 0.8 }}>
                        {checkError}
                      </p>
                    </div>
                  )}
                </div>
                <div className="flex gap-2 w-full">
                  <button
                    onClick={() => setWizardStep("server")}
                    className="px-4 py-2.5 rounded-xl text-sm transition-all active:scale-[0.97]"
                    style={{ color: "var(--color-text-secondary)" }}
                    onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--color-bg-hover)"}
                    onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
                  >
                    Назад
                  </button>
                  <button
                    onClick={() => { saveField("wizardMode", ""); setWizardStep("server"); }}
                    className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium transition-all active:scale-95"
                    style={{ backgroundColor: "var(--color-accent-500)", color: "white" }}
                  >
                    Настроить сервер
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </>
    );
  }

  // ─── Found: TT already installed (setup mode) ──────────────
  if (wizardStep === "found") {
    const isInstalled = serverInfo?.installed;
    return (
      <>
        {renderStepBar()}
        <div className="flex-1 flex items-center justify-center p-6 overflow-y-auto">
          <div className="max-w-sm w-full text-center space-y-5 my-auto">
            {isInstalled ? (
              <>
                <div className="mx-auto w-14 h-14 rounded-2xl flex items-center justify-center" style={{ backgroundColor: "rgba(245, 158, 11, 0.1)" }}>
                  <PackageCheck className="w-7 h-7" style={{ color: "var(--color-warning-500)" }} />
                </div>
                <div className="space-y-1.5">
                  <h2 className="text-lg font-bold" style={{ color: "var(--color-warning-500)" }}>
                    TrustTunnel уже установлен
                  </h2>
                  {serverInfo?.version && (
                    <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                      Версия: {serverInfo.version}
                    </p>
                  )}
                  <p className="text-xs" style={{ color: "var(--color-text-secondary)" }}>
                    Сервис: {serverInfo?.serviceActive ? (
                      <span style={{ color: "var(--color-success-500)" }}>работает</span>
                    ) : (
                      <span style={{ color: "var(--color-text-muted)" }}>не запущен</span>
                    )}
                  </p>
                </div>

                {/* ── Users on server ── */}
                {serverInfo?.users && serverInfo.users.length > 0 && (
                  <div className="text-left space-y-2 p-3 rounded-xl" style={{ backgroundColor: "var(--color-bg-surface)", border: "1px solid var(--color-border)" }}>
                    <p className="text-[11px] font-semibold flex items-center gap-1.5" style={{ color: "var(--color-text-primary)" }}>
                      <User className="w-3.5 h-3.5" />
                      Пользователи на сервере
                    </p>
                    <div className="space-y-1">
                      {serverInfo.users.map((u) => {
                        const isSelected = selectedUser === u;
                        return (
                          <div key={u} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg transition-colors"
                            style={{ backgroundColor: isSelected ? "rgba(99, 102, 241, 0.1)" : "transparent", border: isSelected ? "1px solid rgba(99, 102, 241, 0.3)" : "1px solid transparent" }}
                            onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.backgroundColor = "var(--color-bg-hover)"; }}
                            onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.backgroundColor = "transparent"; }}
                          >
                            <button
                              onClick={() => setSelectedUser(u)}
                              className="flex items-center gap-2 flex-1 min-w-0 text-left"
                            >
                              <div className="w-3.5 h-3.5 rounded-full border-2 shrink-0 flex items-center justify-center"
                                style={{ borderColor: isSelected ? "var(--color-accent-500)" : "var(--color-border)" }}
                              >
                                {isSelected && <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: "var(--color-accent-500)" }} />}
                              </div>
                              <span className="text-xs truncate" style={{ color: isSelected ? "var(--color-accent-500)" : "var(--color-text-secondary)" }}>{u}</span>
                            </button>
                            <div className="flex items-center gap-0.5 shrink-0">
                              <button
                                onClick={() => handleSaveConfigDirect(u)}
                                disabled={!!savingConfigFor}
                                className="p-1.5 rounded-lg transition-all hover:opacity-70 disabled:opacity-40"
                                style={{ color: "var(--color-accent-500)" }}
                                title="Сохранить конфиг"
                              >
                                {savingConfigFor === u ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                              </button>
                              <button
                                onClick={() => !_deletingUser && setConfirmDeleteUser(u)}
                                disabled={!!_deletingUser}
                                className="p-1.5 rounded-lg transition-all hover:opacity-70 disabled:opacity-40"
                                style={{ color: "var(--color-danger-500)" }}
                                title="Удалить пользователя"
                              >
                                {_deletingUser === u ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <ConfirmDialog
                      open={!!confirmDeleteUser}
                      title="Удалить пользователя?"
                      message={`Пользователь «${confirmDeleteUser}» будет удалён с сервера. Его конфигурация перестанет работать.`}
                      onConfirm={() => confirmDeleteUser && handleDeleteUser(confirmDeleteUser)}
                      onCancel={() => setConfirmDeleteUser(null)}
                    />
                  </div>
                )}

                {/* ── Add new user ── */}
                <div className="text-left space-y-2 p-3 rounded-xl" style={{ backgroundColor: "var(--color-bg-surface)", border: "1px solid var(--color-border)" }}>
                  <p className="text-[11px] font-semibold flex items-center gap-1.5" style={{ color: "var(--color-text-primary)" }}>
                    <UserPlus className="w-3.5 h-3.5" />
                    Добавить пользователя
                  </p>
                  <p className="text-[10px] leading-relaxed" style={{ color: "var(--color-text-muted)" }}>
                    Каждое устройство должно подключаться под своим пользователем.
                  </p>
                  <div className="space-y-1.5">
                    <div>
                      <input
                        type="text"
                        placeholder="Имя пользователя"
                        value={newUsername}
                        onChange={(e) => setNewUsername(e.target.value.replace(/\s/g, ""))}
                        className="w-full px-3 py-1.5 rounded-lg text-xs outline-none" style={{ backgroundColor: "var(--color-bg-elevated)", border: "1px solid var(--color-border)", color: "var(--color-text-primary)" }}
                      />
                      {newUsername.trim() && serverInfo?.users?.includes(newUsername.trim()) && (
                        <p className="text-[10px] mt-0.5" style={{ color: "var(--color-danger-500)" }}>
                          Пользователь с таким именем уже существует
                        </p>
                      )}
                    </div>
                    <div className="relative">
                      <input
                        type={showNewPassword ? "text" : "password"}
                        placeholder="Пароль"
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        className="w-full px-3 py-1.5 pr-8 rounded-lg text-xs outline-none" style={{ backgroundColor: "var(--color-bg-elevated)", border: "1px solid var(--color-border)", color: "var(--color-text-primary)" }}
                      />
                      <button
                        type="button"
                        onClick={() => setShowNewPassword(!showNewPassword)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 transition-colors" style={{ color: "var(--color-text-muted)" }}
                      >
                        {showNewPassword ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                      </button>
                    </div>
                    <button
                      onClick={handleAddUser}
                      disabled={_addingUser || !newUsername.trim() || !newPassword.trim() || !!serverInfo?.users?.includes(newUsername.trim())}
                      className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
                      style={{ backgroundColor: "var(--color-accent-500)", color: "white" }}
                    >
                      {_addingUser ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          Добавляем...
                        </>
                      ) : (
                        <>
                          <UserPlus className="w-3.5 h-3.5" />
                          Добавить
                        </>
                      )}
                    </button>
                  </div>
                </div>

                {/* Continue button — always visible, disabled until user explicitly selected */}
                <button
                  onClick={() => { if (selectedUser) handleFetchConfig(selectedUser); }}
                  disabled={!selectedUser}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ backgroundColor: "var(--color-accent-500)", color: "white" }}
                >
                  Продолжить
                  <ChevronRight className="w-4 h-4" />
                </button>

                <div className="space-y-2 pt-1">
                  <button
                    onClick={handleSkip}
                    className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm transition-all active:scale-[0.97] hover:opacity-80"
                    style={{ backgroundColor: "var(--color-bg-hover)", border: "1px solid var(--color-border)", color: "var(--color-text-secondary)" }}
                  >
                    <FolderOpen className="w-4 h-4" />
                    Пропустить — у меня есть конфиг
                  </button>
                  <button
                    onClick={() => { setCameFromFound(true); setWizardStep("endpoint"); }}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm transition-all active:scale-[0.97] hover:opacity-80"
                    style={{ backgroundColor: "var(--color-bg-hover)", border: "1px solid var(--color-border)", color: "var(--color-text-secondary)" }}
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Переустановить TrustTunnel
                  </button>
                  <button
                    onClick={() => setConfirmUninstall(true)}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm transition-all active:scale-[0.97] hover:opacity-80"
                    style={{ backgroundColor: "rgba(239, 68, 68, 0.08)", border: "1px solid rgba(239, 68, 68, 0.25)", color: "var(--color-danger-500)" }}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Удалить TrustTunnel
                  </button>
                </div>
                <ConfirmDialog
                  open={confirmUninstall}
                  title="Вы уверены?"
                  message="Сервис будет остановлен, все файлы TrustTunnel будут удалены с сервера. Текущее VPN-подключение будет разорвано."
                  onConfirm={() => { setConfirmUninstall(false); handleUninstall(); }}
                  onCancel={() => setConfirmUninstall(false)}
                />
              </>
            ) : checkError ? (
              <>
                <div className="mx-auto w-14 h-14 rounded-2xl flex items-center justify-center" style={{ backgroundColor: "rgba(239, 68, 68, 0.08)" }}>
                  <XCircle className="w-7 h-7" style={{ color: "var(--color-danger-500)" }} />
                </div>
                <div className="space-y-1.5">
                  <h2 className="text-lg font-bold" style={{ color: "var(--color-danger-500)" }}>Сервер недоступен</h2>
                  <p className="text-xs" style={{ color: "var(--color-text-secondary)" }}>
                    Не удалось подключиться к серверу по SSH. Проверьте адрес, порт, логин и пароль.
                    Возможно, сервер недоступен из вашей сети.
                  </p>
                  <div className="max-h-20 overflow-y-auto rounded-lg p-2 mt-2" style={{ backgroundColor: "var(--color-bg-elevated)" }}>
                    <p className="text-[10px] leading-relaxed select-text cursor-text break-words" style={{ color: "var(--color-danger-500)", opacity: 0.8 }}>
                      {checkError}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setWizardStep("server")}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm transition-all active:scale-[0.97]"
                  style={{ color: "var(--color-text-secondary)" }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--color-bg-hover)"}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
                >
                  Назад
                </button>
              </>
            ) : (
              <>
                <div className="mx-auto w-14 h-14 rounded-2xl flex items-center justify-center" style={{ backgroundColor: "rgba(99, 102, 241, 0.1)" }}>
                  <Server className="w-7 h-7" style={{ color: "var(--color-accent-500)" }} />
                </div>
                <div className="space-y-1.5">
                  <h2 className="text-lg font-bold">Сервер готов к настройке</h2>
                  <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                    TrustTunnel не обнаружен — можно установить с нуля
                  </p>
                </div>
                <div className="flex gap-2 w-full">
                  <button
                    onClick={() => setWizardStep("server")}
                    className="px-4 py-2.5 rounded-xl text-sm transition-all active:scale-[0.97]"
                    style={{ color: "var(--color-text-secondary)" }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--color-bg-hover)"}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
                  >
                    Назад
                  </button>
                  <button
                    onClick={() => setWizardStep("endpoint")}
                    className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium transition-all active:scale-95"
                    style={{ backgroundColor: "var(--color-accent-500)", color: "white" }}
                  >
                    Продолжить настройку
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </>
            )}

            {isInstalled && (
              <button
                onClick={() => setWizardStep("server")}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm transition-all active:scale-[0.97]"
                style={{ color: "var(--color-text-secondary)" }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--color-bg-hover)"}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
              >
                Назад
              </button>
            )}
          </div>
        </div>
      </>
    );
  }

  // ─── Uninstalling ─────────────────────────────
  if (wizardStep === "uninstalling") {
    const step = deploySteps["uninstall"];
    return (
      <>
        {renderStepBar()}
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-sm w-full text-center space-y-5">
            {step?.status === "ok" ? (
              <CheckCircle2 className="w-10 h-10 mx-auto" style={{ color: "var(--color-success-500)" }} />
            ) : (
              <Loader2 className="w-10 h-10 animate-spin mx-auto" style={{ color: "var(--color-danger-500)" }} />
            )}
            <div className="space-y-1">
              <h2 className="text-lg font-bold">
                {step?.status === "ok"
                  ? "TrustTunnel удалён"
                  : "Удаление TrustTunnel..."}
              </h2>
              <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                {step?.message || "Останавливаем сервис и удаляем файлы..."}
              </p>
            </div>
          </div>
        </div>
      </>
    );
  }

  // ─── Endpoint Settings ──────────────────────────
  if (wizardStep === "endpoint") {
    return (
      <>
        {renderStepBar()}
        <div className="flex-1 flex items-center justify-center p-4 overflow-y-auto">
          <div className="max-w-sm w-full space-y-3">
            <div className="text-center space-y-1">
              <div className="mx-auto w-10 h-10 rounded-xl flex items-center justify-center" style={{ backgroundColor: "rgba(99, 102, 241, 0.1)" }}>
                <Settings className="w-5 h-5" style={{ color: "var(--color-accent-500)" }} />
              </div>
              <h2 className="text-lg font-bold">Настройки VPN</h2>
            </div>

            {/* VPN Credentials */}
            <div className="glass-card p-3 space-y-2">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--color-text-secondary)" }}>
                <User className="w-3 h-3" />
                Учётные данные VPN
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] mb-1" style={{ color: "var(--color-text-muted)" }}>Логин</label>
                  <input
                    type="text"
                    value={vpnUsername}
                    onChange={(e) => setVpnUsername(e.target.value)}
                    placeholder="vpnuser"
                    className="wizard-input !py-2 !text-xs"
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-[11px] mb-1" style={{ color: "var(--color-text-muted)" }}>Пароль</label>
                  <div className="relative">
                    <input
                      type={showVpnPassword ? "text" : "password"}
                      value={vpnPassword}
                      onChange={(e) => setVpnPassword(e.target.value)}
                      placeholder="••••••••"
                      className="wizard-input !py-2 !text-xs pr-9"
                    />
                    <button
                      type="button"
                      onClick={() => setShowVpnPassword(!showVpnPassword)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 transition-colors" style={{ color: "var(--color-text-muted)" }}
                    >
                      {showVpnPassword ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Certificate */}
            <div className="glass-card p-3 space-y-2">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--color-text-secondary)" }}>
                <Lock className="w-3 h-3" />
                TLS-сертификат
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setCertType("letsencrypt")}
                  className="p-2.5 rounded-xl text-xs text-left transition-all"
                  style={
                    certType === "letsencrypt"
                      ? { border: "1px solid rgba(16, 185, 129, 0.4)", backgroundColor: "rgba(16, 185, 129, 0.08)", color: "var(--color-text-primary)" }
                      : { border: "1px solid var(--color-border)", backgroundColor: "var(--color-bg-hover)", color: "var(--color-text-secondary)" }
                  }
                >
                  <div className="font-medium flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" style={{ color: "var(--color-success-500)" }} />
                    Let's Encrypt
                  </div>
                  <div className="text-[10px] mt-0.5" style={{ color: "var(--color-text-muted)" }}>Рекомендуется</div>
                </button>
                <button
                  disabled
                  className="p-2.5 rounded-xl text-xs text-left border cursor-not-allowed opacity-50"
                  style={{ borderColor: "var(--color-border)", color: "var(--color-text-muted)" }}
                >
                  <div className="font-medium">Самоподписанный</div>
                  <div className="text-[10px] mt-0.5" style={{ color: "var(--color-text-muted)" }}>Недоступно</div>
                </button>
              </div>

              {certType === "selfsigned" && (
                <div className="flex items-start gap-2 p-2 rounded-lg" style={{ backgroundColor: "rgba(245, 158, 11, 0.1)", border: "1px solid rgba(245, 158, 11, 0.15)" }}>
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: "var(--color-warning-500)" }} />
                  <p className="text-[10px] leading-relaxed" style={{ color: "var(--color-warning-500)" }}>
                    Самоподписанный сертификат небезопасен и может быть заблокирован.
                    Настоятельно рекомендуем использовать домен с Let's Encrypt.
                  </p>
                </div>
              )}

              {certType === "letsencrypt" && (
                <div className="space-y-2">
                  <div>
                    <label className="block text-[11px] mb-1" style={{ color: "var(--color-text-muted)" }}>Доменное имя</label>
                    <div className="relative">
                      <Globe className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5" style={{ color: "var(--color-text-muted)" }} />
                      <input
                        type="text"
                        value={domain}
                        onChange={(e) => setDomain(e.target.value)}
                        placeholder="vpn.example.com"
                        className="wizard-input !py-2 !text-xs pl-9"
                      />
                    </div>
                    <p className="text-[10px] mt-0.5" style={{ color: "var(--color-text-muted)" }}>
                      A-запись домена → {host || "IP сервера"}, порт 80 открыт
                    </p>
                  </div>
                  <div>
                    <label className="block text-[11px] mb-1" style={{ color: "var(--color-text-muted)" }}>Email для уведомлений</label>
                    <div className="relative">
                      <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5" style={{ color: "var(--color-text-muted)" }} />
                      <input
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="you@example.com"
                        className="wizard-input !py-2 !text-xs pl-9"
                      />
                    </div>
                    <p className="text-[10px] mt-0.5" style={{ color: email.trim() && !isValidEmail(email) ? "var(--color-danger-500)" : "var(--color-text-muted)" }}>
                      {email.trim() && !isValidEmail(email) ? "Введите корректный email" : "Необязательно · для уведомлений об обновлении сертификата"}
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* Advanced settings (collapsed) */}
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-1.5 text-[11px] transition-colors" style={{ color: "var(--color-text-muted)" }}
            >
              {showAdvanced ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              Дополнительные настройки
            </button>
            {showAdvanced && (
              <div className="glass-card p-3">
                <label className="block text-[11px] mb-1" style={{ color: "var(--color-text-muted)" }}>Адрес прослушивания</label>
                <input
                  type="text"
                  value={listenAddress}
                  onChange={(e) => setListenAddress(e.target.value)}
                  placeholder="0.0.0.0:443"
                  className="wizard-input !py-2 !text-xs"
                />
                <p className="text-[10px] mt-0.5" style={{ color: "var(--color-text-muted)" }}>
                  Оставьте по умолчанию, если не уверены
                </p>
              </div>
            )}

            {/* DNS warning */}
            {certType === "letsencrypt" && domain.trim() && (
              <div className="flex items-start gap-2.5 p-3 rounded-xl" style={{ backgroundColor: "rgba(245, 158, 11, 0.08)", border: "1px solid rgba(245, 158, 11, 0.2)" }}>
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: "var(--color-warning-500)" }} />
                <div className="text-[11px] leading-relaxed" style={{ color: "var(--color-text-secondary)" }}>
                  <span className="font-semibold" style={{ color: "var(--color-warning-500)" }}>Важно:</span> убедитесь, что A-запись домена <span className="font-mono font-medium">{domain}</span> указывает на IP <span className="font-mono font-medium">{host || "вашего сервера"}</span>. Без этого Let's Encrypt не сможет выпустить сертификат.
                </div>
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <button
                onClick={() => { const goBack = cameFromFound || serverInfo?.installed ? "found" : "server"; setCameFromFound(false); setWizardStep(goBack); }}
                className="px-4 py-2.5 rounded-xl text-sm transition-all active:scale-[0.97]"
                style={{ color: "var(--color-text-secondary)" }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--color-bg-hover)"}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
              >
                Назад
              </button>
              <button
                onClick={handleDeploy}
                disabled={!canDeploy}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ backgroundColor: "var(--color-accent-500)", color: "white" }}
              >
                <Rocket className="w-4 h-4" />
                Установить
              </button>
            </div>
          </div>
        </div>
      </>
    );
  }

  // ─── Deploying ──────────────────────────────────
  if (wizardStep === "deploying") {
    return (
      <>
        {renderStepBar()}
        <div className="flex-1 flex flex-col items-center justify-center p-6">
          <div className="max-w-md w-full space-y-4">
            <div className="text-center space-y-1">
              <h2 className="text-lg font-bold">Устанавливаем TrustTunnel...</h2>
              <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>Это может занять несколько минут</p>
            </div>

            <div className="glass-card p-4 space-y-2">
              {STEPS_ORDER.map((stepId) => {
                const step = deploySteps[stepId];
                if (!step) {
                  return (
                    <div key={stepId} className="flex items-center gap-2.5" style={{ color: "var(--color-text-muted)" }}>
                      <div className="w-4 h-4 rounded-full shrink-0" style={{ border: "1px solid var(--color-border)" }} />
                      <span className="text-xs">{STEP_LABELS[stepId]}</span>
                    </div>
                  );
                }
                return (
                  <div key={stepId} className="flex items-center gap-2.5">
                    {step.status === "progress" && (
                      <Loader2 className="w-4 h-4 animate-spin shrink-0" style={{ color: "var(--color-warning-500)" }} />
                    )}
                    {step.status === "ok" && (
                      <CheckCircle2 className="w-4 h-4 shrink-0" style={{ color: "var(--color-success-500)" }} />
                    )}
                    {step.status === "error" && (
                      <XCircle className="w-4 h-4 shrink-0" style={{ color: "var(--color-danger-500)" }} />
                    )}
                    <span
                      className="text-xs"
                      style={{
                        color: step.status === "progress"
                          ? "var(--color-warning-500)"
                          : step.status === "ok"
                          ? "var(--color-success-500)"
                          : "var(--color-danger-500)"
                      }}
                    >
                      {step.message}
                    </span>
                  </div>
                );
              })}
            </div>

          </div>
        </div>
      </>
    );
  }

  // ─── Fetching config from server ─────────────────
  if (wizardStep === "fetching") {
    const FETCH_STEPS_ORDER = ["connect", "auth", "check", "export", "save", "done"];
    const FETCH_STEP_LABELS: Record<string, string> = {
      connect: "Подключение к серверу",
      auth: "Авторизация",
      check: "Проверка TrustTunnel",
      export: "Экспорт конфига",
      save: "Сохранение",
      done: "Готово",
    };
    return (
      <>
        {renderStepBar()}
        <div className="flex-1 flex flex-col items-center justify-center p-6">
          <div className="max-w-md w-full space-y-4">
            <div className="text-center space-y-1">
              <Loader2 className="w-8 h-8 animate-spin mx-auto" style={{ color: "var(--color-accent-500)" }} />
              <h2 className="text-lg font-bold">Получаем конфиг с сервера...</h2>
              <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>Подключаемся и экспортируем клиентскую конфигурацию</p>
            </div>

            <div className="glass-card p-4 space-y-2">
              {FETCH_STEPS_ORDER.map((stepId) => {
                const step = deploySteps[stepId];
                if (!step) {
                  return (
                    <div key={stepId} className="flex items-center gap-2.5" style={{ color: "var(--color-text-muted)" }}>
                      <div className="w-4 h-4 rounded-full shrink-0" style={{ border: "1px solid var(--color-border)" }} />
                      <span className="text-xs">{FETCH_STEP_LABELS[stepId]}</span>
                    </div>
                  );
                }
                return (
                  <div key={stepId} className="flex items-center gap-2.5">
                    {step.status === "progress" && (
                      <Loader2 className="w-4 h-4 animate-spin shrink-0" style={{ color: "var(--color-warning-500)" }} />
                    )}
                    {step.status === "ok" && (
                      <CheckCircle2 className="w-4 h-4 shrink-0" style={{ color: "var(--color-success-500)" }} />
                    )}
                    {step.status === "error" && (
                      <XCircle className="w-4 h-4 shrink-0" style={{ color: "var(--color-danger-500)" }} />
                    )}
                    <span
                      className="text-xs"
                      style={{
                        color: step.status === "progress"
                          ? "var(--color-warning-500)"
                          : step.status === "ok"
                          ? "var(--color-success-500)"
                          : "var(--color-danger-500)"
                      }}
                    >
                      {step.message}
                    </span>
                  </div>
                );
              })}
            </div>

          </div>
        </div>
      </>
    );
  }

  // ─── Done ───────────────────────────────────────
  if (wizardStep === "done") {
    const isFetch = isFetchMode;
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-sm w-full text-center space-y-5">
          <div className="mx-auto w-16 h-16 rounded-2xl flex items-center justify-center" style={{ backgroundColor: "var(--color-success-500)", boxShadow: "0 8px 24px rgba(16, 185, 129, 0.25)" }}>
            <CheckCircle2 className="w-8 h-8 text-white" />
          </div>

          <div className="space-y-1.5">
            <h2 className="text-xl font-bold" style={{ color: "var(--color-success-500)" }}>Всё готово!</h2>
            <p className="text-sm" style={{ color: "var(--color-text-secondary)" }}>
              {isFetch
                ? "Конфигурация получена с сервера и сохранена."
                : "Сервер установлен и запущен. Конфигурация создана автоматически."}
            </p>
          </div>

          {configPath && (
            <div className="glass-card p-3 text-left">
              <p className="text-[11px] mb-0.5" style={{ color: "var(--color-text-muted)" }}>Файл конфигурации:</p>
              <p className="text-xs font-mono break-all" style={{ color: "var(--color-text-primary)" }}>{configPath}</p>
            </div>
          )}

          <div className="space-y-2 w-full">
            <button
              onClick={() => { setWizardStep("welcome"); onSetupComplete(configPath); }}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-medium transition-all active:scale-95"
              style={{ backgroundColor: "var(--color-accent-500)", color: "white" }}
            >
              Перейти к подключению
              <ChevronRight className="w-4 h-4" />
            </button>
            {configPath && (
              <button
                onClick={async () => {
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
                }}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm transition-all active:scale-[0.97] hover:opacity-80"
                style={{ backgroundColor: "var(--color-bg-hover)", border: "1px solid var(--color-border)", color: "var(--color-text-secondary)" }}
              >
                <Download className="w-4 h-4" />
                Сохранить как...
              </button>
            )}
            <button
              onClick={() => setWizardStep("welcome")}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm transition-all active:scale-[0.97]"
              style={{ color: "var(--color-text-secondary)" }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--color-bg-hover)"}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
            >
              На главную
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Error ──────────────────────────────────────
  if (wizardStep === "error") {
    const showReinstallPrompt = isFetchMode && fetchRetryCount >= 2;

    // Smart error hints based on error message and deploy logs
    const allText = [errorMessage, ...deployLogs.map(l => l.message)].join("\n").toLowerCase();
    const hints: string[] = [];
    if (allText.includes("nxdomain") || (allText.includes("dns") && allText.includes("domain"))) {
      hints.push("DNS-запись (A-запись) домена не указывает на IP-адрес сервера. Добавьте A-запись в панели управления доменом и подождите 5–10 минут.");
    }
    if (allText.includes("certbot") || allText.includes("letsencrypt") || allText.includes("let's encrypt")) {
      if (!hints.length) hints.push("Let's Encrypt не смог выпустить сертификат. Убедитесь, что домен указывает на сервер и порт 80 открыт.");
    }
    if (allText.includes("port 80")) {
      hints.push("Порт 80 должен быть открыт и не занят другим сервисом (nginx, apache) для получения сертификата.");
    }
    if (allText.includes("connection refused") || allText.includes("connection timed out") || allText.includes("os error 10054") || allText.includes("os error 10060")) {
      hints.push("Сервер недоступен. Проверьте, что IP-адрес верный, сервер включён и не блокирует подключения из вашей сети.");
    }
    if (allText.includes("authentication") || allText.includes("auth failed") || allText.includes("permission denied")) {
      hints.push("Ошибка авторизации SSH. Проверьте логин и пароль.");
    }

    return (
      <div className="flex-1 flex flex-col items-center overflow-y-auto p-6">
        <div className="max-w-sm w-full text-center space-y-4 my-auto">
          <div className="mx-auto w-16 h-16 rounded-2xl flex items-center justify-center shrink-0" style={{ backgroundColor: "var(--color-danger-500)", boxShadow: "0 8px 24px rgba(239, 68, 68, 0.25)" }}>
            <XCircle className="w-8 h-8 text-white" />
          </div>

          <div className="space-y-1.5">
            <h2 className="text-xl font-bold" style={{ color: "var(--color-danger-500)" }}>Что-то пошло не так</h2>
            <div className="max-h-32 overflow-y-auto rounded-lg p-2" style={{ backgroundColor: "var(--color-bg-elevated)" }}>
              <p className="text-xs leading-relaxed select-text cursor-text break-words" style={{ color: "var(--color-text-secondary)" }}>
                {errorMessage || "Неизвестная ошибка"}
              </p>
            </div>
          </div>

          {hints.length > 0 && (
            <div className="text-left space-y-1.5 p-3 rounded-xl" style={{ backgroundColor: "rgba(245, 158, 11, 0.05)", border: "1px solid rgba(245, 158, 11, 0.15)" }}>
              <p className="text-[11px] font-semibold flex items-center gap-1.5" style={{ color: "var(--color-warning-500)" }}>
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                Возможная причина
              </p>
              {hints.map((hint, i) => (
                <p key={i} className="text-[11px] leading-relaxed" style={{ color: "var(--color-text-secondary)" }}>{hint}</p>
              ))}
            </div>
          )}

          {deployLogs.length > 0 && (
            <div>
              <button
                onClick={() => setShowLogs(!showLogs)}
                className="flex items-center gap-1.5 text-[11px] transition-colors mx-auto" style={{ color: "var(--color-text-muted)" }}
              >
                {showLogs ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                {showLogs ? "Скрыть логи" : "Показать логи"}
              </button>
              {showLogs && (
                <div className="mt-1.5 glass-card p-2.5 max-h-36 overflow-y-auto font-mono text-[10px] space-y-0.5 text-left select-text cursor-text relative group">
                  <button
                    onClick={copyLogsToClipboard}
                    className="absolute top-1.5 right-1.5 p-1 rounded-lg hover:opacity-80 transition-colors opacity-0 group-hover:opacity-100" style={{ backgroundColor: "var(--color-bg-hover)", color: "var(--color-text-secondary)" }}
                    title="Копировать логи"
                  >
                    {copied ? <ClipboardCheck className="w-3 h-3" style={{ color: "var(--color-success-500)" }} /> : <Copy className="w-3 h-3" />}
                  </button>
                  {deployLogs.map((log, i) => (
                    <div
                      key={i}
                      style={{ color: log.level === "error" ? "var(--color-danger-500)" : "var(--color-text-muted)" }}
                    >
                      {log.message}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {showReinstallPrompt ? (
            <div className="p-3 rounded-xl space-y-2.5" style={{ backgroundColor: "rgba(245, 158, 11, 0.1)", border: "1px solid rgba(245, 158, 11, 0.2)" }}>
              <p className="text-xs font-medium" style={{ color: "var(--color-warning-500)" }}>
                Хотите переустановить VPN на сервере?
              </p>
              <p className="text-xs leading-relaxed" style={{ color: "var(--color-text-secondary)" }}>
                Копирование конфига не удалось повторно. Можно переустановить VPN с нуля.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setWizardStep("server")}
                  className="flex-1 px-3 py-2 rounded-xl text-xs transition-all"
                  style={{ color: "var(--color-text-secondary)" }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--color-bg-hover)"}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
                >
                  Отмена
                </button>
                <button
                  onClick={() => { setFetchRetryCount(0); saveField("wizardMode", ""); setWizardStep("endpoint"); }}
                  className="flex-1 px-3 py-2 rounded-xl text-xs font-medium transition-all"
                  style={{ backgroundColor: "rgba(245, 158, 11, 0.1)", border: "1px solid rgba(245, 158, 11, 0.3)", color: "var(--color-warning-500)" }}
                >
                  Да, переустановить
                </button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2 justify-center">
              <button
                onClick={() => setWizardStep(isFetchMode ? "server" : "endpoint")}
                className="px-4 py-2.5 rounded-xl text-sm transition-all active:scale-[0.97]"
                style={{ color: "var(--color-text-secondary)" }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--color-bg-hover)"}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
              >
                {isFetchMode ? "Назад" : "Назад к настройкам"}
              </button>
              <button
                onClick={isFetchMode ? () => handleFetchConfig() : handleDeploy}
                className="px-6 py-2.5 rounded-xl text-sm font-medium transition-all active:scale-95"
                style={{ backgroundColor: "var(--color-accent-500)", color: "white" }}
              >
                Попробовать снова
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
}

export default SetupWizard;
