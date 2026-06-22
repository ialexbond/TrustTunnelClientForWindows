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
  // AUDIT-2026-06-11 #8: shared with useVpnEvents (owned by App.tsx). handleReconnect
  // marks it true ONLY for the window where its own optimistic "reconnecting" status
  // hides the teardown's transient "disconnected" (the no-dwell guard). Without the
  // mark, the guard also swallowed a REAL terminal Disconnected emitted by a tray
  // disconnect during a backend auto-reconnect. Optional so call sites / tests that
  // don't wire it keep type-checking (they simply get no suppression).
  manualReconnectActiveRef?: React.MutableRefObject<boolean>;
}

// AUDIT-2026-06-11 #8: upper bound on how long the manual-reconnect mark may stay
// raised if handleReconnect never reaches a clearing point (e.g. vpn_disconnect's
// IPC await hangs). Matches the 5s disconnect-event safety timeout below — past
// that window a "disconnected" is no longer plausibly the teardown's transient one.
const MANUAL_RECONNECT_SAFETY_MS = 5000;

export function useVpnActions({
  config,
  status,
  setStatus,
  setError,
  i18n,
  reconnectResolve,
  manualReconnectActiveRef,
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

    // AUDIT-2026-06-11 #8: raise the shared manual-reconnect mark SYNCHRONOUSLY,
    // before the optimistic setStatus("reconnecting") below, so the no-dwell guard
    // in useVpnEvents only suppresses "disconnected" while THIS flow is actually in
    // flight (a backend auto-reconnect never raises it, so a tray disconnect's real
    // terminal Disconnected now lands). Cleared at every exit: the teardown-failure
    // catch, right before reconnecting (handleConnect owns the status from there),
    // and a safety timeout in case an IPC await never resolves.
    let safetyTimer: ReturnType<typeof setTimeout> | undefined;
    const clearManualReconnectMark = () => {
      if (safetyTimer !== undefined) clearTimeout(safetyTimer);
      safetyTimer = undefined;
      if (manualReconnectActiveRef) manualReconnectActiveRef.current = false;
    };
    if (manualReconnectActiveRef) {
      manualReconnectActiveRef.current = true;
      safetyTimer = setTimeout(clearManualReconnectMark, MANUAL_RECONNECT_SAFETY_MS);
    }

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
      // AUDIT-2026-06-11 #8: the reconnect flow is over — drop the mark so the
      // no-dwell guard stops suppressing future "disconnected" events.
      clearManualReconnectMark();
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

    // AUDIT-2026-06-11 #8: teardown is done (the "disconnected" event fired or the
    // 5s wait elapsed) — clear the mark BEFORE reconnecting. From here handleConnect
    // owns the optimistic status, and any later "disconnected" is a real one.
    clearManualReconnectMark();

    // Reconnect immediately — sidecar is already terminated when disconnect event
    // fires. handleConnect moves "reconnecting" → "connecting" → "connected" on
    // success, or → "error" via its own catch on a real failure.
    await handleConnect();
  }, [status, handleConnect, reconnectResolve, setStatus, setError, manualReconnectActiveRef]);

  return { handleConnect, handleDisconnect, handleReconnect };
}
