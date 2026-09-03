import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { localizeVpnError } from "./vpnEventHelpers";
import { samePath } from "../utils/samePath";
import type { VpnStatus, VpnConfig } from "../types";
import type { ConnectOutcome } from "../ipc/events";
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
  // BUG-B (17-uat) B1: App.tsx's POST-TEARDOWN variant — pushes the notification ping AND seeds the
  // destination's freeze cache from the SAME single probe. Called by the teardown paths
  // (handleReconnect + a real switchTo) at the post-teardown/pre-connect point, where the destination
  // is genuinely INACTIVE so the probe is honest. It replaces the plain pushPendingConnectPing on the
  // teardown paths so the ACTIVE card shows the same honest number the notification shows on every path
  // (previously the switch/save-and-reconnect active card fell to «● —»). Optional (test call sites that
  // don't wire it simply get no push/seed — the pre-fix behaviour).
  pushPendingConnectPingSeeded?: (path: string) => Promise<void>;
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
  pushPendingConnectPingSeeded,
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
      // NIT-1 (Phase 17): vpn_connect resolves a typed ConnectOutcome { spawned, reason }.
      // The direct-connect path intentionally does NOT react to `spawned:false` (unlike
      // switchTo, which must release the switch lock): a supersede here means a genuine
      // disconnect already landed, and the Rust `vpn-status` event is the single status
      // owner (D-01) that drives the UI — reacting here would double-write the status. The
      // typed cast documents the shape so a future consumer reads the same contract.
      (await invoke("vpn_connect", {
        configPath: config.configPath,
        logLevel: config.logLevel,
      })) as ConnectOutcome | null | undefined;
    } catch (e) {
      setError(localizeVpnError(e, i18n));
      setStatus("error");
    }
  }, [config, i18n, setError, setStatus]);

  const handleDisconnect = useCallback(async () => {
    try {
      setStatus("disconnecting");
      await invoke("vpn_disconnect");
    } catch (e) {
      setError(localizeVpnError(e, i18n));
    }
  }, [i18n, setError, setStatus]);

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
    // Item 7 (30.1 review): arm the teardown-settled resolver BEFORE the vpn_disconnect invoke and
    // await it after — the F-8 (Fable-5) shape `switchTo` has used since Phase 14 (see the identical
    // block on its teardown leg: same file, same ref, same 5000 ms safety timer).
    //
    // WHY IT MATTERS HERE. Rust emits the terminal Disconnected from INSIDE the teardown, BEFORE
    // vpn_disconnect's IPC promise resolves. This path used to build the promise AFTER that await,
    // so the real event always arrived with `reconnectResolve.current` still null, nothing was
    // listening for it, and the wait could only ever end via the 5 s backstop — «Сохранить и
    // переподключиться» burned five seconds on the HAPPY path, every single time. F-8 fixed exactly
    // this for the switch leg and was never carried over. The two teardown paths are now one
    // pattern: change one, change the other.
    const teardownSettled = new Promise<void>((resolve) => {
      reconnectResolve.current = resolve;
      // Safety timeout: a teardown that never emits (a wedged sidecar) still releases the wait after
      // 5 s. This is a BACKSTOP, not the normal path — deleting it is NOT the fix for the stall above.
      setTimeout(() => {
        if (reconnectResolve.current === resolve) {
          reconnectResolve.current = null;
          resolve();
        }
      }, 5000);
    });

    try {
      await invoke("vpn_disconnect");
    } catch (e) {
      // WR-02: if the teardown REJECTS (e.g. a "Lock error: …" or a kill_sidecar
      // Err), no "disconnected" vpn-status event will ever fire — so falling through
      // to the wait below would hang on the «Переподключение…» spinner for the full
      // 5s safety timeout and only THEN surface an error (via handleConnect hitting
      // the "VPN is already running" guard on a still-alive sidecar). Abort cleanly
      // instead: show the error now and stop, do NOT proceed to the wait + reconnect.
      // Item 7 / F-8: the resolver armed above is now orphaned — no Disconnected will fire for a
      // rejected teardown. It self-cleans exactly as it does on switchTo's reject path: the 5 s
      // safety timer nulls it (`reconnectResolve.current === resolve`), or the next teardown
      // overwrites it. A stray Disconnected in that window resolves only the abandoned,
      // un-awaited promise — harmless.
      // AUDIT-2026-06-11 #8: the reconnect flow is over — drop the mark so the
      // no-dwell guard stops suppressing future "disconnected" events.
      clearManualReconnectMark();
      // Phase 13 (BL-01): the teardown rejected — no Disconnected will ever fire, so drop the
      // suppression intent now; otherwise a stale true would swallow the next genuine user
      // «Отключено» until the Rust terminal-outcome backstop clears it.
      clearSwitchPending();
      setError(localizeVpnError(e, i18n));
      setStatus("error");
      return;
    }

    // Wait for the actual "disconnected" event (sidecar fully torn down) before we
    // reconnect — the safety timeout armed above resolves after 5s if it never comes.
    await teardownSettled;

    // AUDIT-2026-06-11 #8: teardown is done (the "disconnected" event fired or the
    // 5s wait elapsed) — clear the mark BEFORE reconnecting. From here handleConnect
    // owns the optimistic status, and any later "disconnected" is a real one.
    clearManualReconnectMark();
    // Phase 13 (BL-01): the intermediate teardown Disconnected has passed (and was
    // suppressed) — drop the suppression intent so the re-connect's own outcome plate fires
    // normally and a later genuine user disconnect still shows «Отключено». (The Rust side
    // also clears it on the Connected/Error terminal outcome as a backstop.)
    clearSwitchPending();

    // Fable-A review #3 + BUG-B (17-uat) B1: push the connect-time PING (+ origin=Manual) for the
    // reconnect's terminal «Подключено» plate AND seed the active card's freeze cache from the SAME
    // probe — the SEEDED variant. Timing is deliberate: AFTER the teardown wait above (the endpoint is
    // inactive again, so the fresh probe reads a real DIRECT number — probing while the tunnel was still
    // up reads Unreachable BY DESIGN) and BEFORE handleConnect below (so the Rust Connected edge finds
    // the cell filled instead of None → «—», and the freeze cache is seeded before the connected freeze).
    // The seeded variant seeds UNCONDITIONALLY on an ok reading (the plain pushPendingConnectPing gates
    // the seed on a disconnected/error status, which is FALSE here — the save-and-reconnect keeps the
    // status optimistically on «reconnecting» through the teardown — so the active card fell to «● —»
    // before this fix). AWAITED for the same reason (13-12): the slow-path push must land before the
    // Connected edge peeks. The App-provided callback catches every invoke internally, but BUG-B B1
    // requires the probe to NEVER block/fail the reconnect — so it is also wrapped defensively here: a
    // rejected push/seed is swallowed and the reconnect proceeds regardless (the seed is a UI nicety, not
    // a gate on the connect). Fallback to the plain push when the seeded variant is not wired.
    try {
      if (pushPendingConnectPingSeeded && config.configPath) {
        await pushPendingConnectPingSeeded(config.configPath);
      } else if (pushPendingConnectPing && config.configPath) {
        await pushPendingConnectPing(config.configPath);
      }
    } catch {
      // BUG-B B1: a probe/push/seed failure must not abort the reconnect — proceed to handleConnect.
    }

    // Reconnect immediately — sidecar is already terminated when disconnect event
    // fires. handleConnect moves "reconnecting" → "connecting" → "connected" on
    // success, or → "error" via its own catch on a real failure.
    await handleConnect();
  }, [
    status,
    handleConnect,
    i18n,
    reconnectResolve,
    setStatus,
    setError,
    manualReconnectActiveRef,
    pushPendingConnectPing,
    pushPendingConnectPingSeeded,
    config.configPath,
  ]);

  // Phase 14 (FAB-02): mark a config last-used by PATH (resolves the manifest id from the path).
  // Extracted so BOTH switchTo's accept path (direct callers / revert) AND the App's terminal
  // `connected` edge (the switch's real success — a spawned B may still die never-connected) can
  // stamp it. Best-effort: a missing entry / failed marker never throws (the tunnel is already up
  // — the marker is a UI nicety the list reload reconciles). No config content crosses (D-29).
  const markLastUsed = useCallback(async (path: string): Promise<void> => {
    try {
      const list = await invoke<Array<{ id: string; path: string }>>("list_configs");
      // Raw-path-comparison class (30.1 class sweep — site 1 of 3). The path the connect flow
      // carries and the path the manifest stores are the SAME FILE routinely spelled differently
      // on Windows (`C:\…` vs `C:/…`, `c:` vs `C:`), so a byte `===` found no entry and the
      // last-used marker was silently skipped — and because this step is best-effort by design,
      // nothing ever surfaced. Sites 2 and 3 of the class are `useAutoConnect`'s last-used
      // reconciliation and `useConfigLifecycle`'s external-delete watcher; all three now compare
      // through `samePath`.
      const match = list?.find((c) => samePath(c.path, path));
      if (match) {
        await invoke("set_last_used", { id: match.id });
      }
    } catch {
      // Best-effort: a last-used-marker failure is not worth surfacing.
    }
  }, []);

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
  // Phase 14 (14-04, Open Q1): switchTo now RESOLVES to `{ ok: boolean }` so the App revert
  // orchestration (D-05/D-05-impl) has an explicit, testable signal that B failed to connect —
  // ok:true when the connect succeeds (the path that reaches set_last_used), ok:false on the
  // connect catch that sets status=error (or a teardown reject / missing path). The explicit
  // return is more testable than observing the terminal vpn-status edge from App. EVERYTHING else
  // about switchTo's contract is UNCHANGED (teardown only when connected/connecting, the
  // reconnectResolve + 5s safety + WR-02 reject-abort, set_switch_or_reconnect_pending(true,
  // isSwitch:true) + clears, set_last_used after success). switchTo STILL never rejects — callers
  // that fire-and-forget keep working; callers that await it now get a result to branch on.
  //
  // Phase 14 (FAB-07): `skipTeardown` lets the App REVERT leg reconnect A WITHOUT running a
  // spurious second teardown. When a switch to B fails, the connection is already settled
  // error/disconnected — there is no live tunnel to tear down, so a `vpn_disconnect` there is
  // pure overhead (and if that spurious disconnect REJECTS — e.g. a transient «Lock error» — the
  // old code aborted the revert entirely without ever trying A). The revert passes
  // skipTeardown:true so it goes STRAIGHT to `vpn_connect(A)`. The forward switch keeps its
  // status-gated teardown; skipTeardown does NOT change that path (default false).
  const switchTo = useCallback(
    async (
      path: string,
      opts?: { skipTeardown?: boolean; stampLastUsed?: boolean; seedAfterTeardown?: boolean },
    ): Promise<{ ok: boolean; superseded?: boolean }> => {
      if (!path) {
        setError(i18n.t("messages.config_required"));
        setStatus("error");
        return { ok: false };
      }

      // Tear the existing tunnel down first ONLY if one is up/coming up. From a
      // disconnected (or error/recovering/reconnecting) state we connect directly —
      // there is nothing to wait for. NOTE: unlike handleReconnect (which keeps the
      // status on "reconnecting" to drive its no-dwell guard), a manual switch is a
      // plain disconnect→connect, so we use the honest "disconnecting" status during
      // the teardown — there is no no-dwell requirement for switching this phase.
      // Phase 14 (FAB-07): the revert leg passes skipTeardown — A is being reconnected from an
      // already-settled error/disconnected state, so there is no live tunnel to tear down.
      if (!opts?.skipTeardown && (status === "connected" || status === "connecting")) {
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
        // F-8 (Fable-5): arm the teardown-settled resolver BEFORE the vpn_disconnect invoke. Rust
        // emits the final Disconnected event BEFORE vpn_disconnect's promise resolves; arming the
        // resolver AFTER the await (as before) left a window where the settled edge was processed
        // with reconnectResolve still null → the teardown half of every switch flashed the
        // intermediate «VPN отключён» snackbar before the destination «VPN подключён». Arming first
        // makes the status listener's snackbar-suppression cover the whole teardown regardless of
        // event/continuation ordering: reduceVpnStatus reads this armed `reconnectResolve` as its
        // `reconnectPending` guard (F7 — the restored pre-CA-1 `!reconnectResolve.current` gate) and
        // drops the neutral «VPN отключён» on the connected/disconnecting→disconnected teardown leg.
        // This is the SAME reconnectResolve pattern as handleReconnect, just armed one step earlier.
        const teardownSettled = new Promise<void>((resolve) => {
          reconnectResolve.current = resolve;
          setTimeout(() => {
            if (reconnectResolve.current === resolve) {
              reconnectResolve.current = null;
              resolve();
            }
          }, 5000);
        });
        setStatus("disconnecting");
        try {
          await invoke("vpn_disconnect");
        } catch (e) {
          // WR-02 abort path (same as handleReconnect lines 108-123): a teardown
          // REJECT means no "disconnected" event will ever fire — do NOT fall through
          // to the wait (it would hang on the spinner for the full 5s safety window).
          // Surface the error now and stop; do not proceed to connect.
          // F-8: the resolver armed above (for the teardown-settled wait) is now orphaned — no
          // Disconnected will fire for this rejected teardown. It self-cleans: the 5s safety timer
          // nulls it (`reconnectResolve.current === resolve`), or the next switch overwrites it. A
          // stray Disconnected in that window resolves only the abandoned (un-awaited) promise —
          // harmless. (Left as-is to keep the shared ref immutable per react-hooks/immutability.)
          // Phase 13 (BL-01): drop the suppression intent — no Disconnected will fire, so a
          // stale true must not swallow a later genuine user «Отключено».
          void invoke("set_switch_or_reconnect_pending", { pending: false });
          setError(localizeVpnError(e, i18n));
          setStatus("error");
          // Phase 14 (14-04): the teardown rejected — the switch never reached B, so report
          // failure. The App revert re-points to the previous config A (which is still the
          // connected server here), so the user stays put with a calm info notice.
          return { ok: false };
        }

        // Wait for the real "disconnected" event (sidecar fully torn down) before we connect the new
        // config — the safety timeout (armed above) resolves after 5s if it never comes.
        await teardownSettled;

        // Phase 13 (BL-01): the intermediate teardown Disconnected has passed (suppressed) —
        // drop the intent so the destination connect's own outcome plate fires and a later
        // genuine user disconnect still shows «Отключено». (Rust also clears on Connected/Error.)
        void invoke("set_switch_or_reconnect_pending", { pending: false });

        // BUG-B (17-uat) B1: NOW — the old tunnel is torn down (teardownSettled resolved) and the
        // destination is genuinely INACTIVE — is the ONE honest moment to probe the destination and seed
        // its freeze cache. A manual «Переключиться» used to push the notification ping BEFORE the
        // teardown (in performSwitch), riding tunnel A → through-tunnel garbage, and never seeded the
        // active card → the switched-to card fell to «● —». The SEEDED variant pushes the notification
        // AND seeds lastGoodByPath[dest] from the SAME single probe. `seedAfterTeardown` is passed only by
        // the MANUAL performSwitch path (the auto-switch stamps its own AutoSwitch origin/plate inside
        // this seam and must NOT be re-stamped Manual). It never rejects (every invoke inside is caught),
        // so it cannot abort the switch, and it is AWAITED so the push lands before the Rust Connected
        // edge peeks the cell (13-12) and the seed lands before the connected freeze. Wrapped
        // defensively (BUG-B B1): a probe/push/seed failure must NEVER abort the switch — the connect
        // proceeds regardless (the callback also catches internally, this is belt-and-suspenders).
        if (opts?.seedAfterTeardown && pushPendingConnectPingSeeded) {
          try {
            await pushPendingConnectPingSeeded(path);
          } catch {
            // A probe/push/seed failure must not block the switch — fall through to vpn_connect.
          }
        }
      }

      // Connect the selected config. handleConnect is NOT reused here because it always
      // connects `config.configPath` (the app-level active config); switchTo connects an
      // ARBITRARY path from the list. The connect shape (setStatus + invoke + catch) is
      // identical to handleConnect otherwise.
      try {
        setStatus("connecting");
        // 3.5 F-VERDICT (F11): vpn_connect now returns a ConnectOutcome { spawned, reason }. A
        // NO-SPAWN supersede (a genuine tray/manual disconnect landed during the connect — Rust's
        // FAB-R4 / cancel bails) RESOLVES (not rejects) with spawned:false. That is NEITHER a live
        // session NOR a failure: report it distinctly so performSwitch releases the switch lock
        // immediately (no 15s park on a terminal edge that never comes, no revert re-fighting the
        // user's disconnect, no phantom «остались на A» notice — the stuck-amber + phantom-banner bug).
        const outcome = (await invoke("vpn_connect", {
          configPath: path,
          logLevel: config.logLevel,
        })) as ConnectOutcome | null | undefined;
        if (outcome && outcome.spawned === false) {
          // The Rust bail already wrote Disconnected through the single mutator, so the status is
          // driven by that event — do NOT setStatus here (keep the Rust event as the source of truth).
          return { ok: false, superseded: true };
        }
      } catch (e) {
        setError(localizeVpnError(e, i18n));
        setStatus("error");
        // Phase 14 (14-04): B failed to connect — report failure so the App reverts to the
        // previous config A (D-05). The status is already `error`; the App's revert re-points
        // config.configPath back to A, reconnects A via this SAME vpn_connect path, and shows a
        // calm `ErrorBanner variant="info"` (never red for a switch-failed-reverted).
        return { ok: false };
      }

      // The connect was accepted — mark this config last-used so the lead card sorts to
      // the top and auto-connect-on-launch (useAutoConnect) targets it next boot. Resolve
      // the manifest id from the path; a missing entry / failed marker must NOT undo the
      // successful connect (the tunnel is up — the marker is a best-effort UI nicety), so
      // we swallow any error from this step.
      //
      // Phase 14 (FAB-02): `stampLastUsed` gates this. A vpn_connect ACCEPT only means B's
      // process SPAWNED — B can still die never-connected (broken auth / connect-timeout). If we
      // stamped last-used here, a failed B would become the next-boot auto-connect target even
      // though it never connected. So `performSwitch` passes stampLastUsed:false and stamps only
      // AFTER the terminal `connected` edge (via markLastUsed below). Direct callers and the revert
      // leg keep the default (stamp on accept) — the revert's A is the server we WANT remembered.
      if (opts?.stampLastUsed !== false) {
        await markLastUsed(path);
      }

      // Phase 14 (14-04): the connect was accepted (a last-used-marker hiccup does NOT downgrade
      // this to a failure — the tunnel is up). Report success so the App does NOT trigger a revert.
      return { ok: true };
    },
    [status, config, i18n, setStatus, setError, reconnectResolve, markLastUsed, pushPendingConnectPingSeeded],
  );

  return { handleConnect, handleDisconnect, handleReconnect, switchTo, markLastUsed };
}
