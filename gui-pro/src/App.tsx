import { useState, useRef, useMemo, useCallback, useEffect, type CSSProperties } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
import { useAutoSwitch } from "./shared/hooks/useAutoSwitch";
import { useAppSettings } from "./shared/hooks/useAppSettings";
import { useConfigPingSource } from "./shared/hooks/useConfigPingSource";
import { useTabPersistence } from "./shared/hooks/useTabPersistence";
import { useActivityLogStartup } from "./shared/hooks/useActivityLogStartup";
import { useAppShellActions } from "./shared/hooks/useAppShellActions";
import { useTrayNavigate } from "./shared/hooks/useTrayNavigate";
import { useNavigateToTab } from "./shared/hooks/useNavigateToTab";
import { runViewTransition } from "./shared/utils/viewTransition";
import { samePath } from "./shared/utils/samePath";
import { DropOverlay } from "./shared/ui/DropOverlay";
import { ConfirmDialog, ConfirmDialogProvider } from "./shared/ui";
import { ImportModal } from "./components/connection/ImportModal";
import { shouldActivateConfig } from "./components/wizard/shouldActivateConfig";
import { WelcomeTour } from "./components/welcome/WelcomeTour";
import { useWelcomeTour } from "./shared/hooks/useWelcomeTour";
import { Terminal, X } from "lucide-react";
import type { AppTab, VpnStatus, VpnConfig, LogEntry, ReconnectProgress } from "./shared/types";

// Phase 13 (13-12): the Rust `PingResult` discriminated union (serde tag = "status", kebab-case) —
// the SAME shape useAutoConnect / usePerConfigPing consume. Declared locally (a structural subset,
// same pattern as useAutoConnect's own copy) so App.tsx does not grow a cross-hook type import for
// the manual connect-time fresh probe below.
type PingResult =
  | { status: "ok"; ms: number }
  | { status: "unreachable" }
  | { status: "no-data" };

// Phase 13 (13-12): SHORT fresh-probe timeout for the MANUAL connect/switch plate ping — the same
// bound the LAUNCH auto-connect uses (useAutoConnect's LAUNCH_PING_TIMEOUT_MS = 1500). The probe is
// AWAITED before the connect fires (see pushPendingConnectPing), so it must stay tight: on a
// slow/unreachable endpoint the manual connect is delayed by at most this before an honest
// null («—») is pushed. (usePerConfigPing's background sweep uses 3s; this path is
// latency-sensitive, so it mirrors the launch path's tighter bound.)
const MANUAL_PING_TIMEOUT_MS = 1500;

