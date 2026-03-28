import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useServerState, type ServerInfo, type ServerPanelProps } from "./useServerState";

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

    const { result } = renderHook(() => useServerState(baseProps));

    expect(result.current.serverInfo).toBeNull();
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBe("");
  });

  // ── loadServerInfo success ─────────────────────────

  it("populates serverInfo after successful load", async () => {
    setupInvokeForLoad();

    const { result } = renderHook(() => useServerState(baseProps));

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

  it("sets translated error when loadServerInfo fails", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "check_server_installation") throw "SSH_TIMEOUT|10.0.0.1";
      if (cmd === "server_get_available_versions") return [];
      return null;
    });

    const { result } = renderHook(() => useServerState(baseProps));

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // translateSshError maps SSH_TIMEOUT via t("sshErrors.timeout", ...)
    // i18n returns the key or interpolated string
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

    renderHook(() => useServerState(propsNoPass));

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

    const { result } = renderHook(() => useServerState(baseProps));

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
    // Success message pushed to queue
    expect(result.current.successQueue).toContain("Service restarted");
  });

  // ── runAction error ────────────────────────────────

  it("runAction sets actionResult error when invoke throws", async () => {
    setupInvokeForLoad();

    const { result } = renderHook(() => useServerState(baseProps));

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

    const { result } = renderHook(() => useServerState(baseProps));

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.usernameError).toBe("");
  });

  it("usernameError detects spaces in username", async () => {
    setupInvokeForLoad();

    const { result } = renderHook(() => useServerState(baseProps));

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

    const { result } = renderHook(() => useServerState(baseProps));

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

    const { result } = renderHook(() => useServerState(baseProps));

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

  // ── successQueue management ────────────────────────

  it("pushSuccess adds to queue and shiftSuccess removes first item", async () => {
    setupInvokeForLoad();

    const { result } = renderHook(() => useServerState(baseProps));

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.pushSuccess("msg1");
      result.current.pushSuccess("msg2");
    });

    expect(result.current.successQueue).toEqual(["msg1", "msg2"]);

    act(() => {
      result.current.shiftSuccess();
    });

    expect(result.current.successQueue).toEqual(["msg2"]);
  });

  // ── Optimistic user state updates ──────────────────

  it("addUserToState adds user optimistically", async () => {
    setupInvokeForLoad();

    const { result } = renderHook(() => useServerState(baseProps));

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

    const { result } = renderHook(() => useServerState(baseProps));

    await vi.waitFor(() => {
      expect(result.current.serverInfo).not.toBeNull();
    });

    act(() => {
      result.current.removeUserFromState("bob");
    });

    expect(result.current.serverInfo!.users).not.toContain("bob");
    expect(result.current.serverInfo!.users).toContain("alice");
  });
});
