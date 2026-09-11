import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { formatError } from "../utils/formatError";
import type { VpnStatus, VpnConfig } from "../types";
import type { i18n as I18nType } from "i18next";

interface UseVpnActionsParams {
  config: VpnConfig;
  status: VpnStatus;
  setStatus: (s: VpnStatus) => void;
  setError: (e: string | null) => void;
  i18n: I18nType;
  reconnectResolve: React.MutableRefObject<(() => void) | null>;
}

export function useVpnActions({
  config,
  status,
  setStatus,
  setError,
  i18n,
  reconnectResolve,
}: UseVpnActionsParams) {
  const handleConnect = useCallback(async () => {
    if (!config.configPath) {
      setError(i18n.t("messages.config_required"));
      setStatus("error");
      return;
    }
    try {
      setError(null);
      setStatus("connecting");
      await invoke("vpn_connect", {
        configPath: config.configPath,
        logLevel: config.logLevel,
      });
    } catch (e) {
      setError(formatError(e));
      setStatus("error");
    }
  }, [config, i18n, setError, setStatus]);

  const handleDisconnect = useCallback(async () => {
    try {
      setStatus("disconnecting");
      await invoke("vpn_disconnect");
    } catch (e) {
      setError(formatError(e));
    }
  }, [setError, setStatus]);

  const handleReconnect = useCallback(async () => {
    if (status !== "connected" && status !== "connecting") return;

    // Plan 02-12 (Light mirror of Pro): opt the MANUAL reconnect into the same
    // recovering guard the AUTO-reconnect path already uses (useVpnEvents.ts:
    // prev === "recovering" && payload === "disconnected" → keep). We set the
    // status to the canonical Plan-02-06/08 "recovering" token UP FRONT so the
    // intermediate teardown "disconnected" event is suppressed and the user keeps
    // seeing a continuous «Переподключение…» label instead of a misleading
    // «Отключено» flash for the whole teardown window (user-reported bug 02-12).
    setStatus("recovering");

    // Tear the tunnel down via a DIRECT vpn_disconnect invoke rather than
    // handleDisconnect(): handleDisconnect sets status to "disconnecting", which
    // would clobber the "recovering" we just set and break the guard above (the
    // guard keys on prev === "recovering"; with prev === "disconnecting" the
    // intermediate "disconnected" event would NOT be suppressed and the «Отключено»
    // flash would return). The "disconnected" event still resolves the reconnect
    // promise below (that listener keys on reconnectResolve.current, not on status).
    try {
      await invoke("vpn_disconnect");
    } catch (e) {
      setError(formatError(e));
    }

    await new Promise<void>((resolve) => {
      reconnectResolve.current = resolve;
      // Safety timeout: if disconnect event never comes, resolve after 5s
      setTimeout(() => {
        if (reconnectResolve.current === resolve) {
          reconnectResolve.current = null;
          resolve();
        }
      }, 5000);
    });

    // Small delay to let the sidecar process fully terminate
    await new Promise((r) => setTimeout(r, 200));

    // Now reconnect — handleConnect moves "recovering" → "connecting" → "connected"
    // on success, or → "error" via its own catch on a real failure.
    await handleConnect();
  }, [status, handleConnect, reconnectResolve, setStatus, setError]);

  return { handleConnect, handleDisconnect, handleReconnect };
}
