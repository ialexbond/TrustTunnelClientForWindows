import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAutoConnect } from "./useAutoConnect";
import type { VpnConfig, VpnStatus } from "../types";

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

// AUDIT-2026-06-11 #15/#23: the harness now supports rerendering with a changed
// `status` (the live value App passes every render — feeds the hook's statusRef)
// and a changed `config` (whose configPath change cancels an in-flight wait).
const renderAutoConnect = (
  initialProps: { status: VpnStatus; config: VpnConfig } = {
    status: "disconnected",
    config: baseConfig,
  },
) =>
  renderHook(
    ({ status, config }: { status: VpnStatus; config: VpnConfig }) =>
      useAutoConnect({
        config,
        status,
        setStatus,
        setError,
      }),
    { initialProps },
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

describe("useAutoConnect — AUDIT-2026-06-11 #15 (live-status re-check, no stale closure)", () => {
  it("stands down when the mount snapshot restored a live status before the 1.5s timer fires", async () => {
    // Webview remount with a live tunnel: the snapshot restores "connected" within
    // ~100ms — well inside the 1.5s auto-connect delay. The old guard read `status`
    // from a stale closure (always the initial "disconnected"), so auto-connect fired
    // anyway, clobbered the green status with "connecting" and bounced off the backend
    // R8 «VPN is already running» guard into a STUCK error. The timer callback must
    // re-check the LIVE status (statusRef) and do nothing.
    localStorage.setItem("tt_auto_connect", "true");
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "network_ready") return true;
      if (cmd === "vpn_connect") return null;
      return null;
    });

    const { rerender } = renderAutoConnect();
    // Snapshot lands BEFORE the 1.5s timer: App re-renders with the live status.
    rerender({ status: "connected", config: baseConfig });

    await flush();

    expect(mockInvoke).not.toHaveBeenCalledWith("vpn_connect", expect.anything());
    // The optimistic "connecting" mark was never written — the green status survives.
    expect(setStatus).not.toHaveBeenCalledWith("connecting");
    expect(setStatus).not.toHaveBeenCalledWith("error");
  });

  it("aborts right before vpn_connect when the status went live DURING the network wait", async () => {
    // The second re-check point: the timer already fired (status "connecting" set
    // optimistically) and the bounded network wait is polling. A live vpn-status
    // event then lands "connected" (e.g. a tray connect / late snapshot). Firing
    // vpn_connect now would hit the backend R8 guard → stuck error. The pre-invoke
    // re-check must bail instead.
    localStorage.setItem("tt_auto_connect", "true");
    let ready = false;
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "network_ready") return ready;
      if (cmd === "vpn_connect") return null;
      return null;
    });

    const { rerender } = renderAutoConnect();

    // Timer fires → optimistic "connecting" + the wait loop starts (probe false).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(setStatus).toHaveBeenCalledWith("connecting");

    // A live event commits "connected" mid-wait; App re-renders with it.
    rerender({ status: "connected", config: baseConfig });

    // Network becomes ready → the wait loop exits → pre-invoke re-check must bail.
    ready = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(mockInvoke).not.toHaveBeenCalledWith("vpn_connect", expect.anything());
    expect(setStatus).not.toHaveBeenCalledWith("error");
  });

  it("still connects when the status stays 'disconnected' through the wait (no false stand-down)", async () => {
    // Regression guard for the re-checks themselves: a normal boot (status stays
    // disconnected, network comes up) must still auto-connect exactly as before.
    localStorage.setItem("tt_auto_connect", "true");
    let ready = false;
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "network_ready") return ready;
      if (cmd === "vpn_connect") return null;
      return null;
    });

    renderAutoConnect();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    ready = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(mockInvoke).toHaveBeenCalledWith("vpn_connect", {
      configPath: "/config.json",
      logLevel: "info",
    });
  });
});

describe("useAutoConnect — AUDIT-2026-06-11 #23 (cancel mid-wait rolls back the optimistic 'connecting')", () => {
  it("rolls 'connecting' back to 'disconnected' when cancelled during the network wait", async () => {
    // T-22 B3 boot scenario: timer fired → optimistic "connecting" shown, network not
    // ready yet (wait loop polling). The config path then changes (e.g. the watched
    // config file disappears → useConfigLifecycle clears it) → the effect cleanup
    // cancels the wait. vpn_connect was never invoked, so NO backend event will ever
    // correct the optimistic "connecting" — the old code left it on screen forever.
    // The cancelled exit must roll back our own mark (functional updater).
    localStorage.setItem("tt_auto_connect", "true");
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "network_ready") return false; // never ready → keeps polling
      if (cmd === "vpn_connect") return null;
      return null;
    });

    const { rerender } = renderAutoConnect();

    // Timer fires → optimistic "connecting", wait loop starts polling.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(setStatus).toHaveBeenCalledWith("connecting");
    setStatus.mockClear();

    // The config path changes → effect deps change → cleanup sets cancelled=true.
    rerender({ status: "connecting", config: { ...baseConfig, configPath: "" } });

    // Let the in-flight wait loop wake (≤1s poll sleep) and hit the cancelled exit.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    // vpn_connect must never have fired …
    expect(mockInvoke).not.toHaveBeenCalledWith("vpn_connect", expect.anything());
    // … and the rollback is a FUNCTIONAL updater that only undoes our own mark:
    // "connecting" → "disconnected", but any backend-owned status passes through.
    const updaterCalls = setStatus.mock.calls.filter(
      (c) => typeof c[0] === "function",
    );
    expect(updaterCalls.length).toBeGreaterThanOrEqual(1);
    const updater = updaterCalls[updaterCalls.length - 1][0] as (
      s: VpnStatus,
    ) => VpnStatus;
    expect(updater("connecting")).toBe("disconnected");
    expect(updater("connected")).toBe("connected");
    expect(updater("reconnecting")).toBe("reconnecting");
  });

  it("does NOT roll back when the connect already fired (backend owns the status)", async () => {
    // If cancellation happens AFTER vpn_connect was invoked, the backend is emitting
    // its own vpn-status events — the frontend must not second-guess them. The
    // cancelled rollback only exists on the pre-invoke path.
    localStorage.setItem("tt_auto_connect", "true");
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "network_ready") return true; // ready at once → connect fires
      if (cmd === "vpn_connect") return null;
      return null;
    });

    const { rerender } = renderAutoConnect();
    await flush();
    expect(mockInvoke).toHaveBeenCalledWith("vpn_connect", expect.anything());
    setStatus.mockClear();

    // Cancel after the fact (config path cleared) — nothing to roll back.
    rerender({ status: "connecting", config: { ...baseConfig, configPath: "" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(setStatus).not.toHaveBeenCalled();
  });
});
