import { invoke } from "@tauri-apps/api/core";
import type { SshCredentials } from "./SshConnectForm";

/** Legacy localStorage key for the pre-keyring credential blob. */
const LEGACY_CREDS_KEY = "trusttunnel_control_ssh";
/**
 * One-time guard flag (Chrome C-04 / threat T-04-25). Set after the very first
 * legacy → keyring migration so the migration NEVER runs again. Because
 * `readStoredCredentials` is called from the 2s polling loop, an unguarded
 * migration would re-fire on every tick — meaning a legacy key (re)written by
 * an external party (another tab, a compromised extension) AFTER the user
 * disconnected would be silently migrated into the keyring and trip an
 * auto-reconnect, re-exposing the secret. The flag turns the migration into a
 * true one-time upgrade path.
 */
const MIGRATED_FLAG = "tt_legacy_creds_migrated";

/**
 * Reads stored SSH credentials, with a one-time legacy-localStorage → keyring
 * migration.
 *
 * Originally extracted VERBATIM from ControlPanelPage (Plan 04-08, PANEL-02
 * data layer) with the migration left inline so it ran on every polling tick.
 * Plan 04-12 fixes that (Chrome C-04 / T-04-25): the migration now runs at most
 * once, guarded by the `tt_legacy_creds_migrated` flag, and the legacy key is
 * removed in a `try/finally` BEFORE the async keyring save so a save failure
 * still consumes the at-rest plaintext key (defence in depth — we never leave
 * the secret behind in localStorage once we've decided to migrate it).
 */
export async function readStoredCredentials(): Promise<SshCredentials | null> {
  try {
    const obj = await invoke<{ host: string; port: string; user: string; password: string; keyPath: string } | null>("load_ssh_credentials");
    if (obj && obj.host && (obj.password || obj.keyPath)) {
      return {
        host: obj.host,
        port: obj.port || "22",
        user: obj.user || "root",
        password: obj.password || "",
        keyPath: obj.keyPath || undefined,
      };
    }

    // C-04: migration is a one-time upgrade path. Once the flag is set we never
    // touch the legacy key again — a re-appearing key is ignored, not migrated.
    if (localStorage.getItem(MIGRATED_FLAG) === "true") {
      return null;
    }

    const raw = localStorage.getItem(LEGACY_CREDS_KEY);
    if (raw) {
      const legacy = JSON.parse(raw);
      if (legacy.host && (legacy.password || legacy.keyPath)) {
        try {
          await invoke("save_ssh_credentials", {
            host: legacy.host,
            port: legacy.port || "22",
            user: legacy.user || "root",
            password: legacy.password || "",
            keyPath: legacy.keyPath || null,
          });
        } finally {
          // Remove the at-rest plaintext key BEFORE we can return — runs even if
          // the keyring save threw, so the legacy secret is never left behind
          // once migration has been attempted (T-04-25).
          localStorage.removeItem(LEGACY_CREDS_KEY);
          localStorage.setItem(MIGRATED_FLAG, "true");
        }
        return {
          host: legacy.host,
          port: legacy.port || "22",
          user: legacy.user || "root",
          password: legacy.password || "",
          keyPath: legacy.keyPath || undefined,
        };
      }
    }

    // No keyring creds, no usable legacy key → mark migration done so the
    // polling tick never re-parses an external write of the legacy key.
    localStorage.setItem(MIGRATED_FLAG, "true");
    return null;
  } catch {
    return null;
  }
}
