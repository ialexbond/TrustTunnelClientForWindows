import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-shell";
import Header from "./components/Header";
import StatusPanel from "./components/StatusPanel";
import SetupWizard from "./components/SetupWizard";
import SettingsPanel from "./components/SettingsPanel";
import RoutingPanel from "./components/RoutingPanel";
import AboutPanel from "./components/AboutPanel";

export type VpnStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "disconnecting"
  | "recovering"
  | "error";

export type AppTab = "setup" | "settings" | "routing" | "about";

export interface UpdateInfo {
  available: boolean;
  latestVersion: string;
  currentVersion: string;
  downloadUrl: string;
  releaseNotes: string;
  checking: boolean;
}

export interface VpnConfig {
  configPath: string;
  logLevel: string;
}


function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

function App() {
  const [activeTab, setActiveTab] = useState<AppTab>(() => {
    const saved = localStorage.getItem("tt_active_tab");
    const savedConfig = localStorage.getItem("tt_config_path");
    // Only show settings/routing tabs if a config file is set
    if (savedConfig && (saved === "settings" || saved === "routing" || saved === "about")) return saved;
    if (savedConfig) return "settings";
    return "setup";
  });
  const [status, setStatus] = useState<VpnStatus>("disconnected");
  const [config, setConfig] = useState<VpnConfig>(() => {
    const savedPath = localStorage.getItem("tt_config_path") || "";
    const savedLevel = localStorage.getItem("tt_log_level") || "info";
    return { configPath: savedPath, logLevel: savedLevel };
  });
  const [error, setError] = useState<string | null>(null);
  const [vpnMode, setVpnMode] = useState<string>("general");
  const [connectedSince, setConnectedSince] = useState<Date | null>(() => {
    const saved = localStorage.getItem("tt_connected_since");
    return saved ? new Date(saved) : null;
  });
  // ─── Update check ───
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo>({
    available: false, latestVersion: "", currentVersion: "",
    downloadUrl: "", releaseNotes: "", checking: false,
  });

  const checkForUpdates = useCallback(async (_silent = false) => {
    setUpdateInfo(prev => ({ ...prev, checking: true }));
    try {
      const currentVersion = await getVersion();
      const res = await fetch(
        "https://api.github.com/repos/ialexbond/TrustTunnelClientForWindows/releases/latest",
        { headers: { "Accept": "application/vnd.github.v3+json" } }
      );
      if (!res.ok) throw new Error(`GitHub API: ${res.status}`);
      const data = await res.json();
      const latestTag = (data.tag_name || "").replace(/^v/, "");
      const isNewer = compareVersions(latestTag, currentVersion) > 0;
      const assets = data.assets || [];
      const asset =
        assets.find((a: { name: string }) => a.name.endsWith(".zip")) ||
        assets.find((a: { name: string }) => a.name.endsWith(".exe") || a.name.endsWith(".msi"));
      setUpdateInfo({
        available: isNewer,
        latestVersion: latestTag,
        currentVersion,
        downloadUrl: asset?.browser_download_url || data.html_url || "",
        releaseNotes: data.body || "",
        checking: false,
      });
    } catch (e) {
      console.warn("Update check failed:", e);
      setUpdateInfo(prev => ({ ...prev, checking: false }));
    }
  }, []);

  // Auto-check on startup (silent)
  useEffect(() => { checkForUpdates(true); }, [checkForUpdates]);

  // Validate saved config path on startup — if file doesn't exist, reset to wizard
  // Also auto-detect .toml config in app directory if no config is set
  useEffect(() => {
    const savedPath = localStorage.getItem("tt_config_path");
    if (savedPath) {
      invoke<{ vpn_mode?: string }>("read_client_config", { configPath: savedPath }).then((cfg) => {
        if (cfg?.vpn_mode) setVpnMode(cfg.vpn_mode);
      }).catch(() => {
        // Config file doesn't exist — stale localStorage, reset everything
        localStorage.removeItem("tt_config_path");
        localStorage.removeItem("tt_active_tab");
        localStorage.removeItem("tt_connected_since");
        localStorage.removeItem("trusttunnel_wizard");
        setConfig({ configPath: "", logLevel: "info" });
        setActiveTab("setup");
        setWizardKey(k => k + 1);
      });
    } else {
      // No saved config — clear any stale wizard data (SSH credentials, etc.)
      // so a fresh portable install doesn't show previous session's data
      localStorage.removeItem("trusttunnel_wizard");
      localStorage.removeItem("tt_active_tab");
      localStorage.removeItem("tt_connected_since");

      // Try to auto-detect .toml config in app directory
      invoke<string | null>("auto_detect_config").then((detected) => {
        if (detected) {
          setConfig(prev => ({ ...prev, configPath: detected }));
          if (activeTab === "setup") setActiveTab("settings");
        }
      }).catch(() => {});
    }
  }, []);

  // Persist tab and config to localStorage
  useEffect(() => { localStorage.setItem("tt_active_tab", activeTab); }, [activeTab]);
  useEffect(() => {
    localStorage.setItem("tt_config_path", config.configPath);
    localStorage.setItem("tt_log_level", config.logLevel);
  }, [config]);
  useEffect(() => { localStorage.setItem("tt_vpn_status", status); }, [status]);


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
      unlistenStatus.then((f) => f());
    };
  }, []);

  // Auto-reconnect on internet loss
  // Backend monitors connectivity and sends action-based events:
  //   { online: false, action: "disconnect" } — disconnect VPN, backend will wait for adapter
  //   { online: true, action: "reconnect" }   — adapter is back, reconnect VPN
  //   { online: false, action: "give_up" }    — adapter didn't come back in 5 min
  useEffect(() => {
    const unlistenInternet = listen<{ online: boolean; action?: string }>(
      "internet-status",
      async (event) => {
        const { online, action } = event.payload;

        if (!online && action === "disconnect") {
          console.warn("[connectivity] Internet lost — disconnecting VPN, waiting for adapter...");
          setStatus("recovering");
          setError("Интернет-соединение потеряно. Отключение VPN, ожидание восстановления сети...");
          try {
            await invoke("vpn_disconnect");
          } catch (e) {
            console.error("[connectivity] Disconnect failed:", e);
          }
        } else if (online && action === "reconnect") {
          console.log("[connectivity] Adapter back online — reconnecting VPN");
          setError("Сеть восстановлена. Переподключение к VPN...");
          const savedPath = localStorage.getItem("tt_config_path");
          const savedLevel = localStorage.getItem("tt_log_level") || "info";
          if (savedPath) {
            try {
              setStatus("connecting");
              await invoke("vpn_connect", {
                configPath: savedPath,
                logLevel: savedLevel,
              });
              setError(null);
            } catch (e) {
              console.error("[connectivity] Reconnect failed:", e);
              setError(`Ошибка переподключения: ${e}`);
              setStatus("error");
            }
          }
        } else if (!online && action === "give_up") {
          setError("Не удалось дождаться восстановления сети (5 мин). Подключитесь вручную.");
          setStatus("disconnected");
        }
      },
    );

    return () => {
      unlistenInternet.then((f) => f());
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

  // Reset scroll positions on mount (fresh state after app restart)
  useEffect(() => {
    document.querySelectorAll('[class*="overflow"]').forEach((el) => {
      el.scrollTop = 0;
    });
  }, [activeTab]);

  return (
    <div className="h-screen flex flex-col bg-surface-950">
      {/* Header — full width, edge-to-edge */}
      <Header
        activeTab={activeTab}
        onTabChange={setActiveTab}
        updateInfo={updateInfo}
        onCheckUpdates={() => checkForUpdates(false)}
        onOpenDownload={() => { setActiveTab("about"); }}
        hasConfig={!!config.configPath}
        vpnStatus={status}
      />

      {/* Content — constrained max-width, centered */}
      <div className="flex-1 min-h-0 w-full max-w-[980px] mx-auto px-5">
        {/* All tabs always mounted; inactive hidden via display:none to preserve state */}
        <div className="h-full flex flex-col overflow-hidden" style={{ display: activeTab === "setup" ? "flex" : "none" }}>
          <SetupWizard key={wizardKey} onSetupComplete={handleSetupComplete} />
        </div>

        <div className="h-full flex flex-col gap-2 py-3 overflow-hidden" style={{ display: activeTab === "settings" ? "flex" : "none" }}>
          <StatusPanel
            status={status}
            error={error}
            connectedSince={connectedSince}
            onConnect={handleConnect}
            onDisconnect={handleDisconnect}
          />
          <div className="flex-1 min-h-0">
            <SettingsPanel
              configPath={config.configPath}
              onConfigChange={setConfig}
              status={status}
              onReconnect={async () => {
                if (status === "connected" || status === "connecting") {
                  await handleDisconnect();
                  setTimeout(() => handleConnect(), 500);
                }
              }}
              onSwitchToSetup={handleSwitchToSetup}
              onClearConfig={handleClearConfig}
              onVpnModeChange={setVpnMode}
            />
          </div>
        </div>

        <div className="h-full flex flex-col py-3 overflow-hidden" style={{ display: activeTab === "routing" ? "flex" : "none" }}>
          <RoutingPanel
            configPath={config.configPath}
            status={status}
            vpnMode={vpnMode}
            onReconnect={async () => {
              if (status === "connected" || status === "connecting") {
                await handleDisconnect();
                setTimeout(() => handleConnect(), 500);
              }
            }}
          />
        </div>

        <div className="h-full flex flex-col overflow-hidden" style={{ display: activeTab === "about" ? "flex" : "none" }}>
          <AboutPanel
            updateInfo={updateInfo}
            onCheckUpdates={() => checkForUpdates(false)}
            onOpenDownload={() => { if (updateInfo.downloadUrl) open(updateInfo.downloadUrl); }}
          />
        </div>
      </div>
    </div>
  );
}

export default App;
