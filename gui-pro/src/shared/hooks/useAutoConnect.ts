import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { formatError } from "../utils/formatError";
import type { VpnConfig, VpnStatus } from "../types";

interface UseAutoConnectParams {
  config: VpnConfig;
  status: VpnStatus;
  setStatus: React.Dispatch<React.SetStateAction<VpnStatus>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
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

/**
 * Fires a one-shot VPN auto-connect on startup when `tt_auto_connect=true`
 * is set in localStorage and a config path exists. Uses a 1.5s delay so
 * that the UI mounts before the connect attempt.
 *
 * T-22 B3: before firing, it waits a BOUNDED time for the local network to be
 * ready (so an autostart relaunch at OS boot never engages the killswitch before
 * the network stack is up), then connects regardless if it never comes up. The
 * gate is best-effort — if the `network_ready` probe is unavailable / throws, it
 * proceeds immediately (captive-net-safe, and keeps existing call sites/tests that
 * don't mock the probe working).
 *
 * Extracted from App.tsx verbatim (Phase 12.5, D-03); boot guard added (T-22 B3).
 */
export function useAutoConnect({
  config,
  status,
  setStatus,
  setError,
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
    if (!config.configPath) return;
    // NOTE: stale closure — on the first run this is always "disconnected"
    // (App initializes status before the snapshot lands). Kept as a cheap
    // first-render guard; the LIVE checks are the statusRef re-checks below (#15).
    if (status !== "disconnected") return;
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

      try {
        await invoke("vpn_connect", {
          configPath: config.configPath,
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.configPath]);
}
