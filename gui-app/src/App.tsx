import { useState, useRef, useMemo, useCallback } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { TitleBar } from "./components/layout/TitleBar";
import { TabNavigation } from "./components/layout/TabNavigation";
import { WindowControls } from "./components/layout/WindowControls";
import StatusPanel from "./components/StatusPanel";
import { ControlPanelPage } from "./components/ControlPanelPage";
import SettingsPanel from "./components/SettingsPanel";
import RoutingPanel from "./components/RoutingPanel";
import AboutPanel from "./components/AboutPanel";
import AppSettingsPanel from "./components/AppSettingsPanel";
import { PanelErrorBoundary } from "./shared/ui/PanelErrorBoundary";
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
import { useConfigLifecycle } from "./shared/hooks/useConfigLifecycle";
import { useAutoConnect } from "./shared/hooks/useAutoConnect";
import { useTabPersistence } from "./shared/hooks/useTabPersistence";
import { useActivityLogStartup } from "./shared/hooks/useActivityLogStartup";
import { useAppShellActions } from "./shared/hooks/useAppShellActions";
import { DropOverlay } from "./shared/ui/DropOverlay";
import { EmptyState } from "./shared/ui/EmptyState";
import { ConfirmDialog, ConfirmDialogProvider } from "./shared/ui";
import { Settings } from "lucide-react";
import type { AppTab, VpnStatus, VpnConfig, LogEntry } from "./shared/types";

