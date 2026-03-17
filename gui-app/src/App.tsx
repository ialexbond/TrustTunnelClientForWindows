import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Header from "./components/Header";
import StatusPanel from "./components/StatusPanel";
import LogPanel from "./components/LogPanel";
import SetupWizard from "./components/SetupWizard";
import SettingsPanel from "./components/SettingsPanel";
import RoutingPanel from "./components/RoutingPanel";

export type VpnStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "disconnecting"
  | "recovering"
  | "error";

export type AppTab = "setup" | "settings" | "routing";

export interface VpnConfig {
  configPath: string;
  logLevel: string;
}

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
}

function App() {
  const [activeTab, setActiveTab] = useState<AppTab>(() => {
    const saved = localStorage.getItem("tt_active_tab");
    const savedConfig = localStorage.getItem("tt_config_path");
    if (saved === "settings" || saved === "routing") return saved;
    if (savedConfig) return "settings";
    return "setup";
  });
  const [status, setStatus] = useState<VpnStatus>("disconnected");
  const [logs, setLogs] = useState<LogEntry[]>(() => {
    try {
      const saved = sessionStorage.getItem("tt_logs");
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  const [config, setConfig] = useState<VpnConfig>(() => {
    const savedPath = localStorage.getItem("tt_config_path") || "";
    const savedLevel = localStorage.getItem("tt_log_level") || "info";
    return { configPath: savedPath, logLevel: savedLevel };
  });
  const [error, setError] = useState<string | null>(null);
  const [connectedSince, setConnectedSince] = useState<Date | null>(() => {
    const saved = localStorage.getItem("tt_connected_since");
    return saved ? new Date(saved) : null;
  });
  // processConflict removed — check_process_conflict was detecting our own sidecar

  // Persist tab and config to localStorage
  useEffect(() => { localStorage.setItem("tt_active_tab", activeTab); }, [activeTab]);
  useEffect(() => {
    localStorage.setItem("tt_config_path", config.configPath);
    localStorage.setItem("tt_log_level", config.logLevel);
  }, [config]);
  useEffect(() => { localStorage.setItem("tt_vpn_status", status); }, [status]);

  // Persist logs to sessionStorage (survives WebView2 network-change reloads)
  useEffect(() => {
    try { sessionStorage.setItem("tt_logs", JSON.stringify(logs.slice(-200))); } catch {}
  }, [logs]);

  // Persist connectedSince
  useEffect(() => {
    if (connectedSince) {
      localStorage.setItem("tt_connected_since", connectedSince.toISOString());
    } else {
      localStorage.removeItem("tt_connected_since");
    }
  }, [connectedSince]);

  // On mount: check actual VPN process state from backend
  useEffect(() => {
    invoke<string>("check_vpn_status").then((backendStatus) => {
      if (backendStatus === "connected") {
        setStatus("connected");
        setConnectedSince((prev) => prev ?? new Date());
      } else if (backendStatus === "connecting") {
        setStatus("connecting");
        setConnectedSince(null);
      } else {
        setStatus("disconnected");
        setConnectedSince(null);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const unlisten = listen<{ message: string; level: string }>(
      "vpn-log",
      (event) => {
        console.log(`[VPN ${event.payload.level}] ${event.payload.message}`);
        setLogs((prev) => [
          ...prev.slice(-500),
          {
            timestamp: new Date().toLocaleTimeString(),
            level: event.payload.level,
            message: event.payload.message,
          },
        ]);
      },
    );

    const unlistenStatus = listen<{ status: VpnStatus; error?: string }>(
      "vpn-status",
      (event) => {
        setStatus(event.payload.status);
        if (event.payload.error) {
          setError(event.payload.error);
        }
        if (event.payload.status === "connected") {
          setConnectedSince(new Date());
        } else if (event.payload.status === "disconnected") {
          setConnectedSince(null);
        }
      },
    );

    return () => {
      unlisten.then((f) => f());
      unlistenStatus.then((f) => f());
    };
  }, []);

  const handleConnect = useCallback(async () => {
    if (!config.configPath) {
      setError("Сначала укажите файл конфигурации или настройте сервер");
      setStatus("error");
      return;
    }
    try {
      setError(null);
      setStatus("connecting");
      await invoke("vpn_connect", {
        configPath: config.configPath,
        logLevel: config.logLevel,
      });
    } catch (e) {
      setError(String(e));
      setStatus("error");
    }
  }, [config]);

  const handleDisconnect = useCallback(async () => {
    try {
      setStatus("disconnecting");
      await invoke("vpn_disconnect");
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const handleSetupComplete = useCallback((configPath: string) => {
    setConfig((prev) => ({ ...prev, configPath }));
    localStorage.setItem("tt_config_path", configPath);
    setActiveTab("settings");
  }, []);

  const clearLogs = useCallback(() => {
    setLogs([]);
    try { sessionStorage.removeItem("tt_logs"); } catch {}
  }, []);

  const handleSwitchToSetup = useCallback(() => {
    setActiveTab("setup");
  }, []);

  const [wizardKey, setWizardKey] = useState(0);

  const handleClearConfig = useCallback(() => {
    setConfig({ configPath: "", logLevel: "info" });
    localStorage.removeItem("tt_config_path");
    // Reset wizard step so it shows welcome screen, not stale "done"
    try {
      const raw = localStorage.getItem("trusttunnel_wizard");
      const obj = raw ? JSON.parse(raw) : {};
      obj.wizardStep = "welcome";
      obj.deploySteps = "{}";
      obj.deployLogs = "[]";
      obj.configPath = "";
      obj.errorMessage = "";
      localStorage.setItem("trusttunnel_wizard", JSON.stringify(obj));
    } catch {}
    // Force wizard remount to pick up reset state
    setWizardKey(k => k + 1);
  }, []);

  return (
    <div className="h-screen flex flex-col bg-surface-950">
      <Header activeTab={activeTab} onTabChange={setActiveTab} />

      {/* All tabs always mounted; inactive hidden via display:none to preserve state */}
      <div className="flex-1 flex flex-col overflow-hidden" style={{ display: activeTab === "setup" ? "flex" : "none" }}>
        <SetupWizard key={wizardKey} onSetupComplete={handleSetupComplete} />
      </div>

      <div className="flex-1 flex flex-col gap-2 p-3 overflow-hidden" style={{ display: activeTab === "settings" ? "flex" : "none" }}>
        <StatusPanel
          status={status}
          error={error}
          connectedSince={connectedSince}
          onConnect={handleConnect}
          onDisconnect={handleDisconnect}
        />
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-3 gap-2 min-h-0">
          <SettingsPanel
            configPath={config.configPath}
            onConfigChange={setConfig}
            status={status}
            onReconnect={async () => {
              if (status === "connected" || status === "connecting") {
                await handleDisconnect();
                // Small delay before reconnecting
                setTimeout(() => handleConnect(), 500);
              }
            }}
            onSwitchToSetup={handleSwitchToSetup}
            onClearConfig={handleClearConfig}
          />
          <LogPanel logs={logs} onClear={clearLogs} />
        </div>
      </div>

      <div className="flex-1 flex flex-col p-3 overflow-hidden" style={{ display: activeTab === "routing" ? "flex" : "none" }}>
        <RoutingPanel />
      </div>
    </div>
  );
}

export default App;
