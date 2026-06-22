import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { readStoredCredentials, readStoredCredentialsFor } from "./readStoredCredentials";

const mockInvoke = vi.mocked(invoke) as unknown as Mock;

const LEGACY_KEY = "trusttunnel_control_ssh";
const MIGRATED_FLAG = "tt_legacy_creds_migrated";

describe("readStoredCredentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("returns keyring creds when load_ssh_credentials resolves a valid object", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "load_ssh_credentials") {
        return { host: "10.0.0.1", port: "2222", user: "deploy", password: "pw", keyPath: "" };
      }
      return null;
    });

    const creds = await readStoredCredentials();
    expect(creds).toEqual({
      host: "10.0.0.1",
      port: "2222",
      user: "deploy",
      password: "pw",
      keyPath: undefined,
    });
  });

  it("returns null when no keyring creds and no legacy key", async () => {
    mockInvoke.mockResolvedValue(null);
    expect(await readStoredCredentials()).toBeNull();
  });

  it("migrates a legacy localStorage entry to the keyring once and returns it", async () => {
    localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify({ host: "5.5.5.5", port: "22", user: "root", password: "legacy-pw" }),
    );
    const saveCalls: unknown[][] = [];
    mockInvoke.mockImplementation(async (cmd: string, args: unknown) => {
      if (cmd === "load_ssh_credentials") return null;
      if (cmd === "save_ssh_credentials") {
        saveCalls.push([args]);
        return null;
      }
      return null;
    });

    const creds = await readStoredCredentials();
    expect(creds?.host).toBe("5.5.5.5");
    expect(saveCalls).toHaveLength(1);
    // Legacy key consumed.
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  // ─── C-04 regression: migration must NOT run on every polling tick ───
  // Symptom: readStoredCredentials is called from the 2s polling loop. If the
  // legacy key is (re)written by an external party after the first migration,
  // a subsequent call migrates AGAIN — silently re-persisting creds to the
  // keyring and tripping an auto-reconnect. The migration must be a one-time
  // upgrade path, guarded so a re-appearing legacy key is NOT re-migrated.
  it("C-04: does NOT re-migrate when the legacy key reappears after a completed migration", async () => {
    const saveCalls: unknown[][] = [];
    mockInvoke.mockImplementation(async (cmd: string, args: unknown) => {
      if (cmd === "load_ssh_credentials") return null;
      if (cmd === "save_ssh_credentials") {
        saveCalls.push([args]);
        return null;
      }
      return null;
    });

    // First tick: legacy key present → migrate once.
    localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify({ host: "5.5.5.5", port: "22", user: "root", password: "legacy-pw" }),
    );
    await readStoredCredentials();
    expect(saveCalls).toHaveLength(1);
    expect(localStorage.getItem(MIGRATED_FLAG)).toBe("true");

    // External re-write of the legacy key (another tab / compromised extension)
    // after the user disconnected. The next polling tick must NOT migrate.
    localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify({ host: "9.9.9.9", port: "22", user: "root", password: "attacker-pw" }),
    );
    const resurrected = await readStoredCredentials();

    // No second save_ssh_credentials, and the externally-written key is ignored.
    expect(saveCalls).toHaveLength(1);
    expect(resurrected).toBeNull();
  });
});

// ─── readStoredCredentialsFor (06-19 / D-15 / C-23): host-keyed read ─────────
describe("readStoredCredentialsFor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("invokes load_ssh_credentials_for with the target and returns the target's bundle", async () => {
    const calls: { cmd: string; args: unknown }[] = [];
    mockInvoke.mockImplementation(async (cmd: string, args: unknown) => {
      calls.push({ cmd, args });
      if (cmd === "load_ssh_credentials_for") {
        return { host: "10.0.0.1", port: "22", user: "root", password: "pwA", keyPath: "" };
      }
      return null;
    });

    const creds = await readStoredCredentialsFor({ host: "10.0.0.1", port: "22", user: "root" });
    expect(creds).toEqual({
      host: "10.0.0.1",
      port: "22",
      user: "root",
      password: "pwA",
      keyPath: undefined,
    });
    // The host-keyed command is invoked with the exact target.
    expect(calls[0]).toEqual({
      cmd: "load_ssh_credentials_for",
      args: { host: "10.0.0.1", port: "22", user: "root" },
    });
  });

  it("returns null for an unknown target (command resolves null)", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "load_ssh_credentials_for") return null;
      return null;
    });
    const creds = await readStoredCredentialsFor({ host: "9.9.9.9", port: "22", user: "nobody" });
    expect(creds).toBeNull();
  });

  it("does NOT run the legacy localStorage migration (no save_ssh_credentials)", async () => {
    // A legacy key is present, but the host-keyed sibling must NOT migrate it
    // (the no-arg reader owns the one-time migration on cold start).
    localStorage.setItem(
      "trusttunnel_control_ssh",
      JSON.stringify({ host: "5.5.5.5", port: "22", user: "root", password: "legacy" }),
    );
    const saveCalls: unknown[] = [];
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "save_ssh_credentials") saveCalls.push(cmd);
      return null;
    });

    await readStoredCredentialsFor({ host: "5.5.5.5", port: "22", user: "root" });
    expect(saveCalls).toHaveLength(0);
    // Legacy key untouched (not consumed by the host-keyed read).
    expect(localStorage.getItem("trusttunnel_control_ssh")).not.toBeNull();
  });
});
