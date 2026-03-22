import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import Header from "./components/Header";
import StatusPanel from "./components/StatusPanel";
import RoutingPanel from "./components/RoutingPanel";
import AboutPanel from "./components/AboutPanel";

export type VpnStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "disconnecting"
  | "recovering"
  | "error";

export type AppTab = "vpn" | "routing" | "about";

export interface VpnConfig {
  configPath: string;
  logLevel: string;
}

export interface UpdateInfo {
  available: boolean;
  latestVersion: string;
  currentVersion: string;
  downloadUrl: string;
  releaseNotes: string;
  checking: boolean;
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
    const saved = localStorage.getItem("ttl_active_tab");
    if (saved === "vpn" || saved === "routing" || saved === "about") return saved;
    return "vpn";
  });
  const [status, setStatus] = useState<VpnStatus>("disconnected");
  const [config, setConfig] = useState<VpnConfig>(() => {
    const savedPath = localStorage.getItem("ttl_config_path") || "";
    return { configPath: savedPath, logLevel: "info" };
  });
  const [error, setError] = useState<string | null>(null);
  const [vpnMode, setVpnMode] = useState<string>("general");
  const [connectedSince, setConnectedSince] = useState<Date | null>(() => {
    const saved = localStorage.getItem("ttl_connected_since");
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
        assets.find((a: { name: string }) => a.name.toLowerCase().includes("light") && a.name.endsWith(".zip")) ||
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

  // Validate saved config on startup & auto-detect
  useEffect(() => {
    const savedPath = localStorage.getItem("ttl_config_path");
    if (savedPath) {
      invoke<{ vpn_mode?: string }>("read_client_config", { configPath: savedPath }).then((cfg) => {
        if (cfg?.vpn_mode) setVpnMode(cfg.vpn_mode);
      }).catch(() => {
        localStorage.removeItem("ttl_config_path");
        setConfig({ configPath: "", logLevel: "info" });
      });
    } else {
      invoke<string | null>("auto_detect_config").then((detected) => {
        if (detected) {
          setConfig(prev => ({ ...prev, configPath: detected }));
        }
      }).catch(() => {});
    }
  }, []);

  // Persist state
  useEffect(() => { localStorage.setItem("ttl_active_tab", activeTab); }, [activeTab]);
  useEffect(() => { localStorage.setItem("ttl_config_path", config.configPath); }, [config]);
  useEffect(() => {
    if (connectedSince) {
      localStorage.setItem("ttl_connected_since", connectedSince.toISOString());
    } else {
      localStorage.removeItem("ttl_connected_since");
    }
  }, [connectedSince]);

  // Check actual VPN process state on mount
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

  // Listen for VPN status events
  useEffect(() => {
    const unlistenStatus = listen<{ status: VpnStatus; error?: string }>(
      "vpn-status",
      (event) => {
        setStatus((prev) => {
          if (prev === "recovering" && event.payload.status === "disconnected") return prev;
          return event.payload.status;
        });
        if (event.payload.error) setError(event.payload.error);
        if (event.payload.status === "connected") setConnectedSince(new Date());
        else if (event.payload.status === "disconnected") setConnectedSince(null);
      },
    );
    return () => { unlistenStatus.then((f) => f()); };
  }, []);

  // Auto-reconnect on internet loss/recovery
  useEffect(() => {
    const unlistenInternet = listen<{ online: boolean; action?: string }>(
      "internet-status",
      async (event) => {
        const { online, action } = event.payload;
        if (!online && action === "disconnect") {
          setStatus("recovering");
          setError("Интернет-соединение потеряно. Ожидание восстановления сети...");
          try { await invoke("vpn_disconnect"); } catch { /* ignore */ }
        } else if (online && action === "reconnect") {
          setError("Сеть восстановлена. Переподключение к VPN...");
          const savedPath = localStorage.getItem("ttl_config_path");
          if (savedPath) {
            try {
              setStatus("connecting");
              await invoke("vpn_connect", { configPath: savedPath, logLevel: "info" });
              setError(null);
            } catch (e) {
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
    return () => { unlistenInternet.then((f) => f()); };
  }, []);

  const handleConnect = useCallback(async () => {
    if (!config.configPath) {
      setError("Сначала укажите файл конфигурации");
      setStatus("error");
      return;
    }
    try {
      setError(null);
      setStatus("connecting");
      await invoke("vpn_connect", { configPath: config.configPath, logLevel: config.logLevel });
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

  const handleBrowseConfig = useCallback(async () => {
    const file = await openDialog({ filters: [{ name: "TOML", extensions: ["toml"] }] });
    if (file) {
      const path = typeof file === "string" ? file : file;
      setConfig(prev => ({ ...prev, configPath: path }));
      // Read vpn_mode from new config
      invoke<{ vpn_mode?: string }>("read_client_config", { configPath: path }).then((cfg) => {
        if (cfg?.vpn_mode) setVpnMode(cfg.vpn_mode);
      }).catch(() => {});
    }
  }, []);

  return (
    <div className="h-screen flex flex-col bg-surface-950">
      <Header
        activeTab={activeTab}
        onTabChange={setActiveTab}
        updateInfo={updateInfo}
        onCheckUpdates={() => checkForUpdates(false)}
        onOpenDownload={() => { setActiveTab("about"); }}
        hasConfig={!!config.configPath}
      />

      <div className="flex-1 min-h-0 w-full mx-auto">
        <div className="h-full flex flex-col overflow-hidden" style={{ display: activeTab === "vpn" ? "flex" : "none" }}>
          <StatusPanel
            status={status}
            error={error}
            connectedSince={connectedSince}
            onConnect={handleConnect}
            onDisconnect={handleDisconnect}
            configPath={config.configPath}
            onBrowseConfig={handleBrowseConfig}
            onConfigPathChange={(p) => setConfig(prev => ({ ...prev, configPath: p }))}
          />
        </div>

        <div className="h-full flex flex-col py-2 px-3 overflow-hidden" style={{ display: activeTab === "routing" ? "flex" : "none" }}>
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
            onOpenDownload={() => { if (updateInfo.downloadUrl) openUrl(updateInfo.downloadUrl); }}
          />
        </div>
      </div>
    </div>
  );
}

export default App;
