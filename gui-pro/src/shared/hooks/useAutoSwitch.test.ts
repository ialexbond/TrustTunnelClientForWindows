// Phase 12 / Plan 12-05 — fake-timers lifecycle tests for the `useAutoSwitch` engine hook.
//
// The 4 `it` names are inherited VERBATIM from the Wave-0 (12-01) scaffold so the plan's
// `-t` filters stay valid. They prove the engine's lifecycle WITHOUT a real backend:
//   - status gating (no fire while disconnected),
//   - the N-breach → switch → hidden cooldown sequence,
//   - clean cancel on unmount (no leaked timers/loops),
//   - it keeps monitoring after a manual pick (D-05 — no manual-mode freeze).
//
// `ping_config_endpoint` (the only invoke the hook makes) is mocked to return a controllable
// `{status, ms}` union; `switchTo` is a spy passed as a prop. Fake timers + `advanceTimersByTimeAsync`
// inside `act` drive the interval ticks deterministically.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAutoSwitch, COOLDOWN_MS, type UseAutoSwitchParams } from "./useAutoSwitch";
import type { Candidate, Reading } from "../lib/decideAutoSwitch";

// Mock @tauri-apps/api/core — the hook only ever invokes "ping_config_endpoint".
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

/** Build the hook props with sensible defaults; override per test. */
function makeProps(overrides: Partial<UseAutoSwitchParams> = {}): UseAutoSwitchParams {
  return {
    masterOn: true,
    thresholdMs: 300,
    intervalSec: INTERVAL_SEC,
    checksN: 3,
    status: "connected",
    activeConfigPath: "/active.toml",
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
  // Default: the active config pings BAD every tick (most tests want breaches).
  mockInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === "ping_config_endpoint") return BAD;
    return null;
  });
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

    // Advance several intervals — the loop must be inert: no active-config ping, no switch.
    await advanceOneTick();
    await advanceOneTick();
    await advanceOneTick();

    expect(
      mockInvoke.mock.calls.filter((c) => c[0] === "ping_config_endpoint"),
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

  it("cancels on unmount", async () => {
    const switchTo = vi.fn().mockResolvedValue(undefined);
    const { unmount } = renderHook(() => useAutoSwitch(makeProps({ switchTo })));

    // One tick to prove the loop is alive, then unmount mid-loop.
    await advanceOneTick();
    const pingsBefore = mockInvoke.mock.calls.filter(
      (c) => c[0] === "ping_config_endpoint",
    ).length;
    expect(pingsBefore).toBeGreaterThan(0);

    unmount();

    // After unmount, advancing timers must produce NO further pings or switches (cancelled flag +
    // clearTimeout). A leaked timer would keep pinging here.
    await advanceOneTick();
    await advanceOneTick();
    const pingsAfter = mockInvoke.mock.calls.filter(
      (c) => c[0] === "ping_config_endpoint",
    ).length;
    expect(pingsAfter).toBe(pingsBefore);
    expect(switchTo).not.toHaveBeenCalled();
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
});
