import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PING_TIMEOUT_MS } from "./usePerConfigPing";
import {
  decideAutoSwitch,
  type Candidate,
  type EngineState,
  type Reading,
} from "../lib/decideAutoSwitch";
import type { VpnStatus } from "../types";

/**
 * `useAutoSwitch` — the LIVE engine loop of the smart auto-switch feature (Phase 12 / 12-05).
 *
 * It wires the PURE `decideAutoSwitch` (12-04) to real, status-gated ping monitoring of the
 * CURRENTLY-ACTIVE config and, on a switch verdict, fires the EXISTING `switchTo(path)` then
 * arms the hidden post-switch cooldown. It is the FE-hook home chosen in RESEARCH: the window
 * hides-not-destroys on close, so this hook keeps running in the tray while connected.
 *
 * Design (mirrors the proven idioms in the repo, no VPN-core change):
 *   - Pattern 1 / Pitfall 6 — the loop runs ONLY while `status === "connected" && masterOn`.
 *     It is gated on a LIVE `statusRef`/`masterOnRef` (NOT a stale closure — the AUDIT #15
 *     bug `useAutoConnect` was fixed for); it cancels cleanly on unmount, on status leaving
 *     "connected", and on master toggling off (the `cancelled` flag + `clearTimeout` cleanup,
 *     StrictMode-correct WITHOUT a separate once-guard — WR-06, same as `usePerConfigPing`).
 *   - Each tick pings the ACTIVE config via `ping_config_endpoint` (the SAME command the cards
 *     use), maps the result to a decision `Reading`, reads the latest prefs + priority-ordered
 *     candidates from refs, runs `decideAutoSwitch`, writes back the next `EngineState`, and on
 *     `action.kind === "switch"` awaits `switchTo(targetPath)` then re-arms the cooldown.
 *   - It does NOT start a second inactive-ping loop: the caller (App wiring, 12-07) builds the
 *     `candidates` prop from the EXISTING `usePerConfigPing` map joined with manifest order; the
 *     hook only pings the single active config.
 *   - After ANY switch (auto OR a manual pick that changed `activeConfigPath`) the engine keeps
 *     monitoring the now-active config — no manual-mode freeze (D-05).
 *
 * D-29: the hook has NO log sink — it adds no console/emit line interpolating config content,
 * and never reads `endpoint.password` (it only sees readings + non-secret numeric prefs).
 *
 * It deliberately adds NO new `VpnStatus` value and NO `switching` wire-state — the user sees the
 * normal disconnecting→connecting→connected of `switchTo`; seamless wire-states are Phase 14.
 */

/**
 * Hidden post-switch settle window (D-04). NOT user-configurable: after a switch the engine waits
 * this long before another auto-switch may fire, so a flapping network cannot ping-pong the tunnel
 * (T-12-09). Per the recorded decision D-12-04-cooldown-param this exact value is passed straight
 * to `decideAutoSwitch` (which stamps `cooldownUntil = now + COOLDOWN_MS` on a switch) so the engine
 * and the pure fn share ONE arming rule.
 */
export const COOLDOWN_MS = 60_000;

/**
 * F24 / Fable R4 (MAJOR-1) loop-break window. After a switch fires, the target is excluded from the
 * candidate list for this long. A switch that FAILED and silently reverted leaves the target frozen at
 * its stale-good pre-connect band (F24 freezes inactive cards while connected + the retained cache only
 * stores GOOD bands), so it looks perpetually healthy — without the exclusion the engine would re-pick
 * the same DEAD target every ~60–90 s forever (switch→fail→revert→switch), churning the tunnel. Set WELL
 * above COOLDOWN_MS so a failed target is not retried the instant the settle window lapses; after this
 * window it may be re-tried once (it might have recovered), so at worst one failed attempt per window —
 * never a tight loop. Harmless on a SUCCESSFUL switch: the target is then the active config, already
 * absent from the candidate list.
 */
export const SKIP_WINDOW_MS = 300_000;

/**
 * Defense-in-depth floor for the schedule interval (seconds). `useAppSettings` already clamps the
 * stored value to >= 5 s (AUTO_SWITCH_BOUNDS.intervalSec.min), so this is a second guard against a
 * 0/NaN interval ever reaching `setTimeout` and causing a tight ping-storm.
 */
const MIN_INTERVAL_SEC = 5;

