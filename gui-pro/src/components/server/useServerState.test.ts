import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useServerState, type ServerInfo, type ServerPanelProps } from "./useServerState";
import { hookWrapper as wrapper } from "../../test/test-utils";

// ─── Helpers ─────────────────────────────────────────

const mockInvoke = vi.mocked(invoke) as unknown as Mock;

const baseProps: ServerPanelProps = {
  host: "10.0.0.1",
  port: "22",
  sshUser: "root",
  sshPassword: "pass123",
  sshKeyPath: undefined,
  onSwitchToSetup: vi.fn(),
  onClearConfig: vi.fn(),
  onDisconnect: vi.fn(),
  onConfigExported: vi.fn(),
};

const fakeServerInfo: ServerInfo = {
  installed: true,
  version: "1.4.0",
  serviceActive: true,
  users: ["alice", "bob"],
};

function setupInvokeForLoad(info: ServerInfo = fakeServerInfo) {
  mockInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === "check_server_installation") return info;
    if (cmd === "server_get_config") return "config-data";
    if (cmd === "server_get_cert_info") return { cn: "test" };
    if (cmd === "server_get_available_versions") return ["1.4.0", "1.3.0"];
    return null;
  });
}

// ─── Tests ───────────────────────────────────────────

describe("useServerState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue(null);
  });

  // ── Initial state ──────────────────────────────────

  it("has null serverInfo and loading=true initially before load completes", () => {
    // Hang the invoke so loading stays true
    mockInvoke.mockImplementation(() => new Promise(() => {}));

    const { result } = renderHook(() => useServerState(baseProps), { wrapper });

    expect(result.current.serverInfo).toBeNull();
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBe("");
  });

  // ── loadServerInfo success ─────────────────────────

  it("populates serverInfo after successful load", async () => {
    setupInvokeForLoad();

    const { result } = renderHook(() => useServerState(baseProps), { wrapper });

    // Wait for the useEffect load to finish
    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.serverInfo).toEqual(fakeServerInfo);
    expect(result.current.error).toBe("");
    expect(mockInvoke).toHaveBeenCalledWith(
      "check_server_installation",
      expect.objectContaining({ host: "10.0.0.1", port: 22, user: "root" }),
    );
  });

  // ── loadServerInfo error ───────────────────────────

  it("sets translated error when loadServerInfo fails (after the R-6 retry budget)", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "check_server_installation") throw "SSH_TIMEOUT|10.0.0.1";
      if (cmd === "server_get_available_versions") return [];
      return null;
    });

    const { result } = renderHook(() => useServerState(baseProps), { wrapper });

    // R-6: the probe now retries up to 3× with ~1.5s between attempts, so the error
    // surfaces ~3s later — widen the waitFor + test timeouts accordingly.
    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    }, { timeout: 8000 });

    // translateSshError maps SSH_TIMEOUT via t("sshErrors.timeout", ...).
    expect(result.current.error).toBeTruthy();
    expect(result.current.serverInfo).toBeNull();
  }, 10000);

  // ── cold-start transient: one-shot fresh retry (UAT 2026-06-19) ──

  it("retries the probe on a transient SSH_CHANNEL_FAILED, then succeeds without error", async () => {
    let calls = 0;
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "check_server_installation") {
        calls += 1;
        if (calls === 1) throw "SSH_CHANNEL_FAILED|Disconnected";
        return fakeServerInfo;
      }
      if (cmd === "server_get_config") return "config-data";
      if (cmd === "server_get_cert_info") return { cn: "test" };
      if (cmd === "server_get_available_versions") return ["1.4.0"];
      return null;
    });

    const { result } = renderHook(() => useServerState(baseProps), { wrapper });

    await vi.waitFor(
      () => {
        expect(result.current.loading).toBe(false);
      },
      { timeout: 5000 },
    );

    // R-6: a transient first probe is retried (≥2 attempts) and the second succeeds.
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(result.current.serverInfo).toEqual(fakeServerInfo);
    expect(result.current.error).toBe("");
  }, 8000);

  // 06-review: the retry trigger was BROADENED. The cold-start double-handshake race
  // surfaces under many russh wordings (not just SSH_CHANNEL_FAILED), and translateSshError
  // reclassifies some of them as «Неверный SSH логин или пароль». So a transient that does
  // NOT mention the channel (e.g. SSH_TIMEOUT) must now ALSO get the one fresh retry —
  // otherwise a spurious auth-error screen flashes on launch.
  it("retries ONCE on a generic transient (SSH_TIMEOUT, not channel-tagged), then succeeds", async () => {
    let calls = 0;
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "check_server_installation") {
        calls += 1;
        if (calls === 1) throw "SSH_TIMEOUT|10.0.0.1";
        return fakeServerInfo;
      }
      if (cmd === "server_get_config") return "config-data";
      if (cmd === "server_get_cert_info") return { cn: "test" };
      if (cmd === "server_get_available_versions") return ["1.4.0"];
      return null;
    });

    const { result } = renderHook(() => useServerState(baseProps), { wrapper });

    await vi.waitFor(() => { expect(result.current.loading).toBe(false); }, { timeout: 3000 });

    expect(calls).toBe(2); // broadened: generic transient → one fresh retry
    expect(result.current.serverInfo).toEqual(fakeServerInfo);
    expect(result.current.error).toBe("");
  });

  it("a genuine PERSISTENT failure surfaces the error after the R-6 retries are exhausted", async () => {
    let calls = 0;
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "check_server_installation") {
        calls += 1;
        throw "SSH_AUTH_FAILED|10.0.0.1"; // fails on every attempt
      }
      if (cmd === "server_get_available_versions") return [];
      return null;
    });

    const { result } = renderHook(() => useServerState(baseProps), { wrapper });

    await vi.waitFor(() => { expect(result.current.loading).toBe(false); }, { timeout: 8000 });

    // R-6: retried up to the 3-attempt budget before giving up.
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(result.current.error).toBeTruthy();
    expect(result.current.serverInfo).toBeNull();
  }, 10000);

  it("does NOT run the R-6 retry loop on a changed host key (deterministic + security-sensitive)", async () => {
    let calls = 0;
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "check_server_installation") {
        calls += 1;
        throw "HOST_KEY_CHANGED|10.0.0.1";
      }
      if (cmd === "forget_ssh_host_key") return null;
      if (cmd === "server_get_available_versions") return [];
      return null;
    });

    const { result } = renderHook(() => useServerState(baseProps), { wrapper });

    await vi.waitFor(() => { expect(result.current.loading).toBe(false); });

    // A changed host key short-circuits the retry loop (thrown immediately) → it is NEVER
    // probed the full 3-attempt budget; the reset flow (forget_ssh_host_key) runs instead.
    expect(calls).toBeLessThan(3);
    expect(mockInvoke).toHaveBeenCalledWith("forget_ssh_host_key", expect.anything());
    expect(result.current.error).toBeTruthy();
    expect(result.current.serverInfo).toBeNull();
  });

  // ── loadServerInfo skips when no credentials ───────

  it("does not invoke when host or password is empty", async () => {
    const propsNoPass = { ...baseProps, sshPassword: "", sshKeyPath: undefined };
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "server_get_available_versions") return [];
      return null;
    });

    renderHook(() => useServerState(propsNoPass), { wrapper });

    // Give effects a tick
    await vi.waitFor(() => {});

    expect(mockInvoke).not.toHaveBeenCalledWith(
      "check_server_installation",
      expect.anything(),
    );
  });

  // ── runAction success ──────────────────────────────

  it("runAction calls invoke, refreshes server info, and pushes success message", async () => {
    setupInvokeForLoad();

    const { result } = renderHook(() => useServerState(baseProps), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.runAction(
        "restart_service",
        () => invoke("restart_service", result.current.sshParams),
        "Service restarted",
      );
    });

    expect(mockInvoke).toHaveBeenCalledWith("restart_service", expect.anything());
    // Success message is now pushed via useSnackBar (no successQueue on the hook)
  });

  // ── runAction error ────────────────────────────────

  it("runAction sets actionResult error when invoke throws", async () => {
    setupInvokeForLoad();

    const { result } = renderHook(() => useServerState(baseProps), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.runAction("restart_service", async () => {
        throw "SSH_SERVICE_RESTART_FAILED";
      });
    });

    expect(result.current.actionResult).not.toBeNull();
    expect(result.current.actionResult?.type).toBe("error");
    expect(result.current.actionResult?.message).toBeTruthy();
  });

  // ── Username validation ────────────────────────────

  it("usernameError returns empty string when newUsername is blank", async () => {
    setupInvokeForLoad();

    const { result } = renderHook(() => useServerState(baseProps), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.usernameError).toBe("");
  });

  it("usernameError detects spaces in username", async () => {
    setupInvokeForLoad();

    const { result } = renderHook(() => useServerState(baseProps), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.setNewUsername("bad user");
    });

    expect(result.current.usernameError).toBe("server.users.username_spaces");
  });

  it("usernameError detects duplicate username", async () => {
    setupInvokeForLoad();

    const { result } = renderHook(() => useServerState(baseProps), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.setNewUsername("alice");
    });

    expect(result.current.usernameError).toBe("server.users.username_exists");
  });

  // ── Auto-dismiss error actionResult after 5s ──────

  it("auto-dismisses error actionResult after 5 seconds", async () => {
    vi.useFakeTimers();

    setupInvokeForLoad();

    const { result } = renderHook(() => useServerState(baseProps), { wrapper });

    // Let initial load complete
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // Trigger an error action result
    await act(async () => {
      await result.current.runAction("restart_service", async () => {
        throw "SSH_SERVICE_RESTART_FAILED";
      });
    });

    expect(result.current.actionResult).not.toBeNull();
    expect(result.current.actionResult?.type).toBe("error");

    // Advance 5s
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(result.current.actionResult).toBeNull();

    vi.useRealTimers();
  });

  // ── pushSuccess delegates to SnackBar ──────────────

  it("pushSuccess is a function (delegates to useSnackBar)", async () => {
    setupInvokeForLoad();

    const { result } = renderHook(() => useServerState(baseProps), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // pushSuccess now comes from useSnackBar and is a fire-and-forget function
    expect(typeof result.current.pushSuccess).toBe("function");
  });

  // ── Optimistic user state updates ──────────────────

  it("addUserToState adds user optimistically", async () => {
    setupInvokeForLoad();

    const { result } = renderHook(() => useServerState(baseProps), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.serverInfo).not.toBeNull();
    });

    act(() => {
      result.current.addUserToState("charlie");
    });

    expect(result.current.serverInfo!.users).toContain("charlie");
  });

  it("removeUserFromState removes user optimistically", async () => {
    setupInvokeForLoad();

    const { result } = renderHook(() => useServerState(baseProps), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.serverInfo).not.toBeNull();
    });

    act(() => {
      result.current.removeUserFromState("bob");
    });

    expect(result.current.serverInfo!.users).not.toContain("bob");
    expect(result.current.serverInfo!.users).toContain("alice");
  });

  // ── usersKnown sentinel: producer logic (R2-F08 review-fix, Plan 09-37) ──
  //
  // The original sentinel flipped usersKnown=true on ANY non-silent load via a
  // `|| !silent` clause. But the cold-start race that produces a false `users:[]`
  // happens on the NON-SILENT mount load: the backend creds grep fail-softs to an
  // empty Vec WITHOUT throwing, so the throw-only retry never fires and the empty
  // result is accepted → usersKnown=true → the Overview Users card flashes «0».
  // The corrected producer flips usersKnown=true ONLY on proof (populated list),
  // on a non-installed server, or after a confirming silent re-probe.

  it("does NOT set usersKnown on a NON-SILENT installed load that returns users:[] (the cold-start race)", async () => {
    vi.useFakeTimers();
    // Installed, but the creds probe fail-softed to an empty list (no throw).
    setupInvokeForLoad({ installed: true, version: "1.4.0", serviceActive: true, users: [] });

    const { result } = renderHook(() => useServerState(baseProps), { wrapper });

    // Drain the mount load (and any retry delay) but NOT the confirm re-probe delay.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(result.current.serverInfo).not.toBeNull();
    // The defect: `|| !silent` flipped this true immediately. It must stay false —
    // an empty installed list on the mount load is unconfirmed (could be the race).
    expect(result.current.usersKnown).toBe(false);

    vi.useRealTimers();
  });

  it("sets usersKnown immediately on a load that returns a POPULATED list (proof)", async () => {
    setupInvokeForLoad(); // fakeServerInfo has users:["alice","bob"]

    const { result } = renderHook(() => useServerState(baseProps), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.usersKnown).toBe(true);
  });

  it("sets usersKnown immediately when the server is NOT installed (Users card is not shown)", async () => {
    setupInvokeForLoad({ installed: false, version: "", serviceActive: false, users: [] });

    const { result } = renderHook(() => useServerState(baseProps), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.usersKnown).toBe(true);
  });

  it("fires EXACTLY ONE confirming silent re-probe on an empty installed load; a now-populated re-probe sets usersKnown", async () => {
    vi.useFakeTimers();
    let checkCalls = 0;
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "check_server_installation") {
        checkCalls += 1;
        // First (non-silent) load: empty list (race). Confirming re-probe: populated.
        return checkCalls === 1
          ? { installed: true, version: "1.4.0", serviceActive: true, users: [] }
          : { installed: true, version: "1.4.0", serviceActive: true, users: ["alice"] };
      }
      if (cmd === "server_get_config") return "config-data";
      if (cmd === "server_get_cert_info") return { cn: "test" };
      if (cmd === "server_get_available_versions") return ["1.4.0"];
      return null;
    });

    const { result } = renderHook(() => useServerState(baseProps), { wrapper });

    // Mount load settles empty → usersKnown stays false, confirm timer armed.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(result.current.usersKnown).toBe(false);

    // Fire the confirm re-probe (delay ~1000-1500ms).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(result.current.usersKnown).toBe(true);
    expect(result.current.serverInfo!.users).toContain("alice");

    vi.useRealTimers();
  });

  it("accepts a CONFIRMED zero: a re-probe that is STILL empty sets usersKnown=true (resolves to 0, not stuck on skeleton)", async () => {
    vi.useFakeTimers();
    let checkCalls = 0;
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "check_server_installation") {
        checkCalls += 1;
        // Both the mount load and the confirming re-probe return empty → genuine zero.
        return { installed: true, version: "1.4.0", serviceActive: true, users: [] };
      }
      if (cmd === "server_get_config") return "config-data";
      if (cmd === "server_get_cert_info") return { cn: "test" };
      if (cmd === "server_get_available_versions") return ["1.4.0"];
      return null;
    });

    const { result } = renderHook(() => useServerState(baseProps), { wrapper });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(result.current.usersKnown).toBe(false);

    // Confirm re-probe fires once and is still empty → CONFIRMED zero.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(result.current.usersKnown).toBe(true);
    expect(result.current.serverInfo!.users).toEqual([]);

    // And it fired EXACTLY one confirming re-probe (mount load + 1 confirm = 2).
    expect(checkCalls).toBe(2);

    // Advancing further must NOT fire another re-probe (gated by a ref).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(checkCalls).toBe(2);

    vi.useRealTimers();
  });

  it("resets usersKnown to false when the host (connection target) changes", async () => {
    setupInvokeForLoad(); // populated → usersKnown becomes true

    const { result, rerender } = renderHook((p: ServerPanelProps) => useServerState(p), {
      wrapper,
      initialProps: baseProps,
    });

    await vi.waitFor(() => {
      expect(result.current.usersKnown).toBe(true);
    });

    // Switch to a different server whose installed load fail-softs to an empty list.
    vi.useFakeTimers();
    setupInvokeForLoad({ installed: true, version: "1.4.0", serviceActive: true, users: [] });

    rerender({ ...baseProps, host: "10.0.0.2" });

    // After host change the sentinel must reset to false (fresh server → skeleton),
    // and the empty installed mount load must NOT immediately re-flip it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(result.current.usersKnown).toBe(false);

    vi.useRealTimers();
  });
});
