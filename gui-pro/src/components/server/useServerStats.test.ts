import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useServerStats, type ServerStats } from "./useServerStats";

const mockInvoke = vi.mocked(invoke) as unknown as Mock;

const mockSshParams = {
  host: "10.0.0.1",
  port: 22,
  user: "root",
  password: "pass",
  keyPath: undefined as string | undefined,
};

const mockStats: ServerStats = {
  cpu_percent: 35.5,
  load_1m: 0.5,
  load_5m: 0.6,
  load_15m: 0.7,
  mem_total: 8_000_000_000,
  mem_used: 4_000_000_000,
  disk_total: 50_000_000_000,
  disk_used: 20_000_000_000,
  unique_ips: 3,
  total_connections: 5,
  uptime_seconds: 90_061,
};

/**
 * Канонический helper из useDashboardState.test.ts:35-50.
 * Важно: использовать advanceTimersByTimeAsync с конкретным N,
 * НЕ runAllTimersAsync — у нас setInterval без условия остановки.
 */
async function settleAndTick() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
}

describe("useServerStats", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── D-01: Polling 10s ───
  it("polls server_get_stats every 10s when enabled", async () => {
    let callCount = 0;
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "server_get_stats") {
        callCount++;
        return mockStats as never;
      }
      return null as never;
    });

    renderHook(() => useServerStats(mockSshParams, { enabled: true }));

    await settleAndTick();
    expect(callCount).toBeGreaterThanOrEqual(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(callCount).toBeGreaterThanOrEqual(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  // ─── D-02: Visibility pause ───
  it("does NOT poll when enabled=false", async () => {
    let callCount = 0;
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "server_get_stats") {
        callCount++;
        return mockStats as never;
      }
      return null as never;
    });

    renderHook(() => useServerStats(mockSshParams, { enabled: false }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(callCount).toBe(0);
  });

  // ─── D-03: Stop on rebooting (enabled flip true→false) ───
  it("stops polling when enabled flips true to false", async () => {
    let callCount = 0;
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "server_get_stats") {
        callCount++;
        return mockStats as never;
      }
      return null as never;
    });

    const { rerender } = renderHook(
      ({ enabled }) => useServerStats(mockSshParams, { enabled }),
      { initialProps: { enabled: true } },
    );

    await settleAndTick();
    const afterStart = callCount;
    expect(afterStart).toBeGreaterThanOrEqual(1);

    rerender({ enabled: false });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(callCount).toBe(afterStart);
  });

  // ─── D-13: Exponential backoff ───
  it("applies exponential backoff after 3 consecutive failures (next tick at 60s, not 10s)", async () => {
    let callCount = 0;
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "server_get_stats") {
        callCount++;
        if (callCount <= 3) {
          throw new Error("SSH_TIMEOUT|10.0.0.1");
        }
        return mockStats as never;
      }
      return null as never;
    });

    renderHook(() => useServerStats(mockSshParams, { enabled: true }));

    // Tick 1 — IMMEDIATE fire on mount (Phase 13.UAT G-01 A: было через 10s, стало
    // immediate). Flush microtasks через advance(0). Result: fail, failureRef=1.
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(callCount).toBe(1);

    // Tick 2 — fail (10s позже, intervalMs default)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(callCount).toBe(2);

    // Tick 3 — после 2 fails backoff = 30s
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(callCount).toBe(3);

    // Теперь должен быть 60s pause. На 10s ничего не должно случиться.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(callCount).toBe(3);

    // На 60s от 3-го провала — должен сработать 4-й вызов (success).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(callCount).toBeGreaterThanOrEqual(4);
  });

  // ─── D-13: Reset failureCount on success ───
  it("resets failureCount to 0 on first success after failures", async () => {
    let callCount = 0;
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "server_get_stats") {
        callCount++;
        if (callCount <= 2) {
          throw new Error("SSH_TIMEOUT|10.0.0.1");
        }
        return mockStats as never;
      }
      return null as never;
    });

    const { result } = renderHook(() =>
      useServerStats(mockSshParams, { enabled: true }),
    );

    // 3 тика: 2 fail + 1 success
    await settleAndTick();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(result.current.failureCount).toBe(0);
    expect(result.current.stats).toEqual(mockStats);
    expect(result.current.error).toBeNull();
  });

  // ─── Error surface ───
  it("populates error state on invoke rejection", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "server_get_stats") {
        throw new Error("SSH_TIMEOUT|10.0.0.1");
      }
      return null as never;
    });

    const { result } = renderHook(() =>
      useServerStats(mockSshParams, { enabled: true }),
    );

    await settleAndTick();

    expect(result.current.error).not.toBeNull();
    expect(typeof result.current.error).toBe("string");
    expect(result.current.stats).toBeNull();
  });
});