export interface UseAutoSwitchParams {
  /** Master toggle from `useAppSettings` — the whole engine is inert while false. */
  masterOn: boolean;
  /** A reading at/below this (ms) is "good"; above it (or unreachable/no-data) is a breach. */
  thresholdMs: number;
  /** Active-config re-check cadence (seconds). Clamped upstream; floored here too. */
  intervalSec: number;
  /** Consecutive breaching checks before a switch fires (D-04). */
  checksN: number;
  /** Live VPN status — the loop runs ONLY while this is "connected". */
  status: VpnStatus;
  /** The .toml path of the currently-active config (the one we ping). */
  activeConfigPath: string | undefined;
  /**
   * Priority-ordered (manifest order) inactive configs WITH their latest reading — built by the
   * caller from the existing `usePerConfigPing` map. The hook does NOT ping these itself.
   */
  candidates: Candidate[];
  /**
   * The EXISTING switch mechanism (App's `handleAutoSwitch` → `performSwitch`). FAB-06: it now
   * resolves `{ accepted }` — `accepted:false` when the App REFUSED the switch (a switch already in
   * flight, or status `reconnecting`/`recovering`), `accepted:true` when it ran. The engine consumes
   * the breach (reset counter + arm the ~60 s cooldown) ONLY when the switch was accepted, so a
   * swallowed verdict keeps the breach count and re-fires on a later tick (matching the existing
   * comment). A plain `Promise<void>` is still accepted (treated as accepted) for standalone tests.
   */
  switchTo: (path: string) => Promise<void> | Promise<{ accepted: boolean }>;
  /**
   * Phase 14 (D-13 / Pitfall 5): the App-owned `isSwitching` flag — true while a seamless A→B swap is
   * in flight. A belt-and-suspenders guard: when true the tick short-circuits BEFORE doSwitch, so a
   * second auto-switch cannot fire mid-swap. This is DEFENSE-IN-DEPTH only — the engine is already
   * inert while `status !== "connected"` (a switch's teardown leaves connected) and the ~60s cooldown
   * covers the just-switched window (D-09). It does NOT replace those guards or change COOLDOWN_MS /
   * the consecutive-checks gate / the no-auto-return logic. Optional so standalone tests can omit it.
   */
  isSwitching?: boolean;
}

