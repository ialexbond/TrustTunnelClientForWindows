import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { normalizePath, samePath } from "../utils/samePath";
import { classifyStoredAppSetting, readAppSettingBoolean } from "./useAppSettings";
import { localizeVpnError } from "./vpnEventHelpers";
import type { VpnConfig, VpnStatus } from "../types";
import type { i18n as I18nType } from "i18next";

interface UseAutoConnectParams {
  config: VpnConfig;
  status: VpnStatus;
  setStatus: React.Dispatch<React.SetStateAction<VpnStatus>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  /**
   * 30.1 regression defect 1: auto-connect is a REAL door to the refused connect — on launch it
   * invokes `vpn_connect` with the manifest's last-used path, which is exactly the path a moved
   * data root leaves behind. Its catch used to render `formatError(e)` raw, so the guard's English
   * sentence (and now its ASCII reason code) would reach the banner untranslated. Injected the way
   * `useVpnActions` takes it rather than imported from the singleton, so a test can hand in its own
   * instance and the hook keeps no module-level global.
   */
  i18n: I18nType;
  /**
   * F29: deliver the honest launch-time DIRECT ping (measured right before `vpn_connect`) into the card
   * freeze cache so the auto-connected card shows the real ping instead of «—» / a cold-boot 200/500.
   * Optional — standalone tests omit it. Only called with a numeric ms on an `ok` probe (never fabricated).
   */
  seedConfigPing?: (path: string, ms: number) => void;
  /**
   * G-32-8: in-window announcement channel for the ONE auto-connect outcome the user cannot work
   * out for themselves — auto-connect is on, and the manifest names no server to aim at. App wires
   * it to the existing SnackBar push; no new surface, no new component.
   *
   * Optional, exactly like `seedConfigPing`: Storybook and the standalone tests omit it and the
   * stand-down stays a clean no-op. The hook passes an ALREADY-LOCALIZED string (it holds the i18n
   * instance; the SnackBar takes plain text), so nothing about the channel is language-aware.
   */
  notify?: (message: string) => void;
}

// T-22 B3 (boot guard): how long auto-connect-on-launch will WAIT for the local
// network to become ready before connecting anyway. At OS boot (autostart relaunch)
// the network stack may not be up for a few seconds; connecting against a dead
// early-boot network would engage the sidecar's fail-closed killswitch with no
// working tunnel and could stall boot / freeze Docker's WSL NAT. We poll the
// `network_ready` probe (reuses check_adapter_online) until it reports up OR this
// bounded budget elapses — then connect regardless, mirroring vpn_connect's
// captive-network philosophy (never PERMANENTLY block a connect). MANUAL connects
// are unaffected; only the silent startup auto-connect is gated.
const NETWORK_READY_MAX_WAIT_MS = 30_000;
const NETWORK_READY_POLL_MS = 1_000;

// Phase 11 (P11-03 / D-05): one config entry as `list_configs` returns it. We read
// ONLY id/path/last_used here to resolve the auto-connect target — the rest of the
// ConfigSummary (name/host/user) is irrelevant to launching the tunnel, and the
// password is never part of this shape (D-29). Kept local (a structural subset) so
// this hook does not depend on useConfigList's full type.
interface LastUsedCandidate {
  path: string;
  last_used: boolean;
}

// Phase 13 (13-09, Fix 1): the Rust `PingResult` discriminated union (serde tag = "status",
// kebab-case) — the SAME shape usePerConfigPing consumes. At LAUNCH auto-connect we probe the
// last-used config's endpoint reachability DIRECTLY (the config is still DISCONNECTED at launch,
// so `ping_config_endpoint` measures a real number — unlike pinging an already-active endpoint,
// which reads Unreachable by design). Only an `ok` result carries a number; unreachable/no-data
// push null so the plate honestly renders «—».
type PingResult =
  | { status: "ok"; ms: number }
  | { status: "unreachable" }
  | { status: "no-data" };

