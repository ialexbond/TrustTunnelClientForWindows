import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import {
  useSecurityState,
  validatePort,
  validateSource,
  validateComment,
  validateIp,
  type SecurityStatus,
  type SshParams,
} from "./useSecurityState";

// ─── Helpers ─────────────────────────────────────────

const mockInvoke = vi.mocked(invoke) as unknown as Mock;

const mockSshParams: SshParams = {
  host: "1.2.3.4",
  port: 22,
  user: "root",
  password: "pass",
  keyPath: "",
};

const mockPushSuccess = vi.fn();

function makeSecurityStatus(overrides?: Partial<SecurityStatus>): SecurityStatus {
  return {
    fail2ban: {
      installed: true,
      active: true,
      jails: [
        {
          name: "sshd",
          enabled: true,
          currently_failed: 2,
          total_failed: 10,
          currently_banned: 1,
          total_banned: 5,
          banned_ips: ["10.0.0.1"],
          maxretry: 5,
          bantime: "600",
          findtime: "600",
        },
      ],
    },
    firewall: {
      installed: true,
      active: true,
      default_in: "deny",
      default_out: "allow",
      default_routed: "disabled",
      logging: "on",
      rules: [
        { number: 1, to: "22/tcp", from: "Anywhere", action: "ALLOW IN", proto: "tcp", comment: "SSH" },
        { number: 2, to: "443/tcp", from: "Anywhere", action: "ALLOW IN", proto: "tcp", comment: "VPN" },
      ],
      current_ssh_port: 22,
      vpn_port: 443,
    },
    ...overrides,
  };
}

function setupInvokeForLoad(status?: SecurityStatus) {
  const data = status ?? makeSecurityStatus();
  mockInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === "security_get_status") return data;
    return null;
  });
}

// ─── Pure validator tests ───────────────────────────

describe("validatePort", () => {
  it("accepts valid single port", () => {
    expect(validatePort("80")).toBeNull();
    expect(validatePort("443")).toBeNull();
    expect(validatePort("65535")).toBeNull();
  });

  it("accepts valid port range", () => {
    expect(validatePort("80:90")).toBeNull();
    expect(validatePort("1024:2048")).toBeNull();
  });

  it("rejects empty port", () => {
    expect(validatePort("")).toBe("server.security.errors.port_empty");
    expect(validatePort("  ")).toBe("server.security.errors.port_empty");
  });

  it("rejects shell injection", () => {
    expect(validatePort("80; rm -rf /")).toBe("server.security.errors.port_invalid");
    expect(validatePort("$(whoami)")).toBe("server.security.errors.port_invalid");
    expect(validatePort("80`id`")).toBe("server.security.errors.port_invalid");
  });

  it("rejects out of range port", () => {
    expect(validatePort("0")).toBe("server.security.errors.port_out_of_range");
    expect(validatePort("70000")).toBe("server.security.errors.port_out_of_range");
  });

  it("rejects invalid range (start >= end)", () => {
    expect(validatePort("90:80")).toBe("server.security.errors.port_range_invalid");
    expect(validatePort("80:80")).toBe("server.security.errors.port_range_invalid");
  });
});

describe("validateSource", () => {
  it("accepts empty and 'any'", () => {
    expect(validateSource("")).toBeNull();
    expect(validateSource("any")).toBeNull();
  });

  it("accepts valid IPv4 and CIDR", () => {
    expect(validateSource("10.0.0.1")).toBeNull();
    expect(validateSource("192.168.0.0/24")).toBeNull();
  });

  it("accepts valid IPv6", () => {
    expect(validateSource("::1")).toBeNull();
    expect(validateSource("fe80::1")).toBeNull();
  });

  it("rejects non-IP characters", () => {
    expect(validateSource("abc; rm -rf /")).toBe("server.security.errors.source_invalid");
    expect(validateSource("$(whoami)")).toBe("server.security.errors.source_invalid");
  });

  it("rejects strings without dot or colon", () => {
    expect(validateSource("12345")).toBe("server.security.errors.source_invalid");
  });
});

describe("validateComment", () => {
  it("accepts normal comments", () => {
    expect(validateComment("SSH access")).toBeNull();
    expect(validateComment("")).toBeNull();
  });

  it("rejects backticks and dollar signs", () => {
    expect(validateComment("`whoami`")).toBe("server.security.errors.comment_bad_chars");
    expect(validateComment("$HOME")).toBe("server.security.errors.comment_bad_chars");
  });

  it("rejects too long comments", () => {
    expect(validateComment("a".repeat(81))).toBe("server.security.errors.comment_too_long");
  });
});

describe("validateIp", () => {
  it("accepts valid IPv4", () => {
    expect(validateIp("192.168.1.1")).toBeNull();
  });

  it("accepts valid IPv6", () => {
    expect(validateIp("::1")).toBeNull();
    expect(validateIp("fe80::1")).toBeNull();
  });

  it("rejects empty", () => {
    expect(validateIp("")).toBe("server.security.errors.ip_invalid");
  });

  it("rejects non-IP characters", () => {
    expect(validateIp("abc; rm -rf /")).toBe("server.security.errors.ip_invalid");
    expect(validateIp("10.0.0.1; drop")).toBe("server.security.errors.ip_invalid");
  });

  it("rejects strings without dot or colon", () => {
    expect(validateIp("12345")).toBe("server.security.errors.ip_invalid");
  });
});

