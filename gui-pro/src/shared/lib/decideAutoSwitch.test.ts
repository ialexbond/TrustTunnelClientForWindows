import { describe, it, expect } from "vitest";
import { decideAutoSwitch } from "./decideAutoSwitch";
import type { Candidate, EngineState, Prefs, Reading } from "./decideAutoSwitch";

// Exhaustive unit tests for the PURE decision fn (Wave 1 / Plan 12-04).
// Mirrors statusBadgeVariant.test.ts's exhaustive-table idiom. The 5 named it()s
// are the Wave-0 scaffold names turned GREEN (no -t drift); a table sweep at the
// bottom covers good/bad × in/out-of-cooldown × healthy/no-healthy combinatorially.
// Encodes D-02 (first healthy by priority order), D-03 (silent stay when all bad),
// D-04 (consecutive gate + hidden cooldown + reset on good), D-05 (no auto-return).

// --- Shared fixtures ---------------------------------------------------------
const THRESHOLD = 300; // matches APP_SETTINGS_DEFAULTS.thresholdMs (12-03)
const CHECKS_N = 3; // matches APP_SETTINGS_DEFAULTS.checksN (12-03)
const COOLDOWN_MS = 60_000; // D-04 hidden cooldown (12-05 passes the SAME const)

const prefs: Prefs = { thresholdMs: THRESHOLD, checksN: CHECKS_N };

const freshState: EngineState = { consecutiveBad: 0, cooldownUntil: 0 };

const ok = (ms: number): Reading => ({ status: "ok", ms });
const unreachable: Reading = { status: "unreachable" };
const noData: Reading = { status: "no-data" };

const healthy: Candidate = { path: "/cfg/healthy.toml", order: 1, reading: ok(120) };
const slowButOk: Candidate = { path: "/cfg/slow-ok.toml", order: 2, reading: ok(250) };
const overThreshold: Candidate = { path: "/cfg/over.toml", order: 0, reading: ok(900) };
const dead: Candidate = { path: "/cfg/dead.toml", order: 3, reading: unreachable };

