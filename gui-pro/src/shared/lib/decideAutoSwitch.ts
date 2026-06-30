/**
 * The PURE decision heart of the smart auto-switch engine. Encodes the four
 * locked engine decisions as a side-effect-free transform over
 * `(active, state, prefs, candidates, now, cooldownMs)` → `{ nextState, action }`:
 *
 *   - D-02  switch target = the FIRST candidate that is reachable AND below the
 *           threshold, walking the priority-ordered list top-down (the list IS
 *           the only order source — never re-sort by speed here).
 *   - D-03  no healthy target → STAY (silent): noop, the breach counter is
 *           RETAINED so a switch fires the instant a healthy config appears, no
 *           churn, no notification, never switch to an equally-bad config.
 *   - D-04  a switch fires only after `checksN` CONSECUTIVE bad readings AND
 *           outside the hidden ~60 s post-switch cooldown; a good reading resets
 *           the counter; while in cooldown the counter keeps climbing so the
 *           switch fires the moment the cooldown lapses.
 *   - D-05  NO auto-return: the fn acts ONLY on the active reading + the
 *           candidate set. A recovered OTHER config never triggers a switch
 *           while the active one is fine (there is no "previously-active
 *           recovered" branch at all).
 *
 * Mirrors the repo's `statusBadgeVariant.ts` pure-fn home/shape (import-type
 * only, single exported fn, doc comment citing the decisions). Deliberately has
 * NO `invoke`, NO timers, NO React import — the mutable state + the `switchTo`
 * side-effect live in the 12-05 `useAutoSwitch` hook; this fn only decides, which
 * makes it exhaustively unit-testable without timers or IPC.
 *
 * The cooldown is stamped HERE via the `cooldownMs` param (`now + cooldownMs`)
 * rather than left to the caller, so the engine and its tests share ONE arming
 * rule; 12-05 passes the SAME `COOLDOWN_MS` (60_000) const.
 */

/** Latest reading for a config — the same shape `ping_config_endpoint` produces. */
export type Reading =
  | { status: "ok"; ms: number }
  | { status: "unreachable" }
  | { status: "no-data" };

/** Mutable engine state held by the 12-05 hook between ticks (ms epoch for cooldown). */
export interface EngineState {
  consecutiveBad: number;
  cooldownUntil: number;
}

/** The two numeric prefs the decision needs (clamped upstream by useAppSettings). */
export interface Prefs {
  thresholdMs: number;
  checksN: number;
}

/** An inactive config + its latest reading, supplied in priority (manifest) order. */
export interface Candidate {
  path: string;
  order: number;
  reading: Reading;
}

/** What the hook should do with this tick's verdict. */
export type Action = { kind: "noop" } | { kind: "switch"; targetPath: string };

export function decideAutoSwitch(
  active: Reading,
  state: EngineState,
  prefs: Prefs,
  candidates: Candidate[],
  now: number,
  cooldownMs: number,
): { nextState: EngineState; action: Action } {
  // D-04 reset: a "good" active reading (ok AND at/below threshold) clears the
  // breach counter; the cooldown is left intact (only a real switch re-arms it).
  const isBad = active.status !== "ok" || active.ms > prefs.thresholdMs;
  if (!isBad) {
    return { nextState: { ...state, consecutiveBad: 0 }, action: { kind: "noop" } };
  }

  const consecutiveBad = state.consecutiveBad + 1;

  // D-04 cooldown: while in the hidden settle window we KEEP counting (so the
  // switch can fire the moment the cooldown expires) but never switch.
  if (now < state.cooldownUntil) {
    return { nextState: { ...state, consecutiveBad }, action: { kind: "noop" } };
  }

  // D-04 gate: not enough consecutive breaches yet → noop, counter retained.
  if (consecutiveBad < prefs.checksN) {
    return { nextState: { ...state, consecutiveBad }, action: { kind: "noop" } };
  }

  // D-02: walk the priority-ordered list, take the FIRST reachable+below-threshold
  // candidate (NOT the fastest one — array order is the only order source).
  const target = candidates.find(
    (c) => c.reading.status === "ok" && c.reading.ms <= prefs.thresholdMs,
  );

  // D-03 silent stay: no healthy target → noop, counter RETAINED (so we switch
  // as soon as one appears), no cooldown armed, no notification, no churn.
  if (!target) {
    return { nextState: { ...state, consecutiveBad }, action: { kind: "noop" } };
  }

  // Switch: reset the counter and arm the cooldown for the next settle window.
  return {
    nextState: { consecutiveBad: 0, cooldownUntil: now + cooldownMs },
    action: { kind: "switch", targetPath: target.path },
  };
}