// ─── Hook tests ─────────────────────────────────────

describe("useSecurityState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue(null);
  });

  it("starts with status=null and loading (until resolved)", () => {
    mockInvoke.mockImplementation(() => new Promise(() => {})); // never resolves
    const { result } = renderHook(() => useSecurityState(mockSshParams, mockPushSuccess));
    expect(result.current.status).toBeNull();
    expect(result.current.loading).toBe(true);
  });

  it("loads security status on mount via invoke('security_get_status')", async () => {
    setupInvokeForLoad();
    const { result } = renderHook(() => useSecurityState(mockSshParams, mockPushSuccess));

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.status).not.toBeNull();
    expect(result.current.status!.fail2ban.installed).toBe(true);
    expect(result.current.status!.firewall.rules).toHaveLength(2);
    expect(mockInvoke).toHaveBeenCalledWith("security_get_status", expect.objectContaining({
      host: "1.2.3.4",
      port: 22,
      user: "root",
    }));
  });

  it("load() re-fetches status and updates state", async () => {
    setupInvokeForLoad();
    const { result } = renderHook(() => useSecurityState(mockSshParams, mockPushSuccess));

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Change mock data and reload
    const updated = makeSecurityStatus({
      fail2ban: { installed: false, active: false, jails: [] },
    });
    setupInvokeForLoad(updated);

    await act(async () => {
      await result.current.load();
    });

    expect(result.current.status!.fail2ban.installed).toBe(false);
  });

  it("install fail2ban sets confirm dialog, onConfirm invokes 'security_install_fail2ban'", async () => {
    setupInvokeForLoad();
    const { result } = renderHook(() => useSecurityState(mockSshParams, mockPushSuccess));

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Trigger install
    act(() => {
      result.current.installFail2ban();
    });

    expect(result.current.confirm).not.toBeNull();
    expect(result.current.confirm!.variant).toBe("warning");

    // Confirm
    await act(async () => {
      result.current.confirm!.onConfirm();
    });

    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("security_install_fail2ban", expect.objectContaining({
        host: "1.2.3.4",
      }));
    });
  });

  it("install firewall passes sshParams + keepHttpOpen=false", async () => {
    setupInvokeForLoad();
    const { result } = renderHook(() => useSecurityState(mockSshParams, mockPushSuccess));

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.installFirewall();
    });

    expect(result.current.confirm).not.toBeNull();

    await act(async () => {
      result.current.confirm!.onConfirm();
    });

    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("security_install_firewall", expect.objectContaining({
        host: "1.2.3.4",
        keepHttpOpen: false,
      }));
    });
  });

  it("addRule validates port/source/comment before invoke", async () => {
    setupInvokeForLoad();
    const { result } = renderHook(() => useSecurityState(mockSshParams, mockPushSuccess));

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Set valid rule
    act(() => {
      result.current.setNewRule({ port: "443", proto: "tcp", action: "allow", from: "", comment: "VPN" });
    });

    await act(async () => {
      await result.current.addRule();
    });

    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("security_firewall_add_rule", expect.objectContaining({
        rule: expect.objectContaining({ port: "443" }),
      }));
    });
  });

  it("addRule rejects invalid port (shows error, does NOT invoke add_rule)", async () => {
    setupInvokeForLoad();
    const { result } = renderHook(() => useSecurityState(mockSshParams, mockPushSuccess));

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.setNewRule({ port: "abc", proto: "tcp", action: "allow", from: "", comment: "" });
    });

    await act(async () => {
      await result.current.addRule();
    });

    expect(mockPushSuccess).toHaveBeenCalledWith(expect.any(String), "error");
    expect(mockInvoke).not.toHaveBeenCalledWith("security_firewall_add_rule", expect.anything());
  });

  it("banIp validates IP format before invoke", async () => {
    setupInvokeForLoad();
    const { result } = renderHook(() => useSecurityState(mockSshParams, mockPushSuccess));

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Set invalid IP
    act(() => {
      result.current.setManualBanIp("not-an-ip");
    });

    act(() => {
      result.current.banIp("sshd");
    });

    expect(mockPushSuccess).toHaveBeenCalledWith(expect.any(String), "error");
    expect(mockInvoke).not.toHaveBeenCalledWith("security_fail2ban_ban", expect.anything());
  });

  it("isBusy tracks concurrent operations via busySet", async () => {
    // Make invoke hang so we can observe busy state
    let resolveInvoke: ((v: unknown) => void) | undefined;
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "security_get_status") return makeSecurityStatus();
      if (cmd === "security_start_fail2ban") {
        return new Promise(r => { resolveInvoke = r; });
      }
      return null;
    });

    const { result } = renderHook(() => useSecurityState(mockSshParams, mockPushSuccess));

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Start a long-running action
    act(() => {
      void result.current.startFail2ban();
    });

    // Should be busy now
    await vi.waitFor(() => {
      expect(result.current.isBusy("start-f2b")).toBe(true);
    });
    expect(result.current.f2bBusy).toBe(true);

    // Resolve it
    await act(async () => {
      resolveInvoke?.(null);
    });

    await vi.waitFor(() => {
      expect(result.current.isBusy("start-f2b")).toBe(false);
    });
  });
});
