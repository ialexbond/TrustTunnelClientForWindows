import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-shell";
import { Sidebar, type SidebarPage } from "./components/layout/Sidebar";
import StatusPanel from "./components/StatusPanel";
import SetupWizard from "./components/SetupWizard";
import { ControlPanelPage } from "./components/ControlPanelPage";
import SettingsPanel from "./components/SettingsPanel";
import RoutingPanel from "./components/RoutingPanel";
import LogPanel from "./components/LogPanel";
import AboutPanel from "./components/AboutPanel";
import DashboardPanel from "./components/DashboardPanel";
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
import { DropOverlay } from "./shared/ui/DropOverlay";
import { WindowControls } from "./components/layout/WindowControls";
import type { VpnStatus, VpnConfig, LogEntry } from "./shared/types";

// Re-export types for backward compatibility
export type { VpnStatus, UpdateInfo, VpnConfig, LogEntry, AppTab } from "./shared/types";

function App() {
  // ─── Theme ───
  const { themeMode, handleThemeChange, toggleTheme } = useTheme();

  // ─── Language ───
  const { i18n, handleLanguageChange, toggleLanguage } = useLanguage();

  // ─── Navigation ───
  const [activePage, setActivePage] = useState<SidebarPage>(() => {
    const saved = localStorage.getItem("tt_active_page") || localStorage.getItem("tt_active_tab");
    const savedConfig = localStorage.getItem("tt_config_path");

    // Map old tab names to new page names
    const pageMap: Record<string, SidebarPage> = {
      setup: "server",
      settings: "settings",
      routing: "routing",
      about: "about",
    };
    const mapped = saved ? (pageMap[saved] || saved) : null;

    if (savedConfig && mapped && mapped !== "server") return mapped as SidebarPage;
    if (savedConfig) return "settings";
    return "server";
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
        setActivePage("server");
        setWizardKey(k => k + 1);
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
            if (activePage === "server") setActivePage("settings");
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
        setActivePage("server");
        setWizardKey(k => k + 1);
        pushSuccess(i18n.t("messages.config_file_deleted", "Config file was deleted"), "error");
      } else if (exists && !config.configPath) {
        // Config file appeared — reload it (dismisses error snackbar via success message)
        setConfig({ configPath: path, logLevel: "info" });
        localStorage.setItem("tt_config_path", path);
        setSettingsKey(k => k + 1);
        setActivePage("settings");
        pushSuccess(i18n.t("messages.config_file_restored", "Config loaded"));
      }
    });
    return () => { unlisten.then(f => f()); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.configPath]);

  // ─── Persist state ───
  useEffect(() => { localStorage.setItem("tt_active_page", activePage); }, [activePage]);
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
            password: obj.sshPassword || "", // Already obfuscated
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
      setActivePage("settings");
    } else {
      setControlKey(k => k + 1);
      setActivePage("control");
    }
  }, []);

  const handleSwitchToSetup = useCallback(() => {
    setActivePage("server");
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
  }, [status]);

  // Reset scroll on page change
  useEffect(() => {
    document.querySelectorAll('[class*="overflow"]').forEach((el) => {
      el.scrollTop = 0;
    });
  }, [activePage]);

  // Keyboard shortcuts (Ctrl+Shift+C = connect, Ctrl+1..8 = navigate, etc.)
  useKeyboardShortcuts({
    onToggleConnect: useCallback(() => {
      if (status === "connected") handleDisconnect();
      else if (status === "disconnected" && config.configPath) handleConnect();
    }, [status, config.configPath, handleConnect, handleDisconnect]),
    onNavigate: setActivePage as (page: string) => void,
    onToggleTheme: toggleTheme,
    onToggleLanguage: toggleLanguage,
  });

  // ─── File drag-and-drop ───
  const handleDropConfig = useCallback((configPath: string) => {
    setConfig(prev => ({ ...prev, configPath }));
    localStorage.setItem("tt_config_path", configPath);
    localStorage.removeItem("tt_config_cleared");
    setSettingsKey(k => k + 1);
    setActivePage("settings");
  }, []);

  const handleDropRouting = useCallback(() => {
    setRoutingKey(k => k + 1);
    setActivePage("routing");
  }, []);

  const { isDragging } = useFileDrop({
    status,
    onConfigImported: handleDropConfig,
    onRoutingImported: handleDropRouting,
    pushSuccess,
    isBusy: activePage === "server", // block during setup wizard
  });

  const hasConfig = !!config.configPath;
  const showStatusPanel = hasConfig && activePage !== "server" && activePage !== "control";

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
      {/* Custom titlebar */}
      <div
        className="flex items-center shrink-0"
        data-tauri-drag-region
        style={{
          height: 32,
          backgroundColor: "var(--color-bg-secondary)",
          borderBottom: "1px solid var(--color-border)",
        }}
      >
        <div className="flex items-center gap-1.5 pl-3" data-tauri-drag-region>
          <span className="text-xs font-bold tracking-wide" style={{ color: "var(--color-text-secondary)" }} data-tauri-drag-region>
            TrustTunnel
          </span>
          <span
            className="text-[9px] font-bold px-1.5 py-0.5 rounded"
            style={{ backgroundColor: "rgba(99, 102, 241, 0.1)", color: "var(--color-accent-500)" }}
          >
            PRO
          </span>
        </div>
        <div className="flex-1" data-tauri-drag-region />
        <WindowControls />
      </div>

      {/* App body */}
      <div className="flex-1 min-h-0 flex">
      {/* Sidebar */}
      <Sidebar
        activePage={activePage}
        onPageChange={(page) => {
          if (page === "server" && wizardResetRef.current) {
            wizardResetRef.current();
          }
          setActivePage(page);
        }}
        hasConfig={hasConfig}
        hasUpdate={updateInfo.available}
      />

      {/* Main content */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Page content */}
        <div className="flex-1 min-h-0">
          {/* Installation (SetupWizard) — always shows wizard */}
          <div className="h-full flex flex-col overflow-hidden px-4" style={{ display: activePage === "server" ? "flex" : "none" }}>
            <SetupWizard key={wizardKey} onSetupComplete={handleSetupComplete} resetToWelcomeRef={wizardResetRef} />
          </div>

          {/* Control Panel — SSH form or ServerPanel */}
          <div className="h-full flex flex-col overflow-hidden" style={{ display: activePage === "control" ? "flex" : "none" }}>
            <PanelErrorBoundary onNavigateHome={() => setActivePage("server")} panelName="Control Panel">
            <ControlPanelPage
              key={controlKey}
              onConfigExported={(path) => {
                setConfig(prev => ({ ...prev, configPath: path }));
                localStorage.setItem("tt_config_path", path);
                setSettingsKey(k => k + 1);
              }}
              onSwitchToSetup={() => {
                setWizardKey(k => k + 1);
                setActivePage("server");
              }}
              onNavigateToSettings={() => {
                setActivePage("settings");
              }}
            />
            </PanelErrorBoundary>
          </div>

          {/* Settings */}
          <div className="h-full flex flex-col overflow-hidden" style={{ display: activePage === "settings" ? "flex" : "none" }}>
            <PanelErrorBoundary onNavigateHome={() => setActivePage("server")} panelName="Settings">
            <SettingsPanel
              key={settingsKey}
              configPath={config.configPath}
              onConfigChange={setConfig}
              status={status}
              onReconnect={handleReconnect}
              onSwitchToSetup={handleSwitchToSetup}
              onClearConfig={handleClearConfig}
              onVpnModeChange={setVpnMode}
              statusPanel={statusPanelNode}
            />
            </PanelErrorBoundary>
          </div>

          {/* Dashboard */}
          <div className="h-full flex flex-col overflow-hidden" style={{ display: activePage === "dashboard" ? "flex" : "none" }}>
            <PanelErrorBoundary onNavigateHome={() => setActivePage("server")} panelName="Dashboard">
            <DashboardPanel
              status={status}
              connectedSince={connectedSince}
              configPath={config.configPath}
              vpnMode={vpnMode}
              onConnect={handleConnect}
              onDisconnect={handleDisconnect}
              onNavigateToControl={() => setActivePage("control")}
            />
            </PanelErrorBoundary>
          </div>

          {/* Routing */}
          <div className="h-full flex flex-col overflow-hidden" style={{ display: activePage === "routing" ? "flex" : "none" }}>
            <PanelErrorBoundary onNavigateHome={() => setActivePage("server")} panelName="Routing">
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

          {/* Logs */}
          <div className="h-full flex flex-col overflow-hidden" style={{ display: activePage === "logs" ? "flex" : "none" }}>
            {statusPanelNode}
            <div className="flex-1 overflow-hidden py-3 px-4">
              <LogPanel
                logs={vpnLogs}
                onClear={() => setVpnLogs([])}
                isConnected={status === "connected"}
              />
            </div>
          </div>

          {/* App Settings */}
          <div className="h-full flex flex-col overflow-hidden" style={{ display: activePage === "appSettings" ? "flex" : "none" }}>
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
          <div className="h-full flex flex-col overflow-hidden" style={{ display: activePage === "about" ? "flex" : "none" }}>
            {statusPanelNode}
            <AboutPanel
              updateInfo={updateInfo}
              onCheckUpdates={() => checkForUpdates(false)}
              onOpenDownload={() => { if (updateInfo.downloadUrl) open(updateInfo.downloadUrl); }}
            />
          </div>
        </div>
      </div>
      </div>{/* /App body */}
    </div>

    </VpnProvider>
  );
}

export default App;
