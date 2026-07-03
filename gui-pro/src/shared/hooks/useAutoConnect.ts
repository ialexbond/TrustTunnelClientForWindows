import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { formatError } from "../utils/formatError";
import type { VpnConfig, VpnStatus } from "../types";

interface UseAutoConnectParams {
  config: VpnConfig;
  status: VpnStatus;
  setStatus: React.Dispatch<React.SetStateAction<VpnStatus>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  /**
   * F29: deliver the honest launch-time DIRECT ping (measured right before `vpn_connect`) into the card
   * freeze cache so the auto-connected card shows the real ping instead of «—» / a cold-boot 200/500.
   * Optional — standalone tests omit it. Only called with a numeric ms on an `ok` probe (never fabricated).
   */
  seedConfigPing?: (path: string, ms: number) => void;
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

/**
 * Fires a one-shot VPN auto-connect on startup when `tt_auto_connect=true`
 * is set in localStorage. Uses a 1.5s delay so the UI mounts before the connect.
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
}: UseAutoConnectParams) {
  const autoConnectDone = useRef(false);

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
    if (localStorage.getItem("tt_auto_connect") !== "true") return;
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
    // removed. The one-shot latch stays.
    autoConnectDone.current = true;

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
      const probeReady = async (): Promise<boolean> => {
        try {
          return (await invoke<boolean>("network_ready")) !== false;
        } catch {
          // Probe unavailable (e.g. older backend / test mock) → don't block; proceed.
          return true;
        }
      };

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
        setStatus((s) => (s === "connecting" ? "disconnected" : s));
        return;
      }

      // AUDIT-2026-06-11 #15: last-moment live-status re-check. During the bounded
      // network wait the mount snapshot / a live vpn-status event may have surfaced
      // an already-active session (connected / reconnecting / recovering / error).
      // Firing vpn_connect then would bounce off the backend R8 guard into a stuck
      // error. Proceed only from "disconnected" (nothing changed) or "connecting"
      // (our own optimistic mark from the timer below — React may or may not have
      // re-rendered it into the ref yet, both values mean "still our flow").
      const liveStatus = statusRef.current;
      if (liveStatus !== "disconnected" && liveStatus !== "connecting") return;

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
        if (
          activePath &&
          activePath !== lastUsedPath &&
          list?.some((c) => c.path === activePath)
        ) {
          lastUsedPath = activePath;
        }
      } catch {
        // Manifest unreadable → treat as "no target": stand down without an error.
        lastUsedPath = undefined;
      }
      if (cancelled) return;
      if (!lastUsedPath) {
        // No last-used config to connect to. Undo our own optimistic "connecting" mark
        // (functional updater leaves a backend-owned status untouched) and stop.
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
      } catch (e) {
        if (cancelled) return;
        setError(formatError(e));
        setStatus("error");
      }
    };

    const timer = setTimeout(() => {
      // AUDIT-2026-06-11 #15: re-check the LIVE status (not the stale closure) right
      // before the optimistic mark. By now (1.5s after mount) the snapshot has long
      // restored any live tunnel state — if the session is not plainly disconnected,
      // auto-connect must stand down instead of clobbering it.
      if (statusRef.current !== "disconnected") return;
      // Move to "connecting" up-front (unchanged UX), then run the gated connect.
      setStatus("connecting");
      void waitForNetworkThenConnect();
    }, 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  // WR-05: `config.configPath` is now a genuine read inside the effect (the auto-connect
  // target is reconciled against it), so it is a legitimate, non-hidden dependency. The
  // other values read (`config.logLevel`, the setters) are stable for a single one-shot
  // run guarded by `autoConnectDone`; the disable documents that the one-shot semantics
  // are intentional and we do not want the effect to re-fire on logLevel/setter identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.configPath]);
}