function App() {
  // ─── Theme & Language ───
  const { themeMode, handleThemeChange, toggleTheme } = useTheme();
  const { i18n, handleLanguageChange, toggleLanguage } = useLanguage();

  // ─── Navigation ───
  const [activeTab, setActiveTab] = useState<AppTab>(() => {
    const savedConfig = localStorage.getItem("tt_config_path");
    return savedConfig ? "connection" : "control";
  });

  // ─── Core VPN state ───
  const [status, setStatus] = useState<VpnStatus>("disconnected");
  const [config, setConfig] = useState<VpnConfig>(() => {
    const savedPath = localStorage.getItem("tt_config_path") || "";
    const savedLevel = localStorage.getItem("tt_log_level") || "info";
    return { configPath: savedPath, logLevel: savedLevel };
  });
  const [error, setError] = useState<string | null>(null);
  const [vpnMode, setVpnMode] = useState<string>("general");
  const [_vpnLogs, setVpnLogs] = useState<LogEntry[]>([]);
  const [connectedSince, setConnectedSince] = useState<Date | null>(() => {
    const saved = localStorage.getItem("tt_connected_since");
    return saved ? new Date(saved) : null;
  });

  // ─── Panel remount keys ───
  const [, setWizardKey] = useState(0);
  const [controlKey] = useState(0);
  const [settingsKey, setSettingsKey] = useState(0);
  const [routingKey, setRoutingKey] = useState(0);

  // ─── External integrations ───
  const { updateInfo, checkForUpdates } = useUpdateChecker();
  const { pending: hostKeyPending, respond: hostKeyRespond } = useHostKeyVerification();
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

  // ─── Shell hooks (Phase 12.5 decomposition) ───
  useConfigLifecycle({
    config,
    setConfig,
    setVpnMode,
    setWizardKey,
    setSettingsKey,
    activeTab,
    setActiveTab,
    pushSuccess,
    i18n,
  });
  useAutoConnect({ config, status, setStatus, setError });
  useTabPersistence({ activeTab, config, status, connectedSince });
  useActivityLogStartup();

  // ─── VPN Actions ───
  const { handleConnect, handleDisconnect, handleReconnect } = useVpnActions({
    config,
    status,
    setStatus,
    setError,
    i18n,
    reconnectResolve,
  });

  // ─── Shell action callbacks ───
  const { handleClearConfig, handleDropConfig, handleDropRouting } = useAppShellActions({
    status,
    setStatus,
    setConfig,
    setWizardKey,
    setSettingsKey,
    setRoutingKey,
    setActiveTab,
  });

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
  const { isDragging } = useFileDrop({
    status,
    onConfigImported: handleDropConfig,
    onRoutingImported: handleDropRouting,
    pushSuccess,
    isBusy: false,
  });

  const hasConfig = !!config.configPath;
  const showStatusPanel = hasConfig && activeTab !== "control";

  const vpnContextValue = useMemo(
    () => ({
      status,
      connectedSince,
      configPath: config.configPath,
      vpnMode,
      onConnect: handleConnect,
      onDisconnect: handleDisconnect,
      onReconnect: handleReconnect,
    }),
    [status, connectedSince, config.configPath, vpnMode, handleConnect, handleDisconnect, handleReconnect],
  );

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
    <ConfirmDialogProvider>
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
        className="flex-1 min-h-0 overflow-hidden relative"
        style={{
          maxWidth: 1200,
          width: "100%",
          margin: "0 auto",
          transition: "padding var(--transition-fast) var(--ease-out)",
        }}
      >
        {/* Control Panel */}
        <div
          className="h-full flex flex-col overflow-hidden"
          style={{
            position: activeTab === "control" ? "relative" : "absolute",
            inset: activeTab === "control" ? undefined : 0,
            opacity: activeTab === "control" ? 1 : 0,
            visibility: activeTab === "control" ? ("visible" as const) : ("hidden" as const),
            transition: "opacity var(--transition-fast)",
          }}
          aria-hidden={activeTab !== "control"}
        >
          <PanelErrorBoundary onNavigateHome={() => setActiveTab("control")} panelName="Control Panel">
            <ControlPanelPage
              key={controlKey}
              onConfigExported={(path) => {
                setConfig((prev) => ({ ...prev, configPath: path }));
                localStorage.setItem("tt_config_path", path);
                setSettingsKey((k) => k + 1);
              }}
              onSwitchToSetup={() => {
                setWizardKey((k) => k + 1);
              }}
              onNavigateToSettings={() => {
                setActiveTab("settings");
              }}
            />
          </PanelErrorBoundary>
        </div>

        {/* Connection */}
        <div
          className="h-full flex flex-col overflow-hidden"
          style={{
            position: activeTab === "connection" ? "relative" : "absolute",
            inset: activeTab === "connection" ? undefined : 0,
            opacity: activeTab === "connection" ? 1 : 0,
            visibility: activeTab === "connection" ? ("visible" as const) : ("hidden" as const),
            transition: "opacity var(--transition-fast)",
          }}
          aria-hidden={activeTab !== "connection"}
        >
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
        <div
          className="h-full flex flex-col overflow-hidden"
          style={{
            position: activeTab === "routing" ? "relative" : "absolute",
            inset: activeTab === "routing" ? undefined : 0,
            opacity: activeTab === "routing" ? 1 : 0,
            visibility: activeTab === "routing" ? ("visible" as const) : ("hidden" as const),
            transition: "opacity var(--transition-fast)",
          }}
          aria-hidden={activeTab !== "routing"}
        >
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

        {/* Settings */}
        <div
          className="h-full flex flex-col overflow-hidden"
          style={{
            position: activeTab === "settings" ? "relative" : "absolute",
            inset: activeTab === "settings" ? undefined : 0,
            opacity: activeTab === "settings" ? 1 : 0,
            visibility: activeTab === "settings" ? ("visible" as const) : ("hidden" as const),
            transition: "opacity var(--transition-fast)",
          }}
          aria-hidden={activeTab !== "settings"}
        >
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
        <div
          className="h-full flex flex-col overflow-hidden"
          style={{
            position: activeTab === "about" ? "relative" : "absolute",
            inset: activeTab === "about" ? undefined : 0,
            opacity: activeTab === "about" ? 1 : 0,
            visibility: activeTab === "about" ? ("visible" as const) : ("hidden" as const),
            transition: "opacity var(--transition-fast)",
          }}
          aria-hidden={activeTab !== "about"}
        >
          {statusPanelNode}
          <AboutPanel
            updateInfo={updateInfo}
            onCheckUpdates={() => checkForUpdates(false)}
            onOpenDownload={() => {
              if (updateInfo.downloadUrl) open(updateInfo.downloadUrl);
            }}
          />
        </div>
      </div>

      {/* Bottom tab navigation */}
      <TabNavigation activeTab={activeTab} onTabChange={(tab) => setActiveTab(tab)} />
    </div>

    <ConfirmDialog
      isOpen={hostKeyPending !== null}
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

    </ConfirmDialogProvider>
    </VpnProvider>
  );
}

export default App;
