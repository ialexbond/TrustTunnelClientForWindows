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

  useEffect(() => {
    if (autoConnectDone.current) return;
    if (localStorage.getItem("tt_auto_connect") !== "true") return;
    if (!config.configPath) return;
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

      if (cancelled) return;

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
