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

// Phase 11 (P11-03): the auto-connect target is now the MANIFEST's last-used config,
// resolved via list_configs — NOT config.configPath. Most tests mock list_configs to
// return this single entry whose path matches the legacy "/config.json" so the existing
// connect-target assertions still read "/config.json" (now sourced from the manifest).
const LAST_USED_LIST = [
  { id: "id-1", path: "/config.json", last_used: true },
];

const setStatus = vi.fn();
const setError = vi.fn();
// F29: the freeze-cache seed callback the hook calls with the honest launch ping (path, ms).
const seedConfigPing = vi.fn();

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
        seedConfigPing,
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
      if (cmd === "list_configs") return LAST_USED_LIST;
      return null;
    });

    renderAutoConnect();
    await flush();

    expect(mockInvoke).toHaveBeenCalledWith("network_ready");
    expect(mockInvoke).toHaveBeenCalledWith("vpn_connect", {
      configPath: "/config.json",
      logLevel: "info",
    });
    // Phase 13 (Pitfall 2): the launch auto-connect marks the AutoConnectLaunch origin so the next
    // Rust `Connected` edge emits «Автоподключение при запуске» (camelCase serde wire value).
    expect(mockInvoke).toHaveBeenCalledWith("set_pending_connect_origin", {
      origin: "autoConnectLaunch",
    });
  });

  it("marks the AutoConnectLaunch origin in Rust right BEFORE vpn_connect (Phase 13, Pitfall 2)", async () => {
    localStorage.setItem("tt_auto_connect", "true");
    // Record, at the moment vpn_connect is invoked, whether the origin mark already fired — proving
    // the mark PRECEDES the launch connect (and only the guarded launch path, not a manual connect).
    let originMarkedBeforeConnect = false;
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "network_ready") return true;
      if (cmd === "list_configs") return LAST_USED_LIST;
      if (cmd === "vpn_connect") {
        originMarkedBeforeConnect = mockInvoke.mock.calls.some(
          (c) =>
            c[0] === "set_pending_connect_origin" &&
            (c[1] as { origin?: string })?.origin === "autoConnectLaunch",
        );
        return null;
      }
      return null;
    });

    renderAutoConnect();
    await flush();

    expect(mockInvoke).toHaveBeenCalledWith("vpn_connect", {
      configPath: "/config.json",
      logLevel: "info",
    });
    expect(originMarkedBeforeConnect).toBe(true);
  });

  it("measures the launch reachability ping and pushes the ms when ok (Phase 13, 13-09 Fix 1)", async () => {
    localStorage.setItem("tt_auto_connect", "true");
    // 13-09 Fix 1: at LAUNCH the last-used config is still DISCONNECTED, so ping_config_endpoint
    // measures a REAL reachability number. An `ok` result must push its ms (the plate shows a
    // number instead of «—»). Also record, at the moment vpn_connect fires, whether the ping push
    // already happened, proving it PRECEDES the connect (mirrors the origin push).
    let pingPushedBeforeConnect = false;
    mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "network_ready") return true;
      if (cmd === "list_configs") return LAST_USED_LIST;
      if (cmd === "ping_config_endpoint") {
        // Probe the resolved last-used config path with a short timeout.
        expect(args).toEqual({ configPath: "/config.json", timeoutMs: 1500 });
        return { status: "ok", ms: 42 };
      }
      if (cmd === "vpn_connect") {
        pingPushedBeforeConnect = mockInvoke.mock.calls.some(
          (c) =>
            c[0] === "set_pending_connect_ping" &&
            (c[1] as { ms?: number | null })?.ms === 42,
        );
        return null;
      }
      return null;
    });

    renderAutoConnect();
    await flush();

    expect(mockInvoke).toHaveBeenCalledWith("ping_config_endpoint", {
      configPath: "/config.json",
      timeoutMs: 1500,
    });
    expect(mockInvoke).toHaveBeenCalledWith("set_pending_connect_ping", { ms: 42 });
    expect(pingPushedBeforeConnect).toBe(true);
  });

  it("F29: seeds the freeze cache with the launch ping (path, ms) when the probe is ok", async () => {
    localStorage.setItem("tt_auto_connect", "true");
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "network_ready") return true;
      if (cmd === "list_configs") return LAST_USED_LIST;
      if (cmd === "ping_config_endpoint") return { status: "ok", ms: 58 };
      if (cmd === "vpn_connect") return null;
      return null;
    });

    renderAutoConnect();
    await flush();

    // The honest launch ping is delivered to the card freeze cache (not just the notification plate).
    expect(seedConfigPing).toHaveBeenCalledWith("/config.json", 58);
  });

  it("F29: does NOT seed the freeze cache when the launch probe is not ok (never a fabricated number)", async () => {
    localStorage.setItem("tt_auto_connect", "true");
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "network_ready") return true;
      if (cmd === "list_configs") return LAST_USED_LIST;
      if (cmd === "ping_config_endpoint") return { status: "unreachable" };
      if (cmd === "vpn_connect") return null;
      return null;
    });

    renderAutoConnect();
    await flush();

    expect(seedConfigPing).not.toHaveBeenCalled();
  });

  it("pushes null when the launch reachability probe is unreachable (Phase 13, 13-09 Fix 1)", async () => {
    localStorage.setItem("tt_auto_connect", "true");
    // A filtered/closed endpoint reads Unreachable → push null so the plate honestly shows «—».
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "network_ready") return true;
      if (cmd === "list_configs") return LAST_USED_LIST;
      if (cmd === "ping_config_endpoint") return { status: "unreachable" };
      if (cmd === "vpn_connect") return null;
      return null;
    });

    renderAutoConnect();
    await flush();

    expect(mockInvoke).toHaveBeenCalledWith("set_pending_connect_ping", { ms: null });
    expect(mockInvoke).toHaveBeenCalledWith("vpn_connect", {
      configPath: "/config.json",
      logLevel: "info",
    });
  });

  it("pushes null when the launch reachability probe returns no-data (Phase 13, 13-09 Fix 1)", async () => {
    localStorage.setItem("tt_auto_connect", "true");
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "network_ready") return true;
      if (cmd === "list_configs") return LAST_USED_LIST;
      if (cmd === "ping_config_endpoint") return { status: "no-data" };
      if (cmd === "vpn_connect") return null;
      return null;
    });

    renderAutoConnect();
    await flush();

    expect(mockInvoke).toHaveBeenCalledWith("set_pending_connect_ping", { ms: null });
  });

  it("pushes null and still connects when the launch reachability probe throws (Phase 13, 13-09 Fix 1)", async () => {
    localStorage.setItem("tt_auto_connect", "true");
    // Older backend / unavailable probe → the try/catch pushes null and the connect proceeds.
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "network_ready") return true;
      if (cmd === "list_configs") return LAST_USED_LIST;
      if (cmd === "ping_config_endpoint") throw new Error("unknown command");
      if (cmd === "vpn_connect") return null;
      return null;
    });

    renderAutoConnect();
    await flush();

    expect(mockInvoke).toHaveBeenCalledWith("set_pending_connect_ping", { ms: null });
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
      if (cmd === "list_configs") return LAST_USED_LIST;
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
      if (cmd === "list_configs") return LAST_USED_LIST;
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
      if (cmd === "list_configs") return LAST_USED_LIST;
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
      if (cmd === "list_configs") return LAST_USED_LIST;
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
      if (cmd === "list_configs") return LAST_USED_LIST;
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
      if (cmd === "list_configs") return LAST_USED_LIST;
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
      if (cmd === "list_configs") return LAST_USED_LIST;
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
      if (cmd === "list_configs") return LAST_USED_LIST;
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

