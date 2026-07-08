import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../i18n";
import { useVpnEvents } from "./useVpnEvents";
import type { VpnStatus } from "../types";

// ─────────────────────────────────────────────────────────────────────────
// Tauri event-listener mock (codebase TESTING.md pattern):
// capture each registered callback by event name, count active listeners,
// and let tests emit synthetic events into the registered callbacks.
// `listen()` resolves to an UnlistenFn that decrements the live count, so
// tests can assert exactly-one-listener after a mount/unmount/mount cycle.
// ─────────────────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ListenCallback = (event: { payload: any }) => void;
let listenCallbacks: Record<string, ListenCallback[]> = {};
let liveListenerCount: Record<string, number> = {};

function setupListenMock() {
  listenCallbacks = {};
  liveListenerCount = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(listen).mockImplementation(async (eventName: string, callback: any) => {
    if (!listenCallbacks[eventName]) listenCallbacks[eventName] = [];
    listenCallbacks[eventName].push(callback);
    liveListenerCount[eventName] = (liveListenerCount[eventName] ?? 0) + 1;
    // UnlistenFn — decrements the live count for this event.
    return () => {
      liveListenerCount[eventName] = (liveListenerCount[eventName] ?? 1) - 1;
    };
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function emitEvent(eventName: string, payload: any) {
  const cbs = listenCallbacks[eventName] || [];
  cbs.forEach((cb) => cb({ payload }));
}

function makeParams() {
  const setStatus = vi.fn();
  const setError = vi.fn();
  const setConnectedSince = vi.fn();
  const setVpnLogs = vi.fn();
  const pushSuccess = vi.fn();
  const reconnectResolve = { current: null as null | (() => void) };
  return {
    setStatus,
    setError,
    setConnectedSince,
    setVpnLogs,
    pushSuccess,
    reconnectResolve,
    params: {
      i18n,
      setStatus,
      setError,
      setConnectedSince,
      setVpnLogs,
      pushSuccess,
      reconnectResolve,
    },
  };
}

// The 4 fatal markers the backend now emits VpnStatus::Error for (plan 01-01).
// The frontend must NO LONGER infer status from these log lines (D-07).
const FATAL_LOG_LINES = [
  "Authorization Required",
  "WintunCreateAdapter cannot find module",
  "Failed to create listener on port 1080",
  "Connection refused by remote host",
];

describe("useVpnEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupListenMock();
    i18n.changeLanguage("ru");
  });

  // ──────────────────────────────────────────────────────────
  // Status source of truth: status comes ONLY from vpn-status (D-07)
  // ──────────────────────────────────────────────────────────

  it.each(FATAL_LOG_LINES)(
    "fatal vpn-log line %s sets error message but NEVER status",
    async (line) => {
      const { setStatus, setError, params } = makeParams();

      await act(async () => {
        renderHook(() => useVpnEvents(params));
      });
      // Snapshot-on-mount may have set status via check_vpn_status — ignore those
      // and only assert that the vpn-log path itself does not touch setStatus.
      setStatus.mockClear();

      await act(async () => {
        // WR-04: the real backend payload is { message, level } — there is no
        // `source` field. Feed the production shape so the test exercises the
        // actual path instead of a synthetic field the backend never sends.
        emitEvent("vpn-log", { message: line, level: "error" });
      });

      // Removal contract: the friendly message still surfaces …
      expect(setError).toHaveBeenCalled();
      // … but the vpn-log path must NOT set status anymore (it arrives via vpn-status).
      expect(setStatus).not.toHaveBeenCalled();
    },
  );

  it("the 'Failed to setup adapter: Timed out' line no longer sets status", async () => {
    const { setStatus, setError, params } = makeParams();

    await act(async () => {
      renderHook(() => useVpnEvents(params));
    });
    setStatus.mockClear();

    await act(async () => {
      emitEvent("vpn-log", { message: "Failed to setup adapter: Timed out", level: "error" });
    });

    expect(setError).toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("vpn-log fatal line still appends to the log buffer", async () => {
    const { setVpnLogs, params } = makeParams();

    await act(async () => {
      renderHook(() => useVpnEvents(params));
    });
    setVpnLogs.mockClear();

    await act(async () => {
      emitEvent("vpn-log", { message: "Authorization Required", level: "error" });
    });

    expect(setVpnLogs).toHaveBeenCalled();
  });

  it("a vpn-status 'error' event IS the sole source of error status", async () => {
    const { setStatus, setError, params } = makeParams();

    await act(async () => {
      renderHook(() => useVpnEvents(params));
    });
    setStatus.mockClear();

    await act(async () => {
      emitEvent("vpn-status", { status: "error" as VpnStatus, error: "Authorization failed" });
    });

    // setStatus is called with an updater fn; resolve it to assert the result.
    expect(setStatus).toHaveBeenCalled();
    const calls = setStatus.mock.calls;
    const updater = calls[calls.length - 1]?.[0];
    const resolved = typeof updater === "function" ? updater("connecting") : updater;
    expect(resolved).toBe("error");
    // F16: the core's fixed «Authorization failed» phrase is now localized, not raw.
    expect(setError).toHaveBeenCalledWith(i18n.t("errors.auth_required"));
  });

  it("clears the stale error on a 'connected' vpn-status after a prior error (WR-01)", async () => {
    // WR-01: when connectivity drops, the internet-status listener sets an error
    // message ("internet lost"). A Rust-driven auto-reconnect then recovers the
    // session via a vpn-status "connected" event — it does NOT go through
    // handleConnect (the manual path that used to be the only place clearing the
    // error). The connected transition must clear the error itself, otherwise the
    // red recovery banner lingers over the green Connected badge.
    const { setStatus, setError, params } = makeParams();

    await act(async () => {
      renderHook(() => useVpnEvents(params));
    });

    // Simulate a prior connectivity-loss error, then a successful auto-reconnect.
    await act(async () => {
      emitEvent("internet-status", { online: false, action: "disconnect" });
    });
    setError.mockClear();
    setStatus.mockClear();

    await act(async () => {
      emitEvent("vpn-status", { status: "connected" as VpnStatus });
    });

    // The "connected" branch (incl. setError(null)) lives inside the setStatus
    // updater. setStatus is a mock that does not run its updater, so we resolve
    // it here — simulating React applying the state update from a "recovering"
    // prev — which is what triggers the connected-transition side effects.
    const calls = setStatus.mock.calls;
    const updater = calls[calls.length - 1]?.[0];
    const resolved = typeof updater === "function" ? updater("recovering") : updater;
    expect(resolved).toBe("connected");

    // The connected transition clears the lingering recovery/error message.
    expect(setError).toHaveBeenCalledWith(null);
  });

  // ──────────────────────────────────────────────────────────
  // Late-mount snapshot: a window mounting mid-reconnect (Plan 02-08, T-08-02)
  // ──────────────────────────────────────────────────────────

  it("a check_vpn_status_full snapshot of 'recovering' sets status recovering (not disconnected)", async () => {
    // Plan 02-08 — the backend no longer collapses Reconnecting → disconnected, so
    // the mount snapshot returns the canonical "recovering" string while the Rust
    // supervisor retries. A window mounting mid-reconnect must render the recovering
    // label from that snapshot, NOT fall through to the disconnected else-branch.
    const { setStatus, setConnectedSince, params } = makeParams();
    vi.mocked(invoke).mockResolvedValueOnce({ status: "recovering", error: null });

    await act(async () => {
      renderHook(() => useVpnEvents(params));
      // Let the snapshot promise (.then) settle so the mount handler runs.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setStatus).toHaveBeenCalledWith("recovering");
    // recovering means the session is NOT up — connectedSince is cleared.
    expect(setConnectedSince).toHaveBeenCalledWith(null);
  });

  it("F-9: a check_vpn_status_full snapshot of 'disconnecting' sets status disconnecting (not disconnected)", async () => {
    // F-9 (Fable-5): a window mounting mid-teardown (the 3.4 Disconnecting transient can be in flight
    // up to ~7s under 3.2) must render «Отключение» from the snapshot, NOT collapse to the
    // disconnected else-branch (which briefly lied "disconnected" until the real Disconnected landed).
    const { setStatus, setConnectedSince, params } = makeParams();
    vi.mocked(invoke).mockResolvedValueOnce({ status: "disconnecting", error: null });

    await act(async () => {
      renderHook(() => useVpnEvents(params));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setStatus).toHaveBeenCalledWith("disconnecting");
    expect(setConnectedSince).toHaveBeenCalledWith(null);
  });

  // ──────────────────────────────────────────────────────────
  // SAFETY-03: the `connect-timeout` reason code renders LOCALIZED,
  // never the raw code (Plan 02-02 Task 2).
  // ──────────────────────────────────────────────────────────

  it("maps the connect-timeout reason code to a localized message (ru)", async () => {
    const { setError, params } = makeParams();
    i18n.changeLanguage("ru");

    await act(async () => {
      renderHook(() => useVpnEvents(params));
    });
    setError.mockClear();

    await act(async () => {
      emitEvent("vpn-status", { status: "error" as VpnStatus, error: "connect-timeout" });
    });

    // The raw stable code must NEVER reach the UI — it is localized first.
    expect(setError).toHaveBeenCalledWith(i18n.t("errors.connect_timeout"));
    expect(setError).not.toHaveBeenCalledWith("connect-timeout");
    // And the resolved string is the Russian (primary) wording, not the code.
    expect(i18n.t("errors.connect_timeout")).toBe("Не удалось подключиться. Проверьте сервер и интернет-соединение.");
  });

  it("maps the reconnect-gave-up reason code to a localized message (ru)", async () => {
    // 02-04: the Rust reconnect supervisor sets a terminal Error carrying the stable
    // `reconnect-gave-up` code after 3 failed attempts. It must render LOCALIZED —
    // the user never sees the raw ASCII code (CLAUDE.md i18n rule).
    const { setError, params } = makeParams();
    i18n.changeLanguage("ru");

    await act(async () => {
      renderHook(() => useVpnEvents(params));
    });
    setError.mockClear();

    await act(async () => {
      emitEvent("vpn-status", { status: "error" as VpnStatus, error: "reconnect-gave-up" });
    });

    expect(setError).toHaveBeenCalledWith(i18n.t("errors.reconnect_gave_up"));
    expect(setError).not.toHaveBeenCalledWith("reconnect-gave-up");
    // The resolved string is the Russian (primary) wording, not the code.
    expect(i18n.t("errors.reconnect_gave_up")).toBe("Не удалось переподключиться");
  });

  it("maps the no-internet reason code to a localized message (ru)", async () => {
    // 02-09 (UAT Gap #2): a never-connected exit while the pre-flight saw the network
    // offline carries the stable `no-internet` code. It must render LOCALIZED — the
    // user never sees the raw code, and NEVER the old "Process exited with code N".
    const { setError, params } = makeParams();
    i18n.changeLanguage("ru");

    await act(async () => {
      renderHook(() => useVpnEvents(params));
    });
    setError.mockClear();

    await act(async () => {
      emitEvent("vpn-status", { status: "error" as VpnStatus, error: "no-internet" });
    });

    expect(setError).toHaveBeenCalledWith(i18n.t("errors.no_internet"));
    expect(setError).not.toHaveBeenCalledWith("no-internet");
    // The resolved string is the friendly Russian (primary) wording, not the code.
    expect(i18n.t("errors.no_internet")).toBe("Нет подключения к интернету. Проверьте сеть.");
  });

  it("maps the sidecar-exit reason code to a localized message (ru)", async () => {
    // 02-09 (UAT Gap #2): a generic never-connected VPN-core failure (also an AV /
    // Task-Manager kill mid-connect) carries the stable `sidecar-exit` code. It must
    // render LOCALIZED, not as the raw code or a raw exit-code string.
    const { setError, params } = makeParams();
    i18n.changeLanguage("ru");

    await act(async () => {
      renderHook(() => useVpnEvents(params));
    });
    setError.mockClear();

    await act(async () => {
      emitEvent("vpn-status", { status: "error" as VpnStatus, error: "sidecar-exit" });
    });

    expect(setError).toHaveBeenCalledWith(i18n.t("errors.sidecar_exit"));
    expect(setError).not.toHaveBeenCalledWith("sidecar-exit");
    expect(i18n.t("errors.sidecar_exit")).toBe(
      "VPN-ядро неожиданно завершилось. Попробуйте подключиться снова.",
    );
  });

  it("maps the recovery-timeout reason code to a localized message (ru)", async () => {
    // 02-20: when the local network never returns within RECOVERY_TIMEOUT the Rust
    // adapter-wait emits a terminal Error carrying the stable `recovery-timeout` code.
    // It must render LOCALIZED — the user never sees the raw ASCII code.
    const { setError, params } = makeParams();
    i18n.changeLanguage("ru");

    await act(async () => {
      renderHook(() => useVpnEvents(params));
    });
    setError.mockClear();

    await act(async () => {
      emitEvent("vpn-status", { status: "error" as VpnStatus, error: "recovery-timeout" });
    });

    expect(setError).toHaveBeenCalledWith(i18n.t("errors.recovery_timeout"));
    expect(setError).not.toHaveBeenCalledWith("recovery-timeout");
    expect(i18n.t("errors.recovery_timeout")).toBe(
      "Не удалось восстановить связь. Проверьте подключение к интернету.",
    );
  });

  // ──────────────────────────────────────────────────────────
  // 02-20 status-UX split: reconcile the two event sources
  // ──────────────────────────────────────────────────────────

  it("surfaces the per-attempt «Попытка N/3» counter from a reconnecting vpn-status payload", async () => {
    // 02-20: a server-lost auto-retry event carries attempt/max. They must be stored
    // (via setReconnectProgress) so StatusPanel can render «Попытка N/3».
    const setReconnectProgress = vi.fn();
    const { params } = makeParams();

    await act(async () => {
      renderHook(() => useVpnEvents({ ...params, setReconnectProgress }));
    });
    setReconnectProgress.mockClear();

    await act(async () => {
      emitEvent("vpn-status", { status: "reconnecting" as VpnStatus, error: null, attempt: 2, max: 3 });
    });

    expect(setReconnectProgress).toHaveBeenCalledWith({ attempt: 2, max: 3 });
  });

  it("clears the attempt counter when status leaves reconnecting", async () => {
    // The counter must not linger over a later «Подключено» / «Восстановление» /
    // «Отключено». Any non-reconnecting (or reconnecting-without-attempt) event clears it.
    const setReconnectProgress = vi.fn();
    const { params } = makeParams();

    await act(async () => {
      renderHook(() => useVpnEvents({ ...params, setReconnectProgress }));
    });
    setReconnectProgress.mockClear();

    await act(async () => {
      emitEvent("vpn-status", { status: "connected" as VpnStatus });
    });

    expect(setReconnectProgress).toHaveBeenCalledWith(null);
  });

  it("AUDIT #8: keeps 'reconnecting' over an intermediate 'disconnected' WHILE a manual reconnect is in flight", async () => {
    // Re-pinned (AUDIT-2026-06-11 #8): this test used to pin UNCONDITIONAL suppression
    // (any prev="reconnecting" ate "disconnected"), which is the bug — a tray disconnect
    // during a backend auto-reconnect was swallowed and the UI stuck on «Переподключение»
    // forever. The no-dwell suppression now applies ONLY while the shared
    // manualReconnectActiveRef is raised (useVpnActions.handleReconnect in flight).
    const { setStatus, params } = makeParams();
    const manualReconnectActiveRef = { current: true };

    await act(async () => {
      renderHook(() => useVpnEvents({ ...params, manualReconnectActiveRef }));
    });
    setStatus.mockClear();

    await act(async () => {
      emitEvent("vpn-status", { status: "disconnected" as VpnStatus });
    });

    const calls = setStatus.mock.calls;
    const updater = calls[calls.length - 1]?.[0];
    const resolved = typeof updater === "function" ? updater("reconnecting") : updater;
    expect(resolved).toBe("reconnecting");
  });

  it("AUDIT #8: a real terminal 'disconnected' during an AUTO-reconnect COMMITS (no manual reconnect in flight)", async () => {
    // Tray disconnect while the Rust supervisor is retrying: the backend emits a single
    // bare "disconnected" (no intermediate status, D-09) and prev is "reconnecting" from
    // the supervisor's attempt events. With no manual reconnect in flight the guard must
    // let it through — suppressing it left the window on «Переподключение» with a grey
    // tray and a dead Ctrl+Shift+C, recoverable only by another manual action.
    const { setStatus, params } = makeParams();
    const manualReconnectActiveRef = { current: false };

    await act(async () => {
      renderHook(() => useVpnEvents({ ...params, manualReconnectActiveRef }));
    });
    setStatus.mockClear();

    await act(async () => {
      emitEvent("vpn-status", { status: "disconnected" as VpnStatus });
    });

    const calls = setStatus.mock.calls;
    const updater = calls[calls.length - 1]?.[0];
    const resolved = typeof updater === "function" ? updater("reconnecting") : updater;
    expect(resolved).toBe("disconnected");
  });

  it("3.4 R-DCT: 'disconnecting' stops uptime; a prev='disconnecting' disconnected fires «VPN отключён»", async () => {
    // With the real Disconnecting wire status, a genuine user disconnect arrives as
    // Connected → Disconnecting → Disconnected. The teardown status must stop the uptime clock, and
    // the SETTLED edge (prev="disconnecting") must still fire the «VPN отключён» snackbar (the old
    // prev==="connected"-only check would have lost it). The snackbar/uptime logic lives inside the
    // setStatus updater, so drive it with the chosen prev like the AUDIT-#8 tests above.
    const { setStatus, setConnectedSince, pushSuccess, params } = makeParams();
    await act(async () => {
      renderHook(() => useVpnEvents(params));
    });
    setStatus.mockClear();
    setConnectedSince.mockClear();
    pushSuccess.mockClear();

    await act(async () => {
      emitEvent("vpn-status", { status: "disconnecting" as VpnStatus });
    });
    const discCalls = setStatus.mock.calls;
    const discUpdater = discCalls[discCalls.length - 1]?.[0];
    if (typeof discUpdater === "function") discUpdater("connected");
    expect(setConnectedSince).toHaveBeenCalledWith(null); // teardown stops the uptime clock

    setStatus.mockClear();
    await act(async () => {
      emitEvent("vpn-status", { status: "disconnected" as VpnStatus });
    });
    const doneCalls = setStatus.mock.calls;
    const doneUpdater = doneCalls[doneCalls.length - 1]?.[0];
    if (typeof doneUpdater === "function") doneUpdater("disconnecting");
    expect(pushSuccess).toHaveBeenCalledWith(i18n.t("messages.vpn_disconnected", "VPN disconnected"));
  });

  it("F7: an armed reconnectResolve latch SUPPRESSES the neutral «VPN отключён» on the teardown leg", async () => {
    // A manual «Сохранить и переподключить» / a manual switch arms `reconnectResolve` before its
    // teardown vpn_disconnect. The teardown's `disconnected` (prev="connected"/"disconnecting") is
    // owned by the SEPARATE reconnect-completion listener (it fulfils the promise) — it is NOT a
    // user-visible disconnect, so the neutral snackbar must be suppressed. This is the restored
    // pre-CA-1 `!reconnectResolve.current` gate (F7): without it the teardown half of every
    // save-and-reconnect / switch flashed «VPN отключён» before the destination «VPN подключён».
    //
    // The status listener is registered BEFORE the reconnect-completion listener, and in production
    // React runs the setStatus updater SYNCHRONOUSLY inside the first listener — so the latch is read
    // while still armed, THEN the completion listener nulls it. Model that ordering faithfully with a
    // setStatus mock that runs its updater synchronously against a held `prev` (a plain deferred mock
    // would read the ref only after the completion listener already nulled it — a harness artifact,
    // not the real ordering).
    const { pushSuccess, reconnectResolve, params } = makeParams();
    let prevStatus: VpnStatus = "connected";
    const setStatusSync = vi.fn((updater: VpnStatus | ((p: VpnStatus) => VpnStatus)) => {
      prevStatus = typeof updater === "function" ? (updater as (p: VpnStatus) => VpnStatus)(prevStatus) : updater;
    });
    const syncParams = { ...params, setStatus: setStatusSync };
    await act(async () => {
      renderHook(() => useVpnEvents(syncParams));
    });
    // Arm the latch exactly as useVpnActions does before the teardown vpn_disconnect.
    reconnectResolve.current = () => {};
    pushSuccess.mockClear();

    await act(async () => {
      emitEvent("vpn-status", { status: "disconnected" as VpnStatus });
    });
    // reconnectPending=true was read while armed → the neutral snackbar is dropped …
    expect(pushSuccess).not.toHaveBeenCalledWith(i18n.t("messages.vpn_disconnected", "VPN disconnected"));
    // … the status still committed (only the snackbar is gated) …
    expect(prevStatus).toBe("disconnected");
    // … and the completion listener consumed + nulled the latch (its only job on this edge).
    expect(reconnectResolve.current).toBeNull();
  });

  it("F7 parity: a genuine user disconnect (latch NOT armed) still fires «VPN отключён»", async () => {
    // The mirror of the test above: with `reconnectResolve` null (a real user «Отключить», no
    // reconnect in flight) the connected→disconnected edge still toasts the neutral snackbar —
    // the restored gate must NOT suppress an ordinary disconnect.
    const { pushSuccess, reconnectResolve, params } = makeParams();
    let prevStatus: VpnStatus = "connected";
    const setStatusSync = vi.fn((updater: VpnStatus | ((p: VpnStatus) => VpnStatus)) => {
      prevStatus = typeof updater === "function" ? (updater as (p: VpnStatus) => VpnStatus)(prevStatus) : updater;
    });
    await act(async () => {
      renderHook(() => useVpnEvents({ ...params, setStatus: setStatusSync }));
    });
    reconnectResolve.current = null; // no reconnect/switch in flight
    pushSuccess.mockClear();

    await act(async () => {
      emitEvent("vpn-status", { status: "disconnected" as VpnStatus });
    });
    expect(pushSuccess).toHaveBeenCalledWith(i18n.t("messages.vpn_disconnected", "VPN disconnected"));
  });

  it("AUDIT #8: with no manualReconnectActiveRef wired at all, 'disconnected' is never suppressed", async () => {
    // The ref param is optional (older call sites / tests). Absent ref must behave like
    // "no manual reconnect in flight" — the safe direction (never suppress).
    const { setStatus, params } = makeParams();

    await act(async () => {
      renderHook(() => useVpnEvents(params));
    });
    setStatus.mockClear();

    await act(async () => {
      emitEvent("vpn-status", { status: "disconnected" as VpnStatus });
    });

    const calls = setStatus.mock.calls;
    const updater = calls[calls.length - 1]?.[0];
    const resolved = typeof updater === "function" ? updater("reconnecting") : updater;
    expect(resolved).toBe("disconnected");
  });

  // ──────────────────────────────────────────────────────────
  // AUDIT-2026-06-11 #14: the mount snapshot must not clobber a NEWER live event
  // ──────────────────────────────────────────────────────────

  it("AUDIT #14: a stale mount snapshot does NOT overwrite a newer live vpn-status event", async () => {
    // Webview remounts mid-auto-reconnect: the snapshot IPC reads "reconnecting" and the
    // reply is still in flight when the supervisor emits a live "connected". The stale
    // snapshot reply must be DROPPED — applying it would roll the UI back to a permanent
    // «Переподключение» (a settled-Connected backend emits nothing further to fix it).
    let resolveSnapshot!: (v: { status: VpnStatus; error: string | null }) => void;
    vi.mocked(invoke).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve;
        }),
    );
    const { setStatus, setError, setConnectedSince, params } = makeParams();

    await act(async () => {
      renderHook(() => useVpnEvents(params));
    });

    // The live event lands FIRST (while the snapshot reply is still in flight).
    await act(async () => {
      emitEvent("vpn-status", { status: "connected" as VpnStatus });
    });
    setStatus.mockClear();
    setError.mockClear();
    setConnectedSince.mockClear();

    // The stale snapshot reply arrives LAST — it must be ignored entirely
    // (neither the status nor the error payload may apply).
    await act(async () => {
      resolveSnapshot({ status: "reconnecting", error: "recovery-timeout" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setStatus).not.toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
    expect(setConnectedSince).not.toHaveBeenCalled();
  });

  it("AUDIT #14: the snapshot still applies when it resolves BEFORE any live event", async () => {
    // The other ordering (the common case): no live event yet → the snapshot is the
    // freshest information available and must apply as before.
    const { setStatus, setConnectedSince, params } = makeParams();
    vi.mocked(invoke).mockResolvedValueOnce({ status: "connected", error: null });

    await act(async () => {
      renderHook(() => useVpnEvents(params));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setStatus).toHaveBeenCalledWith("connected");
    expect(setConnectedSince).toHaveBeenCalled();
  });

  it("the internet-status 'disconnect' handler sets the message but NEVER the status (vpn-status owns it)", async () => {
    // 02-20 conflict fix: the old handler forced setStatus("recovering"), which would
    // clobber a backend `reconnecting` (tunnel-lost) back to recovering. It must now set
    // ONLY the descriptive banner — the vpn-status event is the sole status owner (D-01).
    const { setStatus, setError, params } = makeParams();

    await act(async () => {
      renderHook(() => useVpnEvents(params));
    });
    setStatus.mockClear();
    setError.mockClear();

    await act(async () => {
      emitEvent("internet-status", { online: false, action: "disconnect" });
    });

    // Message is set …
    expect(setError).toHaveBeenCalledWith(i18n.t("errors.internet_lost_disconnecting"));
    // … but the status is NOT touched by this handler anymore.
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("WR-01: a 'tunnel-lost' disconnect shows the server-lost banner, not the internet-lost one", async () => {
    // WR-01: declare_offline_and_handoff fires the SAME `disconnect` action for both
    // drop types, tagged by `reason`. A server-silent drop (`tunnel-lost`, net OK) must
    // show «Связь с сервером потеряна…» (errors.server_connection_lost), not the
    // internet-lost message. The old handler ignored `reason` and always showed the
    // internet-lost banner — the wrong message for a «Переподключение» retry.
    const { setStatus, setError, params } = makeParams();

    await act(async () => {
      renderHook(() => useVpnEvents(params));
    });
    setStatus.mockClear();
    setError.mockClear();

    await act(async () => {
      emitEvent("internet-status", { online: false, action: "disconnect", reason: "tunnel-lost" });
    });

    expect(setError).toHaveBeenCalledWith(i18n.t("errors.server_connection_lost"));
    expect(setError).not.toHaveBeenCalledWith(i18n.t("errors.internet_lost_disconnecting"));
    // Still never touches the status (D-01: vpn-status owns it).
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("WR-01: an 'internet-lost' disconnect shows the internet-lost banner", async () => {
    // The other reason branch: a local-net loss (`internet-lost`) keeps the
    // «Интернет-соединение потеряно…» message (errors.internet_lost_disconnecting).
    const { setError, params } = makeParams();

    await act(async () => {
      renderHook(() => useVpnEvents(params));
    });
    setError.mockClear();

    await act(async () => {
      emitEvent("internet-status", { online: false, action: "disconnect", reason: "internet-lost" });
    });

    expect(setError).toHaveBeenCalledWith(i18n.t("errors.internet_lost_disconnecting"));
    expect(setError).not.toHaveBeenCalledWith(i18n.t("errors.server_connection_lost"));
  });

  it("a check_vpn_status_full snapshot of 'reconnecting' sets status reconnecting (not disconnected)", async () => {
    // 02-20: a window mounting mid-server-lost-retry must render «Переподключение» from
    // the snapshot, not fall through to the disconnected else-branch.
    const { setStatus, setConnectedSince, params } = makeParams();
    vi.mocked(invoke).mockResolvedValueOnce({ status: "reconnecting", error: null });

    await act(async () => {
      renderHook(() => useVpnEvents(params));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setStatus).toHaveBeenCalledWith("reconnecting");
    expect(setConnectedSince).toHaveBeenCalledWith(null);
  });

  it("passes an unmapped error string through unchanged", async () => {
    const { setError, params } = makeParams();

    await act(async () => {
      renderHook(() => useVpnEvents(params));
    });
    setError.mockClear();

    await act(async () => {
      // A string that is neither a reason code nor one of the fixed core phrases (F16) —
      // it must still render verbatim (defensive passthrough for anything we don't map).
      emitEvent("vpn-status", { status: "error" as VpnStatus, error: "Some unmapped backend text" });
    });

    expect(setError).toHaveBeenCalledWith("Some unmapped backend text");
  });

  // ──────────────────────────────────────────────────────────
  // DEV-only F12 console mirror (D-08 / D-11, Plan 02-05 Task 1)
  //
  // In a DEV build every vpn-log line is mirrored to the DevTools console at
  // the matching severity with a `[vpn] ` prefix so the user can watch live and
  // paste back. In a release build the mirror is GATED OFF (import.meta.env.DEV
  // falsy) so the verbose channel never streams in production (D-11).
  // ──────────────────────────────────────────────────────────

  it.each([
    ["info", "log"],
    ["warn", "warn"],
    ["error", "error"],
  ] as const)(
    "mirrors a %s vpn-log line to console.%s with the [vpn] prefix in DEV builds",
    async (level, consoleFn) => {
      vi.stubEnv("DEV", true);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const spies = { log: logSpy, warn: warnSpy, error: errorSpy };

      const { params } = makeParams();
      await act(async () => {
        renderHook(() => useVpnEvents(params));
      });

      await act(async () => {
        emitEvent("vpn-log", { message: "sidecar spawned, pid 4242", level });
      });

      // The matching console fn receives the prefixed line …
      expect(spies[consoleFn]).toHaveBeenCalledWith("[vpn] sidecar spawned, pid 4242");
      // … and the other two severities are NOT used for this line.
      for (const [name, spy] of Object.entries(spies)) {
        if (name !== consoleFn) {
          expect(spy).not.toHaveBeenCalledWith("[vpn] sidecar spawned, pid 4242");
        }
      }

      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      vi.unstubAllEnvs();
    },
  );

  it("does NOT mirror vpn-log to console when the DEV gate is off (release build — D-11)", async () => {
    // D-11 gate proof: with import.meta.env.DEV falsy (a shipped release) the
    // verbose console mirror must be a dead code path — the user-facing log
    // buffer (setVpnLogs) still receives the line, but console stays silent so
    // the full vpn-log channel never streams in production.
    vi.stubEnv("DEV", false);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { setVpnLogs, params } = makeParams();
    await act(async () => {
      renderHook(() => useVpnEvents(params));
    });
    setVpnLogs.mockClear();

    await act(async () => {
      emitEvent("vpn-log", { message: "connect-timeout fired (60s, no handshake)", level: "warn" });
    });

    // The log buffer still gets the line (all builds) …
    expect(setVpnLogs).toHaveBeenCalled();
    // … but the console mirror is gated off (release build).
    expect(logSpy).not.toHaveBeenCalledWith("[vpn] connect-timeout fired (60s, no handshake)");
    expect(warnSpy).not.toHaveBeenCalledWith("[vpn] connect-timeout fired (60s, no handshake)");
    expect(errorSpy).not.toHaveBeenCalledWith("[vpn] connect-timeout fired (60s, no handshake)");

    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  // ──────────────────────────────────────────────────────────
  // Async-unlisten StrictMode hardening (D-08, Pitfall 3)
  // ──────────────────────────────────────────────────────────

  function countLive(eventName: string): number {
    return liveListenerCount[eventName] ?? 0;
  }

  it("does not leak vpn-status listeners across a mount/unmount/mount cycle", async () => {
    const { params } = makeParams();

    // Single mount establishes the steady-state listener count for this hook.
    const first = renderHook(() => useVpnEvents(params));
    await act(async () => {
      await Promise.resolve();
    });
    const steadyState = countLive("vpn-status");
    expect(steadyState).toBeGreaterThanOrEqual(1);

    await act(async () => {
      first.unmount();
      await Promise.resolve();
    });
    // After unmount, every vpn-status listener must be gone (always unlisten).
    expect(countLive("vpn-status")).toBe(0);

    // Remount (StrictMode-like second mount) — count returns to steady-state,
    // never doubled (no leaked registration from the first cycle).
    const remounted = renderHook(() => useVpnEvents(params));
    await act(async () => {
      await Promise.resolve();
    });
    expect(countLive("vpn-status")).toBe(steadyState);

    remounted.unmount();
  });

  it("when cleanup runs before listen() resolves, no listener leaks", async () => {
    // Make listen() resolve on a deferred tick so the effect can be torn down
    // while the listen promise is still pending — the exact StrictMode race.
    const deferred: Array<() => void> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(listen).mockImplementation((eventName: string, callback: any) => {
      return new Promise((resolve) => {
        deferred.push(() => {
          if (!listenCallbacks[eventName]) listenCallbacks[eventName] = [];
          listenCallbacks[eventName].push(callback);
          liveListenerCount[eventName] = (liveListenerCount[eventName] ?? 0) + 1;
          resolve(() => {
            liveListenerCount[eventName] = (liveListenerCount[eventName] ?? 1) - 1;
          });
        });
      });
    });

    const { params } = makeParams();
    const { unmount } = renderHook(() => useVpnEvents(params));

    // Tear down BEFORE the listen() promises resolve.
    await act(async () => {
      unmount();
    });

    // Now resolve all pending listen() promises (listener arrives post-cleanup).
    await act(async () => {
      deferred.forEach((d) => d());
      await Promise.resolve();
      await Promise.resolve();
    });

    // Hardened cleanup must immediately unlisten the late-resolved registration.
    expect(countLive("vpn-status")).toBe(0);
  });

  // ──────────────────────────────────────────────────────────
  // Phase 14 (Wave 0, plan 14-01): the no-dwell guard MUST STAY NARROW
  //
  // GREEN INVARIANT (not RED) — a config switch's transient `disconnected` (the teardown leg, prev
  // `disconnecting`) must NOT be eaten by the no-dwell guard. The guard keys ONLY on
  // `prev === "reconnecting" && manualReconnectActiveRef.current`; a switch uses `disconnecting`, so
  // it is NOT caught here — and Phase 14 must NOT broaden it. Broadening risks eating a REAL terminal
  // disconnect (the AUDIT #8 "stuck on yellow" bug). Phase-14 visual continuity comes from the FE-only
  // `isSwitching` flag keeping the hero live (ConfigList gate), NOT from suppressing this event. This
  // test PASSES today and must KEEP passing across every later slice.
  // ──────────────────────────────────────────────────────────

  it("Phase 14: a switch's transient 'disconnected' (prev 'disconnecting') is NOT suppressed by the no-dwell guard", async () => {
    // A manual reconnect ref set true would only matter for a prev="reconnecting" edge — here the
    // switch teardown drives prev="disconnecting", which the guard never covers. Set the ref true to
    // prove even THEN the disconnecting→disconnected edge is not suppressed (the guard is prev-scoped).
    const { setStatus, params } = makeParams();
    const manualReconnectActiveRef = { current: true };

    await act(async () => {
      renderHook(() => useVpnEvents({ ...params, manualReconnectActiveRef }));
    });
    setStatus.mockClear();

    await act(async () => {
      emitEvent("vpn-status", { status: "disconnected" as VpnStatus });
    });

    // The teardown leg's transient disconnected surfaces — prev is "disconnecting", not the
    // "reconnecting" the guard keys on, so the listener commits it (isSwitching keeps the hero live,
    // it does NOT rely on suppressing this event).
    const calls = setStatus.mock.calls;
    const updater = calls[calls.length - 1]?.[0];
    const resolved = typeof updater === "function" ? updater("disconnecting") : updater;
    expect(resolved).toBe("disconnected");
  });

  // ─── F-7 (Fable-5): a user-superseded switch shows the NEUTRAL disconnect snack, not red ───
  // The snackbar logic lives INSIDE the setStatus updater, so — like the no-dwell guard test above —
  // we drive the updater with prev = "connecting" (the switch's destination connect) to exercise the
  // connecting→disconnected branch (a mocked setStatus does not run the updater itself).
  describe("F-7 — superseded switch snackbar (neutral, not red «Connection failed»)", () => {
    it("connecting → disconnected with switchSupersededRef set shows «VPN отключён», not the red error", async () => {
      const { setStatus, pushSuccess, params } = makeParams();
      const switchSupersededRef = { current: true };
      await act(async () => {
        renderHook(() => useVpnEvents({ ...params, switchSupersededRef }));
      });
      pushSuccess.mockClear();
      await act(async () => {
        emitEvent("vpn-status", { status: "disconnected" as VpnStatus });
      });
      const updater = setStatus.mock.calls[setStatus.mock.calls.length - 1]?.[0];
      if (typeof updater === "function") updater("connecting");

      // Neutral «VPN отключён», never the red («error») «Connection failed». And the flag is consumed.
      expect(pushSuccess).toHaveBeenCalledWith(i18n.t("messages.vpn_disconnected", "VPN disconnected"));
      expect(pushSuccess).not.toHaveBeenCalledWith(expect.anything(), "error");
      expect(switchSupersededRef.current).toBe(false);
    });

    it("connecting → disconnected WITHOUT the supersede flag still shows the red «Connection failed»", async () => {
      // Contrast: a genuine connect failure (no user disconnect superseded it) must still be red.
      const { setStatus, pushSuccess, params } = makeParams();
      const switchSupersededRef = { current: false };
      await act(async () => {
        renderHook(() => useVpnEvents({ ...params, switchSupersededRef }));
      });
      pushSuccess.mockClear();
      await act(async () => {
        emitEvent("vpn-status", { status: "disconnected" as VpnStatus, error: "boom" });
      });
      const updater = setStatus.mock.calls[setStatus.mock.calls.length - 1]?.[0];
      if (typeof updater === "function") updater("connecting");

      expect(pushSuccess).toHaveBeenCalledWith("boom", "error");
    });
  });

  // ─── F16 (14-UAT round 2): the snackbar localizes the core's fixed English error phrases ───
  // The C++ sidecar emits fixed English strings on the error payload (sidecar.rs fatal_marker_error /
  // config_parse_error). They must be shown in the active locale, never leaked raw into the Russian
  // UI. localizeError maps them to existing i18n keys; an empty payload falls back to the localized
  // errors.connection_failed, NOT the old English default value.
  describe("F16 — snackbar localizes core error strings", () => {
    const failCases: Array<[string, string]> = [
      ["Server refused the connection", "errors.connection_refused"],
      ["Authorization failed", "errors.auth_required"],
      ["Failed to start VPN tunnel", "errors.listener_failed"],
      ["VPN adapter creation failed", "errors.wintun_missing"],
      ["Configuration parse error. Check your config file.", "errors.config_parse_error"],
    ];
    it.each(failCases)(
      "connecting → disconnected with core error «%s» shows the localized message, not the raw English",
      async (coreError, key) => {
        const { setStatus, pushSuccess, params } = makeParams();
        const switchSupersededRef = { current: false };
        await act(async () => {
          renderHook(() => useVpnEvents({ ...params, switchSupersededRef }));
        });
        pushSuccess.mockClear();
        await act(async () => {
          emitEvent("vpn-status", { status: "disconnected" as VpnStatus, error: coreError });
        });
        const updater = setStatus.mock.calls[setStatus.mock.calls.length - 1]?.[0];
        if (typeof updater === "function") updater("connecting");

        expect(pushSuccess).toHaveBeenCalledWith(i18n.t(key), "error");
        expect(pushSuccess).not.toHaveBeenCalledWith(coreError, "error");
      },
    );

    it("connecting → disconnected with NO error and NO cancel flag shows neutral «VPN отключён» (backend settle, F1/F5)", async () => {
      // Fable F1/F5: WITHOUT the explicit connectCancelledRef flag a connecting → disconnected (no
      // error) edge is a BACKEND settle (e.g. sidecar-exit-0), NOT a user cancel — it shows the neutral
      // «VPN отключён», never a false «Подключение отменено» and never the red «Connection failed».
      const { setStatus, pushSuccess, params } = makeParams();
      const switchSupersededRef = { current: false };
      await act(async () => {
        renderHook(() => useVpnEvents({ ...params, switchSupersededRef }));
      });
      pushSuccess.mockClear();
      await act(async () => {
        emitEvent("vpn-status", { status: "disconnected" as VpnStatus });
      });
      const updater = setStatus.mock.calls[setStatus.mock.calls.length - 1]?.[0];
      if (typeof updater === "function") updater("connecting");

      expect(pushSuccess).toHaveBeenCalledWith(i18n.t("messages.vpn_disconnected", "VPN disconnected"));
      expect(pushSuccess).not.toHaveBeenCalledWith(i18n.t("messages.connect_cancelled", "Connection cancelled"));
      expect(pushSuccess).not.toHaveBeenCalledWith(i18n.t("errors.connection_failed"), "error");
    });

    it("disconnected WITH the connectCancelledRef flag shows «Подключение отменено» + CONSUMES the flag (F1 real button path)", async () => {
      // Fable F1: the REAL button path. handleUserCancel sets connectCancelledRef, then handleDisconnect
      // sets `disconnecting` optimistically, so the terminal edge arrives with prev="disconnecting". The
      // FLAG (not prev) carries the cancel → «Подключение отменено», and the listener CONSUMES the ref.
      const { setStatus, pushSuccess, params } = makeParams();
      const connectCancelledRef = { current: true };
      await act(async () => {
        renderHook(() => useVpnEvents({ ...params, connectCancelledRef }));
      });
      pushSuccess.mockClear();
      await act(async () => {
        emitEvent("vpn-status", { status: "disconnected" as VpnStatus });
      });
      const updater = setStatus.mock.calls[setStatus.mock.calls.length - 1]?.[0];
      if (typeof updater === "function") updater("disconnecting"); // handleDisconnect's optimistic prev

      expect(pushSuccess).toHaveBeenCalledWith(i18n.t("messages.connect_cancelled", "Connection cancelled"));
      expect(pushSuccess).not.toHaveBeenCalledWith(i18n.t("messages.vpn_disconnected", "VPN disconnected"));
      // One-shot: the ref is drained so a LATER disconnect is not mislabelled as «отменено».
      expect(connectCancelledRef.current).toBe(false);
    });
  });

  // ─── F17 (14-UAT round 2): a seamless switch+revert stays calm — no disconnect snackbar ───
  // While isSwitching is mirrored into seamlessSwitchActiveRef, neither the red «Connection failed»
  // (failed B) nor the neutral «VPN отключён» (revert/teardown leg) fires — the amber card + the
  // embedded «…восстановлено» banner are the only signals. With the ref false the snackbars fire as
  // before (no over-suppression of a genuine, non-switch disconnect).
  describe("F17 — seamless switch/revert suppresses the disconnect snackbars", () => {
    it("connecting → disconnected with the ref true fires NO red «Connection failed»", async () => {
      const { setStatus, pushSuccess, params } = makeParams();
      const seamlessSwitchActiveRef = { current: true };
      await act(async () => {
        renderHook(() => useVpnEvents({ ...params, seamlessSwitchActiveRef }));
      });
      pushSuccess.mockClear();
      await act(async () => {
        emitEvent("vpn-status", {
          status: "disconnected" as VpnStatus,
          error: "Server refused the connection",
        });
      });
      const updater = setStatus.mock.calls[setStatus.mock.calls.length - 1]?.[0];
      if (typeof updater === "function") updater("connecting");

      expect(pushSuccess).not.toHaveBeenCalled();
    });

    it("connected/disconnecting → disconnected with the ref true fires NO «VPN отключён»", async () => {
      const { setStatus, pushSuccess, params } = makeParams();
      const seamlessSwitchActiveRef = { current: true };
      await act(async () => {
        renderHook(() => useVpnEvents({ ...params, seamlessSwitchActiveRef }));
      });
      pushSuccess.mockClear();
      await act(async () => {
        emitEvent("vpn-status", { status: "disconnected" as VpnStatus });
      });
      const updater = setStatus.mock.calls[setStatus.mock.calls.length - 1]?.[0];
      if (typeof updater === "function") updater("disconnecting");

      expect(pushSuccess).not.toHaveBeenCalled();
    });

    it("contrast: with the ref false the same edges still fire their snackbars", async () => {
      // red on connecting → disconnected
      {
        const { setStatus, pushSuccess, params } = makeParams();
        const seamlessSwitchActiveRef = { current: false };
        await act(async () => {
          renderHook(() => useVpnEvents({ ...params, seamlessSwitchActiveRef }));
        });
        pushSuccess.mockClear();
        await act(async () => {
          emitEvent("vpn-status", {
            status: "disconnected" as VpnStatus,
            error: "Server refused the connection",
          });
        });
        const updater = setStatus.mock.calls[setStatus.mock.calls.length - 1]?.[0];
        if (typeof updater === "function") updater("connecting");
        expect(pushSuccess).toHaveBeenCalledWith(i18n.t("errors.connection_refused"), "error");
      }
      // neutral on disconnecting → disconnected
      {
        const { setStatus, pushSuccess, params } = makeParams();
        const seamlessSwitchActiveRef = { current: false };
        await act(async () => {
          renderHook(() => useVpnEvents({ ...params, seamlessSwitchActiveRef }));
        });
        pushSuccess.mockClear();
        await act(async () => {
          emitEvent("vpn-status", { status: "disconnected" as VpnStatus });
        });
        const updater = setStatus.mock.calls[setStatus.mock.calls.length - 1]?.[0];
        if (typeof updater === "function") updater("disconnecting");
        expect(pushSuccess).toHaveBeenCalledWith(i18n.t("messages.vpn_disconnected", "VPN disconnected"));
      }
    });
  });

  // ─── B1 (16-UAT round 2): an in-app snackbar ALSO fires on a connect FAILURE («error» edge) ───
  //
  // Root cause: the connect-failure snackbar lived ONLY inside the `disconnected` arm (gated
  // prev==="connecting"). An auth/connect failure arrives as status:"error" (sidecar
  // «Authorization Required» → fatal_marker_error → set_vpn_status(Error)), which today ONLY set the
  // persistent StatusPanel banner (setError) — no pushSuccess. The desktop plate fires on the →error
  // edge (notify.rs), so the two surfaces disagreed. We now ALSO toast on the error edge, guarded the
  // same way the disconnect snackbar is: fire only from an in-flight connect (prev connecting/
  // reconnecting), suppress during a seamless switch, and NEVER re-toast a late-mount/re-emit error.
  // The persistent banner (setError) is kept — the owner wants BOTH surfaces.
  describe("B1 — snackbar on the connect-failure «error» edge", () => {
    it("connecting → error fires the red error snackbar (localized), keeping the persistent banner", async () => {
      const { setStatus, setError, pushSuccess, params } = makeParams();
      await act(async () => {
        renderHook(() => useVpnEvents(params));
      });
      pushSuccess.mockClear();
      setError.mockClear();

      await act(async () => {
        emitEvent("vpn-status", { status: "error" as VpnStatus, error: "Authorization failed" });
      });
      const updater = setStatus.mock.calls[setStatus.mock.calls.length - 1]?.[0];
      if (typeof updater === "function") updater("connecting");

      // The snackbar fires with the localized message and the "error" (red) type …
      expect(pushSuccess).toHaveBeenCalledWith(i18n.t("errors.auth_required"), "error");
      // … and the persistent StatusPanel banner is STILL set (both surfaces, per owner).
      expect(setError).toHaveBeenCalledWith(i18n.t("errors.auth_required"));
    });

    it("reconnecting → error also fires the red error snackbar (an in-flight reconnect that failed)", async () => {
      const { setStatus, pushSuccess, params } = makeParams();
      await act(async () => {
        renderHook(() => useVpnEvents(params));
      });
      pushSuccess.mockClear();

      await act(async () => {
        emitEvent("vpn-status", { status: "error" as VpnStatus, error: "sidecar-exit" });
      });
      const updater = setStatus.mock.calls[setStatus.mock.calls.length - 1]?.[0];
      if (typeof updater === "function") updater("reconnecting");

      expect(pushSuccess).toHaveBeenCalledWith(i18n.t("errors.sidecar_exit"), "error");
    });

    it("error with NO payload falls back to the localized generic errors.connection_failed", async () => {
      const { setStatus, pushSuccess, params } = makeParams();
      await act(async () => {
        renderHook(() => useVpnEvents(params));
      });
      pushSuccess.mockClear();

      await act(async () => {
        emitEvent("vpn-status", { status: "error" as VpnStatus });
      });
      const updater = setStatus.mock.calls[setStatus.mock.calls.length - 1]?.[0];
      if (typeof updater === "function") updater("connecting");

      expect(pushSuccess).toHaveBeenCalledWith(i18n.t("errors.connection_failed"), "error");
    });

    it("a seamless-switch-active error does NOT toast (the calm «…восстановлено» banner covers it)", async () => {
      const { setStatus, pushSuccess, params } = makeParams();
      const seamlessSwitchActiveRef = { current: true };
      await act(async () => {
        renderHook(() => useVpnEvents({ ...params, seamlessSwitchActiveRef }));
      });
      pushSuccess.mockClear();

      await act(async () => {
        emitEvent("vpn-status", { status: "error" as VpnStatus, error: "Authorization failed" });
      });
      const updater = setStatus.mock.calls[setStatus.mock.calls.length - 1]?.[0];
      if (typeof updater === "function") updater("connecting");

      // A failed B during a switch already surfaces via the amber card + «…восстановлено» info
      // banner — it must NOT also red-toast.
      expect(pushSuccess).not.toHaveBeenCalled();
    });

    it("an error NOT from an in-flight connect (prev 'disconnected') does NOT toast", async () => {
      // A late-mount snapshot landing on error, or a re-emit of an already-error status, must not
      // re-toast — only an in-flight connect (connecting/reconnecting) that just failed does.
      const { setStatus, pushSuccess, params } = makeParams();
      await act(async () => {
        renderHook(() => useVpnEvents(params));
      });
      pushSuccess.mockClear();

      await act(async () => {
        emitEvent("vpn-status", { status: "error" as VpnStatus, error: "Authorization failed" });
      });
      const updater = setStatus.mock.calls[setStatus.mock.calls.length - 1]?.[0];
      if (typeof updater === "function") updater("disconnected");

      expect(pushSuccess).not.toHaveBeenCalled();
    });

    it("a re-emit of an already-'error' status (prev 'error') does NOT re-toast", async () => {
      const { setStatus, pushSuccess, params } = makeParams();
      await act(async () => {
        renderHook(() => useVpnEvents(params));
      });
      pushSuccess.mockClear();

      await act(async () => {
        emitEvent("vpn-status", { status: "error" as VpnStatus, error: "sidecar-exit" });
      });
      const updater = setStatus.mock.calls[setStatus.mock.calls.length - 1]?.[0];
      if (typeof updater === "function") updater("error");

      expect(pushSuccess).not.toHaveBeenCalled();
    });
  });

  // ─── B5 (16-UAT round 2): «Сохранить и переподключить» stays seamless (no «Отключение» flash) ───
  //
  // Root cause: the no-dwell guard suppressed only `status === "disconnected"` while
  // manualReconnectActiveRef was set. The backend now emits `Disconnecting` FIRST at every real
  // teardown (vpn.rs), which the guard did NOT match → it leaked to status → «Отключение»; then
  // `disconnected` arrives with prev==="disconnecting" (not "reconnecting") → guard missed it too →
  // «Отключён». We widen the guard to also hold on the `disconnecting` transient during a manual
  // reconnect, so the amber «Переподключение» holds continuously. NOT broadened to recovering/no-mark
  // (keeps the AUDIT #8 stuck-on-yellow fix — that path has manualReconnectActiveRef.current false).
  describe("B5 — manual reconnect holds amber «Переподключение» through the disconnecting transient", () => {
    it("reconnecting → disconnecting → disconnected stays 'reconnecting' for BOTH events (manual reconnect in flight)", async () => {
      const { setStatus, params } = makeParams();
      const manualReconnectActiveRef = { current: true };
      await act(async () => {
        renderHook(() => useVpnEvents({ ...params, manualReconnectActiveRef }));
      });

      // 1) The teardown's leading `disconnecting` transient must be held (prev "reconnecting").
      setStatus.mockClear();
      await act(async () => {
        emitEvent("vpn-status", { status: "disconnecting" as VpnStatus });
      });
      {
        const updater = setStatus.mock.calls[setStatus.mock.calls.length - 1]?.[0];
        const resolved = typeof updater === "function" ? updater("reconnecting") : updater;
        expect(resolved).toBe("reconnecting");
      }

      // 2) The settled `disconnected` must ALSO be held — even though prev is now "reconnecting"
      //    (the guard suppressed the intermediate disconnecting, so status never left reconnecting).
      setStatus.mockClear();
      await act(async () => {
        emitEvent("vpn-status", { status: "disconnected" as VpnStatus });
      });
      {
        const updater = setStatus.mock.calls[setStatus.mock.calls.length - 1]?.[0];
        const resolved = typeof updater === "function" ? updater("reconnecting") : updater;
        expect(resolved).toBe("reconnecting");
      }
    });

    it("does NOT broaden: a plain switch teardown 'disconnecting' (no manual reconnect) still commits", async () => {
      // manualReconnectActiveRef false → the widened guard must NOT suppress a disconnecting edge.
      const { setStatus, params } = makeParams();
      const manualReconnectActiveRef = { current: false };
      await act(async () => {
        renderHook(() => useVpnEvents({ ...params, manualReconnectActiveRef }));
      });
      setStatus.mockClear();

      await act(async () => {
        emitEvent("vpn-status", { status: "disconnecting" as VpnStatus });
      });

      const updater = setStatus.mock.calls[setStatus.mock.calls.length - 1]?.[0];
      const resolved = typeof updater === "function" ? updater("reconnecting") : updater;
      expect(resolved).toBe("disconnecting");
    });

    it("does NOT broaden to 'recovering': a disconnecting from recovering commits (AUDIT #8 intact)", async () => {
      // Even with a manual reconnect ref set, the guard keys on prev==="reconnecting"; a
      // recovering→disconnecting edge is not covered, so it commits (never stuck-on-yellow).
      const { setStatus, params } = makeParams();
      const manualReconnectActiveRef = { current: true };
      await act(async () => {
        renderHook(() => useVpnEvents({ ...params, manualReconnectActiveRef }));
      });
      setStatus.mockClear();

      await act(async () => {
        emitEvent("vpn-status", { status: "disconnecting" as VpnStatus });
      });

      const updater = setStatus.mock.calls[setStatus.mock.calls.length - 1]?.[0];
      const resolved = typeof updater === "function" ? updater("recovering") : updater;
      expect(resolved).toBe("disconnecting");
    });
  });

  // ─── Phase 14 (14-04): defensive onSettled backstop on the terminal edge ───
  //
  // Pitfall 2: even if a switch promise is abandoned (a dropped/never-resolving chain), a
  // terminal `vpn-status` edge (connected OR error) must still clear the App's isSwitching lock —
  // so the UI can never wedge locked. useVpnEvents fires an optional onSettled() callback exactly
  // on the terminal connected/error edge. It MUST land on the terminal-edge branch, NOT inside the
  // no-dwell guard (broadening the guard risks the AUDIT #8 stuck-on-yellow regression).
  describe("Phase 14 — onSettled terminal-edge defensive clear (Pitfall 2)", () => {
    it("fires onSettled on the terminal 'connected' edge", async () => {
      const { params } = makeParams();
      const onSettled = vi.fn();
      await act(async () => {
        renderHook(() => useVpnEvents({ ...params, onSettled }));
      });

      await act(async () => {
        emitEvent("vpn-status", { status: "connected" as VpnStatus });
      });

      expect(onSettled).toHaveBeenCalledTimes(1);
    });

    it("fires onSettled on the terminal 'error' edge", async () => {
      const { params } = makeParams();
      const onSettled = vi.fn();
      await act(async () => {
        renderHook(() => useVpnEvents({ ...params, onSettled }));
      });

      await act(async () => {
        emitEvent("vpn-status", { status: "error" as VpnStatus, error: "sidecar-exit" });
      });

      expect(onSettled).toHaveBeenCalledTimes(1);
    });

    it("does NOT fire onSettled on a NON-terminal edge (connecting / reconnecting / recovering / disconnected)", async () => {
      const { params } = makeParams();
      const onSettled = vi.fn();
      await act(async () => {
        renderHook(() => useVpnEvents({ ...params, onSettled }));
      });

      await act(async () => {
        emitEvent("vpn-status", { status: "connecting" as VpnStatus });
        emitEvent("vpn-status", { status: "reconnecting" as VpnStatus });
        emitEvent("vpn-status", { status: "recovering" as VpnStatus });
        // A bare `disconnected` is the switch teardown's TRANSIENT — NOT a settle. Only
        // connected/error are terminal for the switch lifecycle (a failed switch lands on error).
        emitEvent("vpn-status", { status: "disconnected" as VpnStatus });
      });

      expect(onSettled).not.toHaveBeenCalled();
    });
  });
});
