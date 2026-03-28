import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useDashboardState } from "./useDashboardState";
import type { ClientConfig } from "../settings/useSettingsState";

const mockedInvoke = vi.mocked(invoke);

const fakeConfig: ClientConfig = {
  loglevel: "info",
  vpn_mode: "tun",
  killswitch_enabled: false,
  post_quantum_group_enabled: false,
  endpoint: {
    hostname: "vpn.example.com:443",
    addresses: ["1.2.3.4"],
    upstream_protocol: "tcp",
    anti_dpi: false,
    skip_verification: false,
    custom_sni: "",
    has_ipv6: false,
    username: "user",
    password: "pass",
  },
  listener: {
    tun: {
      mtu_size: 1400,
      change_system_dns: true,
      included_routes: [],
      excluded_routes: [],
    },
  },
};

/**
 * Let config load resolve (sets endpointRef), then advance one interval
 * tick so the first real ping fires.  Uses advanceTimersByTimeAsync which
 * interleaves microtask flushing with timer advancement — avoids the
 * infinite-loop that runAllTimersAsync causes with setInterval.
 */
async function settleAndTick() {
  // 1) flush the config-load promise so endpointRef is populated
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  // 2) advance past one interval period so doPing runs with valid endpointRef
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
}

describe("useDashboardState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockedInvoke.mockResolvedValue(null as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── Initial state ───
  it("returns initial state with null clientConfig, empty pingHistory", () => {
    const { result } = renderHook(() =>
      useDashboardState("disconnected", "", null),
    );

    expect(result.current.clientConfig).toBeNull();
    expect(result.current.pingHistory).toEqual([]);
    expect(result.current.currentPing).toBeNull();
    expect(result.current.avgPing).toBeNull();
    expect(result.current.speed).toBeNull();
    expect(result.current.speedTesting).toBe(false);
    expect(result.current.speedError).toBeNull();
    expect(result.current.recoveryCount).toBe(0);
    expect(result.current.errorCount).toBe(0);
  });

  // ─── Load config ───
  it("loads clientConfig when configPath is provided", async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return fakeConfig as never;
      return null as never;
    });

    const { result } = renderHook(() =>
      useDashboardState("disconnected", "/path/to/config.toml", null),
    );

    // No interval when disconnected, so runAllTimersAsync is safe
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(mockedInvoke).toHaveBeenCalledWith("read_client_config", {
      configPath: "/path/to/config.toml",
    });
    expect(result.current.clientConfig).toEqual(fakeConfig);
  });

  // ─── Speed test success ───
  it("runSpeedTest sets speedTesting=true, calls invoke, updates speed result", async () => {
    const speedResult = { download_mbps: 50.5, upload_mbps: 20.3 };
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return fakeConfig as never;
      if (cmd === "speedtest_run") return speedResult as never;
      if (cmd === "ping_endpoint") return 10 as never;
      return null as never;
    });

    const { result } = renderHook(() =>
      useDashboardState("connected", "/path/config.toml", new Date()),
    );

    await settleAndTick();

    // Run speed test
    let speedTestPromise: Promise<void>;
    act(() => {
      speedTestPromise = result.current.runSpeedTest() as unknown as Promise<void>;
    });

    expect(result.current.speedTesting).toBe(true);

    await act(async () => {
      await speedTestPromise;
    });

    expect(result.current.speedTesting).toBe(false);
    expect(result.current.speed).not.toBeNull();
    expect(result.current.speed!.download_mbps).toBe(50.5);
    expect(result.current.speed!.upload_mbps).toBe(20.3);
    expect(result.current.speed!.timestamp).toBeGreaterThan(0);
    expect(mockedInvoke).toHaveBeenCalledWith("speedtest_run");
  });

  // ─── Speed test error ───
  it("speed test error sets speedError", async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return fakeConfig as never;
      if (cmd === "speedtest_run") throw new Error("network timeout");
      if (cmd === "ping_endpoint") return 10 as never;
      return null as never;
    });

    const { result } = renderHook(() =>
      useDashboardState("connected", "/path/config.toml", new Date()),
    );

    await settleAndTick();

    await act(async () => {
      await (result.current.runSpeedTest() as unknown as Promise<void>);
    });

    expect(result.current.speedTesting).toBe(false);
    expect(result.current.speedError).toBe("Error: network timeout");
  });

  // ─── Connected status triggers ping polling ───
  it("starts ping polling when connected", async () => {
    let pingCallCount = 0;
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return fakeConfig as never;
      if (cmd === "ping_endpoint") {
        pingCallCount++;
        return 42 as never;
      }
      return null as never;
    });

    const { result } = renderHook(() =>
      useDashboardState("connected", "/path/config.toml", new Date()),
    );

    // Config loads -> endpointRef set, first interval tick fires doPing
    await settleAndTick();

    expect(pingCallCount).toBeGreaterThanOrEqual(1);
    expect(result.current.currentPing).toBe(42);
    expect(result.current.pingHistory.length).toBeGreaterThanOrEqual(1);
    expect(result.current.pingHistory[0].ping).toBe(42);

    // Advance another 10s for next ping tick
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(pingCallCount).toBeGreaterThanOrEqual(2);
  });

  // ─── Disconnect clears ping data ───
  it("clears ping data, speed, and counters on disconnect", async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return fakeConfig as never;
      if (cmd === "ping_endpoint") return 55 as never;
      return null as never;
    });

    const { result, rerender } = renderHook(
      ({ status }: { status: string }) =>
        useDashboardState(status as "connected" | "disconnected", "/path/config.toml", new Date()),
      { initialProps: { status: "connected" } },
    );

    await settleAndTick();

    expect(result.current.pingHistory.length).toBeGreaterThanOrEqual(1);

    // Now disconnect
    rerender({ status: "disconnected" });

    expect(result.current.pingHistory).toEqual([]);
    expect(result.current.currentPing).toBeNull();
    expect(result.current.speed).toBeNull();
    expect(result.current.recoveryCount).toBe(0);
    expect(result.current.errorCount).toBe(0);
  });

  // ─── avgPing calculation ───
  it("calculates avgPing from pingHistory", async () => {
    let pingIndex = 0;
    const pings = [10, 20, 30];
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return fakeConfig as never;
      if (cmd === "ping_endpoint") {
        const val = pings[pingIndex] ?? 30;
        pingIndex++;
        return val as never;
      }
      return null as never;
    });

    const { result } = renderHook(() =>
      useDashboardState("connected", "/path/config.toml", new Date()),
    );

    // First ping after config loads + first interval tick
    await settleAndTick();

    // 2nd ping
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    // 3rd ping
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(result.current.pingHistory.length).toBeGreaterThanOrEqual(3);
    // avg of 10, 20, 30 = 20
    expect(result.current.avgPing).toBe(20);
  });

  // ─── Recovery and error counting ───
  it("increments recoveryCount on recovering status", () => {
    const { result, rerender } = renderHook(
      ({ status }: { status: string }) =>
        useDashboardState(status as "connected" | "recovering", "/path/config.toml", null),
      { initialProps: { status: "connected" } },
    );

    rerender({ status: "recovering" });
    expect(result.current.recoveryCount).toBe(1);
  });

  it("increments errorCount on error status", () => {
    const { result, rerender } = renderHook(
      ({ status }: { status: string }) =>
        useDashboardState(status as "connected" | "error", "/path/config.toml", null),
      { initialProps: { status: "connected" } },
    );

    rerender({ status: "error" });
    expect(result.current.errorCount).toBe(1);
  });
});