describe("useAutoConnect — Phase 11 (P11-03 / D-05): targets the manifest last-used config", () => {
  it("connects to the manifest LAST-USED path, NOT config.configPath", async () => {
    // The manifest last-used config is a DIFFERENT file than the app-level
    // config.configPath — proving the target is sourced from list_configs, not the
    // single config path. The list also carries a non-last-used entry that must be
    // ignored.
    localStorage.setItem("tt_auto_connect", "true");
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "network_ready") return true;
      if (cmd === "vpn_connect") return null;
      if (cmd === "list_configs") {
        return [
          { id: "id-other", path: "/other.json", last_used: false },
          { id: "id-last", path: "/last-used.json", last_used: true },
        ];
      }
      return null;
    });

    renderAutoConnect();
    await flush();

    // Connected the manifest last-used path — NOT the app-level "/config.json".
    expect(mockInvoke).toHaveBeenCalledWith("vpn_connect", {
      configPath: "/last-used.json",
      logLevel: "info",
    });
    expect(mockInvoke).not.toHaveBeenCalledWith("vpn_connect", {
      configPath: "/config.json",
      logLevel: "info",
    });
  });

  it("does NOT connect when the manifest has NO last-used config (clean no-op)", async () => {
    // Empty/none-marked manifest → no target → vpn_connect must never fire and the
    // optimistic "connecting" mark is rolled back to "disconnected".
    localStorage.setItem("tt_auto_connect", "true");
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "network_ready") return true;
      if (cmd === "list_configs") return []; // empty manifest — nothing last-used
      if (cmd === "vpn_connect") return null;
      return null;
    });

    renderAutoConnect();
    await flush();

    expect(mockInvoke).not.toHaveBeenCalledWith("vpn_connect", expect.anything());
    // The optimistic "connecting" was rolled back (functional updater), not left stuck.
    expect(setStatus).toHaveBeenCalledWith("connecting");
    const updaterCalls = setStatus.mock.calls.filter(
      (c) => typeof c[0] === "function",
    );
    expect(updaterCalls.length).toBeGreaterThanOrEqual(1);
    const updater = updaterCalls[updaterCalls.length - 1][0] as (
      s: VpnStatus,
    ) => VpnStatus;
    expect(updater("connecting")).toBe("disconnected");
    // setError must NOT have fired — a missing last-used config is not an error.
    expect(setError).not.toHaveBeenCalled();
  });

  it("stands down (no connect, no error) when list_configs throws", async () => {
    // An unreadable manifest is treated as "no target" — auto-connect must not surface
    // a hard error, just quietly stand down.
    localStorage.setItem("tt_auto_connect", "true");
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "network_ready") return true;
      if (cmd === "list_configs") throw new Error("manifest read failed");
      if (cmd === "vpn_connect") return null;
      return null;
    });

    renderAutoConnect();
    await flush();

    expect(mockInvoke).not.toHaveBeenCalledWith("vpn_connect", expect.anything());
    expect(setStatus).not.toHaveBeenCalledWith("error");
    expect(setError).not.toHaveBeenCalled();
  });

  it("still honours the network_ready boot-guard before resolving the last-used target", async () => {
    // Boot-guard preserved: while network_ready is false, NEITHER list_configs' result
    // nor vpn_connect should drive a connect; once the network comes up, it connects to
    // the last-used path.
    localStorage.setItem("tt_auto_connect", "true");
    let ready = false;
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "network_ready") return ready;
      if (cmd === "list_configs") return LAST_USED_LIST;
      if (cmd === "vpn_connect") return null;
      return null;
    });

    renderAutoConnect();

    // 1.5s mount delay → first probe false → no connect yet (boot-guard holds).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(mockInvoke).not.toHaveBeenCalledWith("vpn_connect", expect.anything());

    // Network comes up → next probe true → connect to the resolved last-used path.
    ready = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(mockInvoke).toHaveBeenCalledWith("vpn_connect", {
      configPath: "/config.json",
      logLevel: "info",
    });
  });

  it("WR-05: reconciles to the app-level active config when it differs from manifest last-used", async () => {
    // The manifest last-used marker and the app-level active config (config.configPath,
    // what the status panel / Routing tab show as active) can diverge at runtime. When
    // they disagree AND the active path is still a tracked config, auto-connect must
    // target the DISPLAYED active config — not silently reconnect a different server.
    localStorage.setItem("tt_auto_connect", "true");
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "network_ready") return true;
      if (cmd === "vpn_connect") return null;
      if (cmd === "list_configs") {
        // last_used points at /stale.json, but the app-level active is /config.json,
        // which is ALSO a tracked entry → the active config must win.
        return [
          { id: "id-active", path: "/config.json", last_used: false },
          { id: "id-stale", path: "/stale.json", last_used: true },
        ];
      }
      return null;
    });

    // baseConfig.configPath === "/config.json" — the displayed active config.
    renderAutoConnect();
    await flush();

    // Auto-connect targets the displayed active config, NOT the divergent last-used.
    expect(mockInvoke).toHaveBeenCalledWith("vpn_connect", {
      configPath: "/config.json",
      logLevel: "info",
    });
    expect(mockInvoke).not.toHaveBeenCalledWith("vpn_connect", {
      configPath: "/stale.json",
      logLevel: "info",
    });
  });

  it("WR-05: falls back to manifest last-used when the app-level active path is not tracked", async () => {
    // If config.configPath is not (or no longer) a manifest entry, the app-level pointer
    // is stale/unknown — fall back to the manifest last-used so auto-connect still works.
    localStorage.setItem("tt_auto_connect", "true");
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "network_ready") return true;
      if (cmd === "vpn_connect") return null;
      if (cmd === "list_configs") {
        // /config.json (the app-level active) is NOT in the list → cannot reconcile to it.
        return [{ id: "id-last", path: "/last-used.json", last_used: true }];
      }
      return null;
    });

    renderAutoConnect();
    await flush();

    expect(mockInvoke).toHaveBeenCalledWith("vpn_connect", {
      configPath: "/last-used.json",
      logLevel: "info",
    });
  });

  it("preserves the once-guard: a re-render does not trigger a second connect", async () => {
    // The autoConnectDone once-guard must survive the target change — StrictMode / a
    // status re-render must not fire a second auto-connect.
    localStorage.setItem("tt_auto_connect", "true");
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "network_ready") return true;
      if (cmd === "list_configs") return LAST_USED_LIST;
      if (cmd === "vpn_connect") return null;
      return null;
    });

    const { rerender } = renderAutoConnect();
    await flush();

    const connectCallsAfterFirst = mockInvoke.mock.calls.filter(
      (c) => c[0] === "vpn_connect",
    ).length;
    expect(connectCallsAfterFirst).toBe(1);

    // A re-render with the same config must not re-arm auto-connect.
    rerender({ status: "connected", config: baseConfig });
    await flush();

    const connectCallsAfterRerender = mockInvoke.mock.calls.filter(
      (c) => c[0] === "vpn_connect",
    ).length;
    expect(connectCallsAfterRerender).toBe(1);
  });
});
