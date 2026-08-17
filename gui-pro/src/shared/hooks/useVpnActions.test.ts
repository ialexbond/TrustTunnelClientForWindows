import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../i18n";
import { useVpnActions } from "./useVpnActions";
import { useVpnEvents } from "./useVpnEvents";
import type { VpnStatus, VpnConfig } from "../types";

// ─────────────────────────────────────────────────────────────────────────
// Plan 02-12 — manual reconnect («Сохранить и переподключить») must show the
// «Переподключение…» label CONTINUOUSLY and NEVER dwell on «Отключено»
// (disconnected) during the disconnect→reconnect window.
//
// 02-20 status-UX split: a manual save+reconnect is «Переподключение» (re-establish),
// so the up-front token is now "reconnecting" — NOT "recovering" (which is reserved for
// a LOCAL-network wait). The no-dwell behavior is unchanged.
//
// The no-dwell property is an INTERACTION between two hooks:
//   • useVpnActions.handleReconnect sets status to "reconnecting" up-front, then
//     tears the tunnel down without flipping to "disconnecting".
//   • useVpnEvents' vpn-status listener suppresses the intermediate
//     "disconnected" event while prev === "recovering" || prev === "reconnecting".
// So we render BOTH hooks against one shared status state and drive the real
// status reducer — exactly the wiring App.tsx uses — to prove the visible
// status never becomes "disconnected" during a manual reconnect.
// ─────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ListenCallback = (event: { payload: any }) => void;
let listenCallbacks: Record<string, ListenCallback[]> = {};

