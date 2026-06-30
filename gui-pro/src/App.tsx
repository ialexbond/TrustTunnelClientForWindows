import { useState, useRef, useMemo, useCallback, useEffect } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { invoke } from "@tauri-apps/api/core";
import { TitleBar } from "./components/layout/TitleBar";
import { TabNavigation } from "./components/layout/TabNavigation";
import { WindowControls } from "./components/layout/WindowControls";
import StatusPanel from "./components/StatusPanel";
import LogPanel from "./components/LogPanel";
import { ControlPanelPage } from "./components/ControlPanelPage";
import SetupWizard from "./components/SetupWizard";
import {
  ConnectionPanel as MultiConfigConnectionPanel,
  type ConnectionPanelHandle,
} from "./components/connection/ConnectionPanel";
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
import { useDeepLinkImport } from "./shared/hooks/useDeepLinkImport";
import { useConfigLifecycle } from "./shared/hooks/useConfigLifecycle";
import { useAutoConnect } from "./shared/hooks/useAutoConnect";
import { useTabPersistence } from "./shared/hooks/useTabPersistence";
import { useActivityLogStartup } from "./shared/hooks/useActivityLogStartup";
import { useAppShellActions } from "./shared/hooks/useAppShellActions";
import { useTrayNavigate } from "./shared/hooks/useTrayNavigate";
import { runViewTransition } from "./shared/utils/viewTransition";
import { DropOverlay } from "./shared/ui/DropOverlay";
import { ConfirmDialog, ConfirmDialogProvider } from "./shared/ui";
import { ImportModal } from "./components/connection/ImportModal";
import { shouldActivateConfig } from "./components/wizard/shouldActivateConfig";
import { WelcomeTour } from "./components/welcome/WelcomeTour";
import { useWelcomeTour } from "./shared/hooks/useWelcomeTour";
import { Terminal, X } from "lucide-react";
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
  // Phase 11: the old single-config ConnectionPanel (which consumed `connectionKey` as a
  // remount key) is gone — the multi-config ConnectionPanel refreshes via its ref instead.
  // The setter is kept because several hooks/handlers (useConfigLifecycle, useAppShellActions,
  // the wizard/import paths) still signal a "config changed" remount through it; the value
  // itself is no longer read by any panel.
  const [, setConnectionKey] = useState(0);
  const [routingKey, setRoutingKey] = useState(0);

  // ─── Setup wizard overlay (UAT 2026-05-20) ───
  // Mounted as fullscreen overlay when user clicks «Установить» on the
  // not-installed screen. Wizard reads `trusttunnel_wizard` localStorage
  // for initial step (set by ServerPanel install handler to step="endpoint",
  // mode="deploy").
  const [wizardActive, setWizardActive] = useState(false);
  // UAT (06-uat fix 9): which tab LAUNCHED the wizard. The overlay is a fixed,
  // full-band layer; previously it rendered on `wizardActive` alone, so it covered
  // EVERY tab and a running install blocked the user on all sections. We now record
  // the launch tab and only make the overlay VISIBLE on that tab — but the
  // SetupWizard stays MOUNTED while wizardActive (hidden via CSS, never unmounted),
  // so the deploy-step listener stays alive and a running install keeps going in the
  // background while the user browses other tabs. The × still fully closes.
  const [wizardLaunchTab, setWizardLaunchTab] = useState<AppTab>("control");

  // ─── Connection import (D-06) ───
  // The import entry lives on the «Подключение» tab — the empty-state CTA and the «Добавить
  // конфиг» button both call ConnectionPanel's onImport, which opens the production
  // ImportModal (Phase 11, 11-06). `importOpen` mounts that modal. The «Забрать с сервера»
  // (fetch) choice was removed end-to-end — fetching an existing user's config is done from
  // the Control Panel (per-user QR/Link).
  const [importOpen, setImportOpen] = useState(false);
  // C-22 / D-14 — a clicked tt:// / trusttunnel:// deep-link pre-fills the import
  // modal. The URL survives `consume()` here so it can be passed as the modal's
  // `initialUrl`; it is cleared on modal close/import so a later MANUAL open is not
  // pre-filled with a stale URL.
  const [deepLinkUrl, setDeepLinkUrl] = useState<string | null>(null);

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
  // Manual re-trigger of the welcome tour (About → «Приветственный тур»). The
  // auto-show path above stays gated on the existing-user auto-skip (a configured
  // user is not interrupted on startup); this lets such a user explicitly re-open
  // the tour at any time. Signalled via a window CustomEvent so AboutPanel —
  // rendered deep in the shell — doesn't prop-drill the trigger up to this overlay.
  const [manualWelcomeTour, setManualWelcomeTour] = useState(false);
  useEffect(() => {
    const onShow = () => setManualWelcomeTour(true);
    window.addEventListener("tt-show-welcome-tour", onShow);
    return () => window.removeEventListener("tt-show-welcome-tour", onShow);
  }, []);
  const showWelcomeTour = manualWelcomeTour || (!welcomeCompleted && !hasExistingCredentials);
  // Intent-based completion: 'start' → navigate by config presence, 'skip' (X corner)
  // → stay where we are. WelcomeTour hook сам пишет localStorage; здесь только
  // re-render + conditional navigate.
  //
  // C-21 / D-17 (round-2 audit fix): раньше 'start' ВСЕГДА вёл на вкладку
  // «Подключение». Но first-run пользователь без конфига там упирается в
  // no-config EmptyState, который отправляет его ОБРАТНО в «Панель управления» —
  // петля. Теперь без конфига 'start' ведёт прямо на «Панель управления» (там
  // живёт connect/install-вход ServerPanel), чтобы заявление D-01 «установка
  // начинается из онбординга» стало буквально верным. С уже имеющимся конфигом
  // по-прежнему ведём на «Подключение».
  const handleWelcomeComplete = useCallback(
    (intent: "skip" | "start") => {
      // Close the manually-opened tour too (no-op when it was auto-shown).
      setManualWelcomeTour(false);
      completeWelcome();
      if (intent === "start") {
        setActiveTab(config.configPath ? "connection" : "control");
      }
    },
    [completeWelcome, config.configPath],
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

  // C-22 / D-14 — deep-link config import. A clicked tt:// / trusttunnel:// link
  // (single-instance arg, runtime event, or the backend startup file-poll — all
  // funnel into one `deep-link-url` event) surfaces here as `pendingUrl`. The URL
  // is UNTRUSTED external input: we only ROUTE the user to the Connection import
  // surface and PRE-FILL the modal — the URL is never auto-imported. Validation
  // happens in the backend `decode_deeplink` boundary when the user clicks
  // «Импортировать», so a malformed link cannot silently write a config.
  const { pendingUrl: deepLinkPendingUrl, consume: consumeDeepLink } = useDeepLinkImport();
  useEffect(() => {
    if (!deepLinkPendingUrl) return;
    // This effect is the legitimate "react to an external system" case: a deep-link
    // URL arrived via the useDeepLinkImport subscription, and the shell must adopt
    // it (stash + route + open the modal) on that same arrival. The cascade is
    // bounded — it runs once per distinct arrival, then consume() clears the source.
    //
    // NOTE: when a config already exists, the Connection tab renders ConnectionPanel
    // and the import modal is NOT mounted (App.tsx no-config branch). The deep-link
    // primarily serves the not-yet-configured user receiving a config link;
    // re-import-over-existing is out of round-2 scope.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: synchronizing shell state with an external deep-link arrival; bounded to one run per distinct URL (consume() clears the source)
    setDeepLinkUrl(deepLinkPendingUrl);
    setActiveTab("connection");
    setImportOpen(true);
    // Clear the hook's pending value so the same URL is not re-applied on the next
    // render; our local deepLinkUrl copy keeps it for the modal.
    consumeDeepLink();
  }, [deepLinkPendingUrl, consumeDeepLink]);
  // Phase 11 — handle on the production multi-config ConnectionPanel so an import can
  // refresh the manifest list without remounting the panel.
  const connectionPanelRef = useRef<ConnectionPanelHandle>(null);

  // Phase 11 (P11-02) — startup migration of the legacy single tt_config_path into the
  // configs.json manifest as config #1 + last-used. Runs ONCE before the Connection tab's
  // list loads. Idempotent on the Rust side (a re-run is a no-op), and once-guarded here
  // against StrictMode's double-invoke. The legacy active path is read from localStorage
  // and passed to Rust — the manifest becomes the authoritative source of truth, but the
  // user's existing working config file is never lost.
  const didMigrateRef = useRef(false);
  useEffect(() => {
    if (didMigrateRef.current) return;
    didMigrateRef.current = true;
    const legacyPath = localStorage.getItem("tt_config_path") || null;
    void invoke("migrate_configs", { legacyActivePath: legacyPath })
      .then(() => {
        // Refresh the list once migration has built the manifest (the panel may have
        // already mounted and loaded an empty list before migration finished).
        connectionPanelRef.current?.reload();
      })
      .catch(() => {
        // Migration failure must not break the app — the tab still renders (degrading to
        // the empty state). The legacy config file remains on disk regardless.
      });
  }, []);

  // IN-25/IN-49: refresh the Connection list when the WINDOW regains focus (e.g. the user deleted
  // config files in the file manager while away). The Rust fs-watcher (`configs-changed`, IN-31) is
  // the PRIMARY real-time trigger for on-disk changes; this focus listener is only a backstop.
  // NOTE: there is deliberately NO refresh on tab-SHOW — re-fetching the list a frame after the tab
  // becomes visible was a needless re-render that fought the scroll position; the fs-watcher already
  // keeps the list current while the tab is hidden, so switching back shows the correct list with the
  // scroll preserved natively (IN-49).
  useEffect(() => {
    if (activeTab !== "connection") return;
    const onFocus = () => connectionPanelRef.current?.refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [activeTab]);

  const reconnectResolve = useRef<(() => void) | null>(null);
  // AUDIT-2026-06-11 #8: true only while useVpnActions.handleReconnect (manual
  // «Сохранить и переподключить») is in flight. Shared with useVpnEvents so its
  // no-dwell guard suppresses the teardown's transient "disconnected" ONLY then —
  // a tray disconnect during a backend auto-reconnect must land as a real
  // terminal «Отключено», not be swallowed (UI used to stick on «Переподключение»).
  const manualReconnectActiveRef = useRef(false);
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
    manualReconnectActiveRef,
  });

  // ─── VPN Actions ───
  // IN-32: moved ABOVE useConfigLifecycle so the lifecycle hook can receive handleDisconnect —
  // when the ACTIVE config file is deleted externally (file manager) while connected, the tunnel
  // must be torn down. (useVpnActions only depends on state + the refs above, so the move is safe.)
  const { handleConnect, handleDisconnect, handleReconnect, switchTo } = useVpnActions({
    config,
    status,
    setStatus,
    setError,
    i18n,
    reconnectResolve,
    manualReconnectActiveRef,
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
    // IN-32: disconnect the tunnel if the ACTIVE config file disappears on disk while live.
    status,
    onDisconnect: handleDisconnect,
  });
  useAutoConnect({ config, status, setStatus, setError });
  useTabPersistence({ activeTab, config, status, connectedSince });
  useActivityLogStartup();

  // C-26: no-config tray «Подключиться» emits a `tray-navigate` event; route the
  // user to the install entry («Панель управления» — ServerPanel's connect/install
  // surface) instead of leaving them on a silent blank/last tab.
  useTrayNavigate(
    useCallback((target: "install") => {
      if (target === "install") setActiveTab("control");
    }, []),
  );

  // ─── Log viewing ───
  // Logs are surfaced exclusively through the in-window LogPanel overlay
  // (toggled by the title-bar Terminal button, see showLogs above). An earlier
  // dev-only separate-webview approach (a `open_log_window` Rust command bound to
  // Ctrl+Shift+L) was removed: a second OS window blocked the main window's event
  // loop (froze connect/disconnect/drag/exit) and its shortcut collided with the
  // language toggle. The in-window overlay cannot block the event loop.

  // Phase 11 (11-06): the multi-config Connection tab connects/switches an ARBITRARY config
  // path (the lead card or any inactive card), not just the app-level `config.configPath`.
  // `switchTo` (useVpnActions) does the disconnect-then-connect + marks the manifest
  // last-used; here we also promote the chosen path to the app-level active config +
  // localStorage so the rest of the single-config surface (Routing/Settings/status panel,
  // tt_config_path) stays consistent with what the user just connected. The optimistic
  // promote happens up front; if the connect ultimately errors, the status reflects it but
  // the active-config pointer still points at the user's intended config (matching the old
  // connect path, which also set the path before awaiting).
  const handleConnectConfig = useCallback(
    (path: string) => {
      if (path) {
        // 11-UAT gap D: commit the active-path change INSIDE a View Transition so the
        // «Подключение» list animates the chosen config gliding to the lead (and the previous
        // lead settling down), instead of snapping. ConfigList tags each card with a stable
        // view-transition-name; flushSync (inside runViewTransition) makes this re-render
        // synchronous so the browser captures the before/after frames. Reduced-motion / no-API
        // (jsdom) fall back to an instant promote.
        runViewTransition(() => {
          setConfig((prev) => ({ ...prev, configPath: path }));
        });
        localStorage.setItem("tt_config_path", path);
      }
      void switchTo(path);
    },
    [switchTo],
  );

  // ─── Shell action callbacks ───
  // Phase 11: handleClearConfig (the old single-config "remove config" action wired into
  // the legacy ConnectionPanel) is no longer surfaced — config removal moves to the
  // per-card delete flow (delete_config) in a later wave.
  // IN-18: the CONFIG drop path is now handled by handleImportedConfigDrop below (App-level,
  // behind the shouldActivateConfig guard) — NOT useAppShellActions.handleDropConfig, which
  // unconditionally promoted the dropped file to the active config even mid-connection (gap F:
  // the live card vanished). Only the routing drop still uses the shell-actions hook.
  const { handleDropRouting } = useAppShellActions({
    status,
    setStatus,
    setConfig,
    setWizardKey,
    setConnectionKey,
    setRoutingKey,
    setActiveTab,
  });

  // IN-18 (gap F): an import ADDS a config to the manifest — it must NEVER steal which config
  // is active while a tunnel is live (P11-02). Promote the imported config to the app-level
  // active config ONLY when there is no active config AND the VPN is idle (the SAME gate the
  // install wizard uses, shouldActivateConfig). Otherwise leave the live connection's active
  // pointer untouched and just refresh the card list so the new card appears below. Shared by
  // BOTH import routes (drag-drop + the import modal); without this guard, dropping/importing a
  // config while connected repointed activeConfigPath and the connected lead card disappeared.
  const promoteImportedConfig = useCallback(
    (configPath: string) => {
      if (configPath) {
        const hasActiveConfig = Boolean(config.configPath);
        const vpnConnected = status !== "disconnected" && status !== "error";
        if (shouldActivateConfig({ hasActiveConfig, vpnConnected })) {
          setConfig((prev) => ({ ...prev, configPath }));
          localStorage.setItem("tt_config_path", configPath);
          localStorage.removeItem("tt_config_cleared");
        }
      }
      // Always refresh the manifest list so the newly-added card (or copy) appears, regardless
      // of whether it was promoted to active.
      connectionPanelRef.current?.reload();
      setConnectionKey((k) => k + 1);
    },
    [config.configPath, status],
  );

  // Drag-drop config import: promote (guarded) + show the «Подключение» tab so the user sees
  // the new card. (Routing drops still go through handleDropRouting.)
  const handleImportedConfigDrop = useCallback(
    (configPath: string) => {
      promoteImportedConfig(configPath);
      setActiveTab("connection");
    },
    [promoteImportedConfig],
  );

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
    onConfigImported: handleImportedConfigDrop,
    onRoutingImported: handleDropRouting,
    pushSuccess,
    isBusy: false,
    // IN-16: gate the accepted drop format per tab («Подключение» → .toml only, «Маршрутизация»
    // → .json only) so the overlay label is truthful and a wrong-tab file is rejected clearly.
    activeTab,
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

  // IN-11 (06-review): the tabpanels stay MOUNTED (hidden via opacity/visibility, not
  // unmounted), and statusPanelNode is consumed by three of them (Connection / Settings /
  // About). StatusPanel runs a per-instance 1s uptime ticker (UptimeCounter) while
  // connected, so sharing one node across three mounted panels spun up THREE concurrent
  // tickers. Each consumer below takes the node ONLY when its own tab is active
  // (statusPanelFor), so exactly one StatusPanel — and one ticker — is ever live. Uptime is
  // derived from connectedSince, so the remount on tab-switch shows no glitch.
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
  const statusPanelFor = (tab: AppTab) => (activeTab === tab ? statusPanelNode : null);

  return (
    <VpnProvider value={vpnContextValue}>
    <ConfirmDialogProvider>
    <div
      className="h-screen flex flex-col"
      style={{ backgroundColor: "var(--color-bg-primary)", color: "var(--color-text-primary)" }}
    >
      {/* IN-15: gate the window-level drop overlay OFF while the import modal is open — the
          modal renders its OWN drop overlay (App.tsx ImportModal isDragging), so without this
          gate BOTH overlays mounted at once (one bleeding through the other) when a file was
          dragged over the open «Добавить конфиг» modal. */}
      <DropOverlay
        isDragging={isDragging && !importOpen}
        // IN-16: tab-aware hint so the overlay matches what the tab accepts — «Подключение» a
        // config (.toml), «Маршрутизация» routing rules (.json). Replaces the legacy
        // dual-format hint («.toml — конфиг VPN, .json — правила маршрутизации»).
        hint={
          activeTab === "routing"
            ? i18n.t("drop.overlay_hint_routing")
            : i18n.t("drop.overlay_hint_config")
        }
      />

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
                // UAT (06-uat fix 9): record the launching tab so the overlay is only
                // visible here — a background install no longer covers other tabs.
                setWizardLaunchTab("control");
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
            {/* Phase 11 (11-06): the Connection tab is now FULLY wired. ConnectionPanel owns
                the multi-config list + the per-config edit modal + delete/duplicate/rename
                (via the Wave-1 manifest commands) and routes connect/switch/disconnect through
                the VPN actions passed here. The lead card carries the live status; an inactive
                card's «Переключиться» calls switchTo. The empty-no-configs state lives inside
                ConfigList. */}
            <MultiConfigConnectionPanel
              ref={connectionPanelRef}
              onImport={() => setImportOpen(true)}
              status={status}
              activeConfigPath={config.configPath}
              onConnect={handleConnectConfig}
              onDisconnect={handleDisconnect}
              onSwitchTo={handleConnectConfig}
              onReconnect={handleReconnect}
            />
            {/* Production ImportModal (Phase 11, Plan 04) — the SINGLE point through which a
                config is added (two tiles / link / drag, errors-in-modal, host+user
                duplicate resolution). The deep-link pre-fill seeds the link field but the
                import fires only on an explicit click (deeplink-never-auto). On success the
                imported path is appended to the manifest by the backend import path; here we
                promote it to the app-level active config + reload the card list. */}
            <ImportModal
              isOpen={importOpen}
              // C-22 / D-14: pre-fill with the deep-link URL when present (prefill only —
              // the import never fires automatically). undefined for a manual open.
              initialUrl={deepLinkUrl ?? undefined}
              isDragging={isDragging}
              onClose={() => {
                setImportOpen(false);
                // Clear the stale deep-link URL so a later manual open is not pre-filled.
                setDeepLinkUrl(null);
              }}
              onImported={(path) => {
                // IN-18 (gap F): promote the imported config to active ONLY when safe (no active
                // config + VPN idle) — never steal a live connection's active pointer. Always
                // reloads the list so the new card (or copy) appears. The backend import already
                // appended the manifest entry (no add_config here — that would double-add).
                promoteImportedConfig(path);
                setImportOpen(false);
                setDeepLinkUrl(null);
              }}
            />
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
            statusPanel={statusPanelFor("settings")}
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
          {statusPanelFor("about")}
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
        // D-01 / 06-UI-SPEC §"Accessibility Contract": the wizard overlay is a
        // labelled modal dialog. aria-labelledby points at the stable hidden title
        // below so the dialog always has a non-empty accessible name regardless of
        // which inner screen the wizard opens on.
        role="dialog"
        aria-modal="true"
        aria-labelledby="wizard-dialog-title"
        // UAT (06-uat fix 9): the SetupWizard stays MOUNTED while wizardActive (so a
        // running install / its deploy-step listener is never torn down), but the fixed
        // overlay is only VISIBLE on the tab that launched it. On any other tab we hide
        // it with `hidden` (display:none) + aria-hidden so it no longer covers that tab's
        // content while the install keeps running in the background.
        className={`fixed top-[32px] bottom-[64px] left-0 right-0 z-[var(--z-modal)] overflow-y-auto flex flex-col${activeTab !== wizardLaunchTab ? " hidden" : ""}`}
        aria-hidden={activeTab !== wizardLaunchTab}
        style={{ background: "var(--color-bg-primary)" }}
      >
        {/* Stable accessible name for the dialog. Visually hidden (sr-only) — the
            inner screens render their own visible heroes; this only feeds the a11y
            tree so the dialog name never goes empty. */}
        <h2 id="wizard-dialog-title" className="sr-only">
          {i18n.t("wizard.dialog_title")}
        </h2>
        {/* The overlay-level close (×) was REMOVED (06-uat, user request): the install
            flow is now self-contained and works correctly, so the × had no real purpose and
            only invited closing mid-install. Exits remain: ServerStep «Назад» and the
            Done/Found buttons close via onClose, and switching bottom tabs hides the overlay
            (it sits BETWEEN the title bar and the tab bar — top-[32px] bottom-[64px] — so the
            tab bar stays clickable). So there is no trap to escape without the ×. */}
        <div className="flex-1 flex flex-col w-full max-w-[600px] mx-auto">
          <SetupWizard
            key={wizardKey}
            // D-01 / Pitfall 3: first-screen "Назад" and Done/Found post-install nav
            // close the overlay (no welcome menu to navigate back to).
            onClose={() => setWizardActive(false)}
            onSetupComplete={(configPath) => {
              // UAT 2026-06-19 (R2/R3) — finishing the wizard used to
              // UNCONDITIONALLY promote the freshly-created config to the active
              // «Подключение» config (overwriting whatever was there, even mid-
              // connection). The product owner reported this as a bug. Promote the
              // new config ONLY when there is no active config AND the VPN is not
              // connected; otherwise leave the existing active config/connection
              // completely untouched (the new <username>.toml is still on disk).
              // A future Connection-tab redesign adds a multi-config switcher (R5).
              const hasActiveConfig = Boolean(config.configPath);
              // Treat any non-idle status as "connected" so we never replace the
              // active config while a session is live or being established (R4).
              const vpnConnected = status !== "disconnected" && status !== "error";
              const activate =
                shouldActivateConfig({ hasActiveConfig, vpnConnected }) &&
                Boolean(configPath);
              if (activate) {
                setConfig((prev) => ({ ...prev, configPath }));
                localStorage.setItem("tt_config_path", configPath);
              }
              // 11-UAT IN-10: register the freshly-installed config in the manifest so it shows
              // as a card in «Подключение». The wizard writes a branded
              // «[<CC>_]TrustTunnel_<login>.toml» on disk but previously only set the legacy
              // tt_config_path marker — never add_config — so the install config was missing from
              // the multi-config list (and startup migrate_configs is idempotent, so it could not
              // pick it up later). add_config dedups by canonical path (safe no-op if already
              // tracked); then refresh the list so the new card appears immediately.
              if (configPath) {
                void invoke("add_config", { path: configPath })
                  .then(() => connectionPanelRef.current?.reload())
                  .catch(() => {});
              }
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
              // UAT 2026-06-19 — after finishing the wizard always open the
              // control panel on «Обзор» (Overview), not the last-active sub-tab.
              // Delete+reinstall happens on «Сервис», so tt_active_tab held
              // "service" and the remounted ServerTabs reopened it. Force overview
              // (in ServerTabs VALID_TAB_IDS) before the remount. Normal sub-tab
              // memory during regular use is unaffected (ServerTabs rewrites the
              // key on each click).
              localStorage.setItem("tt_active_tab", "overview");
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
