// ═══════════════════════════════════════════════════════
// wizard/persist.ts — ONE non-secret snapshot serializer (WIZARD-01 / D-05)
// ═══════════════════════════════════════════════════════
//
// Satisfies WIZARD-01 (persistence kept in its own module, separate from the
// UI) and D-05 (secrets are NEVER serialized). This replaces the ~20 ad-hoc
// per-field `saveField(...)` writes in useWizardState.ts with a single
// whitelisting writer/reader over the SAME localStorage key, so an existing
// user's blob migrates in place.
//
// The snapshot is a HINT, not the source of truth (the server-verified resume
// in 05-02 recomputes the step from server reality).

import { invoke } from "@tauri-apps/api/core";
import type { Step } from "./machine";

// REUSE the existing key so old blobs migrate in place (no new key, no orphaned
// state). This is the same key useWizardState.ts wrote per-field today.
export const SNAPSHOT_KEY = "trusttunnel_wizard";

// The whitelist of fields that MAY be persisted.
// `sshPassword` / `vpnPassword` / `sshKeyData` are DELIBERATELY ABSENT (D-05) —
// they are session-only secrets. The SSH password lives in Windows Credential
// Manager (via save_ssh_credentials); pasted key data and the VPN password are
// never persisted at all.
export interface Snapshot {
  step: Step;
  host: string;
  port: string;
  sshUser: string;
  keyPath: string;
  listenAddress: string;
  vpnUsername: string;
  certType: "selfsigned" | "letsencrypt" | "provided";
  domain: string;
  email: string;
  certChainPath: string;
  certKeyPath: string;
}

// The only keys ever written. A defensive allow-list (not a deny-list of the
// secret keys) so a future field added to the input object cannot accidentally
// leak — it simply is not copied unless it is named here.
const SNAPSHOT_KEYS: (keyof Snapshot)[] = [
  "step",
  "host",
  "port",
  "sshUser",
  "keyPath",
  "listenAddress",
  "vpnUsername",
  "certType",
  "domain",
  "email",
  "certChainPath",
  "certKeyPath",
];

// UAT (06-uat fix 3): the full set of endpoint-form keys that a FRESH install must
// reset. The «Установить» path reuses the persisted blob (so host/port/sshUser carry
// over from the just-connected panel), but the PREVIOUS install's endpoint + ADVANCED
// settings (reverse-proxy / auth-status / ...) were leaking forward across installs.
// These are all written via saveField (NOT the Snapshot whitelist), so they must be
// cleared explicitly here. Each cleared key falls back to its useWizardState loadSaved
// default on the fresh mount (authFailureStatusCode→407, vpnUsername→"" regenerates, …).
// vpnPassword / firstUserAdvanced are session-only and never persisted, so they are not
// listed. host / port / sshUser are deliberately NOT cleared (the panel just connected).
//
// 06-uat install-wizard slimming: the Metrics / SOCKS5 / Allow-private keys were dropped
// (those settings were removed from the wizard) and the icmpEnable key was dropped (the
// ICMP toggle was hidden — its safe ON default is now hard-coded in deploy.rs, not a
// persisted user choice). The reverse-proxy / camouflage keys were dropped when that
// feature was removed from the wizard entirely. A stale leftover key from an old blob is
// simply ignored.
const ENDPOINT_FORM_KEYS = [
  "domain", "email", "vpnUsername", "certChainPath", "certKeyPath",
  "authFailureStatusCode",
];

// Clears every persisted endpoint-form key (incl. advanced) on a fresh install and
// resets certType to the default. Mutates the passed blob in place; the caller writes
// it back. Only affects the FRESH-install path — the server-verified resume path never
// calls this (it routes by installEntry/server-probe booleans, not these fields).
export function clearEndpointForm(blob: Record<string, unknown>): void {
  for (const k of ENDPOINT_FORM_KEYS) delete blob[k];
  blob.certType = "letsencrypt";
}

function readRaw(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? (obj as Record<string, unknown>) : {};
  } catch {
    // Corrupt/missing blob → behave as empty. Never throw on a bad read.
    return {};
  }
}