function setupListenMock() {
  listenCallbacks = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(listen).mockImplementation(async (eventName: string, callback: any) => {
    if (!listenCallbacks[eventName]) listenCallbacks[eventName] = [];
    listenCallbacks[eventName].push(callback);
    return () => {};
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function emitEvent(eventName: string, payload: any) {
  const cbs = listenCallbacks[eventName] || [];
  cbs.forEach((cb) => cb({ payload }));
}

const CONFIG: VpnConfig = {
  configPath: "/config.json",
  logLevel: "info",
} as VpnConfig;

// Render useVpnActions + useVpnEvents together with a REAL status state so the
// no-dwell guard in useVpnEvents actually runs against handleReconnect's
// "reconnecting" set. We record every status the reducer ever produced so a test
// can assert "disconnected" never appears mid-reconnect.
// Fable-A review #3: `opts.pushPendingConnectPing` mirrors the App.tsx wiring — the App-owned
// ping+origin push threaded into useVpnActions so handleReconnect can push the plate ping.
function renderReconnectHarness(
  initialStatus: VpnStatus,
  opts?: {
    pushPendingConnectPing?: (path: string) => Promise<void>;
    // BUG-B (17-uat) B1: the post-teardown probe+push+SEED variant threaded from App. Wired the same
    // way as pushPendingConnectPing so a test can assert the teardown paths (handleReconnect + a real
    // switchTo) run it at the post-teardown/pre-connect point (honest, single probe, non-blocking).
    pushPendingConnectPingSeeded?: (path: string) => Promise<void>;
  },
) {
  const statusHistory: VpnStatus[] = [];

  const hook = renderHook(() => {
    const [status, setStatus] = useState<VpnStatus>(initialStatus);
    const [, setError] = useState<string | null>(null);
    const [, setConnectedSince] = useState<Date | null>(null);
    const [, setVpnLogs] = useState<unknown[]>([]);
    const reconnectResolve = useRef<(() => void) | null>(null);
    // AUDIT-2026-06-11 #8: the shared manual-reconnect mark, wired between the two
    // hooks exactly like App.tsx does. handleReconnect raises it; the no-dwell guard
    // in useVpnEvents suppresses the teardown's "disconnected" ONLY while it is up.
    const manualReconnectActiveRef = useRef(false);

    statusHistory.push(status);

    useVpnEvents({
      i18n,
      setStatus,
      setError,
      setConnectedSince,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setVpnLogs: setVpnLogs as any,
      reconnectResolve,
      manualReconnectActiveRef,
    });

    const actions = useVpnActions({
      config: CONFIG,
      status,
      setStatus,
      setError,
      i18n,
      reconnectResolve,
      manualReconnectActiveRef,
      pushPendingConnectPing: opts?.pushPendingConnectPing,
      pushPendingConnectPingSeeded: opts?.pushPendingConnectPingSeeded,
    });

    return { status, actions, reconnectResolve, manualReconnectActiveRef };
  });

  return { hook, statusHistory };
}

describe("useVpnActions.handleReconnect (Plan 02-12 — no dwell on «Отключено»)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupListenMock();
    i18n.changeLanguage("ru");
    vi.mocked(invoke).mockResolvedValue(null);
  });

  it("sets status to 'reconnecting' up-front, never to 'disconnecting'", async () => {
    const { hook, statusHistory } = renderReconnectHarness("connected");

    // Fire the manual reconnect but DO NOT await it yet — we want to inspect the
    // status the instant the teardown is in flight (before the disconnected event).
    let reconnectPromise: Promise<void>;
    await act(async () => {
      reconnectPromise = hook.result.current.actions.handleReconnect();
      // Let the synchronous setStatus("reconnecting") + the vpn_disconnect microtask
      // settle so the harness re-renders with the new status.
      await Promise.resolve();
    });

    // During the teardown window the visible status is "reconnecting" …
    expect(hook.result.current.status).toBe("reconnecting");
    // … and it was NEVER flipped to "disconnecting" (that would have broken the
    // no-dwell guard in useVpnEvents and re-introduced the «Отключено» flash).
    expect(statusHistory).not.toContain("disconnecting");

    // Now deliver the real "disconnected" event (sidecar fully torn down) and let
    // the reconnect complete so the test leaves no dangling promise.
    await act(async () => {
      emitEvent("vpn-status", { status: "disconnected" });
      await reconnectPromise;
    });
  });

  it("the intermediate 'disconnected' event is suppressed — status never becomes «Отключено»", async () => {
    const { hook, statusHistory } = renderReconnectHarness("connected");

    let reconnectPromise: Promise<void>;
    await act(async () => {
      reconnectPromise = hook.result.current.actions.handleReconnect();
      await Promise.resolve();
    });

    // Mid-teardown the visible status is "reconnecting" (set up-front), not «Отключено».
    expect(hook.result.current.status).toBe("reconnecting");

    // The teardown emits the intermediate "disconnected" status event. The
    // no-dwell guard suppresses it from the VISIBLE status; the SAME event also
    // resolves the reconnect promise, so handleConnect proceeds straight to
    // "connecting". The user therefore goes reconnecting → connecting with no
    // «Отключено» in between.
    await act(async () => {
      emitEvent("vpn-status", { status: "disconnected" });
      await reconnectPromise;
    });

    // The "disconnected" status was NEVER committed to the visible state — that is
    // the whole bug fix (no dwell on «Отключено» during a manual reconnect).
    expect(statusHistory).not.toContain("disconnected");
    expect(statusHistory).not.toContain("disconnecting");
  });

  it("reconnect still completes end-to-end: reconnecting → connecting → connected", async () => {
    const { hook, statusHistory } = renderReconnectHarness("connected");

    let reconnectPromise: Promise<void>;
    await act(async () => {
      reconnectPromise = hook.result.current.actions.handleReconnect();
      // Let a render commit the up-front "reconnecting" status before the teardown
      // event arrives, so the reconnecting phase is observable in the history.
      await Promise.resolve();
    });

    // The up-front "reconnecting" phase is now committed (no «Отключено» dwell).
    expect(hook.result.current.status).toBe("reconnecting");

    await act(async () => {
      // Sidecar torn down — resolves the reconnect promise and lets handleConnect run.
      emitEvent("vpn-status", { status: "disconnected" });
      await reconnectPromise;
    });

    // handleConnect moved the status to "connecting" (invoke("vpn_connect") resolved).
    expect(hook.result.current.status).toBe("connecting");

    // The backend then confirms the tunnel is up.
    await act(async () => {
      emitEvent("vpn-status", { status: "connected" });
      await Promise.resolve();
    });
    expect(hook.result.current.status).toBe("connected");

    // The full visible path was reconnecting → connecting → connected, with no
    // disconnected/disconnecting dwell anywhere in between.
    expect(statusHistory).toContain("reconnecting");
    expect(statusHistory).toContain("connecting");
    expect(statusHistory).toContain("connected");
    expect(statusHistory).not.toContain("disconnected");
    expect(statusHistory).not.toContain("disconnecting");
  });

  it("a real connect failure still surfaces 'error' (the catch path is intact)", async () => {
    const { hook } = renderReconnectHarness("connected");
    // vpn_disconnect succeeds, but the reconnect's vpn_connect rejects.
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "vpn_connect") throw new Error("connect failed");
      return null;
    });

    await act(async () => {
      const p = hook.result.current.actions.handleReconnect();
      await Promise.resolve();
      emitEvent("vpn-status", { status: "disconnected" });
      await p;
    });

    // handleConnect's catch set the honest error status — a failed reconnect is
    // NOT hidden behind the recovering label.
    expect(hook.result.current.status).toBe("error");
  });

  it("AUDIT #8: a tray disconnect during an AUTO-reconnect commits 'disconnected' (no manual reconnect in flight)", async () => {
    // The backend supervisor drives «Переподключение» on a server-silent drop; the
    // user then disconnects from the TRAY (no frontend action — handleReconnect was
    // never called, the manual-reconnect mark is down). The backend kills the core
    // and emits ONE bare "disconnected" (D-09 / the supervisor's T-31 forced
    // Disconnected). Before the #8 fix the unconditional no-dwell guard swallowed
    // it and the window stuck on yellow «Переподключение» forever.
    const { hook } = renderReconnectHarness("connected");

    // Backend-driven auto-reconnect attempt (NOT a manual save+reconnect).
    await act(async () => {
      emitEvent("vpn-status", { status: "reconnecting" });
    });
    expect(hook.result.current.status).toBe("reconnecting");
    expect(hook.result.current.manualReconnectActiveRef.current).toBe(false);

    // Tray disconnect → single terminal "disconnected" — must COMMIT, not be eaten.
    await act(async () => {
      emitEvent("vpn-status", { status: "disconnected" });
    });
    expect(hook.result.current.status).toBe("disconnected");
  });

  it("AUDIT #8: the manual-reconnect mark is raised during the teardown window and cleared before the re-connect", async () => {
    // Pins the mark's lifecycle: handleReconnect raises it synchronously (that is what
    // arms the no-dwell suppression), and clears it once the teardown completed — so a
    // LATER real "disconnected" (e.g. tray disconnect after the reconnect) still lands.
    const { hook } = renderReconnectHarness("connected");

    let reconnectPromise: Promise<void>;
    await act(async () => {
      reconnectPromise = hook.result.current.actions.handleReconnect();
      await Promise.resolve();
    });

    // Mid-teardown: the mark is up — the "disconnected" below gets suppressed.
    expect(hook.result.current.manualReconnectActiveRef.current).toBe(true);

    await act(async () => {
      emitEvent("vpn-status", { status: "disconnected" });
      await reconnectPromise;
    });

    // Teardown done, handleConnect ran: the mark must be DOWN again so the guard
    // no longer suppresses real terminal Disconnected events.
    expect(hook.result.current.manualReconnectActiveRef.current).toBe(false);
    expect(hook.result.current.status).toBe("connecting");

    // A real disconnect after the reconnect flow commits normally.
    await act(async () => {
      emitEvent("vpn-status", { status: "connected" });
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "disconnected" });
    });
    expect(hook.result.current.status).toBe("disconnected");
  });

  it("AUDIT #8: a failed teardown clears the manual-reconnect mark (error path)", async () => {
    // WR-02 abort path: vpn_disconnect rejects → handleReconnect stops with "error".
    // The mark must not stay latched (a stale true would silently eat the next
    // reconnecting → disconnected transition for up to the 5s safety window).
    const { hook } = renderReconnectHarness("connected");
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "vpn_disconnect") throw new Error("Lock error");
      return null;
    });

    await act(async () => {
      await hook.result.current.actions.handleReconnect();
    });

    expect(hook.result.current.status).toBe("error");
    expect(hook.result.current.manualReconnectActiveRef.current).toBe(false);
  });

  it("is a no-op when not connected/connecting (guard at the top of handleReconnect)", async () => {
    const { hook, statusHistory } = renderReconnectHarness("disconnected");

    await act(async () => {
      await hook.result.current.actions.handleReconnect();
    });

    // No reconnect was attempted, so the status was never touched and
    // vpn_disconnect was never invoked.
    expect(statusHistory).not.toContain("reconnecting");
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("vpn_disconnect");
  });

  it("BL-01: raises the switch/reconnect-pending signal BEFORE the teardown and clears it on completion", async () => {
    // A manual reconnect is disconnect→connect from a healthy session. Its teardown leg
    // writes a genuine Connected → Disconnected transition; without a signal the Rust
    // decider fired a spurious «Отключено» before «Подключено». handleReconnect must set
    // set_switch_or_reconnect_pending(true) BEFORE the vpn_disconnect (so the intermediate
    // Disconnected is suppressed) and set it back to false once the flow finishes.
    const { hook } = renderReconnectHarness("connected");

    let reconnectPromise: Promise<void>;
    await act(async () => {
      reconnectPromise = hook.result.current.actions.handleReconnect();
      await Promise.resolve();
    });

    // The pending(true) was invoked, and it came BEFORE the vpn_disconnect teardown.
    const calls = vi.mocked(invoke).mock.calls;
    const pendingTrueIdx = calls.findIndex(
      (c) => c[0] === "set_switch_or_reconnect_pending" && (c[1] as { pending: boolean }).pending === true,
    );
    const disconnectIdx = calls.findIndex((c) => c[0] === "vpn_disconnect");
    expect(pendingTrueIdx).toBeGreaterThanOrEqual(0);
    expect(disconnectIdx).toBeGreaterThan(pendingTrueIdx);

    // Finish the flow — the pending signal is cleared (false) on completion.
    await act(async () => {
      emitEvent("vpn-status", { status: "disconnected" });
      await reconnectPromise;
    });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("set_switch_or_reconnect_pending", {
      pending: false,
    });
  });

  it("BL-01: clears the switch/reconnect-pending signal on the teardown-reject error path", async () => {
    // If vpn_disconnect rejects, handleReconnect aborts to 'error'. The pending signal must
    // NOT stay latched true (a stale true would swallow the next genuine user disconnect's
    // «Отключено» until the Rust terminal-outcome backstop clears it).
    const { hook } = renderReconnectHarness("connected");
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "vpn_disconnect") throw new Error("Lock error");
      return null;
    });

    await act(async () => {
      await hook.result.current.actions.handleReconnect();
    });

    expect(hook.result.current.status).toBe("error");
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("set_switch_or_reconnect_pending", {
      pending: false,
    });
  });

  it("Fable-A #3: awaits the threaded pushPendingConnectPing AFTER the teardown wait and BEFORE the reconnect vpn_connect", async () => {
    // handleReconnect was the ONLY connect initiator reaching vpn_connect without pushing
    // pending_connect_ping / stamping origin=Manual — so the save-and-reconnect's terminal
    // «Подключено» plate deterministically rendered ping «—». It now awaits the App-threaded
    // pushPendingConnectPing at the only correct moment: AFTER the teardown-disconnect wait
    // resolved (the endpoint is inactive again, so a fresh probe reads a real number — probing
    // while the tunnel is still up reads Unreachable by design) and BEFORE handleConnect.
    let disconnectsAtPush = -1;
    let connectsAtPush = -1;
    const pushPendingConnectPing = vi.fn(async () => {
      // Snapshot the invoke ledger AT PUSH TIME so the test can prove the push landed between
      // the teardown vpn_disconnect and the reconnect vpn_connect.
      const names = vi.mocked(invoke).mock.calls.map((c) => c[0]);
      disconnectsAtPush = names.filter((n) => n === "vpn_disconnect").length;
      connectsAtPush = names.filter((n) => n === "vpn_connect").length;
    });
    const { hook } = renderReconnectHarness("connected", { pushPendingConnectPing });

    let reconnectPromise: Promise<void>;
    await act(async () => {
      reconnectPromise = hook.result.current.actions.handleReconnect();
      await Promise.resolve();
    });

    // Mid-teardown (the "disconnected" event has not fired yet) the push must NOT have run.
    expect(pushPendingConnectPing).not.toHaveBeenCalled();

    await act(async () => {
      emitEvent("vpn-status", { status: "disconnected" });
      await reconnectPromise;
    });

    // The push ran exactly once, targeting the active config path…
    expect(pushPendingConnectPing).toHaveBeenCalledTimes(1);
    expect(pushPendingConnectPing).toHaveBeenCalledWith(CONFIG.configPath);
    // …strictly AFTER the teardown vpn_disconnect and BEFORE the reconnect vpn_connect.
    expect(disconnectsAtPush).toBe(1);
    expect(connectsAtPush).toBe(0);
    // The reconnect itself still fired.
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("vpn_connect", {
      configPath: CONFIG.configPath,
      logLevel: CONFIG.logLevel,
    });
  });

  it("BUG-B B1: handleReconnect runs the SEEDED post-teardown push (single probe) AFTER the teardown wait and BEFORE the reconnect vpn_connect", async () => {
    // The save-and-reconnect keeps the App status optimistically on «reconnecting» through the teardown,
    // so the plain pushPendingConnectPing's seed (gated on disconnected/error) was skipped → the active
    // card fell to «● —». The SEEDED variant seeds unconditionally on an ok reading. It must run at the
    // same honest moment: AFTER the teardown wait (endpoint inactive → fresh probe reads a real number)
    // and BEFORE handleConnect. It replaces the plain push on this path (no double-probe).
    let disconnectsAtPush = -1;
    let connectsAtPush = -1;
    const seeded = vi.fn(async () => {
      const names = vi.mocked(invoke).mock.calls.map((c) => c[0]);
      disconnectsAtPush = names.filter((n) => n === "vpn_disconnect").length;
      connectsAtPush = names.filter((n) => n === "vpn_connect").length;
    });
    const plain = vi.fn(async () => {});
    const { hook } = renderReconnectHarness("connected", {
      pushPendingConnectPing: plain,
      pushPendingConnectPingSeeded: seeded,
    });

    let reconnectPromise: Promise<void>;
    await act(async () => {
      reconnectPromise = hook.result.current.actions.handleReconnect();
      await Promise.resolve();
    });
    // Mid-teardown neither push has run yet.
    expect(seeded).not.toHaveBeenCalled();

    await act(async () => {
      emitEvent("vpn-status", { status: "disconnected" });
      await reconnectPromise;
    });

    // The SEEDED variant ran exactly once for the active config, strictly between the teardown
    // vpn_disconnect and the reconnect vpn_connect. The plain push did NOT run (the seeded variant
    // supersedes it on the teardown path — single probe).
    expect(seeded).toHaveBeenCalledTimes(1);
    expect(seeded).toHaveBeenCalledWith(CONFIG.configPath);
    expect(plain).not.toHaveBeenCalled();
    expect(disconnectsAtPush).toBe(1);
    expect(connectsAtPush).toBe(0);
  });

  it("BUG-B B1: a THROW inside the seeded push does NOT abort the reconnect (non-blocking)", async () => {
    // The seeded variant catches every invoke internally, but harden the contract: even if it rejected,
    // the reconnect must still reach vpn_connect (the seed is a UI nicety, never a gate on the connect).
    const seeded = vi.fn(async () => {
      throw new Error("probe blew up");
    });
    const { hook } = renderReconnectHarness("connected", { pushPendingConnectPingSeeded: seeded });

    let reconnectPromise: Promise<void>;
    await act(async () => {
      reconnectPromise = hook.result.current.actions.handleReconnect();
      await Promise.resolve();
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "disconnected" });
      await reconnectPromise.catch(() => {});
    });

    // Even though the seed threw, the reconnect still fired vpn_connect for the active config.
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("vpn_connect", {
      configPath: CONFIG.configPath,
      logLevel: CONFIG.logLevel,
    });
  });

  it("Fable-A #6: raises the pending intent with the RECONNECT hint (isSwitch: false → «Настройки применены» start plate)", async () => {
    // A save-and-reconnect and a manual switch BOTH carry origin=Manual, so the Rust seam needs
    // the explicit hint. The FE call is unchanged (isSwitch:false); the Rust picker now maps that hint
    // to the voluntary `applyingSettings` start plate (Phase 22 UAT — was `reconnecting`, whose
    // link-drop copy read wrong for a deliberate save), while the manual switch stays on `switching`.
    const { hook } = renderReconnectHarness("connected");

    let reconnectPromise: Promise<void>;
    await act(async () => {
      reconnectPromise = hook.result.current.actions.handleReconnect();
      await Promise.resolve();
    });

    expect(vi.mocked(invoke)).toHaveBeenCalledWith("set_switch_or_reconnect_pending", {
      pending: true,
      isSwitch: false,
    });

    await act(async () => {
      emitEvent("vpn-status", { status: "disconnected" });
      await reconnectPromise;
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Phase 11 (P11-04 / D-20) — switchTo: MANUAL config switch is a PLAIN
// disconnect→connect of the selected config through the existing VPN commands,
// reusing handleReconnect's teardown-wait, marking the manifest last-used on
// connect. NO new VpnStatus value, NO `switching` wire-state, NO VPN-core change.
// A brief gap during the switch is acceptable (P11-04).
// ─────────────────────────────────────────────────────────────────────────
describe("useVpnActions.switchTo (Phase 11 — manual switch = disconnect→connect)", () => {
  const OTHER_PATH = "/other-config.json";

  beforeEach(() => {
    vi.clearAllMocks();
    setupListenMock();
    i18n.changeLanguage("ru");
    vi.mocked(invoke).mockResolvedValue(null);
  });

  it("from CONNECTED: tears down (vpn_disconnect) THEN connects the new path THEN marks last-used (order verified)", async () => {
    // list_configs resolves the manifest id for OTHER_PATH so set_last_used can mark it.
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_configs") {
        return [{ id: "other-id", path: OTHER_PATH }];
      }
      return null;
    });

    const { hook } = renderReconnectHarness("connected");

    let switchPromise: Promise<{ ok: boolean }>;
    await act(async () => {
      switchPromise = hook.result.current.actions.switchTo(OTHER_PATH);
      // Let the synchronous setStatus("disconnecting") + the vpn_disconnect microtask
      // settle so the teardown-wait is armed before we deliver the disconnected event.
      await Promise.resolve();
    });

    // Deliver the real "disconnected" event (sidecar torn down) → resolves the
    // teardown-wait promise and lets the connect proceed.
    await act(async () => {
      emitEvent("vpn-status", { status: "disconnected" });
      await switchPromise;
    });

    // Assert the call ORDER: vpn_disconnect → vpn_connect(newPath) → set_last_used.
    const calls = vi.mocked(invoke).mock.calls.map((c) => c[0]);
    const disconnectIdx = calls.indexOf("vpn_disconnect");
    const connectIdx = calls.indexOf("vpn_connect");
    const lastUsedIdx = calls.indexOf("set_last_used");
    expect(disconnectIdx).toBeGreaterThanOrEqual(0);
    expect(connectIdx).toBeGreaterThan(disconnectIdx);
    expect(lastUsedIdx).toBeGreaterThan(connectIdx);

    // vpn_connect targeted the SELECTED path (not the app-level config.configPath).
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("vpn_connect", {
      configPath: OTHER_PATH,
      logLevel: "info",
    });
    // set_last_used was called with the manifest id resolved from the path.
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("set_last_used", { id: "other-id" });
  });

  it("from DISCONNECTED: connects directly (no teardown) THEN marks last-used", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_configs") {
        return [{ id: "other-id", path: OTHER_PATH }];
      }
      return null;
    });

    const { hook } = renderReconnectHarness("disconnected");

    await act(async () => {
      await hook.result.current.actions.switchTo(OTHER_PATH);
    });

    // No teardown from a disconnected state.
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("vpn_disconnect");
    // Connected the selected path and marked it last-used.
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("vpn_connect", {
      configPath: OTHER_PATH,
      logLevel: "info",
    });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("set_last_used", { id: "other-id" });
  });

  it("a disconnect REJECT aborts cleanly (no hang, no connect) → status 'error'", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "vpn_disconnect") throw new Error("Lock error");
      return null;
    });

    const { hook } = renderReconnectHarness("connected");

    // No disconnected event will ever fire on a reject — switchTo must NOT hang on the
    // teardown-wait; it returns straight away with an error status.
    await act(async () => {
      await hook.result.current.actions.switchTo(OTHER_PATH);
    });

    expect(hook.result.current.status).toBe("error");
    // The new config was NEVER connected (we aborted before the connect step).
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(
      "vpn_connect",
      expect.objectContaining({ configPath: OTHER_PATH }),
    );
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("set_last_used", expect.anything());
  });

  it("a failed set_last_used does NOT undo the successful connect (best-effort marker)", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_configs") throw new Error("manifest read failed");
      return null;
    });

    const { hook } = renderReconnectHarness("disconnected");

    await act(async () => {
      await hook.result.current.actions.switchTo(OTHER_PATH);
    });

    // The connect succeeded — the status is NOT flipped to error by a marker failure.
    expect(hook.result.current.status).not.toBe("error");
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("vpn_connect", {
      configPath: OTHER_PATH,
      logLevel: "info",
    });
  });

  it("BL-01: raises the switch/reconnect-pending signal BEFORE the teardown (from CONNECTED) and clears it on completion", async () => {
    // A manual «Переключиться» from a live session is disconnect→connect; its teardown
    // Disconnected must be suppressed by the Rust decider. switchTo must set
    // set_switch_or_reconnect_pending(true) BEFORE the vpn_disconnect and clear it (false)
    // once the switch completes.
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_configs") return [{ id: "other-id", path: OTHER_PATH }];
      return null;
    });
    const { hook } = renderReconnectHarness("connected");

    let switchPromise: Promise<{ ok: boolean }>;
    await act(async () => {
      switchPromise = hook.result.current.actions.switchTo(OTHER_PATH);
      await Promise.resolve();
    });

    const calls = vi.mocked(invoke).mock.calls;
    const pendingTrueIdx = calls.findIndex(
      (c) => c[0] === "set_switch_or_reconnect_pending" && (c[1] as { pending: boolean }).pending === true,
    );
    const disconnectIdx = calls.findIndex((c) => c[0] === "vpn_disconnect");
    expect(pendingTrueIdx).toBeGreaterThanOrEqual(0);
    expect(disconnectIdx).toBeGreaterThan(pendingTrueIdx);

    await act(async () => {
      emitEvent("vpn-status", { status: "disconnected" });
      await switchPromise;
    });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("set_switch_or_reconnect_pending", {
      pending: false,
    });
  });

  it("BL-01: from DISCONNECTED (no teardown) does NOT raise the pending signal", async () => {
    // Connecting directly from a disconnected state has NO teardown Disconnected to
    // suppress, so switchTo must NOT set the pending signal true (the origin/label path
    // handles the destination plate). This keeps the signal reserved for real teardowns.
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_configs") return [{ id: "other-id", path: OTHER_PATH }];
      return null;
    });
    const { hook } = renderReconnectHarness("disconnected");

    await act(async () => {
      await hook.result.current.actions.switchTo(OTHER_PATH);
    });

    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(
      "set_switch_or_reconnect_pending",
      { pending: true },
    );
  });

  it("BL-01: a teardown REJECT clears the pending signal (no latch)", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "vpn_disconnect") throw new Error("Lock error");
      return null;
    });
    const { hook } = renderReconnectHarness("connected");

    await act(async () => {
      await hook.result.current.actions.switchTo(OTHER_PATH);
    });

    expect(hook.result.current.status).toBe("error");
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("set_switch_or_reconnect_pending", {
      pending: false,
    });
  });

  it("Fable-A #6: raises the pending intent with the SWITCH hint (isSwitch: true → neutral «Переключаю сервер…» start plate)", async () => {
    // A MANUAL server switch shares origin=Manual with the save-and-reconnect, so without the
    // hint the Rust seam fired the `reconnecting` start plate whose body «Связь прервалась —
    // восстанавливаю» falsely claimed the link dropped — the user just picked another healthy
    // server. The explicit isSwitch:true routes it to the neutral `switching` plate instead
    // (the auto-switch also flows through switchTo, so it keeps `switching` unchanged).
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_configs") return [{ id: "other-id", path: OTHER_PATH }];
      return null;
    });
    const { hook } = renderReconnectHarness("connected");

    let switchPromise: Promise<{ ok: boolean }>;
    await act(async () => {
      switchPromise = hook.result.current.actions.switchTo(OTHER_PATH);
      await Promise.resolve();
    });

    expect(vi.mocked(invoke)).toHaveBeenCalledWith("set_switch_or_reconnect_pending", {
      pending: true,
      isSwitch: true,
    });

    await act(async () => {
      emitEvent("vpn-status", { status: "disconnected" });
      await switchPromise;
    });
  });

  // ─── Phase 14 (14-04): switchTo surfaces an explicit { ok } result ───
  //
  // D-05/D-05-impl: the App revert orchestration needs a TESTABLE signal that B failed to
  // connect so it can re-point to A. switchTo now RESOLVES to { ok: boolean } — ok:true on a
  // successful vpn_connect (the path that reaches set_last_used), ok:false on the connect catch
  // that sets status=error. Everything else about its contract (teardown-only-when-live, the
  // reject-abort, the pending signal, set_last_used) is UNCHANGED — the { ok } is purely additive.
  it("14-04: resolves { ok: true } when the connect succeeds (from DISCONNECTED)", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_configs") return [{ id: "other-id", path: OTHER_PATH }];
      return null;
    });
    const { hook } = renderReconnectHarness("disconnected");

    let result: { ok: boolean } | undefined;
    await act(async () => {
      result = await hook.result.current.actions.switchTo(OTHER_PATH);
    });

    expect(result).toEqual({ ok: true });
    expect(hook.result.current.status).not.toBe("error");
  });

  it("3.5 F-VERDICT: a NO-SPAWN supersede resolves { ok:false, superseded:true } and does NOT stamp last-used", async () => {
    // vpn_connect bailed (a genuine disconnect landed mid-connect) → ConnectOutcome { spawned:false }.
    // switchTo reports the supersede distinctly (so performSwitch skips the 15s park + the revert), and
    // it must NOT mark the path last-used (no live session was created).
    const calls: string[] = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "list_configs") return [{ id: "other-id", path: OTHER_PATH }];
      if (cmd === "vpn_connect") return { spawned: false, reason: "superseded-by-disconnect" };
      return null;
    });
    const { hook } = renderReconnectHarness("disconnected");

    let result: { ok: boolean; superseded?: boolean } | undefined;
    await act(async () => {
      result = await hook.result.current.actions.switchTo(OTHER_PATH);
    });

    expect(result).toEqual({ ok: false, superseded: true });
    expect(calls).not.toContain("set_last_used"); // no last-used stamp for a superseded connect
    expect(hook.result.current.status).not.toBe("error"); // a supersede is NOT a failure
  });

  it("14-04: resolves { ok: false } when the connect leg rejects (status → error)", async () => {
    // vpn_connect rejects → switchTo's connect catch sets status=error; the result carries ok:false
    // so the App can trigger the revert-to-previous. switchTo STILL never rejects (the caller awaits
    // a resolved result, not a thrown error).
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "vpn_connect") throw new Error("B connect failed");
      return null;
    });
    const { hook } = renderReconnectHarness("disconnected");

    let result: { ok: boolean } | undefined;
    await act(async () => {
      // Must NOT throw — it resolves to a result the caller reads.
      result = await hook.result.current.actions.switchTo(OTHER_PATH);
    });

    expect(result).toEqual({ ok: false });
    expect(hook.result.current.status).toBe("error");
  });

  it("14-04: resolves { ok: false } on a teardown REJECT (from CONNECTED, no connect attempted)", async () => {
    // A teardown reject aborts before the connect — the switch did NOT reach B, so the result is
    // ok:false (the App's revert re-points to A, which is still the connected server anyway).
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "vpn_disconnect") throw new Error("Lock error");
      return null;
    });
    const { hook } = renderReconnectHarness("connected");

    let result: { ok: boolean } | undefined;
    await act(async () => {
      result = await hook.result.current.actions.switchTo(OTHER_PATH);
    });

    expect(result).toEqual({ ok: false });
    expect(hook.result.current.status).toBe("error");
  });

  it("14-04: resolves { ok: false } when no path is given (guard path)", async () => {
    const { hook } = renderReconnectHarness("disconnected");

    let result: { ok: boolean } | undefined;
    await act(async () => {
      result = await hook.result.current.actions.switchTo("");
    });

    expect(result).toEqual({ ok: false });
    expect(hook.result.current.status).toBe("error");
  });

  // ─── Phase 14 (FAB-07): the revert leg's skipTeardown ───
  // The App revert reconnects A from an ALREADY-settled error/disconnected state — there is no live
  // tunnel to tear down. switchTo(path, { skipTeardown: true }) must go STRAIGHT to vpn_connect
  // WITHOUT a vpn_disconnect, even if the status happens to read connected/connecting. This avoids a
  // spurious second teardown that (if it rejected) would abort the revert without ever reconnecting A.
  it("FAB-07: skipTeardown goes straight to vpn_connect (no vpn_disconnect) even from CONNECTED", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_configs") return [{ id: "other-id", path: OTHER_PATH }];
      return null;
    });
    // Status reads "connected" — normally that would trigger a teardown; skipTeardown must bypass it.
    const { hook } = renderReconnectHarness("connected");

    let result: { ok: boolean } | undefined;
    await act(async () => {
      result = await hook.result.current.actions.switchTo(OTHER_PATH, { skipTeardown: true });
    });

    // No teardown was performed — the revert connects A directly.
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("vpn_disconnect");
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("vpn_connect", {
      configPath: OTHER_PATH,
      logLevel: "info",
    });
    expect(result).toEqual({ ok: true });
  });

  // ─── Phase 14 (FAB-02): stampLastUsed:false defers the last-used marker ───
  // A vpn_connect ACCEPT only means the process spawned — a spawned config can still die
  // never-connected. So the forward switch passes stampLastUsed:false and the App stamps last-used
  // only after the terminal `connected` edge (via the exported markLastUsed). switchTo must NOT call
  // set_last_used when stampLastUsed:false, even on a successful spawn-accept.
  it("FAB-02: stampLastUsed:false does NOT call set_last_used on a spawn-accept", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_configs") return [{ id: "other-id", path: OTHER_PATH }];
      return null;
    });
    const { hook } = renderReconnectHarness("disconnected");

    let result: { ok: boolean } | undefined;
    await act(async () => {
      result = await hook.result.current.actions.switchTo(OTHER_PATH, { stampLastUsed: false });
    });

    // The connect was accepted (ok:true) but last-used was NOT stamped — the App does that after the
    // terminal connected edge.
    expect(result).toEqual({ ok: true });
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("set_last_used", expect.anything());
  });

  // The DEFAULT (no opts) still stamps last-used on accept — direct callers / the revert's A keep it.
  it("FAB-02: the default (stampLastUsed omitted) still stamps last-used on accept", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_configs") return [{ id: "other-id", path: OTHER_PATH }];
      return null;
    });
    const { hook } = renderReconnectHarness("disconnected");

    await act(async () => {
      await hook.result.current.actions.switchTo(OTHER_PATH);
    });

    expect(vi.mocked(invoke)).toHaveBeenCalledWith("set_last_used", { id: "other-id" });
  });

  // markLastUsed is exported so the App can stamp last-used after the terminal connected edge.
  it("FAB-02: markLastUsed(path) resolves the id from the manifest and stamps set_last_used", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_configs") return [{ id: "other-id", path: OTHER_PATH }];
      return null;
    });
    const { hook } = renderReconnectHarness("connected");

    await act(async () => {
      await hook.result.current.actions.markLastUsed(OTHER_PATH);
    });

    expect(vi.mocked(invoke)).toHaveBeenCalledWith("set_last_used", { id: "other-id" });
  });

  // ─── BUG-B (17-uat) B1: switchTo seeds the destination's active card POST-teardown ───
  // A manual «Переключиться» from a LIVE tunnel used to push the destination's connect ping BEFORE the
  // teardown (riding tunnel A → through-tunnel garbage) and never seeded the active card → the
  // switched-to card fell to «● —». switchTo now runs the SEEDED probe+push once, AFTER teardownSettled
  // (destination genuinely inactive → honest DIRECT probe) and BEFORE the destination vpn_connect, when
  // the caller passes seedAfterTeardown:true (the MANUAL performSwitch path only).
  it("BUG-B B1: from CONNECTED with seedAfterTeardown, runs the SEEDED push once between the teardown and the destination vpn_connect", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_configs") return [{ id: "other-id", path: OTHER_PATH }];
      return null;
    });
    let disconnectsAtPush = -1;
    let connectsAtPush = -1;
    const seeded = vi.fn(async () => {
      const names = vi.mocked(invoke).mock.calls.map((c) => c[0]);
      disconnectsAtPush = names.filter((n) => n === "vpn_disconnect").length;
      connectsAtPush = names.filter((n) => n === "vpn_connect").length;
    });
    const { hook } = renderReconnectHarness("connected", { pushPendingConnectPingSeeded: seeded });

    let switchPromise: Promise<{ ok: boolean }>;
    await act(async () => {
      switchPromise = hook.result.current.actions.switchTo(OTHER_PATH, { seedAfterTeardown: true });
      await Promise.resolve();
    });
    // Mid-teardown the seed has NOT run yet (it waits for the teardown-settled event).
    expect(seeded).not.toHaveBeenCalled();

    await act(async () => {
      emitEvent("vpn-status", { status: "disconnected" });
      await switchPromise;
    });

    // The seed ran exactly once for the DESTINATION path, strictly between the teardown vpn_disconnect
    // and the destination vpn_connect (single honest post-teardown probe).
    expect(seeded).toHaveBeenCalledTimes(1);
    expect(seeded).toHaveBeenCalledWith(OTHER_PATH);
    expect(disconnectsAtPush).toBe(1);
    expect(connectsAtPush).toBe(0);
  });

  it("BUG-B B1: WITHOUT seedAfterTeardown the seeded push does NOT run (auto-switch / non-seeding callers)", async () => {
    // The auto-switch flows through switchTo too but stamps its own AutoSwitch origin inside the seam —
    // it must NOT re-run the Manual seeded push. So a switchTo WITHOUT seedAfterTeardown never calls it.
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_configs") return [{ id: "other-id", path: OTHER_PATH }];
      return null;
    });
    const seeded = vi.fn(async () => {});
    const { hook } = renderReconnectHarness("connected", { pushPendingConnectPingSeeded: seeded });

    let switchPromise: Promise<{ ok: boolean }>;
    await act(async () => {
      switchPromise = hook.result.current.actions.switchTo(OTHER_PATH);
      await Promise.resolve();
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "disconnected" });
      await switchPromise;
    });

    expect(seeded).not.toHaveBeenCalled();
  });

  it("BUG-B B1: from DISCONNECTED (no teardown) the seeded push does NOT run even with seedAfterTeardown", async () => {
    // A direct connect from disconnected has NO teardown — the seeded post-teardown push is inside the
    // teardown block, so it never fires. The direct-connect path seeds via performSwitch's pre-switchTo
    // pushPendingConnectPing instead (honest, since there is no tunnel). No double-probe.
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_configs") return [{ id: "other-id", path: OTHER_PATH }];
      return null;
    });
    const seeded = vi.fn(async () => {});
    const { hook } = renderReconnectHarness("disconnected", { pushPendingConnectPingSeeded: seeded });

    await act(async () => {
      await hook.result.current.actions.switchTo(OTHER_PATH, { seedAfterTeardown: true });
    });

    // No teardown ran → the seeded push (inside the teardown block) was skipped.
    expect(seeded).not.toHaveBeenCalled();
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("vpn_disconnect");
  });
});
