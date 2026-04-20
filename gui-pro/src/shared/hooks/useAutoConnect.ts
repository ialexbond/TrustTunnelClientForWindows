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

/**
 * Fires a one-shot VPN auto-connect on startup when `tt_auto_connect=true`
 * is set in localStorage and a config path exists. Uses a 1.5s delay so
 * that the UI mounts before the connect attempt.
 *
 * Extracted from App.tsx verbatim (Phase 12.5, D-03).
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
    const timer = setTimeout(() => {
      invoke("vpn_connect", {
        configPath: config.configPath,
        logLevel: config.logLevel,
      }).catch((e) => {
        setError(formatError(e));
        setStatus("error");
      });
      setStatus("connecting");
    }, 1500);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.configPath]);
}
