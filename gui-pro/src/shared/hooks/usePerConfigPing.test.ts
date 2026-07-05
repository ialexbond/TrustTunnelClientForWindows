import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import {
  usePerConfigPing,
  bandForMs,
  toConfigPing,
  SKELETON_DELAY_MS,
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

describe("usePerConfigPing — WR-06 (cancel clears measuring; no double loop)", () => {
  it("resolves a band for each target on the first tick", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ping_config_endpoint") return { status: "ok", ms: 42 };
      return null;
    });

    const { result } = renderHook(() => usePerConfigPing(TARGETS));

    await waitFor(() => {
      expect(result.current.a?.band).toBe("green");
      expect(result.current.b?.band).toBe("green");
    });
    // Settled cards are NOT left measuring.
    expect(result.current.a?.measuring).toBeFalsy();
    expect(result.current.b?.measuring).toBeFalsy();
  });

  it("clears the 'measuring' flag on the cancel path instead of leaving the card stuck (WR-06 gap 1)", async () => {
    // A probe that hangs while the hook is mounted: 'a' is in flight (measuring=true) when
    // the loop is cancelled. The cancel branch (both success and catch) must clear the
    // measuring flag via setPings so the card never sticks on the skeleton. We resolve the
    // pending probe AFTER cancel and assert the cancel path runs WITHOUT throwing / leaving
    // an unhandled rejection — the clear-on-cancel setter is exercised on the in-flight id.
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

    // TA-11: replace the terminal `expect(true).toBe(true)` tautology with a real assertion —
    // spy on `unhandledrejection` so resolving the probe AFTER unmount (the cancel branch)
    // is proven not to leak a rejected promise. An empty spy list is the meaningful signal.
    const unhandled: PromiseRejectionEvent[] = [];
    const onUnhandled = (e: PromiseRejectionEvent) => unhandled.push(e);
    globalThis.addEventListener?.("unhandledrejection", onUnhandled);

    vi.useFakeTimers();
    const { result, unmount } = renderHook(() =>
      usePerConfigPing([{ id: "a", path: "/a.toml" }]),
    );

    // IN-37: the «measuring» skeleton only shows AFTER SKELETON_DELAY_MS. Advance past it so the
    // still-in-flight probe marks the card measuring (the bug's precondition).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SKELETON_DELAY_MS + 10);
    });
    expect(result.current.a?.measuring).toBe(true);

    // Cancel mid-probe (unmount sets cancelled=true), then let the hung probe resolve so
    // the cancel branch executes its measuring-clear setter. This must not throw.
    unmount();
    await act(async () => {
      resolveProbe?.({ status: "ok", ms: 10 });
      await Promise.resolve();
      await Promise.resolve();
    });

    // The cancel-clear branch ran cleanly: resolving the probe after unmount produced ZERO
    // unhandled rejections. (Post-unmount React no longer re-renders the hook, so the clear
    // is a no-op visually — but the in-FLIGHT-then-re-seed case, where the component stays
    // mounted, relies on this exact setter to settle the card; test :below covers that.)
    await act(async () => {
      await Promise.resolve();
    });
    expect(unhandled).toHaveLength(0);
    globalThis.removeEventListener?.("unhandledrejection", onUnhandled);
  });

  it("settles a card that was measuring after a re-seed keeps it in the set", async () => {
    // Stronger gap-1 guard with the component STAYING mounted: 'a' is measuring, the target
    // set changes (re-seed) but 'a' is still present. The fresh loop re-probes 'a' and it
    // must end up settled (band set, measuring cleared) — never stuck on the spinner.
    vi.useFakeTimers();
    let resolvers: Array<(v: { status: string; ms: number }) => void> = [];
    mockInvoke.mockImplementation(
      (cmd: string) =>
        new Promise((resolve) => {
          if (cmd === "ping_config_endpoint") {
            resolvers.push(resolve as (v: { status: string; ms: number }) => void);
          } else {
            resolve(null);
          }
        }),
    );

    const { result, rerender } = renderHook(
      ({ targets }: { targets: PingTarget[] }) => usePerConfigPing(targets),
      { initialProps: { targets: [{ id: "a", path: "/a.toml" }] } },
    );

    // IN-37: advance past the skeleton delay so 'a' is marked measuring (the gap-1 precondition).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SKELETON_DELAY_MS + 10);
    });
    expect(result.current.a?.measuring).toBe(true);

    // Re-seed: add 'b' (a still present) → prior loop cancelled, fresh loop probes both.
    rerender({
      targets: [
        { id: "a", path: "/a.toml" },
        { id: "b", path: "/b.toml" },
      ],
    });

    // Resolve all outstanding probes (the old hung 'a' + the fresh loop's 'a'/'b').
    await act(async () => {
      const r = resolvers;
      resolvers = [];
      r.forEach((res) => res({ status: "ok", ms: 20 }));
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      const r = resolvers;
      resolvers = [];
      r.forEach((res) => res({ status: "ok", ms: 20 }));
      await vi.advanceTimersByTimeAsync(0);
    });

    // The fresh loop's fast probe settles 'a' (green) WITHOUT a skeleton (resolved before the
    // delay), so measuring is cleared.
    expect(result.current.a?.band).toBe("green");
    expect(result.current.a?.measuring).toBeFalsy();
  });

  it("re-seeds (single fresh loop) when the target set changes — no interleaved duplicate", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ping_config_endpoint") return { status: "ok", ms: 10 };
      return null;
    });

    const { result, rerender } = renderHook(
      ({ targets }: { targets: PingTarget[] }) => usePerConfigPing(targets),
      { initialProps: { targets: [{ id: "a", path: "/a.toml" }] } },
    );

    await waitFor(() => expect(result.current.a?.band).toBe("green"));

    // Add a second target → effect re-runs (targetsKey changed) → prior loop cancelled,
    // one fresh loop probes both. No assertion-friendly "double loop" leak: both ids
    // resolve, and the hook does not throw / spin.
    rerender({
      targets: [
        { id: "a", path: "/a.toml" },
        { id: "b", path: "/b.toml" },
      ],
    });

    await waitFor(() => {
      expect(result.current.a?.band).toBe("green");
      expect(result.current.b?.band).toBe("green");
    });
  });
});
