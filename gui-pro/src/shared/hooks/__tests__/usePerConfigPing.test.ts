import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { usePerConfigPing, type PingTarget } from "../usePerConfigPing";

// `@tauri-apps/api/core` invoke is globally mocked in src/test/tauri-mock.ts. We set the
// resolved value per-test to drive the `ping_config_endpoint` command.

const targets: PingTarget[] = [
  { id: "cfg-de", path: "C:/app/TrustTunnel_swift-fox.toml" },
  { id: "cfg-nl", path: "C:/app/TrustTunnel_bold-eagle.toml" },
];

describe("usePerConfigPing (manual refresh — no auto ping)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Default: a reachable endpoint (42 ms → green band).
    vi.mocked(invoke).mockResolvedValue({ status: "ok", ms: 42 });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  // Truth (owner's decision): the ping loop is MANUAL. Nothing fires on mount and there is no
  // interval — the map stays empty and NO `ping_config_endpoint` is invoked until refreshPings runs.
  it("does NOT ping on mount — the map is empty and invoke is never called", async () => {
    const { result } = renderHook(() => usePerConfigPing(targets));

    // Flush any microtasks a mount might have scheduled.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
    expect(result.current.pings).toEqual({});
    expect(result.current.pinging).toBe(false);
  });

  // Truth: NO interval — advancing time (well past the former 15 s cadence) fires zero pings while
  // no manual round was requested.
  it("does NOT ping on any interval — advancing time fires nothing", async () => {
    renderHook(() => usePerConfigPing(targets));

    await act(async () => {
      // Advance far beyond the old 15 s cadence — still zero pings without a manual trigger.
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
  });

  // Truth: refreshPings runs EXACTLY ONE round — one invoke per target — and maps each result to a band.
  it("refreshPings pings each config once and maps the result to a band", async () => {
    const { result } = renderHook(() => usePerConfigPing(targets));

    await act(async () => {
      await result.current.refreshPings();
    });

    // ping_config_endpoint invoked exactly once per target with its path + a timeout — one round only.
    expect(vi.mocked(invoke).mock.calls.length).toBe(2);
    expect(invoke).toHaveBeenCalledWith(
      "ping_config_endpoint",
      expect.objectContaining({ configPath: targets[0].path }),
    );
    expect(invoke).toHaveBeenCalledWith(
      "ping_config_endpoint",
      expect.objectContaining({ configPath: targets[1].path }),
    );
    // 42 ms → green band with the numeric value.
    expect(result.current.pings["cfg-de"]).toMatchObject({ band: "green", valueMs: 42 });
    expect(result.current.pings["cfg-nl"]).toMatchObject({ band: "green", valueMs: 42 });
  });

  // Truth: each refreshPings is ONE round — two clicks fire two rounds (2 invokes each), never a
  // self-scheduling loop that keeps firing on its own.
  it("each refreshPings call is exactly one round (no self-rescheduling)", async () => {
    const { result } = renderHook(() => usePerConfigPing(targets));

    await act(async () => {
      await result.current.refreshPings();
    });
    expect(vi.mocked(invoke).mock.calls.length).toBe(2);

    // Advancing time between rounds fires nothing on its own.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(vi.mocked(invoke).mock.calls.length).toBe(2);

    // A second manual round adds exactly one more round (2 more invokes).
    await act(async () => {
      await result.current.refreshPings();
    });
    expect(vi.mocked(invoke).mock.calls.length).toBe(4);
  });

  // Truth (IN-22): owner-set colour bands — ≤150 green, 151–300 yellow, >300 red. Lock the
  // exact boundaries so a future edit can't silently drift the green/yellow/red cutoffs.
  it("maps ms to the IN-22 colour bands at the 150/300 boundaries", async () => {
    const one: PingTarget[] = [{ id: "cfg", path: "C:/app/x.toml" }];
    const cases: Array<[number, string]> = [
      [150, "green"],
      [151, "yellow"],
      [300, "yellow"],
      [301, "red"],
    ];
    for (const [ms, band] of cases) {
      vi.mocked(invoke).mockResolvedValue({ status: "ok", ms });
      const { result, unmount } = renderHook(() => usePerConfigPing(one));
      await act(async () => {
        await result.current.refreshPings();
      });
      expect(result.current.pings["cfg"]).toMatchObject({ band, valueMs: ms });
      unmount();
    }
  });

  // Truth: an unreachable result maps to the timeout band («Недоступен»), no-data to «—».
  it("maps unreachable → timeout and no-data → no-data", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce({ status: "unreachable" })
      .mockResolvedValueOnce({ status: "no-data" });
    const { result } = renderHook(() => usePerConfigPing(targets));

    await act(async () => {
      await result.current.refreshPings();
    });

    expect(result.current.pings["cfg-de"]).toMatchObject({ band: "timeout" });
    expect(result.current.pings["cfg-nl"]).toMatchObject({ band: "no-data" });
  });

  // Truth: a failed invoke degrades to no-data «—» (never red), not a crash.
  it("a failed probe degrades to no-data", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("backend gone"));
    const { result } = renderHook(() => usePerConfigPing(targets));

    await act(async () => {
      await result.current.refreshPings();
    });

    expect(result.current.pings["cfg-de"]).toMatchObject({ band: "no-data" });
    expect(result.current.pings["cfg-nl"]).toMatchObject({ band: "no-data" });
  });

  // Truth: an EMPTY target set is a no-op — refreshPings pings nothing and does not flip `pinging`.
  it("refreshPings on an empty target set is a no-op", async () => {
    const { result } = renderHook(() => usePerConfigPing([]));
    await act(async () => {
      await result.current.refreshPings();
    });
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
    expect(result.current.pings).toEqual({});
  });
});
