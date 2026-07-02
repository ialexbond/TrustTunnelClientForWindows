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
  // Fable-A review #3: App.tsx's pushPendingConnectPing (ping + origin=Manual push for the
  // notification plate). handleReconnect was the ONLY initiator reaching vpn_connect without it,
  // so the save-and-reconnect's terminal «Подключено» plate deterministically rendered ping «—»
  // (pending_connect_ping stayed None) and skipped the origin=Manual stamp. It lives in App.tsx
  // (it resolves the config from the App-owned ping source), so it is threaded in here. Optional
  // so call sites / tests that don't wire it keep type-checking (they simply get no push —
  // the plate then honestly shows «—», the pre-fix behaviour).
  pushPendingConnectPing?: (path: string) => Promise<void>;
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
  pushPendingConnectPing,
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

    // Phase 13 (BL-01): raise the Rust-side switch/reconnect-teardown intent BEFORE the
    // teardown-disconnect below. A manual reconnect is disconnect→connect; its teardown leg
    // writes a genuine Connected → Disconnected transition, and without this signal
    // notify::maybe_fire fired a spurious «Отключено» plate before the real «Подключено».
    // The Rust decider reads this signal and SUPPRESSES that intermediate «Отключено».
    // Cleared on EVERY exit (teardown-reject catch, and after the teardown completes just
    // before the re-connect) so it marks only THIS teardown; the Rust side also clears it on
    // the destination terminal outcome as a durable backstop. This is a fire-and-forget bare
    // bool (no config content — D-29) and does NOT change vpn_connect/vpn_disconnect.
    // Fable-A review #6: `isSwitch: false` — this is a SAVE-AND-RECONNECT (same server), so the
    // Rust seam fires the `reconnecting` start plate («Переподключение»), NOT the neutral
    // `switching` one a manual SERVER SWITCH gets. The hint is needed because both flows share
    // origin=Manual, so the origin alone cannot tell them apart (owner-accepted in UAT test 12).
    void invoke("set_switch_or_reconnect_pending", { pending: true, isSwitch: false });
    const clearSwitchPending = () => {
      void invoke("set_switch_or_reconnect_pending", { pending: false });
    };

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
      // Phase 13 (BL-01): the teardown rejected — no Disconnected will ever fire, so drop the
      // suppression intent now; otherwise a stale true would swallow the next genuine user
      // «Отключено» until the Rust terminal-outcome backstop clears it.
      clearSwitchPending();
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
    // Phase 13 (BL-01): the intermediate teardown Disconnected has passed (and was
    // suppressed) — drop the suppression intent so the re-connect's own outcome plate fires
    // normally and a later genuine user disconnect still shows «Отключено». (The Rust side
    // also clears it on the Connected/Error terminal outcome as a backstop.)
    clearSwitchPending();

    // Fable-A review #3: push the connect-time PING (+ the origin=Manual stamp inside the
    // callback) for the reconnect's terminal «Подключено» plate — the same belt every other
    // connect initiator wears. Timing is deliberate: AFTER the teardown wait above (the endpoint
    // is inactive again, so the fresh probe reads a real number — probing while the tunnel was
    // still up reads Unreachable BY DESIGN) and BEFORE handleConnect below (so the Rust Connected
    // edge finds the cell filled instead of None → «—»). AWAITED for the same reason the other
    // initiators await it (13-12): the slow-path push must land before the Connected edge peeks.
    // The callback never rejects (every invoke inside is caught), so this cannot abort the flow.
    if (pushPendingConnectPing && config.configPath) {
      await pushPendingConnectPing(config.configPath);
    }

    // Reconnect immediately — sidecar is already terminated when disconnect event
    // fires. handleConnect moves "reconnecting" → "connecting" → "connected" on
    // success, or → "error" via its own catch on a real failure.
    await handleConnect();
  }, [
    status,
    handleConnect,
    reconnectResolve,
    setStatus,
    setError,
    manualReconnectActiveRef,
    pushPendingConnectPing,
    config.configPath,
  ]);

  // Phase 11 (P11-04 / D-20): MANUAL config switch — «Переключиться» on an inactive
  // ConfigCard. This is intentionally a PLAIN disconnect→connect of the selected
  // config through the EXISTING vpn_disconnect/vpn_connect commands; it touches NO
  // VPN-core / killswitch / routing / reconnect-supervisor code, adds NO new VpnStatus
  // value and NO `switching` wire-state (all deferred to Phase 14). A brief gap with no
  // killswitch during the teardown→connect window is acceptable this phase — it is the
  // SAME exposure as today's reconnect, not a new one (see 11-RESEARCH §Pitfall 4).
  //
  // The teardown-wait is the EXACT machinery handleReconnect uses (reconnectResolve
  // promise + 5s safety timeout + the WR-02 reject-abort), reused verbatim so we do not
  // hand-roll a second sequencer. On a successful connect the manifest last-used marker
  // is moved to the newly-active config via set_last_used (the Wave-1 manifest command).
  // set_last_used takes the manifest ID, not the path, so we resolve the ID from the
  // path via list_configs (the manifest is the source of truth for id↔path).
  const switchTo = useCallback(
    async (path: string) => {
      if (!path) {
        setError(i18n.t("messages.config_required"));
        setStatus("error");
        return;
      }

      // Tear the existing tunnel down first ONLY if one is up/coming up. From a
      // disconnected (or error/recovering/reconnecting) state we connect directly —
      // there is nothing to wait for. NOTE: unlike handleReconnect (which keeps the
      // status on "reconnecting" to drive its no-dwell guard), a manual switch is a
      // plain disconnect→connect, so we use the honest "disconnecting" status during
      // the teardown — there is no no-dwell requirement for switching this phase.
      if (status === "connected" || status === "connecting") {
        // Phase 13 (BL-01): a manual switch's teardown leg writes a genuine
        // Connected → Disconnected transition; raise the Rust-side suppression intent BEFORE
        // vpn_disconnect so notify::maybe_fire does not flash a spurious «Отключено» before
        // the destination «Подключено». Cleared on the reject-abort and after the teardown
        // completes (before the connect); the Rust side also clears it on the terminal
        // outcome. Only raised when there IS a teardown — a direct connect from a
        // disconnected state has no intermediate Disconnected to suppress. Bare bool (D-29).
        // Fable-A review #6: `isSwitch: true` — a MANUAL SERVER SWITCH (and the auto-switch, which
        // also routes through here) fires the NEUTRAL `switching` start plate («Переключаю
        // сервер…»), not `reconnecting`'s «Связь прервалась» — the link did not drop, the user
        // (or the engine) deliberately chose another server. The hint is needed because a manual
        // switch shares origin=Manual with save-and-reconnect, so the Rust seam cannot tell them
        // apart from the origin alone.
        void invoke("set_switch_or_reconnect_pending", { pending: true, isSwitch: true });
        setStatus("disconnecting");
        try {
          await invoke("vpn_disconnect");
        } catch (e) {
          // WR-02 abort path (same as handleReconnect lines 108-123): a teardown
          // REJECT means no "disconnected" event will ever fire — do NOT fall through
          // to the wait (it would hang on the spinner for the full 5s safety window).
          // Surface the error now and stop; do not proceed to connect.
          // Phase 13 (BL-01): drop the suppression intent — no Disconnected will fire, so a
          // stale true must not swallow a later genuine user «Отключено».
          void invoke("set_switch_or_reconnect_pending", { pending: false });
          setError(formatError(e));
          setStatus("error");
          return;
        }

        // Wait for the real "disconnected" event (sidecar fully torn down) before we
        // connect the new config — the safety timeout resolves after 5s if it never
        // comes. This is the EXACT reconnectResolve pattern from handleReconnect.
        await new Promise<void>((resolve) => {
          reconnectResolve.current = resolve;
          setTimeout(() => {
            if (reconnectResolve.current === resolve) {
              reconnectResolve.current = null;
              resolve();
            }
          }, 5000);
        });

        // Phase 13 (BL-01): the intermediate teardown Disconnected has passed (suppressed) —
        // drop the intent so the destination connect's own outcome plate fires and a later
        // genuine user disconnect still shows «Отключено». (Rust also clears on Connected/Error.)
        void invoke("set_switch_or_reconnect_pending", { pending: false });
      }

      // Connect the selected config. handleConnect is NOT reused here because it always
      // connects `config.configPath` (the app-level active config); switchTo connects an
      // ARBITRARY path from the list. The connect shape (setStatus + invoke + catch) is
      // identical to handleConnect otherwise.
      try {
        setStatus("connecting");
        await invoke("vpn_connect", {
          configPath: path,
          logLevel: config.logLevel,
        });
      } catch (e) {
        setError(formatError(e));
        setStatus("error");
        return;
      }

      // The connect was accepted — mark this config last-used so the lead card sorts to
      // the top and auto-connect-on-launch (useAutoConnect) targets it next boot. Resolve
      // the manifest id from the path; a missing entry / failed marker must NOT undo the
      // successful connect (the tunnel is up — the marker is a best-effort UI nicety), so
      // we swallow any error from this step.
      try {
        const list = await invoke<Array<{ id: string; path: string }>>("list_configs");
        const match = list?.find((c) => c.path === path);
        if (match) {
          await invoke("set_last_used", { id: match.id });
        }
      } catch {
        // Best-effort: the connect already succeeded; a last-used-marker failure is not
        // worth flipping the user into an error state. The list reload will reconcile.
      }
    },
    [status, config, i18n, setStatus, setError, reconnectResolve],
  );

  return { handleConnect, handleDisconnect, handleReconnect, switchTo };
}
