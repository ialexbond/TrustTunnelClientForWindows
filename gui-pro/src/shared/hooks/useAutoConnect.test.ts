import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StrictMode } from "react";
import { renderHook, act } from "@testing-library/react";
import { useAutoConnect } from "./useAutoConnect";
import ru from "../i18n/locales/ru.json";
import en from "../i18n/locales/en.json";
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
// 30.1 defect 1: the hook now localizes a rejected `vpn_connect` through the shared reason-code
// map, so it needs an i18n instance. A minimal stub is enough here — every error these tests throw
// is an ordinary Error, which `localizeVpnError` passes through UNCHANGED without calling `t`; the
// mapping itself is asserted in vpnEventHelpers.test.ts against the real bundle.
const testI18n = { t: (key: string) => key } as unknown as Parameters<
  typeof useAutoConnect
>[0]["i18n"];
// F29: the freeze-cache seed callback the hook calls with the honest launch ping (path, ms).
const seedConfigPing = vi.fn();
// G-32-8: the in-window announcement channel (App wires it to the SnackBar push). Injected the
// same way `seedConfigPing` is, so the hook keeps no coupling to a UI context.
const notify = vi.fn();

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
        notify,
        i18n: testI18n,
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
  // G-32-9: an ABSENT key means what the Settings screen already shows for it — ENABLED.
  //
  // This test used to assert the opposite, and it was the defect written down as a contract: the
  // screen painted the switch ON from `APP_SETTINGS_DEFAULTS.autoConnectOnLaunch` while this hook
  // required the literal "true" and stood down. Both readings cannot be right, and the screen is
  // the promise, so the hook is what changed.
  it("auto-connects when the key is ABSENT (the default the Settings screen shows)", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "network_ready") return true;
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

  it("does nothing when tt_auto_connect is explicitly false", async () => {
    localStorage.setItem("tt_auto_connect", "false");
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

// ─────────────────────────────────────────────────────────────────────────
// The raw-path-comparison class (30.1 class sweep) — site 2 of 3.
//
// WR-05 prefers the APP-LEVEL active config over the manifest's last-used marker,
// so that «what auto-connect reconnects to» equals «what the UI shows active». The
// membership test that gates that preference was a byte `===` against the manifest
// paths, so when the manifest spelled the same file differently the active config
// looked absent from the list and the preference was skipped — auto-connect then
// launched a DIFFERENT server than the one the user sees marked active.
// ─────────────────────────────────────────────────────────────────────────
describe("useAutoConnect — the raw-path-comparison class (30.1, site 2 of 3)", () => {
  it("prefers the app-level active config even when the manifest spells its path differently", async () => {
    localStorage.setItem("tt_auto_connect", "true");
    // The manifest holds two servers in Windows' native spelling and marks A last-used…
    const list = [
      { id: "id-a", path: "C:\\cfg\\a.toml", last_used: true },
      { id: "id-b", path: "C:\\cfg\\b.toml", last_used: false },
    ];
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "network_ready") return true;
      if (cmd === "list_configs") return list;
      return null;
    });

    // …while the app shows B as active, holding its path in the forward-slash form.
    renderAutoConnect({
      status: "disconnected",
      config: { configPath: "C:/cfg/b.toml", logLevel: "info" } as VpnConfig,
    });
    await flush();

    // Auto-connect must launch the server the user sees active. Before the sweep the membership
    // test failed on the spelling, the preference was skipped, and it launched A instead.
    expect(mockInvoke).toHaveBeenCalledWith("vpn_connect", {
      configPath: "C:/cfg/b.toml",
      logLevel: "info",
    });
    expect(mockInvoke).not.toHaveBeenCalledWith("vpn_connect", {
      configPath: "C:\\cfg\\a.toml",
      logLevel: "info",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// G-32-8: every terminal outcome of the launch auto-connect leaves a trace.
//
// The hook used to write NOTHING anywhere — not to activity.log, not to app.log, not even to the
// console. It can stand down in five different ways and from outside all five look identical
// («не подключилось»), so the first complaint about this feature could not be diagnosed at all:
// «the toggle is off» was indistinguishable from «there is no server to connect to» from «the
// core refused». Each outcome now writes ONE line through the existing `write_activity_log` sink,
// in the established `namespace.event key=value` shape.
//
// These assertions are about OBSERVABILITY ONLY. The suites above pin the BEHAVIOUR (the one-shot
// latch, the bounded network poll, the live-status re-check, the last-used resolution) and none of
// them change here — instrumentation that alters the decision it reports is worse than none.
// ─────────────────────────────────────────────────────────────────────────

/** Every `write_activity_log` payload the hook emitted, in call order. */
const activityLines = () =>
  mockInvoke.mock.calls
    .filter((c) => c[0] === "write_activity_log")
    .map((c) => c[1] as { tag: string; message: string; details?: string | null });

/** The `message` field of every activity line (what a person greps for in activity.log). */
const activityMessages = () => activityLines().map((l) => l.message);

describe("useAutoConnect — G-32-8: each outcome is written to activity.log", () => {
  it("records the stand-down when the tt_auto_connect toggle is off (:114)", async () => {
    // The user turned the switch off — a likely reason for «it did not connect», and the one they
    // are most able to fix themselves once they can see it.
    //
    // G-32-9: this used to leave the key ABSENT, back when absent also meant off. It no longer
    // does (absent = the Settings default = ON), so the arrangement now writes the "false" that a
    // deliberate flip of the switch writes.
    localStorage.setItem("tt_auto_connect", "false");
    mockInvoke.mockResolvedValue(null);
    renderAutoConnect();
    await flush();

    expect(activityMessages()).toContain("autoconnect.skipped reason=toggle_off");
    // Still a no-op: observability must not connect anything.
    expect(mockInvoke).not.toHaveBeenCalledWith("vpn_connect", expect.anything());
  });

  it("writes the toggle-off line ONCE even if the effect re-runs on a config path change", async () => {
    // The effect's dep is `config.configPath`, which legitimately changes a couple of times while
    // the app loads its config at startup. A line per re-run would bury the useful entries.
    localStorage.setItem("tt_auto_connect", "false");
    mockInvoke.mockResolvedValue(null);
    const { rerender } = renderAutoConnect();
    rerender({
      status: "disconnected",
      config: { configPath: "/other.json", logLevel: "info" } as VpnConfig,
    });
    await flush();

    const offLines = activityMessages().filter(
      (m) => m === "autoconnect.skipped reason=toggle_off",
    );
    expect(offLines).toHaveLength(1);
  });

  it("never reaches the toggle-off stand-down when the switch was simply never touched", async () => {
    // G-32-9, stated as the contract that replaced the old one.
    //
    // There used to be a test here asserting `details === "stored=absent"` — that an untouched
    // switch stood DOWN, and that the log line said so. It described the bug faithfully and
    // pinned it in place: the Settings screen renders the «Автоподключение при запуске» switch from
    // APP_SETTINGS_DEFAULTS.autoConnectOnLaunch (= true) whenever the key is absent, so standing
    // down on absent meant the screen and the behaviour disagreed.
    //
    // Now both readers take the default from the same constant, so «absent» cannot reach this
    // branch at all — it proceeds instead. That is the whole fix, expressed where it is visible.
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "network_ready") return true;
      if (cmd === "list_configs") return LAST_USED_LIST;
      return null;
    });
    renderAutoConnect();
    await flush();

    expect(activityMessages()).not.toContain("autoconnect.skipped reason=toggle_off");
    expect(activityMessages()).toContain("autoconnect.connect_invoked path=/config.json");
  });

  it("says stored=false when the user has actually turned the switch off", async () => {
    localStorage.setItem("tt_auto_connect", "false");
    mockInvoke.mockResolvedValue(null);
    renderAutoConnect();
    await flush();

    const line = activityLines().find(
      (l) => l.message === "autoconnect.skipped reason=toggle_off",
    );
    expect(line?.details).toBe("stored=false");
  });

  it("records that the network came up inside the budget (:141, the ready branch)", async () => {
    localStorage.setItem("tt_auto_connect", "true");
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "network_ready") return true;
      if (cmd === "list_configs") return LAST_USED_LIST;
      return null;
    });

    renderAutoConnect();
    await flush();

    expect(activityMessages()).toContain("autoconnect.network_ready");
    expect(activityMessages()).not.toContain("autoconnect.network_timeout");
  });

  it("records that the network never came up and we proceeded anyway (:141, the budget branch)", async () => {
    // The two halves of the bounded wait must be distinguishable in the log: connecting into a
    // dead early-boot network is a different story from connecting into a live one, and the
    // outcome the user sees («не подключилось») is the same in both.
    localStorage.setItem("tt_auto_connect", "true");
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "network_ready") return false; // never ready
      if (cmd === "list_configs") return LAST_USED_LIST;
      return null;
    });

    renderAutoConnect();
    await flush();

    expect(activityMessages()).toContain("autoconnect.network_timeout");
    expect(activityMessages()).not.toContain("autoconnect.network_ready");
    // Unchanged captive-net behaviour: it still connects after the budget elapses.
    expect(mockInvoke).toHaveBeenCalledWith("vpn_connect", {
      configPath: "/config.json",
      logLevel: "info",
    });
  });

  it("records the live-status stand-down BEFORE the wait, with the status value (:288)", async () => {
    // The mount snapshot restored a live tunnel inside the 1.5s delay. Correct behaviour, but
    // silent: from outside it is «autostart did nothing».
    localStorage.setItem("tt_auto_connect", "true");
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "network_ready") return true;
      if (cmd === "list_configs") return LAST_USED_LIST;
      return null;
    });

    const { rerender } = renderAutoConnect();
    rerender({ status: "connected", config: baseConfig });
    await flush();

    expect(activityMessages()).toContain(
      "autoconnect.stood_down reason=status_not_idle stage=pre_wait status=connected",
    );
    expect(mockInvoke).not.toHaveBeenCalledWith("vpn_connect", expect.anything());
  });

  it("records the live-status stand-down DURING the wait, with the status value (:175)", async () => {
    localStorage.setItem("tt_auto_connect", "true");
    let ready = false;
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "network_ready") return ready;
      if (cmd === "list_configs") return LAST_USED_LIST;
      return null;
    });

    const { rerender } = renderAutoConnect();
    // Timer fires → optimistic "connecting" + the poll loop starts (probe false).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    // A live vpn-status event lands mid-wait, then the network comes up.
    rerender({ status: "connected", config: baseConfig });
    ready = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(activityMessages()).toContain(
      "autoconnect.stood_down reason=status_not_idle stage=pre_connect status=connected",
    );
    expect(mockInvoke).not.toHaveBeenCalledWith("vpn_connect", expect.anything());
  });

  it("records the no-last-used stand-down (:227) — the branch a fresh install always hits", async () => {
    // A full uninstall takes the manifest with it, so after re-installing there is nothing marked
    // last-used. This branch is CORRECT and was completely silent: no log, no message, nothing.
    localStorage.setItem("tt_auto_connect", "true");
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "network_ready") return true;
      if (cmd === "list_configs") return []; // empty manifest — nothing last-used
      return null;
    });

    renderAutoConnect();
    await flush();

    expect(activityMessages()).toContain("autoconnect.stood_down reason=no_last_used");
    expect(mockInvoke).not.toHaveBeenCalledWith("vpn_connect", expect.anything());
  });

  it("records the no-last-used stand-down when the manifest itself is unreadable (:222)", async () => {
    localStorage.setItem("tt_auto_connect", "true");
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "network_ready") return true;
      if (cmd === "list_configs") throw new Error("manifest read failed");
      return null;
    });

    renderAutoConnect();
    await flush();

    expect(activityMessages()).toContain("autoconnect.stood_down reason=no_last_used");
  });

  it("records the chosen config path and that vpn_connect was invoked (the success path)", async () => {
    localStorage.setItem("tt_auto_connect", "true");
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "network_ready") return true;
      if (cmd === "list_configs") return LAST_USED_LIST;
      return null;
    });

    renderAutoConnect();
    await flush();

    expect(activityMessages()).toContain("autoconnect.connect_invoked path=/config.json");
  });

  it("records a REFUSED vpn_connect as an ERROR line (the core said no)", async () => {
    localStorage.setItem("tt_auto_connect", "true");
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "network_ready") return true;
      if (cmd === "list_configs") return LAST_USED_LIST;
      if (cmd === "vpn_connect") throw new Error("core refused");
      return null;
    });

    renderAutoConnect();
    await flush();

    const failed = activityLines().find((l) =>
      l.message.startsWith("autoconnect.connect_failed"),
    );
    expect(failed).toBeDefined();
    expect(failed?.tag).toBe("ERROR");
    // Unchanged behaviour: the refusal still reaches the UI the way it always did.
    expect(setError).toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledWith("error");
  });

  it("D-29: no logged argument carries a password or anything password-shaped", async () => {
    // The manifest entry the hook reads is a whole record; only its `path` may be written down.
    // A well-meaning `JSON.stringify(entry)` in a log line would ship the user's secret into a
    // plain-text file the app itself offers to collect and hand over. The token is assembled at
    // runtime so it is never spelled out in this file (comment-text discipline, T-17-01).
    const SECRET = ["AUTOCONNECT", "TOKEN", "D29"].join("-");
    localStorage.setItem("tt_auto_connect", "true");
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "network_ready") return true;
      if (cmd === "list_configs") {
        return [
          {
            id: "id-1",
            path: "/config.json",
            last_used: true,
            // Shapes a manifest entry could plausibly grow; none of them may be logged.
            password: SECRET,
            ssh_password: SECRET,
          },
        ];
      }
      return null;
    });

    renderAutoConnect();
    await flush();

    // The hook DID write lines — otherwise the assertions below are vacuously true.
    expect(activityLines().length).toBeGreaterThan(0);
    const written = JSON.stringify(activityLines());
    expect(written).not.toContain(SECRET);
    expect(written).not.toMatch(/password|passwd|secret|credential/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// G-32-8, second half: the no-target stand-down says something to the PERSON.
//
// The log line above is for whoever is diagnosing afterwards. The user standing in front of a
// disconnected screen at launch, having switched auto-connect on, gets nothing from it — they do
// not open activity.log, and the app never told them their auto-connect had no server to aim at.
//
// Why this is not a first-run nag: the ANNOUNCEMENT (not the connect) requires `tt_auto_connect`
// to hold the literal "true", which only a deliberate flip of the switch writes.
//
// G-32-9 moved that gate. It used to be free: absent meant off, so a fresh install stood down at
// :114 and never reached this branch. Now absent means ON — so a brand-new install with an empty
// manifest DOES arrive here, and without an explicit gate it would greet a first-time user with a
// message about a feature they never asked for. The connect still follows the screen's default;
// only the sentence is held back to the person who asked for it and has nothing to connect to,
// which is the one case where silence is indistinguishable from a broken feature.
// ─────────────────────────────────────────────────────────────────────────
describe("useAutoConnect — G-32-8: the no-target stand-down is announced", () => {
  it("announces it once when the manifest names no last-used config (:227)", async () => {
    localStorage.setItem("tt_auto_connect", "true");
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "network_ready") return true;
      if (cmd === "list_configs") return []; // empty manifest — nothing last-used
      return null;
    });

    renderAutoConnect();
    await flush();

    expect(notify).toHaveBeenCalledTimes(1);
    // Localized through the injected i18n instance (the stub echoes the key back).
    expect(notify).toHaveBeenCalledWith("messages.auto_connect_no_target");
  });

  it("announces it when the manifest itself could not be read", async () => {
    localStorage.setItem("tt_auto_connect", "true");
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "network_ready") return true;
      if (cmd === "list_configs") throw new Error("manifest read failed");
      return null;
    });

    renderAutoConnect();
    await flush();

    expect(notify).toHaveBeenCalledWith("messages.auto_connect_no_target");
  });

  it("says NOTHING when auto-connect was never switched on (no first-run nag)", async () => {
    // The branch a brand-new install actually takes after G-32-9: the key is absent, so the connect
    // is attempted, `list_configs` names nothing last-used, and the hook stands down. Silence here
    // is correct — the user did not ask for auto-connect, so there is nothing to report to them.
    mockInvoke.mockResolvedValue(null);
    renderAutoConnect();
    await flush();

    expect(notify).not.toHaveBeenCalled();
    // …but the stand-down is still WRITTEN DOWN. Sparing the user a message must not also cost
    // whoever diagnoses this afterwards the one line that explains it (G-32-8).
    expect(activityMessages()).toContain("autoconnect.stood_down reason=no_last_used");
  });

  it("says NOTHING on the success path", async () => {
    localStorage.setItem("tt_auto_connect", "true");
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "network_ready") return true;
      if (cmd === "list_configs") return LAST_USED_LIST;
      return null;
    });

    renderAutoConnect();
    await flush();

    expect(mockInvoke).toHaveBeenCalledWith("vpn_connect", {
      configPath: "/config.json",
      logLevel: "info",
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it("says NOTHING when a live session already owns the tunnel", async () => {
    localStorage.setItem("tt_auto_connect", "true");
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "network_ready") return true;
      if (cmd === "list_configs") return LAST_USED_LIST;
      return null;
    });

    const { rerender } = renderAutoConnect();
    rerender({ status: "connected", config: baseConfig });
    await flush();

    expect(notify).not.toHaveBeenCalled();
  });

  it("stays a clean no-op when no announcement channel is wired (Storybook / standalone tests)", async () => {
    // `notify` is optional exactly like `seedConfigPing`; a call site without it must not throw.
    localStorage.setItem("tt_auto_connect", "true");
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "network_ready") return true;
      if (cmd === "list_configs") return [];
      return null;
    });

    renderHook(() =>
      useAutoConnect({
        config: baseConfig,
        status: "disconnected",
        setStatus,
        setError,
        i18n: testI18n,
      }),
    );
    await flush();

    expect(setError).not.toHaveBeenCalled();
  });

  it("both bundles carry the copy, and the Russian one is the one a person reads", () => {
    // ru.json is the source language and en.json mirrors it (project convention). A key present in
    // only one bundle renders as the raw key on the other language — the exact silent failure this
    // message exists to end.
    const ruText = (ru as { messages: Record<string, string> }).messages
      .auto_connect_no_target;
    const enText = (en as { messages: Record<string, string> }).messages
      .auto_connect_no_target;
    expect(ruText).toBeTruthy();
    expect(enText).toBeTruthy();
    // Cyrillic, i.e. actually translated rather than the English string copied across.
    expect(ruText).toMatch(/[а-яА-Я]/);
    expect(enText).not.toMatch(/[а-яА-Я]/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// G-32-10 — the one-shot latch must protect the WORK, not the INTENT.
//
// The latch used to be armed synchronously in the effect body, BEFORE the 1.5s timer that does
// the work was even created, while the cleanup unconditionally cleared that timer. So any re-run
// of the effect inside the window — a `config.configPath` write, or StrictMode's dev-only
// mount/cleanup/mount — killed the pending auto-connect and then returned at the latch on the way
// back in. Nothing rescheduled: auto-connect was dead for the life of the webview.
//
// It died BEFORE the timer callback, and every G-32-8 log line sits inside or after that callback,
// so the diagnostics built to remove exactly this blind spot could not see it either.
//
// These contracts fail against the old ordering and pass against the new one. The pair matters:
// the reschedule must happen AND the one-shot guarantee must survive it.
// ─────────────────────────────────────────────────────────────────────────
describe("useAutoConnect — G-32-10: the latch guards the work, not the intent", () => {
  const SECOND_CONFIG = "/second.json";
  const SECOND_LIST = [{ id: "id-2", path: SECOND_CONFIG, last_used: true }];

  const happyPath = () =>
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "network_ready") return true;
      if (cmd === "list_configs") return SECOND_LIST;
      if (cmd === "vpn_connect") return null;
      return null;
    });

  it("still connects when config.configPath changes INSIDE the 1.5s window", async () => {
    localStorage.setItem("tt_auto_connect", "true");
    happyPath();

    const { rerender } = renderAutoConnect();

    // Half-way through the mount delay — the timer is pending, nothing has run yet.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(mockInvoke).not.toHaveBeenCalledWith("vpn_connect", expect.anything());

    // App resolves its config path (a genuine startup write) → the effect re-runs.
    rerender({
      status: "disconnected",
      config: { ...baseConfig, configPath: SECOND_CONFIG },
    });

    await flush();

    // Under the old ordering this is where auto-connect simply ceased to exist.
    expect(mockInvoke).toHaveBeenCalledWith("vpn_connect", {
      configPath: SECOND_CONFIG,
      logLevel: "info",
    });
  });

  it("connects EXACTLY once even when the path changes several times inside the window", async () => {
    // The reschedule must not stack timers, start a second network wait, or double-connect.
    localStorage.setItem("tt_auto_connect", "true");
    happyPath();

    const { rerender } = renderAutoConnect();

    for (const path of ["/a.json", "/b.json", SECOND_CONFIG]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      rerender({ status: "disconnected", config: { ...baseConfig, configPath: path } });
    }

    await flush();

    const connects = mockInvoke.mock.calls.filter((c) => c[0] === "vpn_connect");
    expect(connects).toHaveLength(1);
    // One work run ⇒ one origin mark and one network wait, not three of each.
    expect(
      mockInvoke.mock.calls.filter((c) => c[0] === "set_pending_connect_origin"),
    ).toHaveLength(1);
  });

  it("keeps the one-shot guarantee: a path change AFTER the connect never connects again", async () => {
    localStorage.setItem("tt_auto_connect", "true");
    happyPath();

    const { rerender } = renderAutoConnect();
    await flush();
    expect(mockInvoke.mock.calls.filter((c) => c[0] === "vpn_connect")).toHaveLength(1);

    rerender({ status: "connected", config: { ...baseConfig, configPath: "/third.json" } });
    await flush();

    expect(mockInvoke.mock.calls.filter((c) => c[0] === "vpn_connect")).toHaveLength(1);
  });

  it("fires under React.StrictMode, whose dev-only remount is this exact re-run", async () => {
    // StrictMode double-invokes effects in DEVELOPMENT only: mount → cleanup → mount. That is the
    // defect's trigger with no config change at all, which means the old ordering left
    // auto-connect dead on every `npm run tauri:dev` launch and alive in the packaged build — the
    // inverse of the usual asymmetry, and the reason nobody read the dev behaviour as a bug.
    localStorage.setItem("tt_auto_connect", "true");
    happyPath();

    renderHook(
      () =>
        useAutoConnect({
          config: { ...baseConfig, configPath: SECOND_CONFIG },
          status: "disconnected",
          setStatus,
          setError,
          seedConfigPing,
          notify,
          i18n: testI18n,
        }),
      { wrapper: StrictMode },
    );

    await flush();

    expect(mockInvoke.mock.calls.filter((c) => c[0] === "vpn_connect")).toHaveLength(1);
  });

  it("writes the reschedule down, the way every other outcome is written down", async () => {
    // The class was invisible to G-32-8 because it died upstream of every line G-32-8 added. It
    // now writes through the same fire-and-forget helper. D-29: a reason token and a counter, no
    // path and nothing credential-shaped.
    localStorage.setItem("tt_auto_connect", "true");
    happyPath();

    const { rerender } = renderAutoConnect();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    rerender({
      status: "disconnected",
      config: { ...baseConfig, configPath: SECOND_CONFIG },
    });
    await flush();

    const logged = mockInvoke.mock.calls.filter((c) => c[0] === "write_activity_log");
    const rescheduled = logged.filter((c) =>
      String((c[1] as { message?: string }).message).startsWith("autoconnect.rescheduled"),
    );
    expect(rescheduled).toHaveLength(1);
    expect(rescheduled[0][1]).toMatchObject({
      tag: "STATE",
      message: "autoconnect.rescheduled reason=deps_changed stage=pre_wait",
      details: "attempt=2",
    });
  });

  it("says nothing about a reschedule when there was none", async () => {
    localStorage.setItem("tt_auto_connect", "true");
    happyPath();

    renderAutoConnect();
    await flush();

    const rescheduled = mockInvoke.mock.calls
      .filter((c) => c[0] === "write_activity_log")
      .filter((c) =>
        String((c[1] as { message?: string }).message).includes("rescheduled"),
      );
    expect(rescheduled).toHaveLength(0);
  });
});