// Phase 13 (13-09, Fix 1): SHORT probe timeout for the launch reachability ping. Kept small so a
// slow/unreachable endpoint does not appreciably delay the auto-connect — on a slow/no answer we
// simply push null («—») rather than blocking the connect. (usePerConfigPing uses 3s for the
// background per-config sweep; the launch path is latency-sensitive, so it uses a tighter bound.)
const LAUNCH_PING_TIMEOUT_MS = 1500;

// G-32-8: the launch auto-connect used to write NOTHING — not to activity.log, not to app.log,
// not even to the console. It has five terminal outcomes (toggle off / cancelled / a live status
// already owns the session / no last-used target / connect invoked) and from outside all of them
// look identical: «не подключилось». The first complaint about this feature was undiagnosable for
// exactly that reason, so every outcome now writes ONE line here.
//
// Fire-and-forget through the SAME `write_activity_log` command the rest of the app uses (see
// useActivityLog / MigrationOfferGate) — a logging failure must never affect the connect, and the
// promise is never awaited so the timing of the flow it reports is unchanged.
//
// D-29: only a config PATH is ever written. The manifest entry is a whole record and the app
// stores SSH credentials next to it; `JSON.stringify(entry)` in a log line would ship the user's
// password into a plain-text file the app itself offers to collect and hand over. Callers pass
// pre-formatted `key=value` fragments and nothing else.
const logAutoConnect = (
  message: string,
  tag: "STATE" | "ERROR" = "STATE",
  details?: string,
) => {
  void invoke("write_activity_log", { tag, message, details: details ?? null }).catch(() => {
    // Silent — the activity log is diagnostics, never a precondition for connecting.
  });
};

/**
 * Fires a one-shot VPN auto-connect on startup when the «Автоподключение при запуске» setting is
 * on. Uses a 1.5s delay so the UI mounts before the connect.
 *
 * G-32-9: «on» means what the Settings screen shows, which for an untouched install is the DEFAULT
 * (`APP_SETTINGS_DEFAULTS.autoConnectOnLaunch` = true) — not the literal string "true". Read via
 * `readAppSettingBoolean`, the single reader that owns key and default together.
 *
 * Phase 11 (P11-03 / D-05): the target is the MANIFEST's LAST-USED config (resolved
 * via `list_configs`), NOT the single app-level `config.configPath`. The multi-config
 * manifest is now the source of truth; there is no "favourite"/star concept — the
 * last-used config (the one `switchTo`/connect last marked) is what we reconnect to.
 * If no last-used config exists (empty manifest / none marked) the hook is a clean
 * no-op (it never invokes vpn_connect). `config.logLevel` still supplies the log level.
 *
 * T-22 B3: before firing, it waits a BOUNDED time for the local network to be
 * ready (so an autostart relaunch at OS boot never engages the killswitch before
 * the network stack is up), then connects regardless if it never comes up. The
 * gate is best-effort — if the `network_ready` probe is unavailable / throws, it
 * proceeds immediately (captive-net-safe, and keeps existing call sites/tests that
 * don't mock the probe working).
 *
 * Extracted from App.tsx verbatim (Phase 12.5, D-03); boot guard added (T-22 B3);
 * target switched to the manifest last-used config (Phase 11, P11-03).
 */
