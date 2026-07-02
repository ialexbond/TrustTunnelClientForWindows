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
 * Defense-in-depth floor for the schedule interval (seconds). `useAppSettings` already clamps the
 * stored value to >= 5 s (AUTO_SWITCH_BOUNDS.intervalSec.min), so this is a second guard against a
 * 0/NaN interval ever reaching `setTimeout` and causing a tight ping-storm.
 */
const MIN_INTERVAL_SEC = 5;

/** The Rust `PingResult` discriminated union — identical shape to the decision `Reading`. */
type PingResult = Reading;

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
  /** The EXISTING `useVpnActions.switchTo` — the ONLY allowed switch mechanism (disconnect→connect). */
  switchTo: (path: string) => Promise<void>;
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

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      // Re-check the LIVE gate every tick: status may have left "connected" or master toggled off
      // between the schedule and now. (The effect cleanup also cancels, but this is the cheap path.)
      if (cancelled) return;
      if (statusRef.current !== "connected" || !masterOnRef.current) return;

      const { thresholdMs: thr, checksN: n, candidates: cands, switchTo: doSwitch } =
        inputsRef.current;

      // (b) Ping the ACTIVE config. A failed invoke (backend down / bad path) reads honest
      // no-data — treated as a breach by decideAutoSwitch (status !== "ok"), never thrown.
      const reading = await invoke<PingResult>("ping_config_endpoint", {
        configPath: activeConfigPath,
        timeoutMs: PING_TIMEOUT_MS,
      }).catch((): Reading => ({ status: "no-data" }));

      if (cancelled) return;

      // (d) Run the pure decision over the latest reading + priority-ordered candidates, passing
      // the SAME COOLDOWN_MS so the fn stamps the cooldown consistently with this engine.
      const { nextState, action } = decideAutoSwitch(
        reading,
        engineStateRef.current,
        { thresholdMs: thr, checksN: n },
        cands,
        Date.now(),
        COOLDOWN_MS,
      );
      // (e) Persist the next state.
      engineStateRef.current = nextState;

      // (f) On a switch verdict, fire the EXISTING switchTo then re-arm the cooldown so no second
      // switch fires during the settle window even if the new active config also reads bad at first.
      if (action.kind === "switch") {
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
        await doSwitch(action.targetPath);
        if (cancelled) return;
        engineStateRef.current = {
          consecutiveBad: 0,
          cooldownUntil: Date.now() + COOLDOWN_MS,
        };
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
