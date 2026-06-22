import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  SNAPSHOT_KEY,
  loadSnapshot,
  saveSnapshot,
  clearEndpointForm,
  migrateLegacySshPassword,
} from "./persist";

// Harness shape from useWizardState.test.ts:1-26 — clear localStorage + reset
// the global invoke mock between cases.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockInvoke = invoke as any;

describe("wizard persist", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue(null);
  });

  // ─── 1. Round-trip of the non-secret snapshot ──────────────────────
  it("round-trips the non-secret fields", () => {
    saveSnapshot({
      step: "endpoint",
      host: "10.0.0.1",
      port: "2222",
      sshUser: "admin",
      keyPath: "/home/.ssh/id_rsa",
      listenAddress: "0.0.0.0:8443",
      vpnUsername: "testuser",
      certType: "selfsigned",
      domain: "example.com",
      email: "a@b.com",
      certChainPath: "/c/chain.pem",
      certKeyPath: "/c/key.pem",
    });

    const loaded = loadSnapshot();
    expect(loaded.step).toBe("endpoint");
    expect(loaded.host).toBe("10.0.0.1");
    expect(loaded.port).toBe("2222");
    expect(loaded.sshUser).toBe("admin");
    expect(loaded.keyPath).toBe("/home/.ssh/id_rsa");
    expect(loaded.listenAddress).toBe("0.0.0.0:8443");
    expect(loaded.vpnUsername).toBe("testuser");
    expect(loaded.certType).toBe("selfsigned");
    expect(loaded.domain).toBe("example.com");
    expect(loaded.email).toBe("a@b.com");
    expect(loaded.certChainPath).toBe("/c/chain.pem");
    expect(loaded.certKeyPath).toBe("/c/key.pem");
  });

  // ─── 2. Secrets are NEVER serialized (D-05) ────────────────────────
  it("never writes sshPassword/vpnPassword/sshKeyData to the blob", () => {
    saveSnapshot({
      step: "server",
      host: "10.0.0.1",
      // Secrets planted on the input — they must be dropped, not persisted.
      sshPassword: "hunter2",
      vpnPassword: "vpnpw",
      sshKeyData: "-----BEGIN PRIVATE KEY-----",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const raw = localStorage.getItem(SNAPSHOT_KEY)!;
    expect(raw).not.toContain("hunter2");
    expect(raw).not.toContain("vpnpw");
    expect(raw).not.toContain("BEGIN PRIVATE KEY");
    expect(raw).not.toContain("sshPassword");
    expect(raw).not.toContain("vpnPassword");
    expect(raw).not.toContain("sshKeyData");

    const loaded = loadSnapshot();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((loaded as any).sshPassword).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((loaded as any).vpnPassword).toBeUndefined();
  });

  it("loadSnapshot strips legacy secret keys from an old blob", () => {
    localStorage.setItem(
      SNAPSHOT_KEY,
      JSON.stringify({ host: "1.2.3.4", sshPassword: "legacy", vpnPassword: "legacy2" }),
    );
    const loaded = loadSnapshot();
    expect(loaded.host).toBe("1.2.3.4");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((loaded as any).sshPassword).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((loaded as any).vpnPassword).toBeUndefined();
  });

  // ─── 3. saveSnapshot merges, never clobbers other keys ─────────────
  it("merges into the existing blob without dropping prior fields", () => {
    saveSnapshot({ host: "1.1.1.1", sshUser: "root" });
    saveSnapshot({ port: "2200" });
    const loaded = loadSnapshot();
    expect(loaded.host).toBe("1.1.1.1");
    expect(loaded.sshUser).toBe("root");
    expect(loaded.port).toBe("2200");
  });

  // ─── 4. MIGRATE-BEFORE-STRIP (must-fix #1) ─────────────────────────
  it("calls save_ssh_credentials with the password BEFORE stripping it", async () => {
    localStorage.setItem(
      SNAPSHOT_KEY,
      JSON.stringify({
        host: "10.0.0.1",
        port: "22",
        sshUser: "root",
        sshPassword: "hunter2",
        keyPath: "/k",
      }),
    );

    await migrateLegacySshPassword();

    // The password was handed to Credential Manager FIRST.
    expect(mockInvoke).toHaveBeenCalledWith(
      "save_ssh_credentials",
      expect.objectContaining({
        host: "10.0.0.1",
        port: "22",
        user: "root",
        password: "hunter2",
        keyPath: "/k",
      }),
    );
    // …and only AFTER a successful save is the plaintext gone from the blob.
    const raw = localStorage.getItem(SNAPSHOT_KEY)!;
    expect(raw).not.toContain("hunter2");
    expect(raw).not.toContain("sshPassword");
    // Non-secret fields survive the rewrite.
    const loaded = loadSnapshot();
    expect(loaded.host).toBe("10.0.0.1");
  });

  it("does nothing when there is no legacy plaintext password", async () => {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ host: "10.0.0.1", port: "22", sshUser: "root" }));
    await migrateLegacySshPassword();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("skips migration when host/port/user are incomplete", async () => {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ sshPassword: "hunter2" }));
    await migrateLegacySshPassword();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  // ─── 5. MIGRATION FAILURE — resolve, do NOT lose the password ──────
  it("RESOLVES (does not reject) and KEEPS the plaintext when the invoke rejects", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("keyring down"));
    localStorage.setItem(
      SNAPSHOT_KEY,
      JSON.stringify({ host: "10.0.0.1", port: "22", sshUser: "root", sshPassword: "hunter2" }),
    );

    // Finding I: the fn itself must never reject.
    await expect(migrateLegacySshPassword()).resolves.toBeUndefined();

    // WR-06: the password is NOT lost and the blob is NOT clobbered with "".
    const raw = localStorage.getItem(SNAPSHOT_KEY)!;
    expect(raw).toContain("hunter2");
    expect(raw).not.toBe("");
  });

  // ─── 6. Corrupt blob tolerance (WR-06) ─────────────────────────────
  it("loadSnapshot returns {} on a corrupt blob without throwing", () => {
    localStorage.setItem(SNAPSHOT_KEY, "{not valid json");
    expect(() => loadSnapshot()).not.toThrow();
    expect(loadSnapshot()).toEqual({});
  });

  // ─── 7. clearEndpointForm (UAT 06-uat fix 3) ───────────────────────
  it("clearEndpointForm drops ALL endpoint + advanced keys and resets certType, keeping SSH identity", () => {
    const blob: Record<string, unknown> = {
      // SSH identity that must SURVIVE (panel just connected).
      host: "10.0.0.1",
      port: "22",
      sshUser: "root",
      // endpoint + cert fields
      domain: "old.example.com",
      email: "old@example.com",
      vpnUsername: "old-user",
      certChainPath: "/etc/ssl/old-cert.pem",
      certKeyPath: "/etc/ssl/old-key.pem",
      certType: "provided",
      // advanced settings (the core regression: these leaked forward). 06-uat
      // install-wizard slimming removed the Metrics/SOCKS5/Allow-private/ICMP keys from
      // the wizard, and the reverse-proxy / camouflage keys were dropped when that feature
      // was removed entirely — so only the kept advanced setting (407/405 chooser) is cleared.
      authFailureStatusCode: 405,
    };

    clearEndpointForm(blob);

    // Every kept endpoint + advanced key is gone.
    for (const k of [
      "domain", "email", "vpnUsername", "certChainPath", "certKeyPath",
      "authFailureStatusCode",
    ]) {
      expect(blob[k]).toBeUndefined();
    }
    // certType is reset to the default.
    expect(blob.certType).toBe("letsencrypt");
    // SSH identity is untouched.
    expect(blob.host).toBe("10.0.0.1");
    expect(blob.port).toBe("22");
    expect(blob.sshUser).toBe("root");
  });
});