// Returns only the whitelisted Snapshot fields present in the blob. Legacy
// secret keys (sshPassword/vpnPassword/sshKeyData) are never returned.
export function loadSnapshot(): Partial<Snapshot> {
  const raw = readRaw();
  // Back-compat: the pre-05-01 hook persisted the step under the key `wizardStep`.
  // Surface it as `step` so an existing user's blob restores their screen without
  // a one-shot reset. (New writes use `step`.)
  if (raw.step === undefined && typeof raw.wizardStep === "string") {
    raw.step = raw.wizardStep;
  }
  const out: Partial<Snapshot> = {};
  for (const key of SNAPSHOT_KEYS) {
    if (raw[key] !== undefined) {
      // The stored value is whatever was last written through this writer, so
      // the runtime type matches the Snapshot field; the cast is type-bridging
      // only (we never trust a value into a secret slot — those slots do not
      // exist in Snapshot).
      (out[key] as unknown) = raw[key];
    }
  }
  return out;
}

// Merges ONLY the whitelisted keys into the existing blob, then writes it back.
// Secret keys present on the input are never copied even though they may exist
// on the caller's object. Skips the write on a serialize failure (WR-06: never
// clobber an existing blob with garbage).
export function saveSnapshot(snap: Partial<Snapshot>): void {
  const existing = readRaw();
  // Drop any legacy secret keys that may still be sitting in the existing blob,
  // so a save also opportunistically strips them.
  delete existing.sshPassword;
  delete existing.vpnPassword;
  delete existing.sshKeyData;

  for (const key of SNAPSHOT_KEYS) {
    if (snap[key] !== undefined) {
      existing[key] = snap[key];
    }
  }

  try {
    const serialized = JSON.stringify(existing);
    localStorage.setItem(SNAPSHOT_KEY, serialized);
  } catch {
    // Serialize/quota failure — leave the prior blob intact (WR-06).
  }
}

// migrate-before-strip — move the legacy plaintext SSH password into Windows
// Credential Manager via save_ssh_credentials FIRST, then strip it from
// localStorage. We never delete the only persisted secret before it is safely
// migrated (05-REVIEWS must-fix #1, D-05). The function RESOLVES even on invoke
// failure (round-2 finding I) so it never bubbles an unhandled rejection — and
// on failure the plaintext is left in place (NOT lost), so a later load retries
// the migration (WR-06).
export async function migrateLegacySshPassword(): Promise<void> {
  const raw = readRaw();
  const sshPassword = typeof raw.sshPassword === "string" ? raw.sshPassword : "";
  const host = typeof raw.host === "string" ? raw.host : "";
  const port = typeof raw.port === "string" ? raw.port : "";
  const sshUser = typeof raw.sshUser === "string" ? raw.sshUser : "";
  const keyPath = typeof raw.keyPath === "string" ? raw.keyPath : "";

  // Nothing to migrate unless there is a non-empty plaintext password AND enough
  // identity to key it in Credential Manager.
  if (!sshPassword || !host || !port || !sshUser) {
    return;
  }

  try {
    // save_ssh_credentials(host, port, user, password, key_path) — the REAL
    // command (commands/ssh_commands.rs:601). It stores the password in the
    // keyring (DPAPI) and writes metadata-only JSON. We AWAIT success BEFORE
    // touching the plaintext.
    await invoke("save_ssh_credentials", {
      host,
      port,
      user: sshUser,
      password: sshPassword,
      keyPath: keyPath || undefined,
    });
  } catch {
    // Migration failed (e.g. keyring unavailable, app closing mid-IPC). Do NOT
    // strip the plaintext — leaving it means the next mount retries the
    // migration; nothing is lost. Resolve normally (finding I). NEVER log the
    // password value (D-29) — and we log nothing here because there is no
    // non-secret detail worth the console noise.
    return;
  }

  // Migration succeeded → rewrite the blob WITHOUT the secret keys.
  delete raw.sshPassword;
  delete raw.vpnPassword;
  delete raw.sshKeyData;
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(raw));
  } catch {
    // Serialize failure on the strip rewrite — skip it (WR-06). The password is
    // already safely in Credential Manager; the stale plaintext is stripped on
    // the next successful write.
  }
}
