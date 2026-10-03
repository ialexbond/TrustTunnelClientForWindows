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

  // G-32-12 amended this test. It used to throw SSH_AUTH_FAILED and assert the probe
  // burned all three attempts on it — i.e. it PINNED the defect: three authentication
  // attempts per panel load against a server whose fail2ban this app installs. The
  // budget-exhaustion path it was really about is unchanged and is now exercised with a
  // genuinely persistent TRANSPORT failure; the auth case moved to the G-32-12 suite
  // below, where it asserts exactly one attempt.
  it("a genuine PERSISTENT transport failure surfaces the error after the R-6 retries are exhausted", async () => {
    let calls = 0;
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "check_server_installation") {
        calls += 1;
        throw "SSH_TIMEOUT|10.0.0.1"; // fails on every attempt
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

  // ══════════════════════════════════════════════════
  // G-32-12 — the panel's SSH session must survive the tunnel coming up
  //
  // Measured on build h2vn6t (UAT 2026-09-08): panel.load.start at 10:57:58.326,
  // autoconnect.connect_invoked at 10:58:00.384 — auto-connect rewrites the routing
  // table ~2 s INTO the panel's SSH session. The owner saw a connection error; the
  // panel recovered by itself (dur=6830ms, installed=true) and left NO trace of the
  // error anywhere. Owner's ruling: «SSH-сессия должна пережить подключение VPN».
  //
  // Two things are pinned here. First, the recovery keeps working — but now only for
  // failures whose TRANSPORT broke. Second, a REFUSED credential stops dead on the
  // first attempt: the R-6 loop used to retry everything-but-the-host-key, so a wrong
  // password cost the server three authentication attempts on every panel load, and
  // this app installs fail2ban on that very server.
  // ══════════════════════════════════════════════════

  /** Every `write_activity_log` payload the hook emitted, in call order. */
  const activityLines = () =>
    mockInvoke.mock.calls
      .filter((c) => c[0] === "write_activity_log")
      .map((c) => c[1] as { tag: string; message: string; details?: string | null });

  it("recovers a probe whose transport was cut mid-handshake (SSH_AUTH_ERROR is a broken pipe, not a rejected password)", async () => {
    // ssh/mod.rs emits SSH_AUTH_ERROR when the `authenticate_*` CALL ITSELF errors —
    // the exchange was cut off, the server never refused. This is the route-flip
    // signature, and translateSshError renders it as «Неверный SSH логин или пароль»,
    // so classifying it as a refusal would show "wrong password" for a correct one.
    let calls = 0;
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "check_server_installation") {
        calls += 1;
        if (calls === 1) throw "SSH_AUTH_ERROR|Disconnected";
        return fakeServerInfo;
      }
      if (cmd === "server_get_config") return "config-data";
      if (cmd === "server_get_cert_info") return { cn: "test" };
      if (cmd === "server_get_available_versions") return [];
      return null;
    });

    const { result } = renderHook(() => useServerState(baseProps), { wrapper });

    await vi.waitFor(() => { expect(result.current.loading).toBe(false); }, { timeout: 8000 });

    expect(calls).toBe(2);
    expect(result.current.serverInfo).toEqual(fakeServerInfo);
    expect(result.current.error).toBe("");
  }, 10000);

  it("writes ONE panel.load.retry line per retry, so the recovered error is no longer invisible", async () => {
    let calls = 0;
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "check_server_installation") {
        calls += 1;
        if (calls === 1) throw "SSH_CHANNEL_FAILED|Disconnected";
        return fakeServerInfo;
      }
      if (cmd === "server_get_config") return "config-data";
      if (cmd === "server_get_cert_info") return { cn: "test" };
      if (cmd === "server_get_available_versions") return [];
      return null;
    });

    const { result } = renderHook(() => useServerState(baseProps), { wrapper });
    await vi.waitFor(() => { expect(result.current.loading).toBe(false); }, { timeout: 8000 });

    const retries = activityLines().filter((l) => l.message.startsWith("panel.load.retry"));
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({
      tag: "STATE",
      message: "panel.load.retry attempt=1/3 code=SSH_CHANNEL_FAILED",
      details: "useServerState.loadServerInfo",
    });
  }, 10000);

  it("probes ONCE and surfaces immediately when the password is REJECTED — never three authentication attempts", async () => {
    // The whole point of G-32-12's dangerous half. SSH_PASSWORD_REJECTED means the
    // server completed the exchange and said no; offering the same credential twice
    // more is how fail2ban bans the user from their own server.
    let calls = 0;
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "check_server_installation") {
        calls += 1;
        throw "SSH_PASSWORD_REJECTED";
      }
      if (cmd === "server_get_available_versions") return [];
      return null;
    });

    const { result } = renderHook(() => useServerState(baseProps), { wrapper });
    await vi.waitFor(() => { expect(result.current.loading).toBe(false); }, { timeout: 8000 });

    expect(calls).toBe(1);
    expect(result.current.error).toBeTruthy();
    expect(result.current.serverInfo).toBeNull();

    const refused = activityLines().filter((l) => l.message.startsWith("panel.load.refused"));
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({
      tag: "ERROR",
      message: "panel.load.refused class=refusal code=SSH_PASSWORD_REJECTED",
      details: "useServerState.loadServerInfo",
    });
    // A refusal is not a retry.
    expect(activityLines().filter((l) => l.message.startsWith("panel.load.retry"))).toHaveLength(0);
  }, 10000);

  it.each(["SSH_AUTH_FAILED", "SSH_KEY_REJECTED"])(
    "probes ONCE on %s",
    async (code) => {
      let calls = 0;
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "check_server_installation") {
          calls += 1;
          throw code;
        }
        if (cmd === "server_get_available_versions") return [];
        return null;
      });

      const { result } = renderHook(() => useServerState(baseProps), { wrapper });
      await vi.waitFor(() => { expect(result.current.loading).toBe(false); }, { timeout: 8000 });

      expect(calls).toBe(1);
      expect(result.current.error).toBeTruthy();
    },
    10000,
  );

  it("D-29: no activity line the panel load writes may carry the SSH password", async () => {
    // Spy on the log SINK itself, not on a formatted string: the guarantee has to hold
    // for the retry line, the refusal line, the failed line and the raw-error line at
    // once. baseProps.sshPassword is "pass123".
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "check_server_installation") {
        // A raw error that embeds the credential — the worst case a backend or a
        // russh message could ever hand us.
        throw `SSH_AUTH_ERROR|authentication with password ${baseProps.sshPassword} failed`;
      }
      if (cmd === "server_get_available_versions") return [];
      return null;
    });

    const { result } = renderHook(() => useServerState(baseProps), { wrapper });
    await vi.waitFor(() => { expect(result.current.loading).toBe(false); }, { timeout: 12000 });

    const lines = activityLines();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(JSON.stringify(line)).not.toContain(baseProps.sshPassword);
    }
    // And nothing password-shaped reached the sink through any other argument either.
    for (const call of mockInvoke.mock.calls.filter((c) => c[0] === "write_activity_log")) {
      expect(JSON.stringify(call[1])).not.toContain(baseProps.sshPassword);
    }
  }, 15000);

  // ── G-32-12, second half: the panel-data probes race the same flip ──
  //
  // check_server_installation is a DIRECT one-shot connect; server_get_config and
  // server_get_cert_info ride the pooled connection, and they run right after the
  // probe — inside the same window in which auto-connect rewrites the routing table.
  // They sit in a Promise.allSettled whose rejections were dropped on the floor, so a
  // flip landing on them left the Configuration tab and the certificate card empty
  // with no error on screen and no line in activity.log.
  //
  // Their retry policy is STRICTER than the probe's: transport codes only, no
  // retryUnknown. SSH_READ_CONFIG_FAILED is a deterministic server-side condition
  // (server_config.rs returns it when the file could not be read) and retrying it
  // would add seconds to every load of a server in that state, for nothing.

  it("recovers a config read whose pooled transport was cut by the route flip", async () => {
    let cfgCalls = 0;
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "check_server_installation") return fakeServerInfo;
      if (cmd === "server_get_config") {
        cfgCalls += 1;
        if (cfgCalls === 1) throw "SSH_CHANNEL_FAILED|Disconnected";
        return "config-data";
      }
      if (cmd === "server_get_cert_info") return { cn: "test" };
      if (cmd === "server_get_available_versions") return [];
      return null;
    });

    const { result } = renderHook(() => useServerState(baseProps), { wrapper });
    await vi.waitFor(() => { expect(result.current.configRaw).toBe("config-data"); }, { timeout: 8000 });

    expect(cfgCalls).toBe(2);
    const retries = activityLines().filter((l) => l.message.startsWith("panel.data.retry"));
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({
      tag: "STATE",
      message: "panel.data.retry part=config attempt=1/2 code=SSH_CHANNEL_FAILED",
      details: "useServerState.loadServerInfo",
    });
  }, 10000);

  it("does NOT retry a deterministic server-side read failure, and records it instead of dropping it", async () => {
    let cfgCalls = 0;
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "check_server_installation") return fakeServerInfo;
      if (cmd === "server_get_config") {
        cfgCalls += 1;
        throw "SSH_READ_CONFIG_FAILED";
      }
      if (cmd === "server_get_cert_info") return { cn: "test" };
      if (cmd === "server_get_available_versions") return [];
      return null;
    });

    const { result } = renderHook(() => useServerState(baseProps), { wrapper });
    await vi.waitFor(() => { expect(result.current.loading).toBe(false); }, { timeout: 8000 });

    expect(cfgCalls).toBe(1);
    // The load as a whole still settles — a missing config must not blank the panel.
    expect(result.current.serverInfo).toEqual(fakeServerInfo);
    expect(result.current.certRaw).toEqual({ cn: "test" });

    const failed = activityLines().filter((l) => l.message.startsWith("panel.data.failed"));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      tag: "ERROR",
      message: "panel.data.failed part=config code=SSH_READ_CONFIG_FAILED",
      details: "useServerState.loadServerInfo",
    });
    expect(activityLines().filter((l) => l.message.startsWith("panel.data.retry"))).toHaveLength(0);
  }, 10000);

  it("says nothing about panel data when both parts load cleanly", async () => {
    setupInvokeForLoad();

    const { result } = renderHook(() => useServerState(baseProps), { wrapper });
    await vi.waitFor(() => { expect(result.current.loading).toBe(false); }, { timeout: 8000 });

    expect(activityLines().filter((l) => l.message.startsWith("panel.data."))).toHaveLength(0);
  }, 10000);

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
