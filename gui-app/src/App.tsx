import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-shell";
import { TitleBar } from "./components/layout/TitleBar";
import { TabNavigation } from "./components/layout/TabNavigation";
import { WindowControls } from "./components/layout/WindowControls";
import StatusPanel from "./components/StatusPanel";
import SetupWizard from "./components/SetupWizard";
import { ControlPanelPage } from "./components/ControlPanelPage";
import SettingsPanel from "./components/SettingsPanel";
import RoutingPanel from "./components/RoutingPanel";
import AboutPanel from "./components/AboutPanel";
import AppSettingsPanel from "./components/AppSettingsPanel";
import { PanelErrorBoundary } from "./shared/ui/PanelErrorBoundary";
import { formatError } from "./shared/utils/formatError";
import { VpnProvider } from "./shared/context/VpnContext";
import { useKeyboardShortcuts } from "./shared/hooks/useKeyboardShortcuts";
import { useTheme } from "./shared/hooks/useTheme";
import { useLanguage } from "./shared/hooks/useLanguage";
import { useVpnEvents } from "./shared/hooks/useVpnEvents";
import { useSnackBar } from "./shared/ui/SnackBarContext";
import { useUpdateChecker } from "./shared/hooks/useUpdateChecker";
import { useVpnActions } from "./shared/hooks/useVpnActions";
import { useFileDrop } from "./shared/hooks/useFileDrop";
import { useHostKeyVerification } from "./shared/hooks/useHostKeyVerification";
import { DropOverlay } from "./shared/ui/DropOverlay";
import { EmptyState } from "./shared/ui/EmptyState";
import { ConfirmDialog } from "./shared/ui";
import { Settings } from "lucide-react";
import type { AppTab, VpnStatus, VpnConfig, LogEntry } from "./shared/types";

// Re-export types for backward compatibility
export type { VpnStatus, UpdateInfo, VpnConfig, LogEntry, AppTab } from "./shared/types";

