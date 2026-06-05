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
  const reconnectResolve = { current: null as null | (() => void) };
  return {
    setStatus,
    setError,
    setConnectedSince,
    setVpnLogs,
    reconnectResolve,
    params: {
      i18n,
      setStatus,
      setError,
      setConnectedSince,
      setVpnLogs,
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
    expect(setError).toHaveBeenCalledWith("Authorization failed");
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

  it("the recovering-keep guard ALSO keeps 'reconnecting' over an intermediate 'disconnected'", async () => {
    // 02-20: the no-dwell guard now suppresses a transient "disconnected" while prev is
    // EITHER "recovering" OR "reconnecting" (a manual save+reconnect sets reconnecting
    // up-front). Resolve the updater with prev="reconnecting" → must stay "reconnecting".
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
    expect(resolved).toBe("reconnecting");
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

  it("passes a non-reason-code error through unchanged", async () => {
    const { setError, params } = makeParams();

    await act(async () => {
      renderHook(() => useVpnEvents(params));
    });
    setError.mockClear();

    await act(async () => {
      emitEvent("vpn-status", { status: "error" as VpnStatus, error: "Authorization failed" });
    });

    // Older sanitized backend messages still render verbatim (only known codes map).
    expect(setError).toHaveBeenCalledWith("Authorization failed");
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
});
