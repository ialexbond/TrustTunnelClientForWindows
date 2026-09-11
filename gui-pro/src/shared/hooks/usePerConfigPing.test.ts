import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import {
  usePerConfigPing,
  bandForMs,
  toConfigPing,
  type PingTarget,
} from "./usePerConfigPing";

// Mock @tauri-apps/api/core
const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

const TARGETS: PingTarget[] = [
  { id: "a", path: "/a.toml" },
  { id: "b", path: "/b.toml" },
];

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("bandForMs — owner-set ping thresholds (IN-22 / TA-1 boundary lock)", () => {
  // The audit's MAJOR-1: every other test feeds only green sample values, so a regression
  // that flips a cutoff or swaps `<=` for `<` would pass unnoticed. Lock the EXACT owner
  // thresholds on both sides of each boundary: ≤150 green / 151–300 yellow / >300 red.
  it.each([
    // [ms, expected band] — chosen at and around the exact 150 / 300 cutoffs.
    [0, "green"],
    [149, "green"],
    [150, "green"], // 150 is still green (≤150, not <150)
    [151, "yellow"], // first yellow — guards against `<=`→`<` on the 150 edge
    [200, "yellow"],
    [300, "yellow"], // 300 is still yellow (≤300)
    [301, "red"], // first red — guards against a shifted 300 cutoff
    [1000, "red"],
  ] as const)("maps %i ms → %s band", (ms, expected) => {
    expect(bandForMs(ms)).toBe(expected);
  });

  it("bands the numeric PingResult statuses through the same cutoffs via toConfigPing", () => {
    expect(toConfigPing({ status: "ok", ms: 150 })).toEqual({ band: "green", valueMs: 150 });
    expect(toConfigPing({ status: "ok", ms: 151 })).toEqual({ band: "yellow", valueMs: 151 });
    expect(toConfigPing({ status: "ok", ms: 300 })).toEqual({ band: "yellow", valueMs: 300 });
    expect(toConfigPing({ status: "ok", ms: 301 })).toEqual({ band: "red", valueMs: 301 });
  });

  it("maps the non-numeric statuses to their honest bands (unreachable → timeout, no-data → no-data)", () => {
    // unreachable must NEVER read as red (a number) — it is the distinct «Недоступен» band.
    expect(toConfigPing({ status: "unreachable" })).toEqual({ band: "timeout" });
    // no-data carries no value and is never red (D-16).
    expect(toConfigPing({ status: "no-data" })).toEqual({ band: "no-data" });
  });
});

describe("usePerConfigPing — manual round + pinging flag", () => {
  it("resolves a band for each target on a manual refreshPings round", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ping_config_endpoint") return { status: "ok", ms: 42 };
      return null;
    });

    const { result } = renderHook(() => usePerConfigPing(TARGETS));

    // No auto ping — the map starts empty.
    expect(result.current.pings).toEqual({});

    await act(async () => {
      await result.current.refreshPings();
    });

    expect(result.current.pings.a?.band).toBe("green");
    expect(result.current.pings.b?.band).toBe("green");
    // The flag settles back to false once the round completes.
    expect(result.current.pinging).toBe(false);
  });

  it("sets `pinging` true while a round is in flight and false when it settles", async () => {
    let resolveProbe: ((v: { status: string; ms: number }) => void) | undefined;
    mockInvoke.mockImplementation(
      (cmd: string) =>
        new Promise((resolve) => {
          if (cmd === "ping_config_endpoint") {
            resolveProbe = resolve as (v: { status: string; ms: number }) => void;
          } else {
            resolve(null);
          }
        }),
    );

    const { result } = renderHook(() => usePerConfigPing([{ id: "a", path: "/a.toml" }]));

    // Kick off a round WITHOUT awaiting it — the probe is still hanging, so `pinging` must be true.
    let round: Promise<void>;
    act(() => {
      round = result.current.refreshPings();
    });
    await waitFor(() => expect(result.current.pinging).toBe(true));

    // Resolve the probe → the round settles and the flag clears.
    await act(async () => {
      resolveProbe?.({ status: "ok", ms: 20 });
      await round;
    });
    expect(result.current.pinging).toBe(false);
    expect(result.current.pings.a?.band).toBe("green");
  });
});

