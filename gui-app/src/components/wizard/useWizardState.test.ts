import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useWizardState } from "./useWizardState";
import type { ServerInfo } from "./types";

const STORAGE_KEY = "trusttunnel_wizard";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockInvoke = invoke as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockListen = listen as any;

function renderWizard(overrides?: { onSetupComplete?: () => void }) {
  const onSetupComplete = overrides?.onSetupComplete ?? vi.fn();
  return renderHook(() => useWizardState({ onSetupComplete }));
}

describe("useWizardState", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue(null);
    mockListen.mockResolvedValue(() => {});
  });

  // ─── 1. Initialization ───────────────────────────────

  describe("initialization", () => {
    it('starts at step="welcome" with all fields at defaults', () => {
      const { result } = renderWizard();

      expect(result.current.step).toBe("welcome");
      expect(result.current.host).toBe("");
      expect(result.current.port).toBe("22");
      expect(result.current.sshUser).toBe("root");
      expect(result.current.sshPassword).toBe("");
      expect(result.current.sshKeyPath).toBe("");
      expect(result.current.listenAddress).toBe("0.0.0.0:443");
      expect(result.current.vpnUsername).toBe("");
      expect(result.current.vpnPassword).toBe("");
      expect(result.current.certType).toBe("letsencrypt");
      expect(result.current.domain).toBe("");
      expect(result.current.email).toBe("");
      expect(result.current.pingEnable).toBe(false);
      expect(result.current.speedtestEnable).toBe(false);
      expect(result.current.ipv6Available).toBe(true);
      expect(result.current.serverInfo).toBeNull();
      expect(result.current.errorMessage).toBe("");
      expect(result.current.configPath).toBe("");
    });
  });

  // ─── 2. localStorage restore ─────────────────────────

  describe("localStorage restore", () => {
    it("restores persisted fields from localStorage on init", () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          host: "10.0.0.1",
          port: "2222",
          sshUser: "admin",
          sshKeyPath: "/home/.ssh/id_rsa",
          listenAddress: "0.0.0.0:8443",
          vpnUsername: "testuser",
          certType: "selfsigned",
          domain: "example.com",
          email: "a@b.com",
          pingEnable: true,
          speedtestEnable: true,
          ipv6Available: false,
          wizardStep: "server",
        }),
      );

      const { result } = renderWizard();

      expect(result.current.step).toBe("server");
      expect(result.current.host).toBe("10.0.0.1");
      expect(result.current.port).toBe("2222");
      expect(result.current.sshUser).toBe("admin");
      expect(result.current.sshKeyPath).toBe("/home/.ssh/id_rsa");
      expect(result.current.listenAddress).toBe("0.0.0.0:8443");
      expect(result.current.vpnUsername).toBe("testuser");
      expect(result.current.certType).toBe("selfsigned");
      expect(result.current.domain).toBe("example.com");
      expect(result.current.email).toBe("a@b.com");
      expect(result.current.pingEnable).toBe(true);
      expect(result.current.speedtestEnable).toBe(true);
      expect(result.current.ipv6Available).toBe(false);
    });

    it('resets "done" step to "welcome" when no config path exists', () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ wizardStep: "done" }),
      );

      const { result } = renderWizard();
      expect(result.current.step).toBe("welcome");
    });

    it('keeps "done" step when config path exists', () => {
      localStorage.setItem("tt_config_path", "/some/path.toml");
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ wizardStep: "done" }),
      );

      const { result } = renderWizard();
      expect(result.current.step).toBe("done");
    });

    it('falls back "deploying" to "endpoint" when no config path', () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ wizardStep: "deploying" }),
      );

      const { result } = renderWizard();
      expect(result.current.step).toBe("welcome");
    });

    it('falls back "checking" to "server"', () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ wizardStep: "checking" }),
      );

      const { result } = renderWizard();
      expect(result.current.step).toBe("server");
    });
  });

  // ─── 3. setHost / setPort / etc ──────────────────────

  describe("field setters persist to localStorage", () => {
    it("setHost updates state and persists", () => {
      const { result } = renderWizard();

      act(() => {
        result.current.setHost("192.168.1.1");
      });

      expect(result.current.host).toBe("192.168.1.1");
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
      expect(stored.host).toBe("192.168.1.1");
    });

    it("setPort updates state and persists", () => {
      const { result } = renderWizard();

      act(() => {
        result.current.setPort("3333");
      });

      expect(result.current.port).toBe("3333");
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
      expect(stored.port).toBe("3333");
    });

    it("setSshUser updates state and persists", () => {
      const { result } = renderWizard();

      act(() => {
        result.current.setSshUser("deploy");
      });

      expect(result.current.sshUser).toBe("deploy");
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
      expect(stored.sshUser).toBe("deploy");
    });

    it("setVpnUsername updates state and persists", () => {
      const { result } = renderWizard();

      act(() => {
        result.current.setVpnUsername("myuser");
      });

      expect(result.current.vpnUsername).toBe("myuser");
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
      expect(stored.vpnUsername).toBe("myuser");
    });

    it("setCertType updates state and persists", () => {
      const { result } = renderWizard();

      act(() => {
        result.current.setCertType("selfsigned");
      });

      expect(result.current.certType).toBe("selfsigned");
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
      expect(stored.certType).toBe("selfsigned");
    });

    it("setPingEnable updates state and persists", () => {
      const { result } = renderWizard();

      act(() => {
        result.current.setPingEnable(true);
      });

      expect(result.current.pingEnable).toBe(true);
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
      expect(stored.pingEnable).toBe(true);
    });
  });

  // ─── 4. Password persistence ─────────────────────────

  describe("password persistence", () => {
    it("stores sshPassword as plaintext in localStorage", () => {
      const { result } = renderWizard();

      act(() => {
        result.current.setSshPassword("secret123");
      });

      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
      expect(stored.sshPassword).toBe("secret123");
    });

    it("stores vpnPassword as plaintext in localStorage", () => {
      const { result } = renderWizard();

      act(() => {
        result.current.setVpnPassword("vpnpass!");
      });

      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
      expect(stored.vpnPassword).toBe("vpnpass!");
    });

    it("restores plaintext password from localStorage", () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ sshPassword: "mySecret", vpnPassword: "mySecret" }),
      );

      const { result } = renderWizard();
      expect(result.current.sshPassword).toBe("mySecret");
      expect(result.current.vpnPassword).toBe("mySecret");
    });

    it("handles non-obfuscated password in storage gracefully", () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ sshPassword: "plaintext" }),
      );

      const { result } = renderWizard();
      expect(result.current.sshPassword).toBe("plaintext");
    });
  });

  // ─── 5. handleCheckServer — installed ────────────────

  describe("handleCheckServer — server installed", () => {
    it("transitions to 'found' when server is installed", async () => {
      const serverInfo: ServerInfo = {
        installed: true,
        version: "1.5.0",
        serviceActive: true,
        users: ["alice"],
      };
      mockInvoke.mockResolvedValueOnce(serverInfo);

      const { result } = renderWizard();

      act(() => {
        result.current.setHost("10.0.0.1");
        result.current.setSshPassword("pass");
      });

      await act(async () => {
        await result.current.handleCheckServer();
      });

      expect(mockInvoke).toHaveBeenCalledWith(
        "check_server_installation",
        expect.objectContaining({ host: "10.0.0.1" }),
      );
      expect(result.current.step).toBe("found");
      expect(result.current.serverInfo).toEqual(serverInfo);
    });
  });

  // ─── 6. handleCheckServer — not installed ────────────

  describe("handleCheckServer — not installed", () => {
    it("transitions to 'endpoint' when server is not installed", async () => {
      const serverInfo: ServerInfo = {
        installed: false,
        version: "",
        serviceActive: false,
        users: [],
      };
      mockInvoke.mockResolvedValueOnce(serverInfo);

      const { result } = renderWizard();

      act(() => {
        result.current.setHost("10.0.0.1");
        result.current.setSshPassword("pass");
      });

      await act(async () => {
        await result.current.handleCheckServer();
      });

      expect(result.current.step).toBe("endpoint");
      expect(result.current.serverInfo).toEqual(serverInfo);
    });
  });

  // ─── 7. handleCheckServer — error ────────────────────

  describe("handleCheckServer — error", () => {
    it("sets checkError and step to 'found' on invoke rejection", async () => {
      mockInvoke.mockRejectedValueOnce(new Error("SSH timeout"));

      const { result } = renderWizard();

      act(() => {
        result.current.setHost("10.0.0.1");
        result.current.setSshPassword("pass");
      });

      await act(async () => {
        await result.current.handleCheckServer();
      });

      expect(result.current.step).toBe("found");
      expect(result.current.checkError).toContain("SSH timeout");
      expect(result.current.serverInfo).toEqual({
        installed: false,
        version: "",
        serviceActive: false,
        users: [],
      });
    });
  });

  // ─── 8. handleDeploy ────────────────────────────────

  describe("handleDeploy", () => {
    it("sets step to 'deploying' and calls deploy_server", async () => {
      mockInvoke.mockResolvedValueOnce("/path/to/config.toml");

      const { result } = renderWizard();

      act(() => {
        result.current.setHost("10.0.0.1");
        result.current.setSshPassword("pass");
        result.current.setVpnUsername("user1");
        result.current.setVpnPassword("vpnpass");
      });

      await act(async () => {
        const deployPromise = result.current.handleDeploy();
        // The step should change to deploying immediately
        void result.current.step;
        await deployPromise;
      });

      expect(mockInvoke).toHaveBeenCalledWith(
        "deploy_server",
        expect.objectContaining({
          host: "10.0.0.1",
          settings: expect.objectContaining({
            vpnUsername: "user1",
          }),
        }),
      );
      expect(result.current.configPath).toBe("/path/to/config.toml");
    });

    it("sets error state when deploy_server rejects", async () => {
      mockInvoke.mockRejectedValueOnce(new Error("deploy failed"));

      const { result } = renderWizard();

      act(() => {
        result.current.setHost("10.0.0.1");
        result.current.setSshPassword("pass");
      });

      await act(async () => {
        await result.current.handleDeploy();
      });

      expect(result.current.step).toBe("error");
      expect(result.current.errorMessage).toContain("deploy failed");
    });
  });

  // ─── 9. handleFetchConfig ────────────────────────────

  describe("handleFetchConfig", () => {
    it("calls fetch_server_config and stores config path", async () => {
      mockInvoke.mockResolvedValueOnce("/fetched/config.toml");

      const { result } = renderWizard();

      act(() => {
        result.current.setHost("10.0.0.1");
        result.current.setSshPassword("pass");
        result.current.setVpnUsername("alice");
      });

      await act(async () => {
        await result.current.handleFetchConfig();
      });

      expect(mockInvoke).toHaveBeenCalledWith(
        "fetch_server_config",
        expect.objectContaining({
          host: "10.0.0.1",
          clientName: "alice",
        }),
      );
      expect(result.current.configPath).toBe("/fetched/config.toml");
    });

    it("sets error state on fetch failure and increments retry count", async () => {
      mockInvoke.mockRejectedValueOnce(new Error("fetch error"));

      const { result } = renderWizard();

      act(() => {
        result.current.setHost("10.0.0.1");
        result.current.setSshPassword("pass");
      });

      await act(async () => {
        await result.current.handleFetchConfig();
      });

      expect(result.current.step).toBe("error");
      expect(result.current.errorMessage).toContain("fetch error");
      expect(result.current.fetchRetryCount).toBe(1);
    });

    it("passes forUser parameter as clientName when provided", async () => {
      mockInvoke.mockResolvedValueOnce("/fetched/bob.toml");

      const { result } = renderWizard();

      act(() => {
        result.current.setHost("10.0.0.1");
        result.current.setSshPassword("pass");
        result.current.setVpnUsername("alice");
      });

      await act(async () => {
        await result.current.handleFetchConfig("bob");
      });

      expect(mockInvoke).toHaveBeenCalledWith(
        "fetch_server_config",
        expect.objectContaining({ clientName: "bob" }),
      );
    });
  });

  // ─── 10. handleUninstall ─────────────────────────────

  describe("handleUninstall", () => {
    it("calls vpn_disconnect then uninstall_server", async () => {
      mockInvoke
        .mockResolvedValueOnce(undefined) // vpn_disconnect
        .mockResolvedValueOnce(undefined); // uninstall_server

      const { result } = renderWizard();

      act(() => {
        result.current.setHost("10.0.0.1");
        result.current.setSshPassword("pass");
      });

      await act(async () => {
        await result.current.handleUninstall();
      });

      expect(mockInvoke).toHaveBeenCalledWith("vpn_disconnect");
      expect(mockInvoke).toHaveBeenCalledWith(
        "uninstall_server",
        expect.objectContaining({ host: "10.0.0.1" }),
      );
      expect(result.current.step).toBe("server");
      expect(result.current.serverInfo).toBeNull();
    });

    it("sets error state when uninstall_server rejects", async () => {
      mockInvoke
        .mockResolvedValueOnce(undefined) // vpn_disconnect
        .mockRejectedValueOnce(new Error("uninstall failed")); // uninstall_server

      const { result } = renderWizard();

      act(() => {
        result.current.setHost("10.0.0.1");
        result.current.setSshPassword("pass");
      });

      await act(async () => {
        await result.current.handleUninstall();
      });

      expect(result.current.step).toBe("error");
      expect(result.current.errorMessage).toContain("uninstall failed");
    });
  });

  // ─── 11. handleAddUser / handleDeleteUser ────────────

  describe("handleAddUser", () => {
    it("calls add_server_user with correct params", async () => {
      mockInvoke
        .mockResolvedValueOnce("ok") // add_server_user
        .mockResolvedValueOnce({     // check_server_installation refresh
          installed: true,
          version: "1.5.0",
          serviceActive: true,
          users: ["alice", "newuser"],
        });

      const { result } = renderWizard();

      act(() => {
        result.current.setHost("10.0.0.1");
        result.current.setSshPassword("pass");
        result.current.setNewUsername("newuser");
        result.current.setNewPassword("newpass");
      });

      await act(async () => {
        await result.current.handleAddUser();
      });

      expect(mockInvoke).toHaveBeenCalledWith(
        "add_server_user",
        expect.objectContaining({
          host: "10.0.0.1",
          vpnUsername: "newuser",
          vpnPassword: "newpass",
        }),
      );
      // Fields cleared after success
      expect(result.current.newUsername).toBe("");
      expect(result.current.newPassword).toBe("");
      // Server info refreshed
      expect(result.current.serverInfo?.users).toContain("newuser");
    });

    it("does nothing when username or password is empty", async () => {
      const { result } = renderWizard();

      await act(async () => {
        await result.current.handleAddUser();
      });

      expect(mockInvoke).not.toHaveBeenCalledWith(
        "add_server_user",
        expect.anything(),
      );
    });

    it("sets errorMessage when add_server_user rejects", async () => {
      mockInvoke.mockRejectedValueOnce(new Error("user exists"));

      const { result } = renderWizard();

      act(() => {
        result.current.setNewUsername("dup");
        result.current.setNewPassword("pass");
        result.current.setHost("10.0.0.1");
        result.current.setSshPassword("sshpass");
      });

      await act(async () => {
        await result.current.handleAddUser();
      });

      expect(result.current.errorMessage).toContain("user exists");
    });
  });

  describe("handleDeleteUser", () => {
    it("calls server_remove_user with correct params", async () => {
      mockInvoke
        .mockResolvedValueOnce(undefined) // server_remove_user
        .mockResolvedValueOnce({          // check_server_installation refresh
          installed: true,
          version: "1.5.0",
          serviceActive: true,
          users: ["bob"],
        });

      const { result } = renderWizard();

      act(() => {
        result.current.setHost("10.0.0.1");
        result.current.setSshPassword("pass");
      });

      await act(async () => {
        await result.current.handleDeleteUser("alice");
      });

      expect(mockInvoke).toHaveBeenCalledWith(
        "server_remove_user",
        expect.objectContaining({
          host: "10.0.0.1",
          vpnUsername: "alice",
        }),
      );
      expect(result.current.serverInfo?.users).toEqual(["bob"]);
    });

    it("sets errorMessage when server_remove_user rejects", async () => {
      mockInvoke.mockRejectedValueOnce(new Error("cannot remove"));

      const { result } = renderWizard();

      act(() => {
        result.current.setHost("10.0.0.1");
        result.current.setSshPassword("pass");
      });

      await act(async () => {
        await result.current.handleDeleteUser("alice");
      });

      expect(result.current.errorMessage).toContain("cannot remove");
    });
  });

  // ─── Derived state ──────────────────────────────────

  describe("derived state", () => {
    it("canGoToEndpoint is true when host and password are set", () => {
      const { result } = renderWizard();

      act(() => {
        result.current.setHost("10.0.0.1");
        result.current.setSshPassword("pass");
      });

      expect(result.current.canGoToEndpoint).toBe(true);
    });

    it("canGoToEndpoint is false when host is empty", () => {
      const { result } = renderWizard();
      expect(result.current.canGoToEndpoint).toBe(false);
    });

    it("canDeploy is true for selfsigned with username and password", () => {
      const { result } = renderWizard();

      act(() => {
        result.current.setVpnUsername("user1");
        result.current.setVpnPassword("pass");
        result.current.setCertType("selfsigned");
      });

      expect(result.current.canDeploy).toBe(true);
    });

    it("canDeploy is false when vpnUsername is empty", () => {
      const { result } = renderWizard();

      act(() => {
        result.current.setVpnPassword("pass");
        result.current.setCertType("selfsigned");
      });

      expect(result.current.canDeploy).toBe(false);
    });

    it("isValidEmail returns true for valid emails and empty string", () => {
      const { result } = renderWizard();
      expect(result.current.isValidEmail("")).toBe(true);
      expect(result.current.isValidEmail("a@b.com")).toBe(true);
      expect(result.current.isValidEmail("invalid")).toBe(false);
    });
  });

  // ─── setWizardStep persists ──────────────────────────

  describe("setWizardStep", () => {
    it("updates step and persists to localStorage", () => {
      const { result } = renderWizard();

      act(() => {
        result.current.setWizardStep("server");
      });

      expect(result.current.step).toBe("server");
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
      expect(stored.wizardStep).toBe("server");
    });
  });
});