// Phase 14 (FAB-02 / D-14): the SWITCH SETTLE BACKSTOP. After B's process spawns (switchTo resolves
// ok:true) performSwitch waits for the REAL terminal `vpn-status` edge — `connected` (success) or
// `error` (silent revert). But a spawned B can wedge without emitting EITHER (a stuck connect that
// never terminates). This timer bounds each wait tick.
const SWITCH_SETTLE_TIMEOUT_MS = 15_000;
// F-1 (Fable-5 review): with 3.8 delay-green a HEALTHY B on http3 honestly stays «Подключение» for
// ~30-55s (real traffic-readiness — the delayed `connected` edge), far past the old flat 15s. So the
// backstop is now status-AWARE and RE-ARMS: a 15s tick with the Rust status STILL "connecting" means
// B is alive + warming (connected/error both flip the status AND resolve the park), so we keep the
// amber park instead of a phantom revert. This ceiling caps the total re-arms so a truly wedged B
// (no terminal edge ever) still reverts eventually. 5 × 15s = 75s sits ABOVE the 60s connect-timeout
// watchdog, so in practice the watchdog's `error` edge resolves the park first — this is a last
// resort. Before F-1 the flat 15s timed out every slow-warmup switch → phantom revert into an
// R8-active session (red «уже запущено») → green landing on the WRONG active card.
const SWITCH_SETTLE_MAX_TICKS = 5;

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
  // INSTALL-LOCK (16-12): true while the wizard is in a must-not-interrupt step
  // (deploying / uninstalling). Fed by SetupWizard's onBusyChange and OR-ed into
  // the bottom TabNavigation `locked` prop so the user cannot switch tabs and
  // corrupt a running install/reset («установка не завершена»). Reset to false
  // when the wizard leaves those steps or the overlay closes.
  const [wizardBusy, setWizardBusy] = useState(false);

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
    // Deliberate sync setState in an effect: synchronizing shell state with an external
    // deep-link arrival; bounded to one run per distinct URL (consume() clears the source).
    // (The react-hooks/set-state-in-effect disable that used to sit here became UNUSED after
    // Fable-A: the rule's compiler-based analysis no longer reports this effect once the
    // guarded connect handlers below entered the component — eslint then flags the stale
    // directive itself under --max-warnings 0, so it had to go.)
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
  // Fable-A review #1/#2: SYNCHRONOUS in-flight guard over the MANUAL connect initiators
  // (handleConnectActive / handleConnectConfig / handleReconnectGuarded). The 13-12 fix made those
  // paths `await pushPendingConnectPing(...)` BEFORE connecting; on the slow path that await spans a
  // ≤1500ms fresh probe during which NOTHING sets status — the «Подключить» button and the
  // Ctrl-connect shortcut gate (both keyed on status === "disconnected") stay live. A second
  // activation in that window ran a FULL second connect: it either hit the Rust R8 guard («VPN is
  // already running» → FE flipped to "error" over a live tunnel) or, in the tighter race, two
  // vpn_connect calls both passed the guard.is_none() pre-flight window and spawned TWO sidecars
  // (leaking the first killswitch-owning process). A plain ref — NOT React state — because the guard
  // must flip synchronously within the same event-handler tick (state commits a render later, which
  // is exactly the window being closed). Set true before the first await of every manual initiator,
  // released in a `finally` so a failed/rejected connect never wedges the button.
  const connectInFlightRef = useRef(false);
  // Phase 14 (D-07/D-12): FE-only «a seamless A→B switch is in flight» flag. It is REACT STATE
  // (not a ref like connectInFlightRef) precisely because it DRIVES RENDER — it is OR'd into
  // ConfigList's leadIsLive gate so the frosted hero stays mounted + hoisted through the transient
  // `disconnected` the teardown emits (a ref would flip without re-rendering, and the hero would
  // still demote for that frame). Owning it here (not in the Rust VpnStatus enum) keeps the blast
  // radius entirely off the regression-sensitive status surface (D-07): the Rust core, serde
  // round-trip, notify decider, and tray buckets stay UNTOUCHED. Set synchronously in the switch
  // handlers BEFORE runViewTransition (Pitfall 1) and cleared in their `finally`.
  const [isSwitching, setIsSwitching] = useState(false);
  // F28 (14-UAT round 3): the path of the config whose connect was just INITIATED by a click, held only
  // for the window BEFORE the live status becomes `connecting`. On a fresh connect that window is filled
  // by the awaited pre-connect ping probe (up to ~1.5s on a slow/unreachable server), during which the
  // card still showed the idle «Подключить» with nothing locked — the owner felt it as a hang. The target
  // card reads this to show an INSTANT spinner + disabled primary on click, and the whole list locks
  // (ConfigList OR's it into listLocked); it is set synchronously at the connect initiators (BELOW the
  // in-flight guards, ABOVE runViewTransition — Pitfall 1) and cleared in their `finally`, so the spinner
  // can never hang past a settled/failed connect. Does NOT fight the honest-delay-green — it only covers
  // the pre-`connecting` gap; the existing status spinner takes over once `connecting` lands.
  const [pendingConnectPath, setPendingConnectPath] = useState<string | null>(null);
  // Phase 14 (14-04, D-05): the calm NON-ALARMING revert notice shown when a switch to B fails and
  // the app silently returns to the previous server A. It renders as `ErrorBanner variant="info"`
  // (NEVER the red error banner — reverting to a working A is not a failure state), carries only A's
  // DISPLAY NAME (D-29 — never the .toml path/password), and is dismissible + transient (Open Q3 —
  // `switch-failed-reverted` is a transient outcome, not a persistent new state). Cleared on dismiss
  // and whenever a fresh switch/connect starts (so a stale «остались на A» never lingers over a later
  // successful switch).
  const [revertNotice, setRevertNotice] = useState<string | null>(null);
  // F30 (14-UAT round 3): the calm «…восстановлено» revert notice must appear at the MOMENT A is
  // ACTUALLY reconnected («Подключено») — NOT when `switchTo(A)` merely spawns A. `switchTo` resolves on
  // the vpn_connect SPAWN-ACCEPT (FAB-02), while A is still «Подключение», so the old code set the notice
  // during the amber connecting phase → the owner saw «Соединение восстановлено» pop OVER an amber
  // «Подключение» badge, i.e. "restored before it was restored". Fix: `revertToPrevious` STAGES the
  // message in this ref and the effect below commits it only on A's real `connected` edge; an
  // `error`/`disconnected` edge (A also failed, or the user left) DROPS the staged notice so a calm
  // reassurance never shows over a red error. Tightens WR-02 (the notice now tracks the true connected
  // edge, not the spawn-accept). New connect/switch initiators clear the ref so a stale A-notice never
  // lands on a DIFFERENT server's connect.
  const pendingRevertNoticeRef = useRef<string | null>(null);
  useEffect(() => {
    if (status === "connected") {
      // A actually reconnected → commit the staged calm notice (once).
      if (pendingRevertNoticeRef.current) {
        setRevertNotice(pendingRevertNoticeRef.current);
        pendingRevertNoticeRef.current = null;
      }
    } else if (status === "error") {
      // A ALSO failed to reconnect → drop the staged notice so a calm blue reassurance never shows over a
      // red «Ошибка». NOTE: we deliberately do NOT clear on `disconnected` — the switch teardown passes
      // through a (suppressed) `disconnected` BEFORE the revert stages the notice, so clearing there would
      // race the stage away. A genuine user-disconnect between the stage and A's connect leaves the ref
      // set but harmless: it can only commit on a `connected` edge, and every fresh connect/switch
      // initiator (performSwitch / handleConnectActive) clears the ref first, so it never lands on a
      // different server.
      pendingRevertNoticeRef.current = null;
    }
  }, [status]);
  // Phase 14 (WR-03): a LIVE ref mirroring the current active config path, updated EVERY render (the
  // same pattern as useVpnEvents' statusRef). performSwitch reads `previousPath` from THIS ref, not
  // from a memoized closure over config.configPath. A memoized switch handler captures config.configPath
  // at the render it was created; if an auto-switch fires in the very tick a manual promote committed,
  // that closure lags the just-committed active path by one render, so a failed revert could restore a
  // one-step-stale server A. Reading the ref guarantees the revert always targets the truly-current
  // active path regardless of handler staleness. Written unconditionally below on each render.
  const activeConfigPathRef = useRef(config.configPath);
  activeConfigPathRef.current = config.configPath;
  // Phase 14 (FAB-01): a LIVE ref mirroring the current VPN status, updated every render (same
  // pattern as activeConfigPathRef / useVpnEvents' statusRef). performSwitch reads status from THIS
  // ref (not its memoized closure) so it can REFUSE a switch while the backend reconnect supervisor
  // is running (`reconnecting`/`recovering`) — a manual «Переключиться» clicked during a backend
  // auto-reconnect would race the Rust `respawn_sidecar` (worst case: UI says B while traffic still
  // flows through A). The ref guarantees the refusal sees the truly-current status even if the
  // handler's closure lagged a render.
  const statusRef = useRef(status);
  statusRef.current = status;
  // F17 (14-UAT round 2): a LIVE ref mirroring isSwitching (same render-time pattern as statusRef) so
  // the useVpnEvents listener closure can read the whole-switch-window flag SYNCHRONOUSLY, and a Rust
  // mirror so notify::maybe_fire suppresses the phantom «Отключено» plate across the whole
  // switch+revert. During a seamless switch the card holds amber «Переключение» and the only failure
  // signal is the embedded «…восстановлено» info banner — the disconnect snackbar (this ref) and the
  // «Отключено» plate (the Rust flag) must both stay silent for a failed B / the revert-to-A leg.
  // Tracking isSwitching directly (not a manual set in performSwitch) also covers the defensive clear.
  const seamlessSwitchActiveRef = useRef(isSwitching);
  seamlessSwitchActiveRef.current = isSwitching;
  useEffect(() => {
    void invoke("set_seamless_switch_active", { active: isSwitching }).catch(() => {});
  }, [isSwitching]);
  const pushSuccess = useSnackBar();

  // Phase 14 (FAB-02): the switch's TERMINAL-EDGE settle resolver. `switchTo` resolves when B's
  // process SPAWNS (vpn_connect accepted), NOT when B actually reaches `connected` — a spawned B
  // can still die never-connected (broken auth / connect-timeout), the DOMINANT real "B не
  // подключается" case. performSwitch parks on THIS promise after switchTo's spawn-accept and lets
  // the vpn-status listener resolve it on the real terminal edge: `connected` → success,
  // `error` → revert. Held in a ref (not state) so the listener resolves it without a re-render and
  // performSwitch reads the live resolver. Cleared once resolved so a stale settle never fires.
  const switchSettleRef = useRef<((terminalStatus: "connected" | "error" | "external") => void) | null>(null);

  // Phase 14 (F-7, Fable-5): set when a switch is SUPERSEDED by a genuine user disconnect (a tray
  // «Отключить» mid-switch, or vpn_connect bailing spawned:false). Rust then writes a
  // connecting → disconnected edge that useVpnEvents would otherwise map to the RED «Connection
  // failed» snackbar — but this was a user-intended disconnect. The connecting→disconnected snack arm
  // consults + CONSUMES this ref to show the neutral «VPN отключён» instead. Cleared on consume and
  // at the start of every fresh switch (so a stale supersede never mutes a later real failure).
  const switchSupersededRef = useRef(false);

  // Phase 14 (FAB-02/FAB-03): the terminal-edge callback the vpn-status listener fires on
  // `connected`/`error`. Two jobs, in this order:
  //   1. Resolve the switch's settle-promise so performSwitch can act on the REAL terminal edge
  //      (this is what makes the silent revert fire for a POST-SPAWN B failure — FAB-02).
  //   2. FAB-03: the DEFENSIVE isSwitching clear is now GUARDED — it only clears when the switch
  //      guard is NOT held (connectInFlightRef.current === false). While a switch/revert is in
  //      flight, performSwitch OWNS the isSwitching lifecycle (it clears it in its finally after the
  //      whole switch+revert settles). The old unconditional clear here fired on B's error edge
  //      BEFORE the revert leg ran → the frosted hero unmounted (red/gray flash) and the cards
  //      re-enabled as dead buttons mid-revert. Clearing only when the guard is free preserves the
  //      TRUE abandoned-promise case this backstop was built for (a dropped chain that never hit its
  //      finally leaves connectInFlightRef false → this still releases the lock).
  const onSwitchSettle = useCallback((terminalStatus: "connected" | "error") => {
    const resolve = switchSettleRef.current;
    if (resolve) {
      switchSettleRef.current = null;
      resolve(terminalStatus);
    }
    // FAB-03: only the abandoned-promise case (guard already released) clears here.
    if (!connectInFlightRef.current) setIsSwitching(false);
  }, []);

  // 3.6 F-TRAY (F10/F11): a genuine tray «Отключить» that lands DURING a switch must ABORT the FE's
  // settle-park WITHOUT a revert — the user's disconnect intent wins (Rust already honored it and
  // bailed vpn_connect). The vpn-flow listener (below) calls this to resolve the park with "external";
  // performSwitch then releases the lock and does NOT revert (a revert would re-fight the user's
  // disconnect and flash the phantom «остались на A» notice). Also clears any pending revert notice.
  const onExternalDisconnect = useCallback(() => {
    const resolve = switchSettleRef.current;
    // F-7 / R2-3 (Fable-5 re-review): only a switch actually IN FLIGHT (park armed) can be
    // superseded — mark the flag ONLY then. A plain tray disconnect with no park must NOT set it,
    // else the flag leaks and later mutes a genuine NON-switch (hero-button) connect failure's red
    // «Connection failed» snack (there is no consumer on the plain connected→disconnecting→disconnected
    // wire, and the only clear is at performSwitch entry).
    if (resolve) {
      switchSupersededRef.current = true;
      switchSettleRef.current = null;
      resolve("external");
    }
    setRevertNotice(null);
  }, []);

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
    onSettled: onSwitchSettle,
    switchSupersededRef,
    seamlessSwitchActiveRef,
  });

  // ─── App-level config-list + inactive-ping source (Phase 12, 12-07) ───
  // The SINGLE App-level config-list + inactive-ping source (T-12-14: exactly one ping loop). It is
  // passed down to ConnectionPanel as `source` (so the cards reuse it instead of running their own
  // loop) AND it produces the priority-ordered candidate list the auto-switch engine (below)
  // consumes. Declared ABOVE useVpnActions because pushPendingConnectPing (next) reads it and is
  // now ALSO threaded INTO useVpnActions for the save-and-reconnect ping push (Fable-A review #3).
  // F23 (14-UAT round 2): `status` gates the active-config probe exclusion — the selected config is
  // probed directly while DISCONNECTED (so its pre-connect RTT fills the cache + shows on the card),
  // and excluded/substituted only while the tunnel is up.
  const configPingSource = useConfigPingSource(config.configPath, status);
  // F29: pull the STABLE seed callback out as a plain identifier — `useConfigPingSource` returns a fresh
  // object each render, so referencing it as `configPingSource.seedRetainedPing(...)` (a method call) would
  // make exhaustive-deps demand the whole object as a dep (recreating callbacks every render). The
  // function itself is a `useCallback([])`, so this local is stable.
  const seedRetainedPing = configPingSource.seedRetainedPing;

  // Phase 13 (13-08b, reworked 13-12): push the connect-time PING the notification plate shows,
  // RIGHT BEFORE a manual connect/switch. Two-tier source, mirroring the LAUNCH path's fresh probe
  // (useAutoConnect, 13-09 Fix 1):
  //   - FAST PATH: the config's last-known reachability ping from the SINGLE App-level
  //     `usePerConfigPing` map (measured while the config was still INACTIVE — the map never pings
  //     the active one). A numeric `valueMs` (green/yellow/red band) is pushed synchronously.
  //   - SLOW PATH (13-12 owner-UAT fix): a non-numeric band (timeout / no-data / measuring) or a
  //     target ABSENT from the map does NOT mean the endpoint is down — the last 15s background
  //     sweep may have timed out or simply not landed yet. The old code pushed null here, so a
  //     manual connect/switch to a perfectly reachable server rendered «—» while the SAME server
  //     showed a real number on the launch auto-connect (asymmetric ping supply). Now we run the
  //     SAME fresh `ping_config_endpoint` probe the launch path runs — the target is still
  //     DISCONNECTED at this point, so the probe reads a real number — and push ok→ms, else null.
  // The result promise is AWAITED by every caller BEFORE the connect/switch fires: on a DIRECT
  // connect (disconnected state → no teardown) vpn_connect follows almost immediately, so a
  // fire-and-forget probe would land its push AFTER the Rust Connected edge already peeked
  // `pending_connect_ping` (→ still «—»). A bare number|null crosses — no config content /
  // password (D-29). Every invoke is caught, so a non-Tauri / test env never rejects the connect.
  const pushPendingConnectPing = useCallback(
    async (path: string): Promise<void> => {
      // Phase 13 (13-10 / §B): explicitly stamp origin=Manual right before EVERY manual connect/switch,
      // alongside the ping push. FIX for the origin-leak mislabel: `pending_connect_origin` is a single
      // shared AppState cell. A launch AutoConnectLaunch origin whose Connected is observed only via the
      // mount snapshot is never consumed, so it survived into the NEXT connect — and the manual connect
      // path (unlike useAutoSwitch → AutoSwitch and useAutoConnect → AutoConnectLaunch) never set its
      // own origin, so it read the STALE cell and mislabelled itself «Автоподключение при запуске». By
      // asserting Manual here (this callback fires at every manual connect/switch site, right before the
      // connect), a stale origin can never leak into a manual connect: every initiator now sets its own
      // origin (manual→Manual, launch→AutoConnectLaunch, switch→AutoSwitch). This is a FE belt only — the
      // Rust origin CONSUME logic is untouched. A bare enum crosses (no config content / password — D-29).
      // No-op-safe .catch so a non-Tauri / test env (invoke unmocked) never rejects the connect path.
      void invoke("set_pending_connect_origin", { origin: "manual" }).catch(() => {});

      const match = configPingSource.configs.find((c) => samePath(c.path, path));
      const ping = match ? configPingSource.pings[match.id] : undefined;
      // FAST PATH: `valueMs` is set only when the band is a numeric quality (green/yellow/red) —
      // push it fire-and-forget (no probe, no await cost; the shipped 13-08b ordering — push IPC
      // posted before vpn_connect — is proven adequate in the field for this path).
      if (typeof ping?.valueMs === "number") {
        void invoke("set_pending_connect_ping", { ms: ping.valueMs }).catch(() => {});
        return;
      }
      // SLOW PATH: fresh reachability probe of the still-disconnected target, exact same invoke
      // shape + result handling as useAutoConnect's launch probe. On any non-`ok` result — or a
      // throw (older backend / unmocked test invoke) — push null so the plate honestly reads «—»
      // and the connect is never blocked or rejected. (No initializer: both the try and the catch
      // assign, and eslint's no-useless-assignment rejects a dead `= null` up front.)
      let ms: number | null;
      try {
        const result = await invoke<PingResult>("ping_config_endpoint", {
          configPath: path,
          timeoutMs: MANUAL_PING_TIMEOUT_MS,
        });
        ms = result.status === "ok" ? result.ms : null;
      } catch {
        ms = null;
      }
      // Awaited (unlike the fast path): the probe already cost a round-trip, and the callers'
      // await must cover the push itself so the Rust Connected edge cannot outrun it.
      await invoke("set_pending_connect_ping", { ms }).catch(() => {});
      // F29 (fix-all-paths): a MANUAL connect right after launch (before the background probe loop has a
      // warm reading) hits THIS slow path too. Seed the freeze cache with this honest direct measurement
      // so the connected card shows the real ping — same fix as the autostart path (useAutoConnect). The
      // FAST PATH above needs no seed (the value is already in the cache). null → no seed (honest «—»).
      // Fable R (MAJOR): but this callback ALSO runs on a manual «Переключиться» from a LIVE tunnel (A→B),
      // where the tunnel A is still up when the probe runs — so `ping_config_endpoint(B)` rides tunnel A
      // and returns THROUGH-TUNNEL garbage (586/207/2000 ms, the F24 noise). Seeding that would freeze B on
      // a fake number for the whole session — exactly what F26 forbids. So gate the seed on a genuinely
      // pre-connect status (disconnected/error): only then is the probe a real DIRECT measurement. The
      // plate push above is unaffected (it is transient, consumed on one connect edge — 13-12).
      const preConnect = statusRef.current === "disconnected" || statusRef.current === "error";
      if (ms !== null && preConnect) seedRetainedPing(path, ms);
    },
    [configPingSource.configs, configPingSource.pings, seedRetainedPing],
  );

  // ─── VPN Actions ───
  // IN-32: moved ABOVE useConfigLifecycle so the lifecycle hook can receive handleDisconnect —
  // when the ACTIVE config file is deleted externally (file manager) while connected, the tunnel
  // must be torn down. (useVpnActions only depends on state + the refs above, so the move is safe.)
  // Fable-A review #3: pushPendingConnectPing is threaded in so handleReconnect («Сохранить и
  // переподключить») pushes the SAME ping+origin every other connect initiator pushes — it was the
  // only path reaching vpn_connect without it, so its «Подключено» plate deterministically read «—».
  const { handleConnect, handleDisconnect, handleReconnect, switchTo, markLastUsed } = useVpnActions({
    config,
    status,
    setStatus,
    setError,
    i18n,
    reconnectResolve,
    manualReconnectActiveRef,
    pushPendingConnectPing,
  });

  // Phase 14 (CR-02, FAB-05): the SWITCH-GATED disconnect wrapper. A switch (or revert) legitimately
  // passes through `connected`/`connecting` transiently while it tears A down / reconnects A — an
  // unguarded disconnect landing in that window resolves the SHARED reconnectResolve early, so
  // switchTo proceeds to vpn_connect before the sidecar it expected to tear down is actually gone
  // (double spawn / R8 «VPN is already running»). Gating on isSwitching || connectInFlightRef makes
  // the disconnect inert for the whole switch window; it re-enables atomically on settle. A normal
  // disconnect (no switch in flight) passes straight through. DEFINED ABOVE useConfigLifecycle
  // (FAB-05) so the fs-watcher external-delete path receives THIS guarded disconnect, not the raw one
  // (the raw handleDisconnect was the last FE-reachable disconnect entry the CR-02 sweep missed —
  // an external delete of the active config mid-switch fired an ungated teardown that raced the swap).
  const handleDisconnectGuarded = useCallback(async (): Promise<void> => {
    if (isSwitching || connectInFlightRef.current) return;
    await handleDisconnect();
  }, [isSwitching, handleDisconnect]);

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
    // FAB-05: pass the GUARDED disconnect — an external delete of the active config while a switch is
    // in flight must NOT fire an ungated teardown that races the swap (the guard makes it inert).
    onDisconnect: handleDisconnectGuarded,
    // FAB-05: while a switch is in flight, the fs-watcher must NOT wipe config.configPath — the
    // active pointer is mid-transition to B, and blanking it would strand the swap (and unmount the
    // hero). The lifecycle hook skips the wipe (and defers the delete side-effects) while switching.
    isSwitching,
  });
  useAutoConnect({ config, status, setStatus, setError, seedConfigPing: seedRetainedPing });

  // ─── Phase 12 (12-07): smart auto-switch engine ───
  // (The config-list + inactive-ping source it consumes — configPingSource — now lives ABOVE
  // useVpnActions, see Fable-A review #3.)
  // The persisted «Авто-режим» prefs (the SAME store the AutoModeSettings section writes). The
  // master toggle gates the whole engine; threshold/interval/checks tune it.
  const { settings: autoModeSettings } = useAppSettings();
  // useAutoSwitch runs window-independently (the window hides-not-destroys to tray, so the FE hook
  // keeps monitoring while connected). It is INERT unless connected + masterOn (default OFF), so a
  // fresh install never auto-switches. useAutoConnect (above) is UNCHANGED — startup still targets
  // the last-used config (D-01); the engine then keeps monitoring the active config (D-05) and, on a
  // sustained breach, switches to the first healthy candidate via the EXISTING switchTo (D-02/D-04).
  // The auto-switch engine must PROMOTE the chosen config to the app-level active pointer too —
  // otherwise after an auto-switch `config.configPath` still points at the OLD config, so the engine
  // keeps monitoring the wrong (now-inactive) server and the rest of the single-config surface
  // (Routing/Settings/status panel, tt_config_path) goes stale. Mirror handleConnectConfig's promote,
  // but awaitable so the engine arms the cooldown only after the disconnect→connect resolves.

  // Phase 13 (13-08b / 13-12): the ACTIVE-config connect (status-panel «Подключить», keyboard
  // shortcut, About/Connection panels) goes through `handleConnect`, which connects
  // `config.configPath`. Wrap it so it FIRST pushes that config's connect-time ping — AWAITED
  // (13-12): a direct connect has NO teardown window, so vpn_connect fires immediately after; an
  // un-awaited slow-path probe would land its push AFTER the Rust Connected edge already read the
  // cell (→ «—»). pushPendingConnectPing never rejects, so the await cannot break the connect.
  // Fable-A review #1/#2: guarded by connectInFlightRef — a second activation while the probe (or
  // the connect itself) is in flight is a NO-OP instead of a second vpn_connect. The guard flips
  // synchronously BEFORE the first await and is released in `finally`, so a rejected/failed connect
  // can never wedge the button.
  const handleConnectActive = useCallback(async (): Promise<void> => {
    if (connectInFlightRef.current) return;
    connectInFlightRef.current = true;
    // F28: instant click feedback (same as performSwitch) — the status-panel connect / Ctrl-shortcut path
    // also awaits the pre-connect probe before status flips to connecting. Cleared in finally.
    setPendingConnectPath(config.configPath || null);
    // F30: a fresh manual connect is not a revert — drop any staged revert notice.
    pendingRevertNoticeRef.current = null;
    try {
      if (config.configPath) await pushPendingConnectPing(config.configPath);
      await handleConnect();
    } finally {
      connectInFlightRef.current = false;
      setPendingConnectPath(null);
    }
  }, [config.configPath, pushPendingConnectPing, handleConnect]);

  // Fable-A review #1/#2/#3: the guarded save-and-reconnect («Сохранить и переподключить») — the
  // third MANUAL connect initiator under the same connectInFlightRef. handleReconnect now awaits
  // its own pushPendingConnectPing (threaded into useVpnActions) after the teardown, so it too has
  // an in-flight window a second activation must not re-enter. Every consumer (VpnContext /
  // ConnectionPanel / RoutingPanel) gets THIS wrapper, never the raw handleReconnect.
  const handleReconnectGuarded = useCallback(async (): Promise<void> => {
    if (connectInFlightRef.current) return;
    connectInFlightRef.current = true;
    try {
      await handleReconnect();
    } finally {
      connectInFlightRef.current = false;
    }
  }, [handleReconnect]);

  // Phase 14 (14-04, D-05/D-05-impl): the SHARED revert-to-previous — the silent return to the
  // previous server A when a switch to B fails. Both the manual switch (handleConnectConfig) and the
  // auto switch (handleAutoSwitch) call it with the pre-switch `previousPath` they captured BEFORE
  // promoting the active pointer to B (the promote overwrote config.configPath to B, so A had to be
  // captured first). It:
  //   1. re-points config.configPath back to A INSIDE a view transition (the frosted hero glides
  //      back to A instead of snapping) + restores the tt_config_path marker;
  //   2. reconnects A through the EXISTING switchTo/vpn_connect path (NO new Rust command — D-07),
  //      which also re-marks A as last-used on success (Pitfall 6 — so next-boot auto-connect targets
  //      A, not the failed B);
  //   3. shows a calm `ErrorBanner variant="info"` «Не удалось переключиться, остались на «A»» — the
  //      banner interpolates ONLY A's DISPLAY NAME (D-29 — never the .toml path/password).
  // If the A-reconnect ALSO fails, switchTo lands the status honestly on `error` (a red STATUS badge
  // is legitimate — A genuinely can't connect); we do NOT recurse/loop (Pitfall 3), and the info
  // notice still tells the user we tried to return them to A. The revert is naturally bounded by the
  // switchTo result (well under the 60s connect-timeout watchdog — D-14).
  const revertToPrevious = useCallback(
    async (previousPath: string, bStillLive: boolean): Promise<void> => {
      if (!previousPath) return;
      // Resolve A's friendly display name for the notice (D-29 — name only, never the path). Fall
      // back to a generic «предыдущий сервер» if the manifest entry can't be found.
      const prevConfig = configPingSource.configs.find((c) => samePath(c.path, previousPath));
      const prevName = prevConfig?.name || i18n.t("connection.revert.fallback_name");

      // 1. Re-point the active pointer back to A (view-transitioned glide, like the forward promote).
      runViewTransition(() => {
        setConfig((prev) => ({ ...prev, configPath: previousPath }));
      });
      localStorage.setItem("tt_config_path", previousPath);

      // 2. Reconnect A via the existing switchTo/vpn_connect path. If A also fails, switchTo sets
      // status=error itself — we intentionally do NOT revert-again (no loop, Pitfall 3).
      // Phase 14 (FAB-07): pass skipTeardown — the switch to B already settled the connection on
      // error/disconnected, so there is NO live tunnel to tear down. Running switchTo's normal
      // status-gated teardown here would be a spurious second `vpn_disconnect`; worse, if that
      // disconnect REJECTED (transient lock error) the revert would abort without ever reconnecting
      // A. skipTeardown goes straight to vpn_connect(A) — the revert always starts from a settled
      // error/disconnected state, so this is safe.
      // F-1 (Fable-5) — DEFENSIVE: the normal revert entry (an `error` terminal edge) has B already
      // settled, so skipTeardown is right. But the last-resort re-park ceiling can fire while B is
      // STILL «Подключение» (a wedged-but-alive B), and a skipTeardown vpn_connect(A) into that
      // R8-active session returns "VPN is already running" (red flash) instead of reverting. So skip
      // the teardown ONLY when B has genuinely settled; if B is still live, tear it down first.
      // R2-2 (Fable-5 re-review): `bStillLive` is derived by the CALLER from the park OUTCOME — NOT a
      // `statusRef` re-read here. On the common `error` edge this continuation runs as a microtask
      // BEFORE React commits the error render, so a re-read would still see the pre-error "connecting"
      // and force a spurious 5s F-4-silenced teardown on every failed switch. The outcome is
      // authoritative: `error` ⇒ settled ⇒ skipTeardown; only a ceiling `timeout` that saw B still
      // live (read fresh in the tick's own macrotask) tears B down first.
      const revertResult = await switchTo(previousPath, { skipTeardown: !bStillLive });

      // 3. WR-02 + F30: STAGE the calm blue «остались на A» info notice; the status effect commits it
      // only on A's real `connected` edge (never during the amber «Подключение», and never at all if A
      // ALSO fails — the effect drops the staged notice on `error`/`disconnected`, so a calm
      // blue reassurance can never show on top of a red «Ошибка», nor before A is truly back). `ok` here
      // means A's vpn_connect was ACCEPTED (spawn) — necessary but not sufficient; the effect waits for
      // the terminal `connected`. variant=info is NEVER the red banner (D-05); name only (D-29).
      if (revertResult.ok) {
        pendingRevertNoticeRef.current = i18n.t("connection.revert.body", { name: prevName });
      }
    },
    [switchTo, configPingSource.configs, i18n],
  );

  // Phase 14 (CR-01 / IN-03): the SINGLE shared switch-orchestration helper that BOTH the manual
  // switch (handleConnectConfig) and the auto switch (handleAutoSwitch) call, so the in-flight guard
  // and the whole switch lifecycle are identical BY CONSTRUCTION — the two handlers can no longer
  // drift apart (the exact CR-01 divergence: handleAutoSwitch used to set only isSwitching and never
  // raised connectInFlightRef, so a manual card tap / keyboard connect / status-panel button could run
  // a SECOND switchTo concurrently with an in-flight auto-switch — two teardown chains over the single
  // shared reconnectResolve, risking a double sidecar spawn / R8 error).
  //
  // The helper:
  //   (a) raises the SAME synchronous connectInFlightRef guard the manual initiators use — so
  //       auto-switch and every manual initiator are now MUTUALLY EXCLUSIVE (an in-flight auto-switch
  //       blocks a manual connect and vice-versa). The ref MUST flip synchronously (not React state)
  //       so the guard is closed within the same event-handler tick, before the first await.
  //   (b) captures previousPath from the LIVE activeConfigPathRef (WR-03), never a memoized closure —
  //       so a failed revert always restores the truly-current active server A even if this handler's
  //       closure lagged the just-committed active path by one render.
  //   (c) clears any stale revert notice + flips isSwitching TRUE synchronously BEFORE runViewTransition
  //       (Pitfall 1: runViewTransition uses flushSync, so a flag set AFTER it misses the captured
  //       frame and the frosted hero flickers one frame down to a resting row).
  //   (d) promotes the active pointer to B inside a View Transition + writes tt_config_path.
  //   (e) awaits pushPendingConnectPing ONLY for the manual path (pushPing:true) — the connect-time
  //       plate ping; the auto-switch path (pushPing:false) keeps its prior behavior (AutoSwitch origin
  //       is stamped inside switchTo's seam, not here).
  //   (f) FAB-01: REFUSES the switch (early no-op) while status ∈ {reconnecting, recovering} — a
  //       switch there would race the Rust reconnect supervisor's respawn_sidecar (silent
  //       wrong-server / double-spawn). Read from the LIVE statusRef.
  //   (g) FAB-02: awaits switchTo(path) for the SPAWN-ACCEPT, then parks on the REAL terminal
  //       `vpn-status` edge (connected → success + stamp last-used; error/timeout → silent revert).
  //       switchTo resolving ok:true only means B's PROCESS spawned — a spawned B can still die
  //       never-connected, so the revert must fire on the terminal edge, not on switchTo's return.
  //   (h) clears connectInFlightRef + isSwitching in `finally` — atomically AFTER the whole
  //       switch+revert settles, so the amber lock + hero stay held through the entire revert leg
  //       (FAB-03: the onSettled defensive clear no longer releases the lock while the guard is held).
  //   Returns { accepted } so the auto-switch caller can keep its breach counter on a refused/no-op
  //   tick (FAB-06) — a swallowed verdict must not reset the breach + arm the cooldown.
  const performSwitch = useCallback(
    async ({ path, pushPing }: { path: string; pushPing: boolean }): Promise<{ accepted: boolean }> => {
      // (a) the synchronous in-flight guard — a second switch/connect (manual OR auto) while this one
      // is in flight is a NO-OP. Flipped BEFORE the first await; released in `finally`.
      if (connectInFlightRef.current) return { accepted: false };
      // (f) FAB-01: refuse a switch while the backend reconnect supervisor is running. A manual
      // «Переключиться» (or an auto-switch tick) landing during `reconnecting`/`recovering` races the
      // Rust respawn_sidecar — worst case the UI reads B while traffic still flows through A. Read the
      // LIVE status ref so the refusal is never one render stale. The cards are ALSO visibly locked in
      // these states (ConfigList `locked` extended to reconnecting/recovering), so this is the logic
      // half of the FE closure for FAB-01 (the full Rust generation re-check FAB-R1 is BACKLOGGED).
      if (statusRef.current === "reconnecting" || statusRef.current === "recovering") {
        return { accepted: false };
      }
      connectInFlightRef.current = true;
      // F28: INSTANT click feedback. Flag the target card so it shows a spinner + disabled primary and the
      // whole list locks, RIGHT NOW — before the awaited pre-connect ping probe (below) that otherwise
      // leaves the card looking idle for up to ~1.5s. Set below the refusal guards (a refused call must not
      // touch it) and above runViewTransition (Pitfall 1 — a set after flushSync skips a frame). Cleared in
      // `finally` for every exit (success / error / supersede / throw), so the spinner can never hang.
      setPendingConnectPath(path || null);
      // (b) capture A from the LIVE ref, not a memoized closure (WR-03).
      const previousPath = activeConfigPathRef.current;
      // (c) clear any stale revert notice + flip the amber flag synchronously (Pitfall 1).
      setRevertNotice(null);
      // F30: also drop any STAGED (pending) revert notice — a fresh switch/connect abandons a prior
      // revert-to-A, so its «…восстановлено» must never land on THIS (possibly different) server's
      // connected edge.
      pendingRevertNoticeRef.current = null;
      // F-7: a fresh switch starts clean — never carry a stale supersede flag into it (which would
      // wrongly mute a real connect-failure snackbar on THIS switch).
      switchSupersededRef.current = false;
      // 3.7 F-SWITCHDEF (F3): a SWITCH (amber «Переключение» + park-and-revert) requires a LIVE tunnel
      // to switch FROM — a previous active path AND a live/in-flight status. A plain connect from a
      // settled disconnected/error state is NOT a switch: it must read the normal «Подключение»
      // (connecting, driven by status), NEVER the amber face, and it has no revert target. Read the
      // LIVE statusRef (the same predicate switchTo uses to decide whether a teardown leg is needed).
      const isRealSwitch =
        Boolean(previousPath) && (statusRef.current === "connected" || statusRef.current === "connecting");
      if (isRealSwitch) setIsSwitching(true);
      try {
        if (path) {
          // (d) promote the active pointer to B inside a View Transition (glide, not snap). Must stay
          // ABOVE the first await so runViewTransition's flushSync captures the before frame.
          runViewTransition(() => {
            setConfig((prev) => ({ ...prev, configPath: path }));
          });
          localStorage.setItem("tt_config_path", path);
        }
        // (e) manual path only: push the selected config's connect-time ping BEFORE switchTo. AWAITED
        // (13-12) so a slow-path probe's push lands before the Rust Connected edge peeks the cell.
        // pushPendingConnectPing never rejects. The auto path skips it (AutoSwitch stamps its own
        // origin inside switchTo's seam).
        if (pushPing && path) {
          await pushPendingConnectPing(path);
        }
        // (g) FAB-02: run the switch for the SPAWN-ACCEPT. stampLastUsed:false — a vpn_connect accept
        // only means B's PROCESS spawned; we must NOT stamp a not-yet-connected (possibly-failing) B
        // as last-used, or the next-boot auto-connect would target a dead server. We stamp only after
        // the terminal `connected` edge below.
        // A real switch stamps last-used only AFTER the terminal `connected` edge (FAB-02, via the
        // markLastUsed in the park below); a fresh connect stamps on accept like the pre-Phase-14
        // plain connect (it has no terminal-edge park).
        const result = await switchTo(path, { stampLastUsed: !isRealSwitch });
        // F28 (Fable NIT): clear the instant-feedback flag the moment switchTo returns — by now the live
        // status has flipped to `connecting`, so the card's status face (or the amber `switching` face on
        // a real switch) drives it. This stops a FAILED target from spinning `connectPending` through the
        // whole revert/reconnect leg (it becomes a resting card again on revert). The `finally` still
        // clears too (belt — covers a throw before this point).
        setPendingConnectPath(null);
        if (result.superseded) {
          // F-7: a no-spawn supersede (Rust bailed vpn_connect → connecting→disconnected). Mark it
          // so the snack shows the neutral «VPN отключён», not red «Connection failed».
          switchSupersededRef.current = true;
          // 3.5 F-VERDICT (F11): a genuine tray/manual «Отключить» superseded this switch mid-flight —
          // Rust bailed vpn_connect to a clean Disconnected WITHOUT spawning B. Do NOT park on a
          // terminal edge that will never come (the 15s stuck amber «Переключение»), and do NOT revert
          // (reverting would re-fight the user's disconnect and flash a phantom «остались на A» notice
          // on a disconnected app). Just release the lock (finally) and leave the app disconnected.
          return { accepted: true };
        }
        if (!result.ok) {
          // switchTo already failed at spawn-accept (teardown reject / connect throw). A real switch
          // reverts to A; a fresh connect has NO A to revert to — switchTo already set status=error.
          // R2-2: B settled to error at spawn-accept ⇒ skipTeardown (bStillLive=false).
          if (isRealSwitch) await revertToPrevious(previousPath, false);
          return { accepted: true };
        }
        if (!isRealSwitch) {
          // 3.7 F-SWITCHDEF (F3): a fresh connect is NOT a switch — no terminal-edge park, no revert.
          // switchTo already marked last-used on accept; the status is driven by vpn-status events
          // (Подключение → Подключено/Ошибка), exactly like the pre-Phase-14 plain connect.
          return { accepted: true };
        }
        // B's process spawned. Now park on the REAL terminal edge: the vpn-status listener resolves
        // switchSettleRef with `connected` (B is up) or `error` (B died never-connected). A stuck B
        // that emits NEITHER is bounded by the status-aware SWITCH_SETTLE backstop below.
        let settleTimer: ReturnType<typeof setTimeout> | undefined;
        let settleTicks = 0;
        // R2-2: B's liveness at the deciding TIMEOUT tick, captured with a fresh macrotask statusRef
        // read (not a stale microtask read in the settle continuation). Only consulted for a `timeout`.
        let timeoutBStillLive = false;
        const terminal = await new Promise<"connected" | "error" | "timeout" | "external">((resolve) => {
          // Wrap the resolver so the D-14 timer is CLEARED the moment the terminal edge (or the
          // timeout itself) settles — a dangling setTimeout would otherwise fire long after the
          // switch is done (and, under fake timers in tests, pollute a later test's timeline).
          // 3.6 F-TRAY: "external" is resolved by the vpn-flow tray-disconnect listener (not by the
          // vpn-status terminal edge) → abort the switch without a revert.
          const settle = (outcome: "connected" | "error" | "timeout" | "external") => {
            if (settleTimer !== undefined) clearTimeout(settleTimer);
            settleTimer = undefined;
            switchSettleRef.current = null;
            resolve(outcome);
          };
          switchSettleRef.current = settle;
          // F-1: the backstop RE-ARMS while B is still «Подключение» (3.8 delay-green — a healthy
          // http3 B can take ~30-55s to become traffic-ready). Each 15s tick: if the LIVE status is
          // still "connecting", B is alive + warming (a terminal edge would have flipped the status
          // AND resolved this park via the listener), so re-arm — up to SWITCH_SETTLE_MAX_TICKS. Only
          // a tick where the status has LEFT "connecting" (a genuinely wedged B — the watchdog /
          // Terminated will emit `error`), or the ceiling, resolves "timeout" → revert. This never
          // phantom-reverts a warming B onto the wrong card.
          const armTick = () => {
            settleTimer = setTimeout(() => {
              settleTicks += 1;
              if (statusRef.current === "connecting" && settleTicks < SWITCH_SETTLE_MAX_TICKS) {
                armTick();
              } else {
                // R2-2: capture B's liveness HERE (fresh macrotask read) so the revert's skipTeardown
                // is decided by this tick, not a stale statusRef re-read in the settle microtask. A
                // ceiling timeout with B still "connecting" ⇒ B is live ⇒ tear it down first.
                timeoutBStillLive =
                  statusRef.current === "connecting" || statusRef.current === "connected";
                settle("timeout");
              }
            }, SWITCH_SETTLE_TIMEOUT_MS);
          };
          armTick();
        });
        if (terminal === "connected") {
          // B actually connected — NOW stamp it last-used (FAB-02: never on a failed B).
          await markLastUsed(path);
        } else if (terminal === "external") {
          // 3.6 F-TRAY (F10/F11): a genuine tray «Отключить» superseded the switch mid-park — the
          // user's disconnect wins (Rust already bailed vpn_connect + wrote Disconnected). Do NOT
          // revert (reverting would re-fight the disconnect and flash a phantom «остались на A»
          // notice). Just release the lock (finally); the app stays disconnected.
        } else {
          // error OR timeout: B failed to reach connected while the switch guard was held — silently
          // revert to A (D-05). The revert re-points config.configPath back to A and reconnects A.
          // R2-2: `error` ⇒ B already settled ⇒ skipTeardown (instant A-reconnect, no false 5s
          // «Отключение»); only a ceiling `timeout` that saw B still live tears B down first.
          const bStillLive = terminal === "timeout" ? timeoutBStillLive : false;
          await revertToPrevious(previousPath, bStillLive);
        }
        return { accepted: true };
      } finally {
        // (h) release the guard + amber flag atomically when the switch (and any revert) has fully
        // settled — held through the ENTIRE revert leg so the hero stays frosted-amber the whole time.
        switchSettleRef.current = null;
        connectInFlightRef.current = false;
        setIsSwitching(false);
        // F28: clear the instant-feedback flag once the connect/switch (and any revert) has fully settled.
        // By now the live status has taken over (connecting/connected/error), so the card's own status
        // face drives it — the pending flag has done its job of covering the pre-`connecting` gap.
        setPendingConnectPath(null);
      }
    },
    [switchTo, pushPendingConnectPing, revertToPrevious, markLastUsed],
  );

  // Phase 14 (D-10): the AUTO-switch shares the identical seamless amber experience + in-flight guard
  // as the manual switch — it is a thin wrapper over the shared performSwitch (pushPing:false: the
  // AutoSwitch origin is stamped inside switchTo's seam, not the manual pushPendingConnectPing). The
  // engine already gates itself while status≠"connected" + the ~60s cooldown (D-09); performSwitch's
  // connectInFlightRef additionally makes it mutually exclusive with every manual initiator (CR-01).
  // FAB-06: it returns performSwitch's `{ accepted }` so useAutoSwitch only consumes the breach +
  // arms the cooldown when the switch was ACTUALLY accepted (a refused/no-op tick keeps the count).
  const handleAutoSwitch = useCallback(
    (path: string): Promise<{ accepted: boolean }> => performSwitch({ path, pushPing: false }),
    [performSwitch],
  );

  useAutoSwitch({
    masterOn: autoModeSettings.masterOn,
    thresholdMs: autoModeSettings.thresholdMs,
    intervalSec: autoModeSettings.intervalSec,
    checksN: autoModeSettings.checksN,
    status,
    activeConfigPath: config.configPath || undefined,
    candidates: configPingSource.candidates,
    switchTo: handleAutoSwitch,
    // Phase 14 (D-13 / Pitfall 5): belt-and-suspenders — the engine short-circuits before doSwitch
    // while the App-owned switch is in flight, so a second auto-switch cannot race the swap.
    isSwitching,
  });

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

  // Phase 13 (13-09, Fix 2): clicking the connection notification plate's BODY restores the main
  // window (Rust `restore_main_window`) AND steers here via a `navigate-to-tab` event — the plate
  // is a connection notification, so a body-click should open the Connection tab (not whatever tab
  // the user was last on). We switch the active tab to the emitted target. This works whether the
  // window was closed to tray or just on another tab: the Rust side shows+focuses the window first,
  // then emits this. The × close path does NOT emit (it only hides the plate), so a dismiss never
  // navigates. Only the known "connection" id is honoured — anything else is ignored.
  useNavigateToTab(
    useCallback((tab: string) => {
      if (tab === "connection") setActiveTab("connection");
    }, []),
  );

  // 3.6 F-TRAY (F10/F11): the tray executes connect/disconnect in Rust (so it works even if the
  // webview is wedged); the window MIRRORS what the tray did via a `vpn-flow` event emitted at the
  // START of tray_vpn_connect / tray_vpn_disconnect. This closes the tray↔app desync the owner hit:
  //   - disconnect@tray DURING a switch → abort the FE's settle-park WITHOUT a revert (the user's
  //     disconnect wins; onExternalDisconnect resolves the park "external" + clears any notice).
  //   - connect@tray → ADOPT the pointer (setConfig + tt_config_path + refresh the list) so the hero
  //     follows the config the tray actually connected, instead of a stale/reverted FE pointer (the
  //     owner's "tray icon green while the tab shows all «Подключить» / no active card" split).
  useEffect(() => {
    const unlistenPromise = listen<{ action?: string; origin?: string; configPath?: string }>(
      "vpn-flow",
      (event) => {
        const { action, origin, configPath } = event.payload || {};
        if (origin !== "tray") return;
        if (action === "disconnect") {
          onExternalDisconnect();
        } else if (action === "connect" && configPath) {
          setConfig((prev) => ({ ...prev, configPath }));
          localStorage.setItem("tt_config_path", configPath);
          connectionPanelRef.current?.refresh();
        }
      },
    );
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [onExternalDisconnect]);

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
  // Phase 14 (CR-01 / IN-03): the MANUAL switch/connect (a card's «Переключиться» / «Подключить» on
  // the «Подключение» tab) is now a thin wrapper over the shared performSwitch (pushPing:true — the
  // manual path pushes the connect-time plate ping BEFORE the connect). All of the guard + lifecycle
  // (synchronous connectInFlightRef, isSwitching set-before-runViewTransition + finally-clear, the
  // View Transition promote, and the D-05 revert-on-failure) now lives in performSwitch, so the manual
  // and auto paths cannot drift. A manual «Подключить» with no live tunnel also passes here; the amber
  // face only shows on the LIVE lead card, so a cold connect (no prior hero) reads as a normal connect.
  const handleConnectConfig = useCallback(
    (path: string) => performSwitch({ path, pushPing: true }),
    [performSwitch],
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
      // Phase 14 (CR-02): do NOT let a keyboard toggle issue a disconnect (or a connect) while a
      // switch is in flight. During a switch the status legitimately passes through `connected`
      // transiently (A is still up during B's teardown; on a revert A reconnects back to
      // `connected`), so a Ctrl+Shift+C in that window would fire handleDisconnect() mid-switch —
      // the extra `disconnected` event would resolve the SHARED reconnectResolve early, so switchTo
      // proceeds to vpn_connect before the sidecar it expected to tear down is actually gone (double
      // spawn / R8 «VPN is already running»). Gating on isSwitching || connectInFlightRef makes the
      // toggle inert for the whole switch — the lock re-enables atomically when the switch settles.
      // (The StatusPanel/Connection disconnect buttons are already locked via ConfigList's
      // `locked={isSwitching}`; the tray/backend disconnect is Rust-owned and out of FE scope.)
      if (isSwitching || connectInFlightRef.current) return;
      if (status === "connected") handleDisconnect();
      else if (status === "disconnected" && config.configPath) handleConnectActive();
    }, [status, config.configPath, handleConnectActive, handleDisconnect, isSwitching]),
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
      onConnect: handleConnectActive,
      // Phase 14 (CR-02): the switch-gated disconnect so a Routing/Connection-panel disconnect cannot
      // interleave mid-switch and race the shared reconnectResolve teardown.
      onDisconnect: handleDisconnectGuarded,
      onReconnect: handleReconnectGuarded,
    }),
    [status, connectedSince, config.configPath, vpnMode, handleConnectActive, handleDisconnectGuarded, handleReconnectGuarded],
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
      onConnect={handleConnectActive}
      // Phase 14 (CR-02): the StatusPanel «Отключить»/«Отмена» button is live in `connected`/
      // `connecting` — states a switch transiently passes through — so gate its disconnect on the
      // in-flight switch (handleDisconnectGuarded) to keep it from racing the shared teardown.
      onDisconnect={handleDisconnectGuarded}
      reconnectProgress={reconnectProgress}
      // F28 (fix-all-paths): the StatusPanel «Подключить» (Settings/About tabs) also awaits the
      // pre-connect probe via handleConnectActive — show the instant spinner here too.
      connectPending={pendingConnectPath != null}
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

      {/* Phase 14 (F6, 14-UAT): the calm switch-failed-reverted notice USED to render here as a
          floating window-level banner. It now renders EMBEDDED inside the lead ConfigCard (threaded
          `revertNotice` → ConnectionPanel → ConfigList → ConfigCard), matching the Storybook
          «switch-failed-reverted» design. The `revertNotice` state + `setRevertNotice(null)` dismiss
          still live here in App; only the render LOCATION moved into the active card. */}

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
              // Phase 14 (CR-02): switch-gated disconnect (the lead card's «Отключить»). ConfigList
              // already locks the card via `locked={isSwitching}`; this is defense-in-depth so the
              // disconnect action itself is inert mid-switch and cannot race the shared teardown.
              onDisconnect={handleDisconnectGuarded}
              onSwitchTo={handleConnectConfig}
              onReconnect={handleReconnectGuarded}
              // Phase 14 (D-12): thread the FE-only switching flag so ConfigList can OR it into the
              // leadIsLive gate — the frosted hero survives the transient teardown `disconnected`.
              isSwitching={isSwitching}
              // F28: the just-clicked connect target — instant spinner/lock feedback before status lands.
              pendingConnectPath={pendingConnectPath}
              // F6 (14-UAT): the switch-failed-reverted notice renders EMBEDDED inside the lead card
              // (via ConfigList→ConfigCard), not as a floating window-level banner.
              revertNotice={revertNotice}
              onRevertDismiss={() => setRevertNotice(null)}
              // 12-07: reuse the App-level single config-list + ping source (one inactive-ping loop
              // shared with the auto-switch engine — no rival loop, T-12-14).
              source={configPingSource}
              // F20 (14-UAT round 2): thread the reconnect attempt progress so the lead card shows
              // «Переподключение · Попытка N из M» (the backend already emits attempt/max; StatusPanel
              // rendered it but the redesigned Connection tab surface is the ConfigList lead card).
              reconnectProgress={reconnectProgress}
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
              // Phase 14 (D-13): lock the import while a switch is in flight — a mid-switch import
              // could add + auto-promote a competing flow that races the swap.
              isSwitching={isSwitching}
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
              onConnect={handleConnectActive}
              // Phase 14 (CR-02): switch-gated disconnect — the Routing tab's status controls must
              // not issue a disconnect that races the shared teardown mid-switch.
              onDisconnect={handleDisconnectGuarded}
              onReconnect={handleReconnectGuarded}
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
            statusPanel={statusPanelFor("settings")}
            // Phase 14 (D-13): lock «Авто-режим» master toggle + priority reorder while a switch is
            // in flight — a mid-switch master-on / reorder could arm a competing switch (Pitfall 5).
            isSwitching={isSwitching}
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

      {/* Bottom tab navigation — wrapped in same maxWidth as content area so it aligns with the rest of the UI.
          F1 (14-UAT): `view-transition-name: bottom-nav` gives the nav its own snapshot group during a
          config-switch View Transition; index.css forces that group's z-index above the card groups so a
          promoted card gliding up never paints OVER the bottom nav mid-switch.
          F25 (14-UAT round 3, Fable-confirmed): z-index alone was NOT enough — a `view-transition-name`
          element is snapshotted WITHOUT its ancestors' paint, and neither this wrapper nor TabNavigation
          nor its buttons paint an opaque background (the dark bar behind the nav comes from the ROOT div's
          --color-bg-primary, which goes into the ROOT snapshot BELOW the cards). So the `bottom-nav`
          snapshot was TRANSPARENT: cards gliding UNDER it (correct z-order) were visible THROUGH its
          alpha-0 pixels → read as "cards on top of / through the menu, flicker". Fix: paint an opaque
          --color-bg-primary ON this vt-named element (a visual no-op live — the nav already sits on that
          colour — but it makes the snapshot opaque so "on top" actually occludes). Needs BOTH halves:
          the z-index rule (the sticky hero has z-10 → could legally paint above) AND this opaque bg. */}
      <div style={{ maxWidth: 1000, width: "100%", margin: "0 auto", flexShrink: 0, backgroundColor: "var(--color-bg-primary)", viewTransitionName: "bottom-nav" } as CSSProperties}>
        <TabNavigation
          activeTab={activeTab}
          onTabChange={(tab) => setActiveTab(tab)}
          hasAppUpdate={hasAppUpdate}
          hasSidecarUpdate={hasSidecarUpdate}
          // INSTALL-LOCK (16-12): lock tab switching while the wizard is deploying
          // /uninstalling so unrelated nav can't disrupt a running install.
          locked={wizardActive && wizardBusy}
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
            // INSTALL-LOCK (16-12): report the must-not-interrupt steps so App can
            // lock the bottom tab nav while an install/reset runs.
            onBusyChange={setWizardBusy}
            // D-01 / Pitfall 3: first-screen "Назад" and Done/Found post-install nav
            // close the overlay (no welcome menu to navigate back to).
            onClose={() => {
              // Belt-and-braces: closing the overlay always clears the nav lock.
              setWizardBusy(false);
              setWizardActive(false);
            }}
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