describe("usePerConfigPing — PP-7 coalesced commit (render-count)", () => {
  it("commits the WHOLE round's bands in ONE setPings, not per-target (N=4)", async () => {
    // Four targets. The pre-PP-7 interval era wrote per-target on each resolution (2N+ pings-state
    // commits per round). PP-7 merges the whole round into a single setPings. We assert that the
    // `pings` object identity changes at most ONCE across the round — one merged commit, not four.
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ping_config_endpoint") return { status: "ok", ms: 42 };
      return null;
    });

    const FOUR: PingTarget[] = [
      { id: "a", path: "/a.toml" },
      { id: "b", path: "/b.toml" },
      { id: "c", path: "/c.toml" },
      { id: "d", path: "/d.toml" },
    ];

    // Track every distinct `pings` object reference the hook exposes. A per-target commit path would
    // produce a new reference per resolved target (4+); the coalesced path produces exactly one new
    // reference for the whole round (on top of the initial empty map).
    const seen: Array<Record<string, unknown>> = [];
    const { result } = renderHook(() => {
      const hook = usePerConfigPing(FOUR);
      if (seen[seen.length - 1] !== hook.pings) seen.push(hook.pings);
      return hook;
    });

    // Baseline: the initial empty map is the only reference so far.
    expect(seen.length).toBe(1);
    expect(result.current.pings).toEqual({});

    await act(async () => {
      await result.current.refreshPings();
    });

    // All four bands landed…
    expect(result.current.pings.a?.band).toBe("green");
    expect(result.current.pings.b?.band).toBe("green");
    expect(result.current.pings.c?.band).toBe("green");
    expect(result.current.pings.d?.band).toBe("green");

    // …in a SINGLE new `pings` reference (the coalesced commit) — so exactly 2 distinct references
    // total (initial empty + one merged round), regardless of the 4 targets. A per-target commit
    // would have pushed 4+ references. This is the PP-7 render-count guarantee.
    expect(seen.length).toBe(2);
  });
});

