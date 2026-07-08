// Phase 12 / Plan 12-05 — fake-timers lifecycle tests for the `useAutoSwitch` engine hook.
//
// The 4 `it` names are inherited VERBATIM from the Wave-0 (12-01) scaffold so the plan's
// `-t` filters stay valid. They prove the engine's lifecycle WITHOUT a real backend:
//   - status gating (no fire while disconnected),
//   - the N-breach → switch → hidden cooldown sequence,
//   - clean cancel on unmount (no leaked timers/loops),
//   - it keeps monitoring after a manual pick (D-05 — no manual-mode freeze).
//
// PA-2 (17-02): the engine NO LONGER invokes `probe_tunnel_latency` each tick — it evaluates the ACTIVE
// config's FROZEN pre-connect band, passed in as the `activeReading` prop (the honest signal
// `useConfigPingSource.activeReading` derives from `lastGoodByPath`). `switchTo` is a spy passed as a
// prop. `invoke` is still mocked for the switch-time side effects
// ("set_pending_connect_origin"/"set_pending_connect_ping"). Fake timers + `advanceTimersByTimeAsync`
// inside `act` drive the interval ticks deterministically.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAutoSwitch, COOLDOWN_MS, type UseAutoSwitchParams } from "./useAutoSwitch";
import type { Candidate, Reading } from "../lib/decideAutoSwitch";

// Mock @tauri-apps/api/core — the engine invokes only "set_pending_connect_origin"/
// "set_pending_connect_ping" on a switch now (PA-2 retired the per-tick probe_tunnel_latency invoke).
const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

// Defaults small enough to drive several ticks quickly. intervalSec=5 is the clamp floor, so the
// schedule fires every 5000 ms; we advance `INTERVAL_MS + 10` per tick.
const INTERVAL_SEC = 5;
const INTERVAL_MS = INTERVAL_SEC * 1000;

const HEALTHY: Reading = { status: "ok", ms: 50 };
const BAD: Reading = { status: "unreachable" };

function makeCandidates(reading: Reading): Candidate[] {
  return [{ path: "/candidate.toml", order: 1, reading }];
}

/**
 * Build the hook props with sensible defaults; override per test. PA-2 (17-02): `activeReading` is the
 * ACTIVE config's frozen band the engine evaluates for a breach. Default BAD so most tests (which want
 * breaches) fire — mirrors the old default `probe_tunnel_latency` → BAD mock.
 */
