import { useState, useRef, useMemo, useCallback } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { TitleBar } from "./components/layout/TitleBar";
import { TabNavigation } from "./components/layout/TabNavigation";
import { WindowControls } from "./components/layout/WindowControls";
import StatusPanel from "./components/StatusPanel";
import LogPanel from "./components/LogPanel";
import { ControlPanelPage } from "./components/ControlPanelPage";
import SetupWizard from "./components/SetupWizard";
import ConnectionPanel from "./components/ConnectionPanel";
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
import { WelcomeTour } from "./components/welcome/WelcomeTour";
import { useWelcomeTour } from "./shared/hooks/useWelcomeTour";
import { Settings, Terminal, X } from "lucide-react";
import type { AppTab, VpnStatus, VpnConfig, LogEntry, ReconnectProgress } from "./shared/types";

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
  // 02-20: per-attempt «Попытка N/3» reconnect progress, surfaced by useVpnEvents from
  // the vpn-status payload (server-lost auto-retry only). Lifted here so StatusPanel can
  // render the counter; null whenever no per-attempt retry is live.
  const [reconnectProgress, setReconnectProgress] = useState<ReconnectProgress | null>(null);
  const [vpnMode, setVpnMode] = useState<string>("general");
  // vpnLogs is the live vpn-log stream collected by useVpnEvents (setVpnLogs).
  // Previously prefixed `_vpnLogs` (collected-but-unused) because LogPanel was
  // not rendered anywhere. It is now surfaced through the in-window LogPanel
  // overlay below (toggled by the title-bar Terminal button).
  const [vpnLogs, setVpnLogs] = useState<LogEntry[]>([]);
  // In-window log overlay visibility. This is a normal React overlay rendered
  // inside the main window — NOT a second OS WebviewWindow. A removed earlier
  // approach (a separate `open_log_window` webview) froze the whole app; an
  // in-window panel structurally cannot block the main window's event loop.
  const [showLogs, setShowLogs] = useState(false);
  const [connectedSince, setConnectedSince] = useState<Date | null>(() => {
    const saved = localStorage.getItem("tt_connected_since");
    return saved ? new Date(saved) : null;
  });

  // ─── Panel remount keys ───
  const [wizardKey, setWizardKey] = useState(0);
  // UAT 2026-05-20 — `controlKey` is now writable so SetupWizard's
  // onSetupComplete can bump it. Remounting ControlPanelPage forces
  // `useServerState.loadServerInfo()` to re-run with the existing
  // sshParams — otherwise the cached `installed=false` from the pre-
  // install panel load sticks around and the user sees the «Установить
  // / Выйти» screen even after a successful deploy.
  const [controlKey, setControlKey] = useState(0);
  const [connectionKey, setConnectionKey] = useState(0);
  const [routingKey, setRoutingKey] = useState(0);

  // ─── Setup wizard overlay (UAT 2026-05-20) ───
  // Mounted as fullscreen overlay when user clicks «Установить» on the
  // not-installed screen. Wizard reads `trusttunnel_wizard` localStorage
  // for initial step (set by ServerPanel install handler to step="endpoint",
  // mode="deploy").
  const [wizardActive, setWizardActive] = useState(false);

  // ─── Welcome onboarding tour (Phase 18, REQ-18-ONBOARDING-01..04) ───
  // First-run пользователи (нет `tt_welcome_completed` И нет
  // `tt_ssh_last_host`) видят 3-step intro overlay. Existing users (хотя бы
  // одно SSH-подключение делалось) пропускают тур автоматически — Pitfall 8
  // mitigation. `tt_ssh_last_host` capturedшаредно на mount чтобы переход
  // в connection flow после welcome не «перезакрыл» тур.
  const { completed: welcomeCompleted, complete: completeWelcome } = useWelcomeTour();
  const hasExistingCredentials = useMemo(
    () => Boolean(localStorage.getItem("tt_ssh_last_host")),
    [],
  );
  const showWelcomeTour = !welcomeCompleted && !hasExistingCredentials;
  // Intent-based completion: 'start' → navigate to connection tab, 'skip' (X corner)
  // → stay where we are. WelcomeTour hook сам пишет localStorage; здесь только
  // re-render + conditional navigate.
  const handleWelcomeComplete = useCallback(
    (intent: "skip" | "start") => {
      completeWelcome();
      if (intent === "start") {
        setActiveTab("connection");
      }
    },
    [completeWelcome],
  );

  // ─── External integrations ───
  const { updateInfo, checkForUpdates } = useUpdateChecker();

  // ─── Phase 19 (UI-SPEC §Block 1) — sidecar-update lifted from ControlPanelPage.
  //
  // The ControlPanelPage owns SSH credentials and runs Stage 2 detection via
  // `useUpdateChecker(sshParams).checkSidecarForServer(...)`. It lifts the
  // resulting flag here via `onSidecarUpdateChange` so the bottom
  // TabNavigation can render the dot on «Панель управления». Per-version
  // dismissal is honoured by the child (`sidecarAvailable && !sidecarDismissed`
  // → caller propagates only the net visibility).
  const [hasSidecarUpdate, setHasSidecarUpdate] = useState(false);

  // App-level update flag derives from the Stage 1 `useUpdateChecker()` call
  // above. `appAvailable` is the Phase 18 dual-detection field — falls back to
  // legacy `available` alias so AboutPanel test surface stays untouched.
  const hasAppUpdate = updateInfo.appAvailable ?? updateInfo.available;
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
    setReconnectProgress,
  });

  // ─── Shell hooks (Phase 12.5 decomposition) ───
  useConfigLifecycle({
    config,
    setConfig,
    setVpnMode,
    setWizardKey,
    setConnectionKey,
    activeTab,
    setActiveTab,
    pushSuccess,
    i18n,
  });
  useAutoConnect({ config, status, setStatus, setError });
  useTabPersistence({ activeTab, config, status, connectedSince });
  useActivityLogStartup();

  // ─── Log viewing ───
  // Logs are surfaced exclusively through the in-window LogPanel overlay
  // (toggled by the title-bar Terminal button, see showLogs above). An earlier
  // dev-only separate-webview approach (a `open_log_window` Rust command bound to
  // Ctrl+Shift+L) was removed: a second OS window blocked the main window's event
  // loop (froze connect/disconnect/drag/exit) and its shortcut collided with the
  // language toggle. The in-window overlay cannot block the event loop.

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
    setConnectionKey,
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
      reconnectProgress={reconnectProgress}
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

      {/* Title bar — brand + logs toggle + window controls.
          The logs button lands in the title bar's right-side controls slot
          (which excludes the drag region), BEFORE WindowControls. It toggles
          the in-window LogPanel overlay. It is the ONLY trigger — no keyboard
          shortcut is added (Ctrl+Shift+L already toggles language, see
          useKeyboardShortcuts.ts). */}
      <TitleBar>
        <button
          type="button"
          onClick={() => setShowLogs((v) => !v)}
          aria-label={i18n.t("logs.toggle_aria")}
          aria-pressed={showLogs}
          title={i18n.t("logs.toggle_aria")}
          className="flex items-center justify-center w-8 h-8 transition-colors outline-none focus-visible:shadow-[var(--focus-ring)] hover:bg-[var(--color-bg-hover)]"
          style={{
            color: showLogs
              ? "var(--color-accent-interactive)"
              : "var(--color-text-muted)",
            backgroundColor: showLogs ? "var(--color-accent-tint-10)" : undefined,
          }}
        >
          <Terminal className="w-4 h-4" />
        </button>
        <WindowControls />
      </TitleBar>

      {/* Content area */}
      <div
        className="flex-1 min-h-0 overflow-hidden relative"
        style={{
          maxWidth: 1000,
          width: "100%",
          margin: "0 auto",
          transition: "padding var(--transition-fast) var(--ease-out)",
        }}
      >
        {/* Control Panel */}
        <div
          role="tabpanel"
          id="tabpanel-control"
          aria-labelledby="tab-control"
          tabIndex={0}
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
                setConnectionKey((k) => k + 1);
              }}
              onSwitchToSetup={() => {
                // Remount wizard so it picks up freshly-written localStorage step/mode.
                setWizardKey((k) => k + 1);
                // Activate the wizard overlay (UAT 2026-05-20: «Установить»
                // must actually launch the install flow, not just nav-noop).
                setWizardActive(true);
              }}
              onNavigateToSettings={() => {
                setActiveTab("settings");
              }}
              onSidecarUpdateChange={setHasSidecarUpdate}
            />
          </PanelErrorBoundary>
        </div>

        {/* Connection */}
        <div
          role="tabpanel"
          id="tabpanel-connection"
          aria-labelledby="tab-connection"
          tabIndex={0}
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
              <ConnectionPanel
                key={connectionKey}
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
          role="tabpanel"
          id="tabpanel-routing"
          aria-labelledby="tab-routing"
          tabIndex={0}
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
          role="tabpanel"
          id="tabpanel-settings"
          aria-labelledby="tab-settings"
          tabIndex={0}
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
          role="tabpanel"
          id="tabpanel-about"
          aria-labelledby="tab-about"
          tabIndex={0}
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

      {/* Bottom tab navigation — wrapped in same maxWidth as content area so it aligns with the rest of the UI */}
      <div style={{ maxWidth: 1000, width: "100%", margin: "0 auto", flexShrink: 0 }}>
        <TabNavigation
          activeTab={activeTab}
          onTabChange={(tab) => setActiveTab(tab)}
          hasAppUpdate={hasAppUpdate}
          hasSidecarUpdate={hasSidecarUpdate}
        />
      </div>
    </div>

    {/* Welcome onboarding tour — full-screen overlay для first-run users
        (Phase 18, REQ-18-ONBOARDING-01..04). Mount ДО wizardActive: если
        оба бы оказались true (теоретически только когда пользователь
        вручную почистил localStorage сразу после install), Welcome
        первичен — пользователь увидит intro потом продолжит к шеллу.
        `onComplete` дёргает hook'овский complete() (уже сохранён в
        localStorage) — `welcomeCompleted` обновится на следующем render
        и overlay unmount-ится. */}
    {showWelcomeTour && (
      <WelcomeTour onComplete={handleWelcomeComplete} />
    )}

    {/* Setup wizard — overlay activated by «Установить» on the not-installed
        screen. Reads `trusttunnel_wizard` localStorage for initial step/mode
        (set by ServerPanel install handler).

        UAT 2026-05-20 v2 — overlay layout adjustments:
          • `top-[32px]` keeps TitleBar visible (drag region + window controls)
          • `bottom-[64px]` keeps bottom TabNavigation visible AND clickable.
            User can switch tabs while install runs in the background (the
            other tab content stays under the overlay until cancel/close —
            but the tab bar itself is no longer hidden).
          • `flex flex-col` + child steps with `flex-1 items-center` → content
            vertically centers in the middle band instead of sticking to top.
          • `max-w-[600px] mx-auto` shrinks the canvas to a centered column —
            stops form steps from spanning the full 1000px window width,
            which is what made content look "stuck top-left". */}
    {wizardActive && (
      <div
        className="fixed top-[32px] bottom-[64px] left-0 right-0 z-[var(--z-modal)] overflow-y-auto flex flex-col"
        style={{ background: "var(--color-bg-primary)" }}
      >
        <div className="flex-1 flex flex-col w-full max-w-[600px] mx-auto">
          <SetupWizard
            key={wizardKey}
            onSetupComplete={(configPath) => {
              setConfig((prev) => ({ ...prev, configPath }));
              if (configPath) localStorage.setItem("tt_config_path", configPath);
              setWizardActive(false);
              // UAT 2026-05-21 — honour DoneStep navigation intent. DoneStep
              // writes `tt_navigate_after_setup` = "connection" (or "settings",
              // "routing") when the user clicks a tab-specific CTA. Without
              // this read, both DoneStep buttons («Перейти в панель
              // управления» + «Перейти к подключению») landed on the same
              // control tab — bug reported by user.
              const VALID_TABS: AppTab[] = ["control", "connection", "routing", "settings", "about"];
              const intent = localStorage.getItem("tt_navigate_after_setup");
              localStorage.removeItem("tt_navigate_after_setup");
              const targetTab: AppTab = VALID_TABS.includes(intent as AppTab)
                ? (intent as AppTab)
                : "control";
              setActiveTab(targetTab);
              // UAT 2026-05-20 — force ControlPanelPage remount so
              // useServerState.loadServerInfo() re-fetches
              // check_server_installation and detects the newly-installed
              // endpoint. Without this bump the cached pre-install
              // `installed=false` keeps the «Установить / Выйти» screen
              // visible after a successful deploy.
              setControlKey((k) => k + 1);
            }}
          />
        </div>
      </div>
    )}

    {/* In-window log overlay — mirrors the SetupWizard overlay layout so it
        sits BELOW the 32px title bar and ABOVE the 64px bottom tabs (both stay
        visible + usable while logs are open). This is a plain React overlay
        inside the main window — NOT a second OS window — so connect/disconnect/
        drag/exit keep working with it open, unlike the removed separate-webview
        log window which froze the app. Width is capped to the same 1000px
        centered column as the content area. */}
    {showLogs && (
      <div
        className="fixed top-[32px] bottom-[64px] left-0 right-0 z-[var(--z-modal)] overflow-hidden flex flex-col"
        style={{ background: "var(--color-bg-primary)" }}
      >
        <div className="flex-1 flex flex-col w-full max-w-[1000px] mx-auto min-h-0 px-4 pb-4">
          {/* Compact overlay header — title + close */}
          <div className="flex items-center justify-between py-3 shrink-0">
            <span
              className="text-sm font-semibold"
              style={{ color: "var(--color-text-primary)" }}
            >
              {i18n.t("logs.title")}
            </span>
            <button
              type="button"
              onClick={() => setShowLogs(false)}
              aria-label={i18n.t("logs.close_aria")}
              title={i18n.t("logs.close_aria")}
              className="flex items-center justify-center w-7 h-7 rounded-[var(--radius-sm)] transition-colors outline-none focus-visible:shadow-[var(--focus-ring)] hover:bg-[var(--color-bg-hover)]"
              style={{ color: "var(--color-text-muted)" }}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <LogPanel
            logs={vpnLogs}
            onClear={() => setVpnLogs([])}
            isConnected={status === "connected"}
          />
        </div>
      </div>
    )}

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
