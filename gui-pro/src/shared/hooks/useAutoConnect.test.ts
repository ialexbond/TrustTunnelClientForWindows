import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAutoConnect } from "./useAutoConnect";
import type { VpnConfig } from "../types";

// Mock @tauri-apps/api/core
const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

const baseConfig: VpnConfig = {
  configPath: "/config.json",
  logLevel: "info",
} as VpnConfig;

const setStatus = vi.fn();
const setError = vi.fn();

const renderAutoConnect = () =>
  renderHook(() =>
    useAutoConnect({
      config: baseConfig,
      status: "disconnected",
      setStatus,
      setError,
    }),
  );

/** Drain the post-1500ms async poll/connect microtask chain under fake timers. */
const flush = async () => {
  // Run the 1500ms mount delay timer.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1600);
  });
  // Run any bounded poll-interval timers + their awaited probes.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(35_000);
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useAutoConnect — T-22 B3 boot guard", () => {
  it("does nothing when tt_auto_connect is not set", async () => {
    mockInvoke.mockResolvedValue(null);
    renderAutoConnect();
    await flush();
    expect(mockInvoke).not.toHaveBeenCalledWith("vpn_connect", expect.anything());
  });

  it("connects when the network is ready on the first probe", async () => {
    localStorage.setItem("tt_auto_connect", "true");
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "network_ready") return true;
      if (cmd === "vpn_connect") return null;
      return null;
    });

    renderAutoConnect();
    await flush();

    expect(mockInvoke).toHaveBeenCalledWith("network_ready");
    expect(mockInvoke).toHaveBeenCalledWith("vpn_connect", {
      configPath: "/config.json",
      logLevel: "info",
    });
  });

  it("WAITS while network_ready is false, then connects once it returns true (boot guard)", async () => {
    localStorage.setItem("tt_auto_connect", "true");
    let ready = false;
    const probeCalls: number[] = [];
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "network_ready") {
        probeCalls.push(Date.now());
        return ready;
      }
      if (cmd === "vpn_connect") return null;
      return null;
    });

    renderAutoConnect();

    // Fire the 1500ms mount delay → first probe runs, returns false → no connect yet.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(mockInvoke).not.toHaveBeenCalledWith("vpn_connect", expect.anything());

    // Network comes up; advance past one poll interval → next probe returns true.
    ready = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(probeCalls.length).toBeGreaterThanOrEqual(2);
    expect(mockInvoke).toHaveBeenCalledWith("vpn_connect", {
      configPath: "/config.json",
      logLevel: "info",
    });
  });

  it("connects anyway after the bounded budget if the network never comes up", async () => {
    localStorage.setItem("tt_auto_connect", "true");
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "network_ready") return false; // never ready
      if (cmd === "vpn_connect") return null;
      return null;
    });

    renderAutoConnect();
    await flush();

    // Captive-net philosophy: after the bounded wait it connects regardless.
    expect(mockInvoke).toHaveBeenCalledWith("vpn_connect", {
      configPath: "/config.json",
      logLevel: "info",
    });
  });

  it("proceeds immediately when the network_ready probe is unavailable (throws)", async () => {
    localStorage.setItem("tt_auto_connect", "true");
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "network_ready") throw new Error("unknown command");
      if (cmd === "vpn_connect") return null;
      return null;
    });

    renderAutoConnect();
    await flush();

    expect(mockInvoke).toHaveBeenCalledWith("vpn_connect", {
      configPath: "/config.json",
      logLevel: "info",
    });
  });
});
