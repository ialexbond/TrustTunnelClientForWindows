import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useControlPanelOrchestrator } from "./useControlPanelOrchestrator";

// Pin latestFromGitHubCP = "1.0.33" deterministically (mirrors ControlPanelPage.test.tsx)
vi.mock("./useSidecarVersions", () => ({
  useSidecarVersions: () => ({
    versions: [
      {
        version: "1.0.33",
        tag: "v1.0.33",
        assetDownloadUrl: "",
        assetSizeBytes: 0,
        publishedAt: "",
      },
    ],
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

// Stub useUpdateChecker to prevent real GitHub/SSH calls
const mockCheckSidecarForServer = vi.fn();
const mockDismissSidecarUpdate = vi.fn();
vi.mock("../../shared/hooks/useUpdateChecker", () => ({
  useUpdateChecker: () => ({
    checkSidecarForServer: mockCheckSidecarForServer,
    dismissSidecarUpdate: mockDismissSidecarUpdate,
  }),
}));

const mockInvoke = vi.mocked(invoke) as unknown as Mock;

const defaultParams = {
  onConfigExported: vi.fn(),
  onSwitchToSetup: vi.fn(),
  onNavigateToSettings: vi.fn(),
};

/** Configure invoke mock to return given creds from load_ssh_credentials. */
function mockCredsLoaded(creds: { host: string; port?: string; user?: string; password?: string; keyPath?: string } | null) {
  mockInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === "load_ssh_credentials") {
      if (!creds) return null;
      return {
        host: creds.host,
        port: creds.port || "22",
        user: creds.user || "root",
        password: creds.password || "",
        keyPath: creds.keyPath || "",
      };
    }
    return null;
  });
}

describe("useControlPanelOrchestrator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockCredsLoaded(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts in loading state, then clears it after the initial creds read (no creds)", async () => {
    const { result } = renderHook(() => useControlPanelOrchestrator(defaultParams));
    // Initial synchronous render is still loading.
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    // No creds stored → stays disconnected.
    expect(result.current.creds).toBeNull();
  });

  it("loads stored creds and arms the first-connect skeleton (auto-reconnect)", async () => {
    mockCredsLoaded({ host: "10.0.0.1", password: "secret" });
    const { result } = renderHook(() => useControlPanelOrchestrator(defaultParams));
    await waitFor(() => expect(result.current.creds).not.toBeNull());
    expect(result.current.creds?.host).toBe("10.0.0.1");
    // BUG-01: auto-reconnect shows the skeleton.
    expect(result.current.isFirstConnect).toBe(true);
    expect(result.current.loading).toBe(false);
  });

  it("handleConnect sets creds + persists last SSH identity + bumps refreshKey", async () => {
    const { result } = renderHook(() => useControlPanelOrchestrator(defaultParams));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const beforeKey = result.current.refreshKey;

    act(() => {
      result.current.handleConnect({ host: "1.2.3.4", port: "22", user: "root", password: "pass" });
    });

    expect(result.current.creds?.host).toBe("1.2.3.4");
    expect(result.current.isFirstConnect).toBe(true);
    expect(result.current.refreshKey).toBe(beforeKey + 1);
    expect(localStorage.getItem("tt_ssh_last_host")).toBe("1.2.3.4");
    expect(localStorage.getItem("tt_ssh_last_user")).toBe("root");
    expect(localStorage.getItem("tt_ssh_last_port")).toBe("22");
  });

  it("handleDisconnect clears creds, clears the refresh signal, and calls clear_ssh_credentials", async () => {
    mockCredsLoaded({ host: "10.0.0.1", password: "secret" });
    localStorage.setItem("trusttunnel_control_refresh", "12345");
    const { result } = renderHook(() => useControlPanelOrchestrator(defaultParams));
    await waitFor(() => expect(result.current.creds).not.toBeNull());

    await act(async () => {
      await result.current.handleDisconnect();
    });

    expect(mockInvoke).toHaveBeenCalledWith("clear_ssh_credentials");
    expect(result.current.creds).toBeNull();
    expect(result.current.isFirstConnect).toBe(false);
    expect(localStorage.getItem("trusttunnel_control_refresh")).toBeNull();
  });

  it("derives localSidecarAvailable as the single source: false at latest, true on downgrade", async () => {
    mockCredsLoaded({ host: "10.0.0.1", password: "secret" });
    const { result } = renderHook(() => useControlPanelOrchestrator(defaultParams));
    await waitFor(() => expect(result.current.creds).not.toBeNull());

    // No serverInfoVersion yet → not available.
    expect(result.current.localSidecarAvailable).toBe(false);
    expect(result.current.sidecarUpdateVisible).toBe(false);

    // Latest installed (1.0.33 === latest) → still no update.
    act(() => result.current.setServerInfoVersion("1.0.33"));
    expect(result.current.localSidecarAvailable).toBe(false);

    // Downgrade (1.0.31 < latest 1.0.33) → update available.
    act(() => result.current.setServerInfoVersion("1.0.31"));
    expect(result.current.localSidecarAvailable).toBe(true);
    expect(result.current.sidecarUpdateVisible).toBe(true);
  });

  it("forwards the net visibility flag to onSidecarUpdateChange (false initially, true on downgrade)", async () => {
    const onSidecarUpdateChange = vi.fn();
    mockCredsLoaded({ host: "10.0.0.1", password: "secret" });
    const { result } = renderHook(() =>
      useControlPanelOrchestrator({ ...defaultParams, onSidecarUpdateChange }),
    );
    await waitFor(() => expect(result.current.creds).not.toBeNull());
    expect(onSidecarUpdateChange).toHaveBeenCalledWith(false);

    act(() => result.current.setServerInfoVersion("1.0.31"));
    await waitFor(() => expect(onSidecarUpdateChange).toHaveBeenCalledWith(true));
  });

  it("the refresh-signal polling tick picks up newly-stored creds", async () => {
    const { result } = renderHook(() => useControlPanelOrchestrator(defaultParams));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.creds).toBeNull();

    // Creds become available + refresh signal flips.
    mockCredsLoaded({ host: "5.5.5.5", password: "newpass" });
    act(() => {
      localStorage.setItem("trusttunnel_control_refresh", Date.now().toString());
    });

    await waitFor(() => expect(result.current.creds?.host).toBe("5.5.5.5"), { timeout: 3000 });
  });

  it("handleSidecarUpdateSeen dismisses the GitHub-derived latest version when an update is visible", async () => {
    mockCredsLoaded({ host: "10.0.0.1", password: "secret" });
    const { result } = renderHook(() => useControlPanelOrchestrator(defaultParams));
    await waitFor(() => expect(result.current.creds).not.toBeNull());
    act(() => result.current.setServerInfoVersion("1.0.31"));

    act(() => result.current.handleSidecarUpdateSeen());
    expect(mockDismissSidecarUpdate).toHaveBeenCalledWith("1.0.33");
  });

  // ─── WR-04: re-key the per-host credential record on SSH-port change ────────
  // The per-host store is keyed by host:port:user. Saving under the NEW port must
  // also clear the OLD-port record (+ keyring entry) — otherwise a port change
  // accumulates orphaned old-port records.
  it("handlePortChanged saves the new-port record AND clears the orphaned old-port record (WR-04)", async () => {
    mockCredsLoaded({ host: "10.0.0.1", port: "22", user: "root", password: "secret" });
    const { result } = renderHook(() => useControlPanelOrchestrator(defaultParams));
    await waitFor(() => expect(result.current.creds?.port).toBe("22"));

    await act(async () => {
      await result.current.handlePortChanged(2222);
    });

    // The new-port record is saved.
    expect(mockInvoke).toHaveBeenCalledWith(
      "save_ssh_credentials",
      expect.objectContaining({ host: "10.0.0.1", port: "2222", user: "root" }),
    );
    // The orphaned OLD-port record (+ keyring entry) is cleared.
    expect(mockInvoke).toHaveBeenCalledWith(
      "clear_ssh_credentials_for",
      { host: "10.0.0.1", port: "22", user: "root" },
    );
    // Local state reflects the new port.
    expect(result.current.creds?.port).toBe("2222");
  });

  it("handlePortChanged does NOT clear when the port is unchanged (no spurious re-key)", async () => {
    mockCredsLoaded({ host: "10.0.0.1", port: "22", user: "root", password: "secret" });
    const { result } = renderHook(() => useControlPanelOrchestrator(defaultParams));
    await waitFor(() => expect(result.current.creds?.port).toBe("22"));

    await act(async () => {
      await result.current.handlePortChanged(22); // same port
    });

    expect(mockInvoke).not.toHaveBeenCalledWith(
      "clear_ssh_credentials_for",
      expect.anything(),
    );
  });

  // ─── C-23 / D-15: target validation before setCreds / auto-connect ──────────
  // On a multi-server machine the no-arg load returns the LAST-active record,
  // which may belong to a DIFFERENT server than this panel's persisted target.
  // The orchestrator must NEVER act on (setCreds / auto-connect) a bundle whose
  // host:port:user does not match the persisted lastHost/lastPort/lastUser.
  it("C-23 mismatch: loaded bundle for a different server is rejected (creds null, no auto-connect)", async () => {
    // Persisted target = server A.
    localStorage.setItem("tt_ssh_last_host", "10.0.0.1");
    localStorage.setItem("tt_ssh_last_port", "22");
    localStorage.setItem("tt_ssh_last_user", "root");
    // But the coarse load returns server B's bundle.
    mockCredsLoaded({ host: "10.0.0.2", port: "22", user: "deploy", password: "secretB" });

    const { result } = renderHook(() => useControlPanelOrchestrator(defaultParams));
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Wrong-server bundle is dropped — never set, never auto-connect.
    expect(result.current.creds).toBeNull();
    expect(result.current.isFirstConnect).toBe(false);
  });

  it("C-23 match: loaded bundle matching the persisted target is accepted (creds set)", async () => {
    localStorage.setItem("tt_ssh_last_host", "10.0.0.1");
    localStorage.setItem("tt_ssh_last_port", "22");
    localStorage.setItem("tt_ssh_last_user", "root");
    mockCredsLoaded({ host: "10.0.0.1", port: "22", user: "root", password: "secretA" });

    const { result } = renderHook(() => useControlPanelOrchestrator(defaultParams));
    await waitFor(() => expect(result.current.creds).not.toBeNull());

    expect(result.current.creds?.host).toBe("10.0.0.1");
    expect(result.current.isFirstConnect).toBe(true);
  });

  it("C-23 cold start: with no persisted target the loaded bundle is accepted as before", async () => {
    // No tt_ssh_last_* keys → nothing to validate against.
    mockCredsLoaded({ host: "172.16.0.9", port: "22", user: "root", password: "p" });

    const { result } = renderHook(() => useControlPanelOrchestrator(defaultParams));
    await waitFor(() => expect(result.current.creds).not.toBeNull());

    expect(result.current.creds?.host).toBe("172.16.0.9");
    expect(result.current.isFirstConnect).toBe(true);
  });

  it("C-23 refresh-tick mismatch: a refreshed bundle for a different server is rejected", async () => {
    localStorage.setItem("tt_ssh_last_host", "10.0.0.1");
    localStorage.setItem("tt_ssh_last_port", "22");
    localStorage.setItem("tt_ssh_last_user", "root");
    // Cold mount: matching bundle so the panel is connected to A.
    mockCredsLoaded({ host: "10.0.0.1", port: "22", user: "root", password: "secretA" });
    const { result } = renderHook(() => useControlPanelOrchestrator(defaultParams));
    await waitFor(() => expect(result.current.creds?.host).toBe("10.0.0.1"));

    // Refresh signal flips with a DIFFERENT server's bundle (server B).
    mockCredsLoaded({ host: "10.0.0.2", port: "22", user: "deploy", password: "secretB" });
    act(() => {
      localStorage.setItem("trusttunnel_control_refresh", Date.now().toString());
    });

    // The gate rejects B → creds cleared, never auto-connect on the wrong server.
    await waitFor(() => expect(result.current.creds).toBeNull(), { timeout: 3000 });
  });

  // ─── Chrome C-02 regression: polling tick must not double-fire the creds read ──
  // Symptom: when disconnected, the refresh-signal branch (ts !== lastTs) AND the
  // unconditional `if (!creds)` fallback branch both call readStoredCredentials in
  // the SAME 2s tick → two load_ssh_credentials invokes per tick. The mount effect
  // + the single signal branch already cover cold-start; the fallback is redundant.
  it("C-02: a single polling tick reads creds at most once (no double-fire when disconnected)", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useControlPanelOrchestrator(defaultParams));
    // Flush the mount effect's async creds read (no creds stored).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.creds).toBeNull();

    const loadCallsBefore = mockInvoke.mock.calls.filter(
      ([cmd]) => cmd === "load_ssh_credentials",
    ).length;

    // A refresh signal flips → drives the ts !== lastTs branch on the next tick.
    localStorage.setItem("trusttunnel_control_refresh", "1");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    const loadCallsAfter = mockInvoke.mock.calls.filter(
      ([cmd]) => cmd === "load_ssh_credentials",
    ).length;
    // Exactly one read for the tick — not two (signal branch + fallback branch).
    expect(loadCallsAfter - loadCallsBefore).toBe(1);
  });

  // ─── Chrome C-03 regression: interval is stable, reads creds via a ref ──────
  // Symptom: the interval has `[creds]` in its dependency array, so it is torn
  // down (clearInterval) and re-registered (setInterval) on EVERY creds change —
  // including every refreshKey-driven setCreds. Each re-registration captures a
  // fresh closure, but the churn is the stale-closure hazard the audit calls out
  // (a tick can fire against an about-to-be-replaced closure). The fix holds
  // creds in a useRef so the interval body always reads the latest value and the
  // interval is created exactly ONCE for the hook's lifetime — no per-creds churn.
  it("C-03: the polling interval is registered once and not re-created on every creds change", async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    mockCredsLoaded({ host: "10.0.0.1", password: "secret" });
    const { result } = renderHook(() => useControlPanelOrchestrator(defaultParams));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.creds?.host).toBe("10.0.0.1");

    const intervalsAfterMount = setIntervalSpy.mock.calls.length;

    // Drive several creds changes via the refresh-signal path (reconnect churn).
    for (let i = 1; i <= 3; i++) {
      mockCredsLoaded({ host: "10.0.0.1", port: `${2200 + i}`, password: "secret" });
      localStorage.setItem("trusttunnel_control_refresh", `${i}`);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
    }

    // With ref discipline the interval is NOT torn down + re-created on each
    // creds change: no extra setInterval / clearInterval beyond the single mount
    // registration. (Pre-fix `[creds]` dep would churn one pair per creds change.)
    expect(setIntervalSpy.mock.calls.length).toBe(intervalsAfterMount);
    expect(clearIntervalSpy).not.toHaveBeenCalled();

    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });
});
