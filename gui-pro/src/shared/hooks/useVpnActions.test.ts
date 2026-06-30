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
function renderReconnectHarness(initialStatus: VpnStatus) {
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

    let switchPromise: Promise<void>;
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
});
