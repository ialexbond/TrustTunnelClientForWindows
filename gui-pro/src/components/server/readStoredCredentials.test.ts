import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { readStoredCredentials } from "./readStoredCredentials";

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
