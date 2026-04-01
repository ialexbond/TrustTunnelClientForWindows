import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { WindowControls } from "./components/WindowControls";
import { BottomNav } from "./components/BottomNav";
import VpnScreen from "./components/VpnScreen";
import RoutingScreen from "./components/RoutingScreen";
import SettingsScreen from "./components/SettingsScreen";
import AboutScreen from "./components/AboutScreen";
import { ImportConfigModal } from "./components/wizard/ImportConfigModal";
import { useTheme } from "./shared/hooks/useTheme";
import { useLanguage } from "./shared/hooks/useLanguage";
import { useVpnEvents } from "./shared/hooks/useVpnEvents";
import { useVpnActions } from "./shared/hooks/useVpnActions";
import { useUpdateChecker } from "./shared/hooks/useUpdateChecker";
import { useSnackBar } from "./shared/ui/SnackBarContext";
import type { VpnStatus, VpnConfig, LogEntry } from "./shared/types";

export type AppTab = "vpn" | "routing" | "settings" | "about";

function App() {
  // ─── Theme & Language ───
  const { theme, themeMode, handleThemeChange } = useTheme();
  const { i18n, handleLanguageChange } = useLanguage();
  const pushSuccess = useSnackBar();

  // ─── Tab state ───
  const [activeTab, setActiveTab] = useState<AppTab>(() => {
    const saved = localStorage.getItem("ttl_active_tab");
    if (saved === "vpn" || saved === "routing" || saved === "settings" || saved === "about") return saved;
    return "vpn";
  });

  useEffect(() => {
    localStorage.setItem("ttl_active_tab", activeTab);
  }, [activeTab]);

  // ─── VPN state ───
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
    const saved = localStorage.getItem("ttl_connected_since");
    return saved ? new Date(saved) : null;
  });

  const reconnectResolve = useRef<(() => void) | null>(null);

  // Persist config path
  useEffect(() => {
    localStorage.setItem("tt_config_path", config.configPath);
  }, [config.configPath]);

  // Persist connectedSince
  useEffect(() => {
    if (connectedSince) {
      localStorage.setItem("ttl_connected_since", connectedSince.toISOString());
    } else {
      localStorage.removeItem("ttl_connected_since");
    }
  }, [connectedSince]);

  // ─── VPN events (status sync, internet recovery, log collector) ───
  useVpnEvents({
    i18n,
    setStatus,
    setError,
    setConnectedSince,
    setVpnLogs,
    reconnectResolve,
    pushSuccess,
  });

  // ─── VPN actions ───
  const { handleConnect, handleDisconnect, handleReconnect } = useVpnActions({
    config,
    status,
    setStatus,
    setError,
    i18n,
    reconnectResolve,
  });

  // ─── Update checker ───
  const { updateInfo, checkForUpdates } = useUpdateChecker();

  // ─── Config validation on startup & auto-detect ───
  useEffect(() => {
    const savedPath = localStorage.getItem("tt_config_path");
    if (savedPath) {
      invoke<{ vpn_mode?: string }>("read_client_config", { configPath: savedPath })
        .then((cfg) => {
          if (cfg?.vpn_mode) setVpnMode(cfg.vpn_mode);
        })
        .catch(() => {
          localStorage.removeItem("tt_config_path");
          setConfig({ configPath: "", logLevel: "info" });
        });
    } else {
      invoke<string | null>("auto_detect_config")
        .then((detected) => {
          if (detected) {
            setConfig((prev) => ({ ...prev, configPath: detected }));
          }
        })
        .catch(() => {});
    }
  }, []);

  // ─── Config file watcher ───
  useEffect(() => {
    if (!config.configPath) return;
    invoke("watch_config_file", { configPath: config.configPath }).catch(() => {});

    const unlisten = listen("config-file-changed", () => {
      invoke<{ vpn_mode?: string }>("read_client_config", { configPath: config.configPath })
        .then((cfg) => {
          if (cfg?.vpn_mode) setVpnMode(cfg.vpn_mode);
        })
        .catch(() => {});
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [config.configPath]);

  // ─── Auto-connect on startup ───
  useEffect(() => {
    if (
      localStorage.getItem("tt_auto_connect") === "true" &&
      config.configPath &&
      status === "disconnected"
    ) {
      handleConnect();
    }
    // Only run on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Deep-link listener ───
  const [deepLinkUrl, setDeepLinkUrl] = useState<string | undefined>();
  const [importModalOpen, setImportModalOpen] = useState(false);

  useEffect(() => {
    const unlisten = listen<{ url: string }>("deep-link", (event) => {
      setDeepLinkUrl(event.payload.url);
      setImportModalOpen(true);
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  const handleImportConfig = useCallback(() => {
    setImportModalOpen(true);
  }, []);

  const handleConfigImported = useCallback((path: string) => {
    setConfig((prev) => ({ ...prev, configPath: path }));
    setError(null); // Clear any previous error
    invoke<{ vpn_mode?: string }>("read_client_config", { configPath: path })
      .then((cfg) => {
        if (cfg?.vpn_mode) setVpnMode(cfg.vpn_mode);
      })
      .catch(() => {});
    setImportModalOpen(false);
    setDeepLinkUrl(undefined);
  }, []);

  return (
    <div
      className="h-screen flex flex-col"
      style={{ backgroundColor: "var(--color-bg-primary)" }}
    >
      {/* Title bar — draggable */}
      <div
        className="flex items-center shrink-0"
        data-tauri-drag-region
        style={{ height: 32, borderBottom: "1px solid var(--color-border)", backgroundColor: "var(--color-bg-secondary)" }}
      >
        <div className="flex items-center gap-1.5 pl-3" data-tauri-drag-region>
          <span className="text-xs font-bold tracking-wide" style={{ color: "var(--color-text-secondary)" }} data-tauri-drag-region>
            TrustTunnel
          </span>
          <span
            className="text-[9px] font-bold px-1.5 py-0.5 rounded"
            style={{ backgroundColor: "rgba(99, 102, 241, 0.1)", color: "var(--color-accent-500)" }}
          >
            LIGHT
          </span>
        </div>
        <div className="flex-1" data-tauri-drag-region />
        <WindowControls />
      </div>

      <div className="flex-1 min-h-0 w-full">
        {/* VPN */}
        <div
          className="h-full flex flex-col overflow-hidden"
          style={{ display: activeTab === "vpn" ? "flex" : "none" }}
        >
          <VpnScreen
            status={status}
            error={error}
            connectedSince={connectedSince}
            configPath={config.configPath}
            vpnMode={vpnMode}
            onConnect={handleConnect}
            onDisconnect={handleDisconnect}
            onImportConfig={handleImportConfig}
          />
        </div>

        {/* Routing */}
        <div
          className="h-full flex flex-col overflow-hidden"
          style={{ display: activeTab === "routing" ? "flex" : "none" }}
        >
          <RoutingScreen
            configPath={config.configPath}
            status={status}
            vpnMode={vpnMode}
            onVpnModeChange={setVpnMode}
            onReconnect={handleReconnect}
          />
        </div>

        {/* Settings */}
        <div
          className="h-full flex flex-col overflow-hidden"
          style={{ display: activeTab === "settings" ? "flex" : "none" }}
        >
          <SettingsScreen
            theme={themeMode}
            onThemeChange={handleThemeChange}
            language={i18n.language}
            onLanguageChange={handleLanguageChange}
            hasConfig={!!config.configPath}
          />
        </div>

        {/* About */}
        <div
          className="h-full flex flex-col overflow-hidden"
          style={{ display: activeTab === "about" ? "flex" : "none" }}
        >
          <AboutScreen
            updateInfo={updateInfo}
            onCheckUpdates={() => checkForUpdates(false)}
            onOpenDownload={() => {
              if (updateInfo.downloadUrl) openUrl(updateInfo.downloadUrl);
            }}
          />
        </div>
      </div>

      {/* Bottom Navigation */}
      <BottomNav
        activeTab={activeTab}
        onTabChange={setActiveTab}
        updateAvailable={updateInfo.available}
        hasConfig={!!config.configPath}
      />

      {/* Import Config Modal */}
      <ImportConfigModal
        open={importModalOpen}
        onClose={() => {
          setImportModalOpen(false);
          setDeepLinkUrl(undefined);
        }}
        onImported={handleConfigImported}
        initialUrl={deepLinkUrl}
      />
    </div>
  );
}

export default App;