describe("usePerConfigPing — cancel-on-re-seed + WR-05 prune", () => {
  it("discards a round's result if the target set changes mid-flight (cancel-on-re-seed)", async () => {
    let resolveProbe: ((v: { status: string; ms: number }) => void) | undefined;
    mockInvoke.mockImplementation(
      (cmd: string) =>
        new Promise((resolve) => {
          if (cmd === "ping_config_endpoint") {
            resolveProbe = resolve as (v: { status: string; ms: number }) => void;
          } else {
            resolve(null);
          }
        }),
    );

    const { result, rerender } = renderHook(
      ({ targets }: { targets: PingTarget[] }) => usePerConfigPing(targets),
      { initialProps: { targets: [{ id: "a", path: "/a.toml" }] } },
    );

    // Start a round over the {a} set; the probe hangs.
    let round: Promise<void>;
    act(() => {
      round = result.current.refreshPings();
    });

    // Re-seed the target set (a leaves, c arrives) WHILE the {a} round is in flight → generation bumps.
    rerender({ targets: [{ id: "c", path: "/c.toml" }] });

    // Now resolve the hung {a} probe. Because the generation moved, the stale result must be DISCARDED
    // — 'a' is no longer a target and must not be painted.
    await act(async () => {
      resolveProbe?.({ status: "ok", ms: 10 });
      await round;
    });
    expect(result.current.pings.a).toBeUndefined();
  });

  it("WR-05: prunes a band for an id that leaves the target set", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ping_config_endpoint") return { status: "ok", ms: 10 };
      return null;
    });

    const { result, rerender } = renderHook(
      ({ targets }: { targets: PingTarget[] }) => usePerConfigPing(targets),
      {
        initialProps: {
          targets: [
            { id: "a", path: "/a.toml" },
            { id: "b", path: "/b.toml" },
          ] as PingTarget[],
        },
      },
    );

    // Populate both bands via a manual round.
    await act(async () => {
      await result.current.refreshPings();
    });
    expect(result.current.pings.a?.band).toBe("green");
    expect(result.current.pings.b?.band).toBe("green");

    // Drop 'b' from the target set → the prune effect removes its stale band, 'a' stays.
    rerender({ targets: [{ id: "a", path: "/a.toml" }] });
    await waitFor(() => {
      expect(result.current.pings.b).toBeUndefined();
      expect(result.current.pings.a?.band).toBe("green");
    });
  });

  it("does not throw when a hung probe resolves after unmount (cancel-safe)", async () => {
    let resolveProbe: ((v: { status: string; ms: number }) => void) | undefined;
    mockInvoke.mockImplementation(
      (cmd: string) =>
        new Promise((resolve) => {
          if (cmd === "ping_config_endpoint") {
            resolveProbe = resolve as (v: { status: string; ms: number }) => void;
          } else {
            resolve(null);
          }
        }),
    );

    const unhandled: PromiseRejectionEvent[] = [];
    const onUnhandled = (e: PromiseRejectionEvent) => unhandled.push(e);
    globalThis.addEventListener?.("unhandledrejection", onUnhandled);

    const { result, unmount } = renderHook(() =>
      usePerConfigPing([{ id: "a", path: "/a.toml" }]),
    );

    let round: Promise<void>;
    act(() => {
      round = result.current.refreshPings();
    });

    // Unmount mid-round (generation bumps), then let the hung probe resolve — the result is discarded
    // and no unhandled rejection leaks.
    unmount();
    await act(async () => {
      resolveProbe?.({ status: "ok", ms: 10 });
      await round;
      await Promise.resolve();
    });
    expect(unhandled).toHaveLength(0);
    globalThis.removeEventListener?.("unhandledrejection", onUnhandled);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Item 8 (30.1 milestone review) — «Обновить пинг» must never be left disabled
// with no round in flight.
//
// The round's `finally` block guarded BOTH the result write and the busy-flag clear
// on the same round-generation check. That guard is right for the write (a superseded
// round must not paint a band for an id that just left the list) and wrong for the
// flag: it hands the clear to "whichever round is now live", and since pinging became
// MANUAL-ONLY (D-16 — no mount ping, no interval) there is no successor round to
// inherit it. The button that starts a round is `disabled={pinging}`, so the flag it
// set wedged its own only trigger until the component remounted.
// ─────────────────────────────────────────────────────────────────────────
describe("usePerConfigPing — item 8 (30.1): a superseded round clears the flag it set", () => {
  it("clears `pinging` when the round is superseded mid-flight, while still writing NO result", async () => {
    let resolveProbe: ((v: { status: string; ms: number }) => void) | undefined;
    mockInvoke.mockImplementation(
      (cmd: string) =>
        new Promise((resolve) => {
          if (cmd === "ping_config_endpoint") {
            resolveProbe = resolve as (v: { status: string; ms: number }) => void;
          } else {
            resolve(null);
          }
        }),
    );

    const { result, rerender } = renderHook(
      ({ targets }: { targets: PingTarget[] }) => usePerConfigPing(targets),
      { initialProps: { targets: [{ id: "a", path: "/a.toml" }] } },
    );

    // Start a round over the {a} set; the probe hangs, so the flag is up and the button is held.
    let round: Promise<void>;
    act(() => {
      round = result.current.refreshPings();
    });
    await waitFor(() => expect(result.current.pinging).toBe(true));

    // Re-seed the target set while the {a} round is still in flight → the round is SUPERSEDED.
    // Nothing starts a replacement round: pinging is manual-only and the only manual trigger is
    // the button this very flag disables.
    rerender({ targets: [{ id: "c", path: "/c.toml" }] });

    await act(async () => {
      resolveProbe?.({ status: "ok", ms: 10 });
      await round;
    });

    // The round that RAISED the flag lowers it — no successor is required. Before the fix this
    // read `true` and «Обновить пинг» stayed disabled for the rest of the session.
    expect(result.current.pinging).toBe(false);
    // …and the cancel guard on the RESULT write is untouched: the superseded round still paints
    // nothing, for the departed id or the new one.
    expect(result.current.pings.a).toBeUndefined();
    expect(result.current.pings.c).toBeUndefined();
  });
});