describe("decideAutoSwitch", () => {
  it("fires after N consecutive breaches", () => {
    // D-04: with checksN=3, the switch fires ONLY on the 3rd consecutive bad
    // reading (and not before), when a healthy candidate exists and we are out
    // of cooldown.
    // 1st breach (counter was 0) → noop, counter=1
    const r1 = decideAutoSwitch(unreachable, freshState, prefs, [healthy], 1000, COOLDOWN_MS);
    expect(r1.action).toEqual({ kind: "noop" });
    expect(r1.nextState.consecutiveBad).toBe(1);

    // 2nd breach → still noop, counter=2 (only 2 breaches → no switch)
    const r2 = decideAutoSwitch(unreachable, r1.nextState, prefs, [healthy], 2000, COOLDOWN_MS);
    expect(r2.action).toEqual({ kind: "noop" });
    expect(r2.nextState.consecutiveBad).toBe(2);

    // 3rd breach → SWITCH (counter reached checksN)
    const r3 = decideAutoSwitch(unreachable, r2.nextState, prefs, [healthy], 3000, COOLDOWN_MS);
    expect(r3.action).toEqual({ kind: "switch", targetPath: healthy.path });
  });

  it("cooldown blocks a switch within ~60s", () => {
    // D-04: even at >=N breaches with a healthy candidate, a switch is blocked
    // while now < cooldownUntil — BUT the counter keeps climbing so the switch
    // fires the instant the cooldown lapses.
    const armed: EngineState = { consecutiveBad: CHECKS_N, cooldownUntil: 60_000 };

    // Still inside cooldown (now < cooldownUntil) → noop, counter keeps climbing.
    const blocked = decideAutoSwitch(unreachable, armed, prefs, [healthy], 30_000, COOLDOWN_MS);
    expect(blocked.action).toEqual({ kind: "noop" });
    expect(blocked.nextState.consecutiveBad).toBe(CHECKS_N + 1);
    expect(blocked.nextState.cooldownUntil).toBe(60_000); // cooldown untouched while blocked

    // The instant cooldown lapses (now >= cooldownUntil) → switch fires.
    const fired = decideAutoSwitch(
      unreachable,
      blocked.nextState,
      prefs,
      [healthy],
      60_000,
      COOLDOWN_MS,
    );
    expect(fired.action).toEqual({ kind: "switch", targetPath: healthy.path });
    // A switch re-arms the cooldown for the next settle window.
    expect(fired.nextState.cooldownUntil).toBe(60_000 + COOLDOWN_MS);
    expect(fired.nextState.consecutiveBad).toBe(0);
  });

  it("picks first healthy by order", () => {
    // D-02: the candidate list is the ONLY order source; `find` takes the FIRST
    // reachable+below-threshold entry — NOT a later, faster one. Here the 2nd
    // entry is the first that qualifies (the 1st is over threshold, a later one
    // is faster but must be ignored).
    const faster: Candidate = { path: "/cfg/faster.toml", order: 9, reading: ok(50) };
    const candidates = [overThreshold, slowButOk, faster]; // priority order = array order
    const breached: EngineState = { consecutiveBad: CHECKS_N - 1, cooldownUntil: 0 };

    const res = decideAutoSwitch(unreachable, breached, prefs, candidates, 5000, COOLDOWN_MS);
    expect(res.action).toEqual({ kind: "switch", targetPath: slowButOk.path });
    // proves it did NOT pick the faster-but-later candidate
    expect(res.action).not.toEqual({ kind: "switch", targetPath: faster.path });
  });

  it("stays when all bad", () => {
    // D-03: at >=N breaches with NO reachable+below-threshold candidate → noop,
    // the counter is RETAINED (so a switch fires as soon as a healthy one
    // appears), no churn, no notification.
    const allBad = [overThreshold, dead, { ...slowButOk, reading: noData }];
    const breached: EngineState = { consecutiveBad: CHECKS_N - 1, cooldownUntil: 0 };

    const res = decideAutoSwitch(unreachable, breached, prefs, allBad, 5000, COOLDOWN_MS);
    expect(res.action).toEqual({ kind: "noop" });
    expect(res.nextState.consecutiveBad).toBe(CHECKS_N); // counter retained/incremented, not reset
    expect(res.nextState.cooldownUntil).toBe(0); // no cooldown armed (no switch)
  });

  it("resets on good reading", () => {
    // D-04: a good active reading (ok AND ms<=threshold) clears the breach
    // counter and is a noop, regardless of how high the counter was.
    const breached: EngineState = { consecutiveBad: 5, cooldownUntil: 12_345 };

    const res = decideAutoSwitch(ok(120), breached, prefs, [healthy], 9999, COOLDOWN_MS);
    expect(res.action).toEqual({ kind: "noop" });
    expect(res.nextState.consecutiveBad).toBe(0);
    expect(res.nextState.cooldownUntil).toBe(12_345); // cooldown left intact, only the counter reset
  });

  // --- Boundary: ms exactly at threshold is GOOD (<=), one over is BAD --------
  it("treats ms exactly at threshold as good, one over as bad", () => {
    const atEdge = decideAutoSwitch(ok(THRESHOLD), freshState, prefs, [healthy], 1, COOLDOWN_MS);
    expect(atEdge.action).toEqual({ kind: "noop" });
    expect(atEdge.nextState.consecutiveBad).toBe(0); // <= threshold → good → reset

    const overEdge = decideAutoSwitch(ok(THRESHOLD + 1), freshState, prefs, [healthy], 1, COOLDOWN_MS);
    expect(overEdge.nextState.consecutiveBad).toBe(1); // > threshold → bad → counts
  });

  it("never auto-returns: a recovered candidate while active is good is a pure noop (D-05)", () => {
    // D-05: the fn acts ONLY on the active reading + the candidate set. A healthy
    // OTHER config present while the active one is fine must NEVER trigger a switch.
    const res = decideAutoSwitch(ok(80), freshState, prefs, [healthy, slowButOk], 7777, COOLDOWN_MS);
    expect(res.action).toEqual({ kind: "noop" });
    expect(res.nextState.consecutiveBad).toBe(0);
  });

  // --- Exhaustive table sweep -------------------------------------------------
  // good/bad active × in/out-of-cooldown × healthy/no-healthy candidate, at a
  // counter already at the gate, so each combination's verdict is asserted once.
  describe("table sweep (active × cooldown × candidate health)", () => {
    type Row = {
      name: string;
      active: Reading;
      inCooldown: boolean;
      candidates: Candidate[];
      atGate: boolean; // is the incoming counter already at checksN-1 (so one more breach hits N)?
      expect: "noop-reset" | "noop-blocked" | "noop-stay" | "switch";
    };

    const rows: Row[] = [
      { name: "good reading always resets", active: ok(100), inCooldown: false, candidates: [healthy], atGate: true, expect: "noop-reset" },
      { name: "good reading resets even in cooldown", active: ok(100), inCooldown: true, candidates: [healthy], atGate: true, expect: "noop-reset" },
      { name: "bad + out of cooldown + healthy + at gate → switch", active: unreachable, inCooldown: false, candidates: [healthy], atGate: true, expect: "switch" },
      { name: "bad + out of cooldown + healthy + below gate → noop", active: unreachable, inCooldown: false, candidates: [healthy], atGate: false, expect: "noop-stay" },
      { name: "bad + in cooldown + healthy + at gate → blocked", active: unreachable, inCooldown: true, candidates: [healthy], atGate: true, expect: "noop-blocked" },
      { name: "bad + out of cooldown + no healthy + at gate → stay", active: unreachable, inCooldown: false, candidates: [overThreshold, dead], atGate: true, expect: "noop-stay" },
      { name: "bad (over-threshold ok) + healthy + at gate → switch", active: ok(THRESHOLD + 500), inCooldown: false, candidates: [healthy], atGate: true, expect: "switch" },
      { name: "bad no-data + healthy + at gate → switch", active: noData, inCooldown: false, candidates: [healthy], atGate: true, expect: "switch" },
    ];

    for (const row of rows) {
      it(row.name, () => {
        const now = 50_000;
        const state: EngineState = {
          consecutiveBad: row.atGate ? CHECKS_N - 1 : 0,
          cooldownUntil: row.inCooldown ? now + 10_000 : 0,
        };
        const { action, nextState } = decideAutoSwitch(
          row.active,
          state,
          prefs,
          row.candidates,
          now,
          COOLDOWN_MS,
        );

        switch (row.expect) {
          case "noop-reset":
            expect(action).toEqual({ kind: "noop" });
            expect(nextState.consecutiveBad).toBe(0);
            break;
          case "switch":
            expect(action.kind).toBe("switch");
            expect(nextState.consecutiveBad).toBe(0);
            expect(nextState.cooldownUntil).toBe(now + COOLDOWN_MS);
            break;
          case "noop-blocked":
            expect(action).toEqual({ kind: "noop" });
            expect(nextState.consecutiveBad).toBe(CHECKS_N); // counter still climbs while blocked
            break;
          case "noop-stay":
            expect(action).toEqual({ kind: "noop" });
            // counter retained (incremented), never reset on a bad reading
            expect(nextState.consecutiveBad).toBeGreaterThan(0);
            break;
        }
      });
    }
  });
});
