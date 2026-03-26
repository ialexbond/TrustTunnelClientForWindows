import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
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

export type VpnStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "disconnecting"
  | "recovering"
  | "error";

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

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
}

/** @deprecated Use SidebarPage instead — kept for backward compat with Header.tsx */
export type AppTab = "setup" | "settings" | "routing" | "about";


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
  const { i18n } = useTranslation();

  // ─── Theme ───
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    return (localStorage.getItem("tt_theme") as "dark" | "light") || "dark";
  });
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("tt_theme", theme);
  }, [theme]);
  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  }, []);

  // ─── Language ───
  const toggleLanguage = useCallback(() => {
    const next = i18n.language === "ru" ? "en" : "ru";
    i18n.changeLanguage(next);
    localStorage.setItem("tt_language", next);
  }, [i18n]);

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

  // SSH data is now managed by ControlPanelPage via trusttunnel_control_ssh localStorage
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

  useEffect(() => { checkForUpdates(true); }, [checkForUpdates]);

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

      invoke<string | null>("auto_detect_config").then((detected) => {
        if (detected) {
          setConfig(prev => ({ ...prev, configPath: detected }));
          if (activePage === "server") setActivePage("settings");
        }
      }).catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // ─── VPN status sync ───
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
        setStatus((prev) => {
          if (prev === "recovering" && event.payload.status === "disconnected") {
            return prev;
          }
          return event.payload.status;
        });
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
    return () => { unlistenStatus.then((f) => f()); };
  }, []);

  // ─── Auto-reconnect on internet loss ───
  useEffect(() => {
    const unlistenInternet = listen<{ online: boolean; action?: string }>(
      "internet-status",
      async (event) => {
        const { online, action } = event.payload;

        if (!online && action === "disconnect") {
          console.warn("[connectivity] Internet lost — disconnecting VPN, waiting for adapter...");
          setStatus("recovering");
          setError(i18n.t("errors.internet_lost_disconnecting"));
          try {
            await invoke("vpn_disconnect");
          } catch (e) {
            console.error("[connectivity] Disconnect failed:", e);
          }
        } else if (online && action === "reconnect") {
          console.warn("[connectivity] Adapter back online — reconnecting VPN");
          setError(i18n.t("messages.network_restored_reconnecting"));
          const savedPath = localStorage.getItem("tt_config_path");
          const savedLevel = localStorage.getItem("tt_log_level") || "info";
          if (savedPath) {
            try {
              setStatus("connecting");
              await invoke("vpn_connect", { configPath: savedPath, logLevel: savedLevel });
              setError(null);
            } catch (e) {
              console.error("[connectivity] Reconnect failed:", e);
              setError(i18n.t("errors.reconnection_failed", { error: String(e) }));
              setStatus("error");
            }
          }
        } else if (!online && action === "give_up") {
          setError(i18n.t("errors.network_recovery_timeout"));
          setStatus("disconnected");
        }
      },
    );
    return () => { unlistenInternet.then((f) => f()); };
  }, [i18n]);

  // ─── VPN Actions ───
  const handleConnect = useCallback(async () => {
    if (!config.configPath) {
      setError(i18n.t("messages.config_required"));
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
  }, [config, i18n]);

  const handleDisconnect = useCallback(async () => {
    try {
      setStatus("disconnecting");
      await invoke("vpn_disconnect");
    } catch (e) {
      setError(String(e));
    }
  }, []);

  // ─── Proper async reconnect (no setTimeout hack) ───
  const reconnectResolve = useRef<(() => void) | null>(null);

  // Listen for disconnect confirmation to complete reconnect
  useEffect(() => {
    const unlisten = listen<{ status: VpnStatus }>("vpn-status", (event) => {
      if (event.payload.status === "disconnected" && reconnectResolve.current) {
        const resolve = reconnectResolve.current;
        reconnectResolve.current = null;
        resolve();
      }
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  // ─── VPN log collector + error detection ───
  useEffect(() => {
    const unlisten = listen<{ message: string; source: string }>("vpn-log", (event) => {
      const msg = event.payload.message.trim();
      if (!msg) return;
      const now = new Date();
      const ts = `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}`;
      const level = event.payload.source === "stderr" ? "error" : "info";
      setVpnLogs(prev => {
        const next = [...prev, { timestamp: ts, level, message: msg }];
        return next.length > 500 ? next.slice(-500) : next;
      });

      // ── Detect known errors and show user-friendly messages ──
      if (msg.includes("Authorization Required")) {
        setError(i18n.t("errors.auth_required", "Ошибка авторизации: логин или пароль неверны. Обновите конфиг с сервера через Панель управления."));
        setStatus("error");
      } else if (msg.includes("WintunCreateAdapter") && msg.includes("cannot find")) {
        setError(i18n.t("errors.wintun_missing", "Не удалось создать VPN-адаптер. Запустите приложение от имени администратора."));
        setStatus("error");
      } else if (msg.includes("Failed to create listener")) {
        setError(i18n.t("errors.listener_failed", "Не удалось запустить VPN-туннель. Проверьте права администратора и наличие wintun.dll."));
        setStatus("error");
      } else if (msg.includes("Connection refused") || msg.includes("connection refused")) {
        setError(i18n.t("errors.connection_refused", "Сервер отклонил подключение. Проверьте, запущен ли VPN-сервис на сервере."));
        setStatus("error");
      } else if (msg.includes("timed out") || msg.includes("Timed out")) {
        // Don't override status for non-fatal timeouts (like wintun device query)
        if (msg.includes("Failed to setup adapter")) {
          setError(i18n.t("errors.adapter_timeout", "Таймаут создания VPN-адаптера. Перезапустите приложение от имени администратора."));
          setStatus("error");
        }
      }
    });
    return () => { unlisten.then((f) => f()); };
  }, [i18n]);

  const handleReconnect = useCallback(async () => {
    if (status !== "connected" && status !== "connecting") return;

    // Disconnect and wait for actual disconnected status
    await handleDisconnect();
    await new Promise<void>((resolve) => {
      reconnectResolve.current = resolve;
      // Safety timeout: if disconnect event never comes, resolve after 5s
      setTimeout(() => {
        if (reconnectResolve.current === resolve) {
          reconnectResolve.current = null;
          resolve();
        }
      }, 5000);
    });

    // Small delay to let the sidecar process fully terminate
    await new Promise((r) => setTimeout(r, 200));

    // Now reconnect
    await handleConnect();
  }, [status, handleDisconnect, handleConnect]);

  // ─── Setup / Config ───
  const handleSetupComplete = useCallback((configPath: string) => {
    setConfig((prev) => ({ ...prev, configPath }));
    localStorage.setItem("tt_config_path", configPath);

    // Copy SSH credentials from wizard to control panel storage
    try {
      const raw = localStorage.getItem("trusttunnel_wizard");
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj.host && (obj.sshPassword || obj.sshKeyPath)) {
          localStorage.setItem(
            "trusttunnel_control_ssh",
            JSON.stringify({
              host: obj.host,
              port: obj.port || "22",
              user: obj.sshUser || "root",
              password: obj.sshPassword || "", // Already obfuscated
              keyPath: obj.sshKeyPath || "",
            })
          );
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
  const wizardResetRef = useRef<(() => void) | null>(null);

  const handleClearConfig = useCallback(() => {
    setConfig({ configPath: "", logLevel: "info" });
    localStorage.removeItem("tt_config_path");
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
  }, []);

  // Reset scroll on page change
  useEffect(() => {
    document.querySelectorAll('[class*="overflow"]').forEach((el) => {
      el.scrollTop = 0;
    });
  }, [activePage]);

  const hasConfig = !!config.configPath;
  const showStatusPanel = hasConfig && activePage !== "server" && activePage !== "control";

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
    <div
      className="h-screen flex"
      style={{ backgroundColor: "var(--color-bg-primary)", color: "var(--color-text-primary)" }}
    >
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
        theme={theme}
        onThemeToggle={toggleTheme}
        language={i18n.language}
        onLanguageToggle={toggleLanguage}
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
          </div>

          {/* Settings */}
          <div className="h-full flex flex-col overflow-hidden" style={{ display: activePage === "settings" ? "flex" : "none" }}>
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
          </div>

          {/* Dashboard */}
          <div className="h-full flex flex-col py-3 overflow-hidden px-4 scroll-gutter-match" style={{ display: activePage === "dashboard" ? "flex" : "none" }}>
            <DashboardPanel
              status={status}
              connectedSince={connectedSince}
              configPath={config.configPath}
              vpnMode={vpnMode}
              onConnect={handleConnect}
              onDisconnect={handleDisconnect}
              onNavigateToControl={() => setActivePage("control")}
            />
          </div>

          {/* Routing */}
          <div className="h-full flex flex-col overflow-hidden" style={{ display: activePage === "routing" ? "flex" : "none" }}>
            <RoutingPanel
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
          </div>

          {/* Logs */}
          <div className="h-full flex flex-col py-3 overflow-hidden px-4 scroll-gutter-match" style={{ display: activePage === "logs" ? "flex" : "none" }}>
            {statusPanelNode}
            <LogPanel
              logs={vpnLogs}
              onClear={() => setVpnLogs([])}
              fullWidth
            />
          </div>

          {/* App Settings (placeholder) */}
          <div className="h-full flex flex-col py-3 overflow-hidden px-4 scroll-gutter-match" style={{ display: activePage === "appSettings" ? "flex" : "none" }}>
            {statusPanelNode}
            <div className="flex-1 flex items-center justify-center" style={{ color: "var(--color-text-muted)" }}>
              <div className="text-center">
                <p className="text-lg font-semibold mb-1">{i18n.t("tabs.appSettings")}</p>
                <p className="text-xs">{i18n.t("messages.coming_soon")}</p>
              </div>
            </div>
          </div>

          {/* About */}
          <div className="h-full flex flex-col overflow-hidden px-4 scroll-gutter-match" style={{ display: activePage === "about" ? "flex" : "none" }}>
            {statusPanelNode}
            <AboutPanel
              updateInfo={updateInfo}
              onCheckUpdates={() => checkForUpdates(false)}
              onOpenDownload={() => { if (updateInfo.downloadUrl) open(updateInfo.downloadUrl); }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