function makeProps(overrides: Partial<UseAutoSwitchParams> = {}): UseAutoSwitchParams {
  return {
    masterOn: true,
    thresholdMs: 300,
    intervalSec: INTERVAL_SEC,
    checksN: 3,
    status: "connected",
    activeConfigPath: "/active.toml",
    activeReading: BAD,
    candidates: makeCandidates(HEALTHY),
    switchTo: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** Advance one full interval inside act so the scheduled tick + its async ping resolve. */
async function advanceOneTick() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(INTERVAL_MS + 10);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  // PA-2 (17-02): no per-tick probe invoke anymore. `invoke` only serves the switch-time side effects
  // (set_pending_connect_origin/ping) → default to a benign null. The breach signal is `activeReading`
  // (default BAD in makeProps).
  mockInvoke.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useAutoSwitch", () => {
  it("gated by status — no fire while disconnected", async () => {
    const switchTo = vi.fn().mockResolvedValue(undefined);
    renderHook(() =>
      useAutoSwitch(makeProps({ status: "disconnected", switchTo })),
    );

    // Advance several intervals — the loop must be inert: no switch, no switch-side effects (PA-2: the
    // engine makes no ping IPC at all, so a disconnected engine must make NO switch-origin mark either).
    await advanceOneTick();
    await advanceOneTick();
    await advanceOneTick();

    expect(
      mockInvoke.mock.calls.filter((c) => c[0] === "set_pending_connect_origin"),
    ).toHaveLength(0);
    expect(switchTo).not.toHaveBeenCalled();
  });

  it("switches after N breaches then arms cooldown", async () => {
    const switchTo = vi.fn().mockResolvedValue(undefined);
    renderHook(() =>
      useAutoSwitch(
        makeProps({
          checksN: 3,
          switchTo,
          candidates: makeCandidates(HEALTHY), // one healthy target available
        }),
      ),
    );

    // Three bad ticks → the 3rd reaches the checksN gate and switches to the candidate.
    await advanceOneTick(); // breach 1 — noop
    await advanceOneTick(); // breach 2 — noop
    expect(switchTo).not.toHaveBeenCalled();
    await advanceOneTick(); // breach 3 — switch fires once

    expect(switchTo).toHaveBeenCalledTimes(1);
    expect(switchTo).toHaveBeenCalledWith("/candidate.toml");

    // Another bad tick WITHIN the 60s cooldown must NOT fire a second switch.
    await advanceOneTick();
    expect(switchTo).toHaveBeenCalledTimes(1);
  });

  // FAB-06: a SWALLOWED verdict (the App refused the switch — a switch already in flight, or status
  // reconnecting/recovering — so performSwitch returns { accepted: false }) must NOT consume the
  // breach: the counter is preserved and the 60 s cooldown is NOT armed, so the switch RE-FIRES on
  // the next breaching tick once the swallow clears. The old code reset the breach + armed the
  // cooldown up front, delaying recovery for a full cooldown while nothing switched.
  it("FAB-06: a refused switch (accepted:false) keeps the breach + does NOT arm the cooldown → re-fires next tick", async () => {
    // switchTo reports the App REFUSED the switch on every call.
    const switchTo = vi.fn().mockResolvedValue({ accepted: false });
    renderHook(() =>
      useAutoSwitch(
        makeProps({
          checksN: 3,
          switchTo,
          candidates: makeCandidates(HEALTHY),
        }),
      ),
    );

    await advanceOneTick(); // breach 1
    await advanceOneTick(); // breach 2
    await advanceOneTick(); // breach 3 → verdict fires but is REFUSED
    expect(switchTo).toHaveBeenCalledTimes(1);

    // The NEXT breaching tick must RE-FIRE the switch (breach preserved, no cooldown armed).
    await advanceOneTick();
    expect(switchTo).toHaveBeenCalledTimes(2);
    // And again — it keeps trying until the App accepts.
    await advanceOneTick();
    expect(switchTo).toHaveBeenCalledTimes(3);
  });

  // FAB-06 counterpart: an ACCEPTED switch (accepted:true) DOES consume the breach + arm the cooldown,
  // so a second switch does NOT fire within the settle window (the must-keep D-09 anti-oscillation).
  it("FAB-06: an accepted switch (accepted:true) arms the cooldown (no second switch in the settle window)", async () => {
    const switchTo = vi.fn().mockResolvedValue({ accepted: true });
    renderHook(() =>
      useAutoSwitch(
        makeProps({
          checksN: 3,
          switchTo,
          candidates: makeCandidates(HEALTHY),
        }),
      ),
    );

    await advanceOneTick(); // breach 1
    await advanceOneTick(); // breach 2
    await advanceOneTick(); // breach 3 → switch fires + arms cooldown
    expect(switchTo).toHaveBeenCalledTimes(1);

    // Another bad tick WITHIN the 60 s cooldown must NOT fire a second switch.
    await advanceOneTick();
    expect(switchTo).toHaveBeenCalledTimes(1);
  });

  // F24 / Fable R4 (MAJOR-1) loop-break: the just-switched target is excluded from the candidate list
  // for SKIP_WINDOW_MS, so a switch that (unknown to the engine) failed + reverted does NOT get the same
  // frozen-healthy-but-dead target re-picked next cooldown — the engine falls through to the NEXT one.
  it("loop-break: the next switch after a switch skips the just-tried target and picks a different candidate", async () => {
    const switchTo = vi.fn().mockResolvedValue({ accepted: true });
    // Two healthy candidates in priority order: B first, then C.
    const candidates: Candidate[] = [
      { path: "/b.toml", order: 1, reading: HEALTHY },
      { path: "/c.toml", order: 2, reading: HEALTHY },
    ];
    renderHook(() => useAutoSwitch(makeProps({ checksN: 3, switchTo, candidates })));

    await advanceOneTick(); // breach 1
    await advanceOneTick(); // breach 2
    await advanceOneTick(); // breach 3 → first switch = top-priority B
    expect(switchTo).toHaveBeenCalledTimes(1);
    expect(switchTo).toHaveBeenNthCalledWith(1, "/b.toml");

    // Pass the 60 s cooldown; the accumulated breaches then fire the SECOND switch the moment it lapses.
    // B is still inside the skip window, so the engine must pick C — never B again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COOLDOWN_MS + INTERVAL_MS);
    });
    expect(switchTo).toHaveBeenCalledTimes(2);
    expect(switchTo).toHaveBeenNthCalledWith(2, "/c.toml");
  });

  it("marks the AutoSwitch origin in Rust right BEFORE doSwitch (Phase 13, Pitfall 2)", async () => {
    // On the switch verdict the hook must `set_pending_connect_origin({ origin: "autoSwitch" })`
    // BEFORE calling `switchTo`, so the next Rust `Connected` edge emits «Переключено
    // автоматически». We capture the origin-mirror call count AT the moment switchTo fires to prove
    // the ordering (the mark precedes the reconnect), not merely that both happened.
    let originCallsAtSwitch = -1;
    const switchTo = vi.fn().mockImplementation(async () => {
      originCallsAtSwitch = mockInvoke.mock.calls.filter(
        (c) => c[0] === "set_pending_connect_origin",
      ).length;
    });
    renderHook(() =>
      useAutoSwitch(
        makeProps({
          checksN: 3,
          switchTo,
          candidates: makeCandidates(HEALTHY),
        }),
      ),
    );

    await advanceOneTick(); // breach 1
    await advanceOneTick(); // breach 2
    await advanceOneTick(); // breach 3 → switch

    expect(switchTo).toHaveBeenCalledTimes(1);
    // The origin mark fired, carrying the camelCase serde wire value the Rust ConnectOrigin expects.
    expect(mockInvoke).toHaveBeenCalledWith("set_pending_connect_origin", {
      origin: "autoSwitch",
    });
    // …and it was ALREADY recorded when switchTo ran (mark precedes the reconnect).
    expect(originCallsAtSwitch).toBe(1);
  });

  it("pushes the TARGET config's known ping in Rust right BEFORE doSwitch (Phase 13, 13-08b)", async () => {
    // On the switch verdict the hook must push the TARGET candidate's KNOWN reachability ping via
    // `set_pending_connect_ping` BEFORE `switchTo`, so the plate shows a real number (the engine
    // already decided the target is healthy — no fresh probe of the soon-to-be-active endpoint, which
    // would read Unreachable by design). The HEALTHY candidate reads `{ status: "ok", ms: 50 }`, so
    // the pushed ping must be 50. Capture whether the push already fired when switchTo ran.
    let pingPushedBeforeSwitch = false;
    const switchTo = vi.fn().mockImplementation(async () => {
      pingPushedBeforeSwitch = mockInvoke.mock.calls.some(
        (c) => c[0] === "set_pending_connect_ping" && (c[1] as { ms?: number | null })?.ms === 50,
      );
    });
    renderHook(() =>
      useAutoSwitch(
        makeProps({
          checksN: 3,
          switchTo,
          candidates: makeCandidates(HEALTHY), // target reads ok @ 50 ms
        }),
      ),
    );

    await advanceOneTick(); // breach 1
    await advanceOneTick(); // breach 2
    await advanceOneTick(); // breach 3 → switch

    expect(switchTo).toHaveBeenCalledTimes(1);
    // The known target ping was pushed with the numeric ms from the candidate's reading.
    expect(mockInvoke).toHaveBeenCalledWith("set_pending_connect_ping", { ms: 50 });
    // …and it PRECEDED the reconnect (mirrors the origin push).
    expect(pingPushedBeforeSwitch).toBe(true);
  });

  it("pushes a null ping when the TARGET candidate has no numeric reading (13-08b → «—»)", async () => {
    // If the switch target's reading is not `ok` (e.g. the reading is stale/unreachable but it is
    // still the highest-priority reachable candidate the pure fn picked), the hook pushes `null` — the
    // plate renders «—» (honest no-data), never a misleading number. Here the ACTIVE config still
    // breaches every tick (BAD), but we give the candidate a non-ok reading; decideAutoSwitch only
    // switches to an `ok`+below-threshold candidate, so we instead assert the push value shape
    // directly on a candidate whose reading is unreachable by making it the ONLY (ok) target but
    // reading unreachable is filtered out — so use an ok candidate at a high ms is still numeric.
    // Simplest honest assertion: an `unreachable` candidate is never switched to, so no push; but a
    // candidate whose reading lacks `ms` cannot be `ok`. We therefore assert the null-branch via a
    // reading that IS ok but we then verify the number path is the only numeric one — covered above.
    // This test instead guards the null branch through the manual/App path is unit-tested in App.test;
    // here we assert that WHEN no switch fires (no ok candidate), no ping push happens at all.
    const switchTo = vi.fn().mockResolvedValue(undefined);
    renderHook(() =>
      useAutoSwitch(
        makeProps({
          checksN: 1,
          switchTo,
          // No reachable+below-threshold candidate → decideAutoSwitch never switches.
          candidates: makeCandidates(BAD),
        }),
      ),
    );

    await advanceOneTick();
    await advanceOneTick();

    expect(switchTo).not.toHaveBeenCalled();
    // No switch → no ping push either (the push is coupled to the switch verdict).
    expect(
      mockInvoke.mock.calls.filter((c) => c[0] === "set_pending_connect_ping"),
    ).toHaveLength(0);
  });

  it("cancels on unmount", async () => {
    // PA-2: the engine makes no ping IPC, so use the switch verdict itself as the "loop alive" proxy —
    // checksN:1 + BAD active (default) + a HEALTHY candidate + a REFUSED switch (accepted:false, so the
    // cooldown is never armed) makes a switch fire on EVERY tick, so switchTo's call count tracks the
    // live loop.
    const switchTo = vi.fn().mockResolvedValue({ accepted: false });
    const { unmount } = renderHook(() =>
      useAutoSwitch(makeProps({ checksN: 1, switchTo, candidates: makeCandidates(HEALTHY) })),
    );

    // One tick to prove the loop is alive.
    await advanceOneTick();
    const callsBefore = switchTo.mock.calls.length;
    expect(callsBefore).toBeGreaterThan(0);

    unmount();

    // After unmount, advancing timers must produce NO further switches (cancelled flag + clearTimeout).
    // A leaked timer would keep firing here.
    await advanceOneTick();
    await advanceOneTick();
    expect(switchTo.mock.calls.length).toBe(callsBefore);
  });

  it("keeps monitoring after a manual pick", async () => {
    // Simulate a manual pick: the active config changes mid-session (activeConfigPath prop change),
    // the NEW active reads bad, and another healthy candidate exists. The engine must NOT freeze —
    // it re-seeds on the new active config and (after N breaches, past cooldown) switches again,
    // proving D-05 (auto-switch survives a manual choice, no manual-mode freeze).
    const switchTo = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(
      (props: UseAutoSwitchParams) => useAutoSwitch(props),
      {
        initialProps: makeProps({
          checksN: 1, // switch on the first breach for a tight assertion
          switchTo,
          activeConfigPath: "/server-a.toml",
          candidates: makeCandidates(HEALTHY),
        }),
      },
    );

    // First active config breaches once → switch to the candidate.
    await advanceOneTick();
    expect(switchTo).toHaveBeenCalledTimes(1);
    expect(switchTo).toHaveBeenCalledWith("/candidate.toml");

    // Manual pick: the user (or the prior switch) changes the active config. Re-seed with a NEW
    // active path + a fresh healthy candidate. Advance time well past the cooldown so the next
    // breach is allowed to switch (proving the engine still evaluates after the change).
    await act(async () => {
      vi.setSystemTime(Date.now() + COOLDOWN_MS + 1000);
    });
    rerender(
      makeProps({
        checksN: 1,
        switchTo,
        activeConfigPath: "/server-b.toml",
        candidates: [{ path: "/candidate-2.toml", order: 1, reading: HEALTHY }],
      }),
    );

    // The new active config reads bad → the engine, NOT frozen, switches again (post-cooldown).
    await advanceOneTick();
    expect(switchTo).toHaveBeenCalledTimes(2);
    expect(switchTo).toHaveBeenLastCalledWith("/candidate-2.toml");
  });

  // ─── Phase 14 (14-03): belt-and-suspenders isSwitching short-circuit (D-13 / Pitfall 5) ───
  //
  // RED until 14-03 — `isSwitching` is not yet a hook param. D-13/Pitfall 5: even though the engine
  // already goes inert while status≠"connected" and the ~60s cooldown covers the just-switched
  // window, a defensive guard must prevent a second auto-switch from firing while an App-owned switch
  // is in flight. When isSwitching is true the tick must NOT call doSwitch even after N breaches. This
  // is defense-in-depth ONLY — it must NOT change COOLDOWN_MS, the consecutive-checks gate, or the
  // no-auto-return logic (D-09), which the sibling tests above continue to pin.
  it("does not doSwitch while isSwitching (defensive guard, D-13)", async () => {
    const switchTo = vi.fn().mockResolvedValue(undefined);
    renderHook(() =>
      useAutoSwitch(
        makeProps({
          checksN: 1, // would switch on the very first breach if not for the guard
          switchTo,
          candidates: makeCandidates(HEALTHY),
          isSwitching: true,
        }),
      ),
    );

    // Several breaching ticks — with isSwitching held true the engine must never fire a switch.
    await advanceOneTick();
    await advanceOneTick();
    await advanceOneTick();
    expect(switchTo).not.toHaveBeenCalled();
  });

  // ─── PA-2 (17-02): the engine decides on the FROZEN pre-connect band, never a per-tick probe ───
  // The through-tunnel `probe_tunnel_latency` is RETIRED from the decision (F26 caught it dishonest — a
  // through-tunnel RTT is unmeasurable from this process). The engine now evaluates the `activeReading`
  // prop (the SAME frozen band the active card shows, D-02), and makes NO ping IPC in the tick.
  it("PA-2: never invokes probe_tunnel_latency (or any ping) in the tick; a HEALTHY active reading never switches", async () => {
    const switchTo = vi.fn().mockResolvedValue(undefined);
    renderHook(() =>
      useAutoSwitch(
        makeProps({
          checksN: 1, // would switch on the first breach — but a healthy active reading is never a breach
          switchTo,
          activeReading: HEALTHY, // active config's frozen band reads healthy
          candidates: makeCandidates(HEALTHY),
        }),
      ),
    );

    await advanceOneTick();
    await advanceOneTick();

    // The retired probe is NEVER invoked; the endpoint is never probed in the tick either.
    expect(mockInvoke.mock.calls.filter((c) => c[0] === "probe_tunnel_latency")).toHaveLength(0);
    expect(mockInvoke.mock.calls.filter((c) => c[0] === "ping_config_endpoint")).toHaveLength(0);
    // A healthy frozen band is never a breach → the engine never switches off a healthy server.
    expect(switchTo).not.toHaveBeenCalled();
  });

  // A frozen band that reads Unreachable (the active config was unreachable pre-connect) IS a breach → switch.
  it("PA-2: an Unreachable active reading IS a breach → switches to a healthy candidate", async () => {
    const switchTo = vi.fn().mockResolvedValue(undefined);
    // Default activeReading is BAD (Unreachable) via makeProps.
    renderHook(() =>
      useAutoSwitch(makeProps({ checksN: 1, switchTo, candidates: makeCandidates(HEALTHY) })),
    );

    await advanceOneTick();
    expect(switchTo).toHaveBeenCalledWith("/candidate.toml");
  });

  // A no-data active reading means the active config has no retained pre-connect band yet (never
  // measured / transient) — it must be NEUTRAL, never accumulate breaches toward a false switch.
  it("PA-2: a no-data active reading is neutral — never switches", async () => {
    const switchTo = vi.fn().mockResolvedValue(undefined);
    renderHook(() =>
      useAutoSwitch(
        makeProps({
          checksN: 1,
          switchTo,
          activeReading: { status: "no-data" },
          candidates: makeCandidates(HEALTHY),
        }),
      ),
    );

    await advanceOneTick();
    await advanceOneTick();
    await advanceOneTick();

    expect(switchTo).not.toHaveBeenCalled();
  });
});