export function useAutoConnect({
  config,
  status,
  setStatus,
  setError,
  seedConfigPing,
  notify,
  i18n,
}: UseAutoConnectParams) {
  // G-32-10: the one-shot latch. It is armed at the TOP OF THE TIMER CALLBACK — the moment the
  // work actually begins — and deliberately NOT in the effect body.
  //
  // It used to be armed in the body, synchronously, before the 1.5s timer that does the work was
  // even created, while the cleanup cleared that timer unconditionally. So any re-run of the effect
  // inside the window (`config.configPath` is the dependency, and App legitimately writes it while
  // it loads) ran the cleanup, killed the pending connect, re-entered, and returned on the latch.
  // Nothing rescheduled: auto-connect was dead for the life of the webview. And it died BEFORE the
  // timer callback, which is where every G-32-8 log line lives — so the diagnostics built to remove
  // this exact blind spot could not see it either.
  //
  // Armed where it is now, the latch guards the WORK rather than the INTENT: a re-run before the
  // timer fires simply reschedules (the previous timer is already cleared, so no timers stack), and
  // a re-run at any point after it fires returns as before. The one-shot guarantee is unchanged and
  // in fact stronger, because it is now tied to the only thing that can connect: at most one timer
  // callback ever executes, therefore at most one network wait and at most one `vpn_connect` per
  // webview lifetime.
  const autoConnectDone = useRef(false);

  // G-32-10: how many times the effect has scheduled the pre-wait timer. 1 is the ordinary launch;
  // anything above it means a re-run inside the 1.5s window pushed the connect back, which is the
  // class that used to be fatal and silent. Kept in a ref so the line below can name the attempt.
  const scheduleAttempt = useRef(0);

  // G-32-10: set by the cleanup when it cancels a timer that had NOT yet fired. That is the only
  // state that distinguishes «this run is a reschedule» from «this is the first run», and it is
  // read on the way back in. On unmount the flag is set and simply never read again, which is
  // correct: a torn-down webview has no auto-connect to report on.
  const pendingTimerCancelled = useRef(false);

  // G-32-8: the toggle-off stand-down is written ONCE per mount. The effect's dependency is
  // `config.configPath`, which legitimately changes a couple of times while the app loads its
  // config at startup, so an unlatched line would repeat and bury the entries that matter. The
  // latch is purely about the log — the `return` it guards is untouched.
  const toggleOffLogged = useRef(false);

  // AUDIT-2026-06-11 #15: live status mirror, updated EVERY render. The effect below
  // closes over `status` from its first run only (deps = [config.configPath]), so its
  // `status !== "disconnected"` guard always saw the initial "disconnected" — a dead
  // check. After a webview remount with a live tunnel, the mount snapshot restores
  // "connected" within ~100ms, but the stale guard let auto-connect fire anyway:
  // the optimistic "connecting" clobbered the green status and vpn_connect bounced
  // off the backend's R8 "VPN is already running" guard into a stuck red error
  // (a settled-Connected backend emits no further events to self-heal it). The
  // timer callback and the pre-invoke point re-check THIS ref instead.
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    if (autoConnectDone.current) return;
    // G-32-9: the effective value, read through the SAME key+default pair the Settings screen uses.
    //
    // This line used to be `localStorage.getItem("tt_auto_connect") !== "true"`, and that raw read
    // was a second, private declaration of what an absent key means. It said OFF. The Settings
    // screen said ON, from `APP_SETTINGS_DEFAULTS.autoConnectOnLaunch`, and nothing ever writes
    // that default back to storage — so on an install where nobody had touched the switch, the
    // screen promised auto-connect and this hook returned at its first gate, indefinitely.
    //
    // The screen is the promise, so the behaviour is what moved. Both readers now derive «absent»
    // from one constant, and `appSettingsContract.test.ts` fails if any module reads these keys
    // directly again.
    const storedAutoConnect = classifyStoredAppSetting("autoConnectOnLaunch");
    if (!readAppSettingBoolean("autoConnectOnLaunch")) {
      // G-32-8: the single most likely answer to «autostart ran but nothing connected», and the
      // one the user can fix themselves — once they can see it. Latched (see toggleOffLogged).
      //
      // The detail carries WHICH kind of «off» this was. Before G-32-9 the interesting split was
      // `absent` vs `false` — «the screen and the behaviour disagree» vs «the user turned it off» —
      // and that line is what made the report diagnosable. That split is now impossible to
      // reach: `absent` resolves to the screen's default (ON) and never lands here. What remains is
      // still worth separating, because they are still different bugs: `false` is a deliberate
      // choice, `corrupt` is somebody else's write reading as off. A fixed vocabulary, never the
      // raw stored string (D-29 discipline: log facts, not values).
      if (!toggleOffLogged.current) {
        toggleOffLogged.current = true;
        logAutoConnect(
          "autoconnect.skipped reason=toggle_off",
          "STATE",
          `stored=${storedAutoConnect}`,
        );
      }
      return;
    }
    // Phase 11: the OLD `if (!config.configPath) return` precondition is dropped — the
    // target is now the manifest's last-used config, not the single app-level config
    // path. Whether anything is auto-connected is decided AFTER the network wait, once
    // we resolve the last-used path from list_configs (no last-used → clean no-op).
    // IN-02: the old `if (status !== "disconnected") return` guard here was DEAD — `status`
    // is the FIRST-run closure value (deps = [config.configPath]), which App always
    // initializes to "disconnected" before the mount snapshot lands, so it never fired. The
    // ONLY correct status gate is the LIVE `statusRef.current` re-check just before the
    // optimistic "connecting" mark below (#15) — keeping the dead closure check invited a
    // future edit to trust the stale value and reintroduce the AUDIT #15 bug, so it is
    // removed. The one-shot latch stays — but it is armed inside the timer callback below,
    // not here (G-32-10; see the `autoConnectDone` declaration for why the difference is the
    // whole defect).

    let cancelled = false;

    // T-22 B3: poll `network_ready` until the network is up OR the bounded budget
    // elapses, then connect regardless. An explicit `false` is the ONLY signal that
    // makes us keep waiting; a missing/throwing probe (undefined) proceeds at once so
    // a captive net — or a test that doesn't mock the probe — is never blocked.
    const waitForNetworkThenConnect = async () => {
      const deadline = Date.now() + NETWORK_READY_MAX_WAIT_MS;
      // Probe the network once; only an explicit `false` means "not ready, keep
      // waiting". A missing/throwing probe (undefined) is treated as ready (proceed)
      // so a captive net — or a test that doesn't mock the probe — is never blocked.
      //
      // G-32-8: the probe's LAST verdict is recorded on the way past so the line written after the
      // loop can say WHICH of the two exits happened — the network came up, or the budget ran out
      // and we connected into a network that never reported ready. Those are different stories
      // with the same visible outcome. `unavailable` (a throwing/missing probe) is kept distinct
      // from a genuine `ready` so «we proceeded because we could not ask» never reads as «the
      // network was up». The returned value — and therefore the loop — is unchanged.
      let networkProbe: "ready" | "not_ready" | "unavailable" = "not_ready";
      const probeReady = async (): Promise<boolean> => {
        try {
          const ready = (await invoke<boolean>("network_ready")) !== false;
          networkProbe = ready ? "ready" : "not_ready";
          return ready;
        } catch {
          // Probe unavailable (e.g. older backend / test mock) → don't block; proceed.
          networkProbe = "unavailable";
          return true;
        }
      };

      const waitStartedAt = Date.now();

      // First check is immediate; subsequent checks are spaced by the poll interval.
      // Loop only while the probe explicitly reports the network is NOT ready and the
      // bounded budget has not elapsed.
      while (!cancelled && !(await probeReady()) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, NETWORK_READY_POLL_MS));
      }

      if (cancelled) {
        // AUDIT-2026-06-11 #23: cancelled mid network-wait (config path changed /
        // unmount) — vpn_connect was never invoked, so the backend stays silently
        // Disconnected and no vpn-status event will ever correct the optimistic
        // "connecting" the timer set. Roll back ONLY our own optimistic mark: the
        // functional updater leaves the status untouched if a live vpn-status event
        // already moved it (the backend remains the sole status owner — we never
        // synthesize a status it didn't have).
        logAutoConnect("autoconnect.stood_down reason=cancelled stage=network_wait");
        setStatus((s) => (s === "connecting" ? "disconnected" : s));
        return;
      }

      // G-32-8: which way the bounded wait ended. `network_timeout` means we are about to connect
      // into a network that never reported ready — the captive-net behaviour is deliberate, but it
      // is also the shape of a failed autostart at OS boot, and it must be readable afterwards.
      logAutoConnect(
        networkProbe === "not_ready"
          ? "autoconnect.network_timeout"
          : "autoconnect.network_ready",
        "STATE",
        `probe=${networkProbe} waited_ms=${Date.now() - waitStartedAt}`,
      );

      // AUDIT-2026-06-11 #15: last-moment live-status re-check. During the bounded
      // network wait the mount snapshot / a live vpn-status event may have surfaced
      // an already-active session (connected / reconnecting / recovering / error).
      // Firing vpn_connect then would bounce off the backend R8 guard into a stuck
      // error. Proceed only from "disconnected" (nothing changed) or "connecting"
      // (our own optimistic mark from the timer below — React may or may not have
      // re-rendered it into the ref yet, both values mean "still our flow").
      const liveStatus = statusRef.current;
      if (liveStatus !== "disconnected" && liveStatus !== "connecting") {
        // G-32-8: a CORRECT stand-down that was invisible. Something else already owns the
        // session; the status value is the whole explanation, so it is written down.
        logAutoConnect(
          `autoconnect.stood_down reason=status_not_idle stage=pre_connect status=${liveStatus}`,
        );
        return;
      }

      // Phase 11 (P11-03): resolve the LAST-USED config from the manifest and connect
      // to IT. The manifest is the source of truth; list_configs returns the entries
      // with their last_used flag. A missing/empty manifest, a failed read, or no
      // last-used entry all collapse to a clean no-op — auto-connect simply stands down
      // (we roll our own optimistic "connecting" mark back, exactly like the cancelled
      // path, so the UI does not stick on a spinner with nothing connecting).
      let lastUsedPath: string | undefined;
      try {
        const list = await invoke<LastUsedCandidate[]>("list_configs");
        lastUsedPath = list?.find((c) => c.last_used)?.path;
        // WR-05: reconcile the manifest last-used marker with the app-level active config
        // (`config.configPath`) that the rest of the UI (status panel / Routing tab / the
        // lead card) renders as active. The two are normally kept in sync — App.tsx
        // `handleConnectConfig` promotes the chosen path to `config.configPath` after a
        // switch — but they CAN diverge (the manifest last-used is mutated at runtime via
        // set_last_used/switchTo, while the app-level pointer is its own state). If they
        // disagree, auto-connecting the manifest last-used would silently reconnect a
        // DIFFERENT server than the one shown active. The displayed active config is the
        // user-facing source of truth, so prefer `config.configPath` when it is set and
        // the manifest still lists it — keeping "what auto-connect reconnects to" equal to
        // "what the UI shows active". Fall back to the manifest last-used only when no
        // app-level active path exists (cold start before any in-session switch).
        const activePath = config.configPath;
        // Raw-path-comparison class (30.1 class sweep — site 2 of 3). Two comparisons live here
        // and they deliberately use DIFFERENT helpers:
        //
        //   • the membership test asks «is this the same file?» — `samePath`. With a byte `===`
        //     the app-level active config looked ABSENT from a manifest that merely spelled its
        //     path differently, so this whole preference was skipped and auto-connect launched
        //     the manifest's last-used server instead of the one the UI shows active.
        //   • the inequality asks «are these two paths different?» — and it must NOT be a negated
        //     `samePath`, because `samePath` answers false whenever EITHER side is missing. A
        //     negation would turn «we do not know» into «they differ», which is a different bug in
        //     the same line. Compare the two normalized values instead; `normalizePath` is
        //     exported for exactly this, so both forms derive equality the same way.
        //
        // Sites 1 and 3 of the class: `useVpnActions.markLastUsed`, `useConfigLifecycle`'s
        // external-delete watcher.
        if (
          activePath &&
          normalizePath(activePath) !== normalizePath(lastUsedPath ?? "") &&
          list?.some((c) => samePath(c.path, activePath))
        ) {
          lastUsedPath = activePath;
        }
      } catch {
        // Manifest unreadable → treat as "no target": stand down without an error.
        lastUsedPath = undefined;
      }
      if (cancelled) {
        logAutoConnect("autoconnect.stood_down reason=cancelled stage=resolve_target");
        return;
      }
      if (!lastUsedPath) {
        // No last-used config to connect to. Undo our own optimistic "connecting" mark
        // (functional updater leaves a backend-owned status untouched) and stop.
        //
        // G-32-8: this is the branch a fresh install after a full uninstall necessarily hits — the
        // manifest went with the data folder, so nothing is marked last-used — and it was a
        // completely silent no-op: no log line, no message, an unexplained disconnected screen.
        logAutoConnect("autoconnect.stood_down reason=no_last_used");
        // …and say it out loud, once, on the surface the app already uses for this kind of fact
        // (the SnackBar — the same place «Переключено автоматически» appears). Quiet and factual:
        // auto-connect had nothing to aim at, connect once by hand and it will remember.
        //
        // This is not a first-run nag — and G-32-9 is what makes that a REQUIREMENT rather than a
        // happy accident.
        //
        // It used to be free: absent meant off, so a fresh install stood down at the toggle gate
        // above and never reached this branch. Now absent means ON, and a fresh install after a
        // full uninstall arrives here by the shortest possible route — its manifest went with the
        // data folder, so nothing is marked last-used. Announcing unconditionally would greet a
        // first-time user with a sentence about a feature they have never heard of.
        //
        // So the ANNOUNCEMENT keeps the old precondition explicitly: only when the user has
        // actually written "true" by flipping the switch. The CONNECT above still follows the
        // screen's default — the two are deliberately different thresholds, because acting on a
        // shown-ON promise is what the user expects, while talking to them about it is not.
        if (storedAutoConnect === "true") {
          notify?.(i18n.t("messages.auto_connect_no_target"));
        }
        setStatus((s) => (s === "connecting" ? "disconnected" : s));
        return;
      }

      try {
        // Phase 13 (Pitfall 2): mark the pending connect ORIGIN as AutoConnectLaunch RIGHT BEFORE
        // the launch auto-connect, so the next Rust `Connected` edge emits «Автоподключение при
        // запуске» instead of the generic «Подключено». This sits INSIDE the one-shot guarded block
        // (`autoConnectDone` latch, above) so it marks ONLY the launch connect — the Rust decider
        // consumes + resets the origin on the connected, so any later MANUAL connect reads Manual
        // and shows «Подключено». No secret crosses (a bare enum — D-29).
        await invoke("set_pending_connect_origin", { origin: "autoConnectLaunch" });
        // Phase 13 (13-09, Fix 1): measure the launch connect-time PING the plate shows. Previously
        // (13-08b) this pushed a bare `null` because there is no per-config ping map at launch
        // (usePerConfigPing never pings the ACTIVE config, and at startup nothing is active) — so the
        // plate always rendered «—» for AUTO-CONNECT-ON-LAUNCH. But the last-used config is still
        // DISCONNECTED at this point, so we CAN probe its endpoint reachability directly here: a fresh
        // `ping_config_endpoint` against a not-yet-active endpoint returns a real number (this is the
        // exact case that reads Unreachable ONLY once the endpoint is the live tunnel). We use a SHORT
        // timeout (LAUNCH_PING_TIMEOUT_MS) so a slow/unreachable endpoint does not stall the connect —
        // on any non-`ok` result we push null (honest «—»). Pushed right before vpn_connect so the
        // Rust Connected edge reads it (mirrors the origin push above). A bare number|null crosses —
        // no config content / password (D-29).
        let launchPingMs: number | null = null;
        try {
          const pingResult = await invoke<PingResult>("ping_config_endpoint", {
            configPath: lastUsedPath,
            timeoutMs: LAUNCH_PING_TIMEOUT_MS,
          });
          launchPingMs = pingResult.status === "ok" ? pingResult.ms : null;
        } catch {
          // Probe unavailable (older backend / test mock) or threw → push null («—»), never block.
          launchPingMs = null;
        }
        if (cancelled) return;
        await invoke("set_pending_connect_ping", { ms: launchPingMs });
        // F29: also deliver this honest pre-connect number into the CARD freeze cache (lastGoodByPath),
        // not just the notification plate. On autostart the background probe loop has no warm reading yet,
        // so without this the connected card shows «—» or a cold-boot 200/500 for the whole session;
        // seeding it here (the same number the plate shows, measured after `network_ready`) makes the card
        // show the real ping. null → no seed (honest «—», never a fabricated number).
        if (launchPingMs !== null) seedConfigPing?.(lastUsedPath, launchPingMs);
        await invoke("vpn_connect", {
          configPath: lastUsedPath,
          logLevel: config.logLevel,
        });
        // G-32-8: the success line — WHICH config was chosen (the reconciliation above can pick
        // the app-level active path over the manifest marker, and «it connected to the wrong
        // server» is a real report) and that `vpn_connect` was actually invoked and returned.
        // Only the path: no config content, no credentials (D-29).
        logAutoConnect(`autoconnect.connect_invoked path=${lastUsedPath}`);
      } catch (e) {
        if (cancelled) return;
        // G-32-8: the core refused. The same text already reaches the banner through setError, so
        // writing it down exposes nothing new — but the banner is gone by the time anyone asks.
        logAutoConnect("autoconnect.connect_failed", "ERROR", String(e).slice(0, 200));
        setError(localizeVpnError(e, i18n));
        setStatus("error");
      }
    };

    // G-32-10: the class that used to end auto-connect silently now writes ONE line, through the
    // same fire-and-forget helper every other outcome uses. Written HERE — on the way back in, once
    // we know a cancelled-but-unfired timer is being replaced — rather than from the cleanup, which
    // cannot tell a reschedule from an unmount.
    //
    // D-29: a fixed reason token and a counter. No path, nothing derived from stored values.
    scheduleAttempt.current += 1;
    if (pendingTimerCancelled.current) {
      pendingTimerCancelled.current = false;
      logAutoConnect(
        "autoconnect.rescheduled reason=deps_changed stage=pre_wait",
        "STATE",
        `attempt=${scheduleAttempt.current}`,
      );
    }

    const timer = setTimeout(() => {
      // G-32-10: arm the one-shot latch HERE, synchronously, as the first thing the work does.
      // From this instant every re-run of the effect returns at the top and nothing reschedules,
      // so exactly one timer callback — and therefore exactly one network wait and at most one
      // `vpn_connect` — can ever run for this webview. It is armed before the live-status
      // stand-down below on purpose: that stand-down is a terminal outcome of the launch attempt,
      // and re-arming after it would turn auto-connect into something that retries later.
      autoConnectDone.current = true;
      pendingTimerCancelled.current = false;

      // AUDIT-2026-06-11 #15: re-check the LIVE status (not the stale closure) right
      // before the optimistic mark. By now (1.5s after mount) the snapshot has long
      // restored any live tunnel state — if the session is not plainly disconnected,
      // auto-connect must stand down instead of clobbering it.
      if (statusRef.current !== "disconnected") {
        // G-32-8: the earliest stand-down, and the one that looks most like a broken autostart —
        // the app launched, the toggle is on, and nothing happened. It is correct (a live session
        // already exists) but nothing said so.
        logAutoConnect(
          `autoconnect.stood_down reason=status_not_idle stage=pre_wait status=${statusRef.current}`,
        );
        return;
      }
      // Move to "connecting" up-front (unchanged UX), then run the gated connect.
      setStatus("connecting");
      void waitForNetworkThenConnect();
    }, 1500);
    return () => {
      cancelled = true;
      // G-32-10: remember whether the timer we are about to clear had already fired. If it had
      // not, the pending auto-connect is being dropped and the next run of the effect owes the
      // user a reschedule and a log line. `autoConnectDone` is the exact witness: the callback
      // arms it as its first statement, so «still false» means «never ran».
      if (!autoConnectDone.current) pendingTimerCancelled.current = true;
      clearTimeout(timer);
    };
  // WR-05: `config.configPath` is now a genuine read inside the effect (the auto-connect
  // target is reconciled against it), so it is a legitimate, non-hidden dependency. The
  // other values read (`config.logLevel`, the setters, and the injected `i18n` instance —
  // a process-wide singleton whose identity does not change on a language switch) are stable
  // for a single one-shot run guarded by `autoConnectDone`; the disable documents that the
  // one-shot semantics are intentional and we do not want the effect to re-fire on
  // logLevel/setter/i18n identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.configPath]);
}