export function useAutoSwitch({
  masterOn,
  thresholdMs,
  intervalSec,
  checksN,
  status,
  activeConfigPath,
  candidates,
  switchTo,
  isSwitching = false,
}: UseAutoSwitchParams): void {
  // Mutable engine state held BETWEEN ticks (not React state — it must not trigger re-renders, and
  // the loop reads/writes it synchronously). The pure fn owns the transition rules; we just persist.
  const engineStateRef = useRef<EngineState>({ consecutiveBad: 0, cooldownUntil: 0 });

  // LIVE mirrors of the gate inputs, updated every render — read inside the tick so the loop never
  // trusts a stale first-run closure (the AUDIT #15 stale-status bug fixed in useAutoConnect).
  const statusRef = useRef(status);
  statusRef.current = status;
  const masterOnRef = useRef(masterOn);
  masterOnRef.current = masterOn;
  // Phase 14 (D-13): LIVE mirror of the App-owned isSwitching flag, read inside the tick so the
  // belt-and-suspenders guard never trusts a stale closure (same discipline as statusRef).
  const isSwitchingRef = useRef(isSwitching);
  isSwitchingRef.current = isSwitching;

  // Latest tunable inputs, read inside the loop WITHOUT restarting the interval on every render —
  // changing threshold/interval/checks/candidates just takes effect on the next tick (the same
  // targetsRef trick as usePerConfigPing). Written in an effect so the refs stay lint-clean.
  const inputsRef = useRef({ thresholdMs, intervalSec, checksN, candidates, switchTo });
  useEffect(() => {
    inputsRef.current = { thresholdMs, intervalSec, checksN, candidates, switchTo };
  });

  // The effect keys on `[masterOn, status, activeConfigPath]` so a genuine connect/disconnect,
  // master toggle, or active-config change re-seeds exactly ONE fresh loop — mirroring
  // usePerConfigPing's targetsKey discipline. Tunable changes (threshold/interval/candidates) are
  // read via inputsRef and do NOT re-seed mid-loop.
  useEffect(() => {
    // Inert unless connected + master ON. (The cleanup of the prior run already cancelled it.)
    if (status !== "connected" || !masterOn || !activeConfigPath) return;

    // Fable R3 (MINOR): each (re)entry into a CONNECTED+masterOn span is a FRESH health epoch. Reset the
    // consecutive-breach counter so breaches counted just before a drop (this effect re-seeds on
    // connected→reconnecting→connected, and on a switch's activeConfigPath change) do NOT glue onto
    // post-recovery breaches as "consecutive" — with the live tunnel probe they would otherwise survive
    // the drop, and 1–2 bad ticks would fire a switch instead of the full checksN. PRESERVE cooldownUntil
    // so a just-fired switch's ~60s settle window still holds across the reconnect.
    engineStateRef.current = { ...engineStateRef.current, consecutiveBad: 0 };

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      // Re-check the LIVE gate every tick: status may have left "connected" or master toggled off
      // between the schedule and now. (The effect cleanup also cancels, but this is the cheap path.)
      if (cancelled) return;
      if (statusRef.current !== "connected" || !masterOnRef.current) return;

      const { thresholdMs: thr, checksN: n, candidates: cands, switchTo: doSwitch } =
        inputsRef.current;

      // (b) F23 (14-UAT round 2, owner-chosen design): measure the ACTIVE TUNNEL's REAL current
      // latency by probing neutral reference hosts THROUGH the tunnel (client → VPN server →
      // reference). The endpoint itself can't be honestly probed while connected — a direct connect to
      // it (it IS the VPN server) rides the tunnel to the-server-and-back = the ~2× / «Недоступен»
      // noise that caused the false switches. The reference probe reflects the honest in-session
      // tunnel health: a slow tunnel → high ms (breach), a dead tunnel → Unreachable (breach), a
      // healthy one → normal ms (no switch off a good server). A failed invoke reads no-data (neutral,
      // handled below), never thrown.
      const reading = await invoke<Reading>("probe_tunnel_latency", {
        timeoutMs: PING_TIMEOUT_MS,
      }).catch((): Reading => ({ status: "no-data" }));

      if (cancelled) return;

      // (c) A `no-data` reading here means the IPC invoke itself failed (a transient error), NOT that
      // the tunnel is failing (a dead tunnel reads `Unreachable`, which IS a breach). Treat the
      // transient failure as neutral — reset the breach counter and wait for the next tick — so an IPC
      // hiccup never accumulates toward a false switch off a healthy, user-chosen server.
      if (reading.status === "no-data") {
        engineStateRef.current = { ...engineStateRef.current, consecutiveBad: 0 };
        const intervalMs = Math.max(inputsRef.current.intervalSec, MIN_INTERVAL_SEC) * 1000;
        timer = setTimeout(() => void tick(), intervalMs);
        return;
      }

      // (d0) F24 / Fable R4 (MAJOR-1) loop-break: exclude the MOST RECENT switch target from the
      // candidate list for SKIP_WINDOW_MS. A switch that FAILED and reverted leaves that target frozen at
      // its stale-good pre-connect band (F24 freezes inactive cards while connected + the cache only
      // stores GOOD bands), so it looks perpetually healthy — without this the engine would re-pick the
      // same DEAD target every cooldown forever (switch→fail→revert→switch). Excluding it briefly lets the
      // engine fall through to the next healthy candidate (or silently stay put — D-03) instead of
      // looping. Harmless when the switch SUCCEEDED: the target is then the ACTIVE config, already absent
      // from the candidate list. Consistent with D-05 (no auto-return to the just-left server).
      const st = engineStateRef.current;
      const skipPath =
        st.lastSwitchPath && Date.now() - (st.lastSwitchAt ?? 0) < SKIP_WINDOW_MS
          ? st.lastSwitchPath
          : undefined;
      const eligibleCands = skipPath ? cands.filter((c) => c.path !== skipPath) : cands;

      // (d) Run the pure decision over the latest reading + priority-ordered ELIGIBLE candidates,
      // passing the SAME COOLDOWN_MS so the fn stamps the cooldown consistently with this engine.
      const { nextState, action } = decideAutoSwitch(
        reading,
        engineStateRef.current,
        { thresholdMs: thr, checksN: n },
        eligibleCands,
        Date.now(),
        COOLDOWN_MS,
      );
      // (e) Persist the next state — BUT for a `switch` verdict, FAB-06: do NOT commit the breach
      // RESET + cooldown ARM until the switch is actually ACCEPTED. `decideAutoSwitch` returns a
      // switch `nextState` of `{ consecutiveBad: 0, cooldownUntil: now + COOLDOWN_MS }`; persisting
      // that up front would reset the breach + arm the 60 s cooldown even when the App SWALLOWS the
      // verdict (a switch already in flight, or status reconnecting/recovering) — delaying recovery
      // for a full cooldown while nothing switched. So on a switch verdict we PRESERVE the breach
      // count here (increment, no cooldown) and only stamp the reset+cooldown after doSwitch reports
      // accepted:true (below). A `noop` verdict persists its nextState as before.
      if (action.kind !== "switch") {
        engineStateRef.current = nextState;
      } else {
        // Preserve the just-incremented breach (never below checksN so a still-breaching next tick
        // re-fires immediately once the swallow clears); do NOT arm the cooldown yet. Spread the current
        // state so cooldownUntil + the lastSwitchPath/At loop-break memory survive.
        engineStateRef.current = {
          ...engineStateRef.current,
          consecutiveBad: Math.max(engineStateRef.current.consecutiveBad, n),
        };
      }

      // (f) On a switch verdict, fire the EXISTING switchTo then re-arm the cooldown so no second
      // switch fires during the settle window even if the new active config also reads bad at first.
      //
      // Phase 14 (D-13 / Pitfall 5): belt-and-suspenders — if an App-owned switch is ALREADY in
      // flight, do NOT fire a second one (nor push the origin/ping side-effects that precede it). The
      // engine is normally inert while status≠"connected" and the ~60s cooldown covers the
      // just-switched window (D-09); this guard is defense-in-depth, NOT a replacement — it does not
      // touch COOLDOWN_MS, the consecutive-checks gate, or the no-auto-return logic. The breach count
      // is preserved above (FAB-06), so a switch fires on a later tick once the App flag clears.
      if (action.kind === "switch" && !isSwitchingRef.current) {
        // Phase 13 (Pitfall 2 / A4): mark the pending connect ORIGIN as AutoSwitch RIGHT BEFORE
        // the switch, so the next Rust `Connected` edge emits «Переключено автоматически» instead
        // of the generic «Подключено». The origin is a durable AppState signal the Rust decider
        // consumes + resets on the connected, so it labels ONLY this auto-switch's reconnect — a
        // later manual connect reads Manual. This does NOT add a parallel switch path: `doSwitch`
        // (the EXISTING `switchTo`) remains the ONLY switch mechanism; we only set the label first.
        await invoke("set_pending_connect_origin", { origin: "autoSwitch" });
        // Phase 13 (13-08b): push the TARGET config's KNOWN reachability ping the plate shows. The
        // engine just decided this target is healthy from its own candidate reading, so we already
        // have it — no fresh probe needed (and a fresh probe of the soon-to-be-active endpoint would
        // read Unreachable by design once connected). Take the target candidate's reading: a numeric
        // ms only when it read `ok`, else null → the plate renders «—». Pushed right before the
        // switch so the Rust Connected edge reads it (mirrors the origin push above). A bare
        // number|null — no config content / password (D-29).
        const targetReading = cands.find((c) => c.path === action.targetPath)?.reading;
        const targetPingMs =
          targetReading?.status === "ok" ? targetReading.ms : null;
        await invoke("set_pending_connect_ping", { ms: targetPingMs });
        // FAB-06: doSwitch (App's performSwitch) resolves `{ accepted }`. Only when the switch was
        // ACTUALLY accepted do we consume the breach (reset counter + arm the ~60 s cooldown). A
        // swallowed verdict (App refused: a switch already in flight, or status reconnecting/
        // recovering) returns accepted:false — the breach count preserved above then re-fires the
        // switch on a later tick once the swallow clears, instead of resetting + arming a cooldown
        // for a switch that never happened. A legacy `Promise<void>` (standalone tests) resolves
        // undefined → treated as accepted (accepted !== false).
        const outcome = await doSwitch(action.targetPath);
        if (cancelled) return;
        const accepted = (outcome as { accepted?: boolean } | void)?.accepted !== false;
        if (accepted) {
          // Reset the breach + arm the cooldown, AND record this switch target + time so (d0) can
          // exclude it for SKIP_WINDOW_MS — if it turns out to have reverted (target dead), the engine
          // won't re-pick the same frozen-healthy-but-dead target on the next cycle.
          const nowMs = Date.now();
          engineStateRef.current = {
            consecutiveBad: 0,
            cooldownUntil: nowMs + COOLDOWN_MS,
            lastSwitchPath: action.targetPath,
            lastSwitchAt: nowMs,
          };
        }
      }

      // (g) Schedule the next tick. Floor the interval (defense-in-depth against a 0/NaN value).
      if (cancelled) return;
      const intervalMs = Math.max(inputsRef.current.intervalSec, MIN_INTERVAL_SEC) * 1000;
      timer = setTimeout(() => void tick(), intervalMs);
    };

    // First tick fires after one interval (the active config is already being shown live elsewhere;
    // we do not need an immediate probe — and waiting one interval matches the "every intervalSec"
    // contract). Floor it the same way.
    const firstIntervalMs = Math.max(intervalSec, MIN_INTERVAL_SEC) * 1000;
    timer = setTimeout(() => void tick(), firstIntervalMs);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // `activeConfigPath` is read directly (a genuine dependency). Tunables are read via inputsRef on
    // purpose, so they are intentionally NOT in the deps — changing them must not re-seed the loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [masterOn, status, activeConfigPath]);
}
