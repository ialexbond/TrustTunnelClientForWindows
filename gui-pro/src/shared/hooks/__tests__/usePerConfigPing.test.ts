import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import {
  usePerConfigPing,
  PING_INTERVAL_MS,
  type PingTarget,
} from "../usePerConfigPing";

// `@tauri-apps/api/core` invoke is globally mocked in src/test/tauri-mock.ts. We set the
// resolved value per-test to drive the `ping_config_endpoint` command.

const targets: PingTarget[] = [
  { id: "cfg-de", path: "C:/app/TrustTunnel_swift-fox.toml" },
  { id: "cfg-nl", path: "C:/app/TrustTunnel_bold-eagle.toml" },
];

describe("usePerConfigPing", () => {
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

  // Truth: the hook pings every inactive config on mount and resolves its band.
  it("pings each config on mount and maps the result to a band", async () => {
    const { result } = renderHook(() => usePerConfigPing(targets));

    // Flush the initial pingAll round (microtasks).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // ping_config_endpoint invoked once per target with its path + a timeout.
    expect(invoke).toHaveBeenCalledWith(
      "ping_config_endpoint",
      expect.objectContaining({ configPath: targets[0].path }),
    );
    expect(invoke).toHaveBeenCalledWith(
      "ping_config_endpoint",
      expect.objectContaining({ configPath: targets[1].path }),
    );
    // 42 ms → green band with the numeric value.
    expect(result.current["cfg-de"]).toMatchObject({ band: "green", valueMs: 42 });
    expect(result.current["cfg-nl"]).toMatchObject({ band: "green", valueMs: 42 });
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
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current["cfg"]).toMatchObject({ band, valueMs: ms });
      unmount();
    }
  });

  // Truth: the hook re-pings on the 15 s interval (D-23).
  it("re-pings on the interval", async () => {
    renderHook(() => usePerConfigPing(targets));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const afterFirst = vi.mocked(invoke).mock.calls.length;
    expect(afterFirst).toBe(2); // one per target

    // Advance one full interval → a second round fires.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    });
    expect(vi.mocked(invoke).mock.calls.length).toBe(afterFirst + 2);
  });

  // Truth: an unreachable result maps to the timeout band («Недоступен»), no-data to «—».
  it("maps unreachable → timeout and no-data → no-data", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce({ status: "unreachable" })
      .mockResolvedValueOnce({ status: "no-data" });
    const { result } = renderHook(() => usePerConfigPing(targets));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current["cfg-de"]).toMatchObject({ band: "timeout" });
    expect(result.current["cfg-nl"]).toMatchObject({ band: "no-data" });
  });

  // Truth: a failed invoke degrades to no-data «—» (never red), not a crash.
  it("a failed probe degrades to no-data", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("backend gone"));
    const { result } = renderHook(() => usePerConfigPing(targets));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current["cfg-de"]).toMatchObject({ band: "no-data" });
    expect(result.current["cfg-nl"]).toMatchObject({ band: "no-data" });
  });

  // Truth: on unmount the loop is cancelled — no further pings fire after the next interval.
  it("stops pinging on unmount", async () => {
    const { unmount } = renderHook(() => usePerConfigPing(targets));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const afterFirst = vi.mocked(invoke).mock.calls.length;

    unmount();

    // Advance several intervals — no new pings after unmount.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 3);
    });
    expect(vi.mocked(invoke).mock.calls.length).toBe(afterFirst);
  });

  // Truth: a simulated StrictMode double-mount does not double-fire the interval. Two
  // hook instances with the SAME target set must not start two interleaved loops that
  // double the per-tick probe count.
  it("does not double-fire under a simulated double-mount", async () => {
    // Render twice with the same target identity to emulate StrictMode's mount/remount.
    const first = renderHook(() => usePerConfigPing(targets));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    first.unmount();
    const second = renderHook(() => usePerConfigPing(targets));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // After the second mount's first round, the total is the first mount's 2 + the second
    // mount's 2 — never 4 in a single tick from one mount (the once-guard prevents a
    // single instance from launching two interleaved loops).
    const total = vi.mocked(invoke).mock.calls.length;
    // One round per mount = 2 targets each = 4 total; the key assertion is that a single
    // advance(0) after the second mount produced exactly 2 NEW calls, not 4.
    expect(total).toBe(4);
    second.unmount();
  });
});
