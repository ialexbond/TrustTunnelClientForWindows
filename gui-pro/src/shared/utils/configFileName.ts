// ═══════════════════════════════════════════════════════
// configFileName.ts — branded default name for the SAVE dialog (06-uat fix 14)
// ═══════════════════════════════════════════════════════
//
// Both save paths (DoneStep «Сохранить как» + Users-tab UserConfigModal download)
// must default to a CONSISTENT, branded filename:
//
//   TrustTunnel_<username>.toml
//
// …with an OPTIONAL best-effort country-code prefix when a country is readily
// available at save time:
//
//   <COUNTRY>_TrustTunnel_<username>.toml      e.g. DE_TrustTunnel_keen-mole17.toml
//
// This is the SAVE-DIALOG default name ONLY — the internal active config file in
// AppData stays `<username>.toml` (client_config_filename), unchanged.
//
// The username and country are whitelist-validated upstream, but we sanitize again
// here defensively so the produced name can never carry a path separator or other
// filename-unsafe character regardless of the caller.

// Strip anything that is not a safe filename character. We allow letters, digits,
// dash, underscore and dot; everything else (path separators, spaces, control chars,
// quotes, etc.) is removed. Empty input yields an empty string.
function sanitizeForFileName(value: string): string {
  return (value || "").replace(/[^A-Za-z0-9._-]/g, "");
}

// Normalize a country code to an UPPERCASE A-Z token (e.g. "de" → "DE"). Returns ""
// for anything that is not a plausible 2-3 letter code, so a junk value never
// produces a junk prefix.
function normalizeCountry(country: string | null | undefined): string {
  const c = sanitizeForFileName(country || "").toUpperCase();
  return /^[A-Z]{2,3}$/.test(c) ? c : "";
}

/**
 * Build the branded default save-dialog filename.
 *
 * @param username  VPN username (whitelist-validated upstream; re-sanitized here).
 * @param country   Optional country code; included as a prefix ONLY when it
 *                  normalizes to a plausible A-Z code. Omitted gracefully otherwise
 *                  (never blocks the save) — `TrustTunnel_<username>.toml`.
 * @returns `[COUNTRY_]TrustTunnel_<username>.toml`. Falls back to a safe generic
 *          name when the username sanitizes to empty.
 */
export function buildConfigFileName(
  username: string,
  country?: string | null,
): string {
  const safeUser = sanitizeForFileName(username.trim());
  const base = safeUser.length > 0 ? safeUser : "client";
  const prefix = normalizeCountry(country);
  const stem = prefix ? `${prefix}_TrustTunnel_${base}` : `TrustTunnel_${base}`;
  return `${stem}.toml`;
}