function App() {
  // ─── Theme ───
  const { themeMode, handleThemeChange, toggleTheme } = useTheme();

  // ─── Language ───
  const { i18n, handleLanguageChange, toggleLanguage } = useLanguage();

  // ─── Navigation ───
  const [activeTab, setActiveTab] = useState<AppTab>(() => {
    // Fresh start: config exists → connection, no config → control panel
    // Tab is NOT restored from localStorage — always fresh on app start
    const savedConfig = localStorage.getItem("tt_config_path");
    return savedConfig ? "connection" : "control";
  });

  const [status, setStatus] = useState<VpnStatus>("disconnected");
  const [config, setConfig] = useState<VpnConfig>(() => {
    const savedPath = localStorage.getItem("tt_config_path") || "";
    const savedLevel = localStorage.getItem("tt_log_level") || "info";
    return { configPath: savedPath, logLevel: savedLevel };
  });
  const [error, setError] = useState<string | null>(null);
  const [vpnMode, setVpnMode] = useState<string>("general");
  const [vpnLogs, setVpnLogs] = useState<LogEntry[]>([]);

  const [connectedSince, setConnectedSince] = useState<Date | null>(() => {
    const saved = localStorage.getItem("tt_connected_since");
    return saved ? new Date(saved) : null;
  });

  // ─── Update check ───
  const { updateInfo, checkForUpdates } = useUpdateChecker();

  // ─── Host Key Verification (TOFU) ───
  const { pending: hostKeyPending, respond: hostKeyRespond } = useHostKeyVerification();

  // ─── VPN event listeners (status, internet-status, vpn-log, reconnect resolver) ───
  const reconnectResolve = useRef<(() => void) | null>(null);
  const pushSuccess = useSnackBar();

  useVpnEvents({
    i18n,
    setStatus,
    setError,
    setConnectedSince,
    setVpnLogs,
    reconnectResolve,
    pushSuccess,
  });

  // Deep-link state (used by ImportConfigModal in WelcomeStep, future installer support)
  // For portable builds, deep-link is manual only (paste URL in import modal)

  // ─── Config validation on startup ───
  useEffect(() => {
    const savedPath = localStorage.getItem("tt_config_path");
    if (savedPath) {
      invoke<{ vpn_mode?: string }>("read_client_config", { configPath: savedPath }).then((cfg) => {
        if (cfg?.vpn_mode) setVpnMode(cfg.vpn_mode);
      }).catch(() => {
        localStorage.removeItem("tt_config_path");
        localStorage.removeItem("tt_active_page");
        localStorage.removeItem("tt_active_tab");
        localStorage.removeItem("tt_connected_since");
        localStorage.removeItem("trusttunnel_wizard");
        setConfig({ configPath: "", logLevel: "info" });
        setWizardKey(k => k + 1);
        // Control tab auto-shows wizard when hasConfig is false
      });
    } else {
      localStorage.removeItem("trusttunnel_wizard");
      localStorage.removeItem("tt_active_page");
      localStorage.removeItem("tt_active_tab");
      localStorage.removeItem("tt_connected_since");

      // Skip auto-detect if user explicitly cleared config
      const wasCleared = localStorage.getItem("tt_config_cleared");
      if (!wasCleared) {
        invoke<string | null>("auto_detect_config").then((detected) => {
          if (detected) {
            setConfig(prev => ({ ...prev, configPath: detected }));
            if (activeTab === "control") setActiveTab("connection");
          }
        }).catch(() => {});
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Watch config file for external deletion ───
  useEffect(() => {
    if (config.configPath) {
      invoke("watch_config_file", { configPath: config.configPath }).catch(() => {});
    }
    return () => { invoke("unwatch_config_file").catch(() => {}); };
  }, [config.configPath]);

  useEffect(() => {
    const unlisten = listen<{ exists: boolean; path: string }>("config-file-changed", (event) => {
      const { exists, path } = event.payload;
      if (!exists && path === config.configPath) {
        // Config file was deleted externally
        localStorage.removeItem("tt_config_path");
        setConfig({ configPath: "", logLevel: "info" });
        setWizardKey(k => k + 1);
        // Control tab auto-shows wizard when hasConfig is false
        pushSuccess(i18n.t("messages.config_file_deleted", "Config file was deleted"), "error");
      } else if (exists && !config.configPath) {
        // Config file appeared — reload it (dismisses error snackbar via success message)
        setConfig({ configPath: path, logLevel: "info" });
        localStorage.setItem("tt_config_path", path);
        setSettingsKey(k => k + 1);
        setActiveTab("connection");
        pushSuccess(i18n.t("messages.config_file_restored", "Config loaded"));
      }
    });
    return () => { unlisten.then(f => f()); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.configPath]);

  // ─── Persist state ───
  useEffect(() => {
    localStorage.setItem("tt_active_tab", activeTab);
    // Also persist with old key for backward compat
    localStorage.setItem("tt_active_page", activeTab);
  }, [activeTab]);
  useEffect(() => {
    localStorage.setItem("tt_config_path", config.configPath);
    localStorage.setItem("tt_log_level", config.logLevel);
  }, [config]);
  useEffect(() => { localStorage.setItem("tt_vpn_status", status); }, [status]);
  useEffect(() => {
    if (connectedSince) {
      localStorage.setItem("tt_connected_since", connectedSince.toISOString());
    } else {
      localStorage.removeItem("tt_connected_since");
    }
  }, [connectedSince]);

  // ─── Auto-connect on startup ───
  const autoConnectDone = useRef(false);
  useEffect(() => {
    if (autoConnectDone.current) return;
    if (localStorage.getItem("tt_auto_connect") !== "true") return;
    if (!config.configPath) return;
    if (status !== "disconnected") return;
    autoConnectDone.current = true;
    const timer = setTimeout(() => {
      invoke("vpn_connect", {
        configPath: config.configPath,
        logLevel: config.logLevel,
      }).catch((e) => {
        setError(formatError(e));
        setStatus("error");
      });
      setStatus("connecting");
    }, 1500);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.configPath]);

  // ─── VPN Actions ───
  const { handleConnect, handleDisconnect, handleReconnect } = useVpnActions({
    config,
    status,
    setStatus,
    setError,
    i18n,
    reconnectResolve,
  });

  // ─── Setup / Config ───
  const handleSetupComplete = useCallback((configPath: string) => {
    setConfig((prev) => ({ ...prev, configPath }));
    localStorage.setItem("tt_config_path", configPath);
    localStorage.removeItem("tt_config_cleared"); // re-enable auto-detect for future

    // Copy SSH credentials from wizard to Rust backend storage (not localStorage)
    try {
      const raw = localStorage.getItem("trusttunnel_wizard");
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj.host && (obj.sshPassword || obj.sshKeyPath)) {
          invoke("save_ssh_credentials", {
            host: obj.host,
            port: obj.port || "22",
            user: obj.sshUser || "root",
            password: obj.sshPassword || "",
            keyPath: obj.sshKeyPath || null,
          }).catch(() => {});
        }
      }
    } catch { /* ignore */ }

    // Check if user wants to go to settings instead of control panel
    const navigateTo = localStorage.getItem("tt_navigate_after_setup");
    localStorage.removeItem("tt_navigate_after_setup");

    if (navigateTo === "settings") {
      setSettingsKey(k => k + 1);
      setActiveTab("settings");
    } else {
      setControlKey(k => k + 1);
      setActiveTab("control");
    }
  }, []);

  const [wizardKey, setWizardKey] = useState(0);
  const [controlKey, setControlKey] = useState(0);
  const [settingsKey, setSettingsKey] = useState(0);
  const [routingKey, setRoutingKey] = useState(0);
  const wizardResetRef = useRef<(() => void) | null>(null);

  const handleClearConfig = useCallback(async () => {
    // Disconnect VPN first if running
    if (status === "connected" || status === "connecting") {
      try {
        setStatus("disconnecting");
        await invoke("vpn_disconnect");
      } catch { /* ignore */ }
    }
    setConfig({ configPath: "", logLevel: "info" });
    localStorage.removeItem("tt_config_path");
    localStorage.setItem("tt_config_cleared", "true"); // prevent auto-detect on restart
    try {
      const raw = localStorage.getItem("trusttunnel_wizard");
      const obj = raw ? JSON.parse(raw) : {};
      obj.wizardStep = "welcome";
      obj.deploySteps = "{}";
      obj.deployLogs = "[]";
      obj.configPath = "";
      obj.errorMessage = "";
      localStorage.setItem("trusttunnel_wizard", JSON.stringify(obj));
    } catch { /* ignore */ }
    setWizardKey(k => k + 1);
    // Control tab auto-shows wizard when hasConfig is false
  }, [status]);

  // Reset scroll on tab change
  useEffect(() => {
    document.querySelectorAll('[class*="overflow"]').forEach((el) => {
      el.scrollTop = 0;
    });
  }, [activeTab]);

  // Keyboard shortcuts (Ctrl+Shift+C = connect, Ctrl+1..5 = navigate, etc.)
  useKeyboardShortcuts({
    onToggleConnect: useCallback(() => {
      if (status === "connected") handleDisconnect();
      else if (status === "disconnected" && config.configPath) handleConnect();
    }, [status, config.configPath, handleConnect, handleDisconnect]),
    onNavigate: setActiveTab as (page: string) => void,
    onToggleTheme: toggleTheme,
    onToggleLanguage: toggleLanguage,
  });

  // ─── File drag-and-drop ───
  const handleDropConfig = useCallback((configPath: string) => {
    setConfig(prev => ({ ...prev, configPath }));
    localStorage.setItem("tt_config_path", configPath);
    localStorage.removeItem("tt_config_cleared");
    setSettingsKey(k => k + 1);
    setActiveTab("connection");
  }, []);

  const handleDropRouting = useCallback(() => {
    setRoutingKey(k => k + 1);
    setActiveTab("routing");
  }, []);

  const { isDragging } = useFileDrop({
    status,
    onConfigImported: handleDropConfig,
    onRoutingImported: handleDropRouting,
    pushSuccess,
    isBusy: false, // drag-drop is safe on any tab — import uses a separate SSH session
  });

  const hasConfig = !!config.configPath;
  const showStatusPanel = hasConfig && activeTab !== "control";

  const vpnContextValue = useMemo(() => ({
    status,
    connectedSince,
    configPath: config.configPath,
    vpnMode,
    onConnect: handleConnect,
    onDisconnect: handleDisconnect,
    onReconnect: handleReconnect,
  }), [status, connectedSince, config.configPath, vpnMode, handleConnect, handleDisconnect, handleReconnect]);

  const statusPanelNode = showStatusPanel ? (
    <StatusPanel
      status={status}
      error={error}
      connectedSince={connectedSince}
      onConnect={handleConnect}
      onDisconnect={handleDisconnect}
    />
  ) : null;

  return (
    <VpnProvider value={vpnContextValue}>
    <div
      className="h-screen flex flex-col"
      style={{ backgroundColor: "var(--color-bg-primary)", color: "var(--color-text-primary)" }}
    >
      <DropOverlay isDragging={isDragging} />

      {/* Title bar — brand + window controls */}
      <TitleBar>
        <WindowControls />
      </TitleBar>

      {/* Content area */}
      <div
        className="flex-1 min-h-0 flex flex-col overflow-hidden"
        style={{ maxWidth: 1000, width: "100%", margin: "0 auto" }}
      >
        {/* Control Panel — always shows ControlPanelPage (handles no-creds internally) */}
        <div className="h-full flex flex-col overflow-hidden" style={{ display: activeTab === "control" ? "flex" : "none" }}>
          <PanelErrorBoundary onNavigateHome={() => setActiveTab("control")} panelName="Control Panel">
            <ControlPanelPage
              key={controlKey}
              onConfigExported={(path) => {
                setConfig(prev => ({ ...prev, configPath: path }));
                localStorage.setItem("tt_config_path", path);
                setSettingsKey(k => k + 1);
              }}
              onSwitchToSetup={() => {
                setWizardKey(k => k + 1);
              }}
              onNavigateToSettings={() => {
                setActiveTab("settings");
              }}
            />
          </PanelErrorBoundary>
        </div>

        {/* Connection — VPN Settings or placeholder */}
        <div className="h-full flex flex-col overflow-hidden" style={{ display: activeTab === "connection" ? "flex" : "none" }}>
          <PanelErrorBoundary onNavigateHome={() => setActiveTab("control")} panelName="Connection">
            {hasConfig ? (
              <SettingsPanel
                key={settingsKey}
                configPath={config.configPath}
                onConfigChange={setConfig}
                status={status}
                onReconnect={handleReconnect}
                onSwitchToSetup={() => setActiveTab("control")}
                onClearConfig={handleClearConfig}
                onVpnModeChange={setVpnMode}
                statusPanel={statusPanelNode}
              />
            ) : (
              <EmptyState
                icon={<Settings className="w-6 h-6" />}
                heading={i18n.t("connection.noConfig", "Нет подключения")}
                body={i18n.t("connection.noConfigHint", "Настройте сервер в «Панель управления», чтобы управлять VPN-подключением")}
                className="flex-1"
              />
            )}
          </PanelErrorBoundary>
        </div>

        {/* Routing */}
        <div className="h-full flex flex-col overflow-hidden" style={{ display: activeTab === "routing" ? "flex" : "none" }}>
          <PanelErrorBoundary onNavigateHome={() => setActiveTab("control")} panelName="Routing">
            <RoutingPanel
              key={routingKey}
              configPath={config.configPath}
              status={status}
              vpnMode={vpnMode}
              connectedSince={connectedSince}
              vpnError={error}
              onConnect={handleConnect}
              onDisconnect={handleDisconnect}
              onReconnect={handleReconnect}
              onVpnModeChange={setVpnMode}
            />
          </PanelErrorBoundary>
        </div>

        {/* Settings — App settings (theme, language, autostart) */}
        <div className="h-full flex flex-col overflow-hidden" style={{ display: activeTab === "settings" ? "flex" : "none" }}>
          <AppSettingsPanel
            theme={themeMode}
            onThemeChange={handleThemeChange}
            language={i18n.language}
            onLanguageChange={handleLanguageChange}
            hasConfig={!!config.configPath}
            statusPanel={statusPanelNode}
          />
        </div>

        {/* About */}
        <div className="h-full flex flex-col overflow-hidden" style={{ display: activeTab === "about" ? "flex" : "none" }}>
          {statusPanelNode}
          <AboutPanel
            updateInfo={updateInfo}
            onCheckUpdates={() => checkForUpdates(false)}
            onOpenDownload={() => { if (updateInfo.downloadUrl) open(updateInfo.downloadUrl); }}
          />
        </div>
      </div>

      {/* Bottom tab navigation */}
      <TabNavigation
        activeTab={activeTab}
        onTabChange={(tab) => {
          if (tab === "control" && wizardResetRef.current) {
            wizardResetRef.current();
          }
          setActiveTab(tab);
        }}
      />
    </div>

    <ConfirmDialog
      open={hostKeyPending !== null}
      title={i18n.t("hostKey.title")}
      message={
        hostKeyPending
          ? i18n.t("hostKey.message", {
              host: hostKeyPending.host,
              fingerprint: hostKeyPending.fingerprint,
            })
          : ""
      }
      confirmLabel={i18n.t("hostKey.accept")}
      cancelLabel={i18n.t("hostKey.reject")}
      variant="warning"
      onConfirm={() => hostKeyRespond(true)}
      onCancel={() => hostKeyRespond(false)}
    />

    </VpnProvider>
  );
}

export default App;
