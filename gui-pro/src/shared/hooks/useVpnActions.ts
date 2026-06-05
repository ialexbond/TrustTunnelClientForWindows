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

    // Opt the MANUAL reconnect («Сохранить и переподключить») into the same no-dwell
    // guard the AUTO-reconnect path uses (useVpnEvents.ts: prev === "recovering" ||
    // prev === "reconnecting" && payload === "disconnected" → keep). 02-20: a manual
    // save+reconnect is «Переподключение» (re-establish), NOT «Восстановление» (which is
    // now reserved for a LOCAL-network wait). So we set the status to "reconnecting" UP
    // FRONT — before the teardown begins — so when the intermediate "disconnected"
    // vpn-status event fires, that guard suppresses it and the user keeps seeing a
    // continuous «Переподключение…» label instead of a misleading «Отключено» flash for
    // the whole teardown window (user-reported bug 02-12: "отключение висит, висит,
    // висит, а потом хуякс — подключение").
    setStatus("reconnecting");

    // Tear the tunnel down by invoking vpn_disconnect DIRECTLY rather than calling
    // handleDisconnect(): handleDisconnect sets status to "disconnecting", which
    // would clobber the "reconnecting" status we just set and break the guard above
    // (the guard keys on prev === "recovering" || "reconnecting"; with prev ===
    // "disconnecting" the intermediate "disconnected" event would NOT be suppressed and
    // the «Отключено» flash would return). Keeping the status on "reconnecting" through
    // the teardown is exactly what makes the no-dwell behavior work. The "disconnected"
    // still fires and still resolves the reconnect promise below (that listener keys
    // on reconnectResolve.current, not on the visible status).
    try {
      await invoke("vpn_disconnect");
    } catch (e) {
      // WR-02: if the teardown REJECTS (e.g. a "Lock error: …" or a kill_sidecar
      // Err), no "disconnected" vpn-status event will ever fire — so falling through
      // to the wait below would hang on the «Переподключение…» spinner for the full
      // 5s safety timeout and only THEN surface an error (via handleConnect hitting
      // the "VPN is already running" guard on a still-alive sidecar). Abort cleanly
      // instead: show the error now and stop, do NOT proceed to the wait + reconnect.
      setError(formatError(e));
      setStatus("error");
      return;
    }

    // Wait for the actual "disconnected" event (sidecar fully torn down) before we
    // reconnect — the safety timeout resolves after 5s if the event never comes.
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

    // Reconnect immediately — sidecar is already terminated when disconnect event
    // fires. handleConnect moves "reconnecting" → "connecting" → "connected" on
    // success, or → "error" via its own catch on a real failure.
    await handleConnect();
  }, [status, handleConnect, reconnectResolve, setStatus, setError]);

  return { handleConnect, handleDisconnect, handleReconnect };
}
