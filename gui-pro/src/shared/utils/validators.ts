/**
 * Frontend validators for Phase 15 Configuration UI.
 *
 * All validators return i18n KEY (string):
 *   - empty string ("") = valid
 *   - non-empty string  = i18n key under server.config.* for the error message
 *
 * These mirror backend `gui-pro/src-tauri/src/ssh/sanitize.rs` whitelists EXACTLY.
 * Backend remains the trust boundary (Pitfall 6 in 15-RESEARCH); frontend validators
 * exist only for UX feedback (early warnings, button-disabled states).
 *
 * Pair contract (per validator → backend mirror):
 *   validateListenAddress    ↔ sanitize.rs::validate_listen_address
 *   validateLogLevel         ↔ sanitize.rs::validate_log_level
 *   validateUrlPath          ↔ sanitize.rs::validate_url_path
 *   validateAuthStatusCode   ↔ sanitize.rs::validate_auth_status_code
 *   validateFqdnSni          ↔ sanitize.rs::validate_fqdn_sni
 */

const LOG_LEVELS = new Set(["", "trace", "debug", "info", "warn", "error"]);
const AUTH_STATUS_CODES = new Set([405, 407]);

const SHELL_METACHARS = /['"`$;|&(){}<>\n\r]/;

/** listen_address: "IPv4:port" or "[IPv6]:port" — no shell metachars, max 64 chars. */
export function validateListenAddress(v: string): string {
  if (!v) return "server.config.error_listen_address_empty";
  if (v.length > 64) return "server.config.error_listen_address_too_long";
  if (SHELL_METACHARS.test(v)) return "server.config.error_listen_address_invalid";
  // Format check: must contain `:` and a numeric port at the end.
  // Accepts both IPv4:port and [IPv6]:port — `:NNN` suffix is the discriminator.
  const portMatch = v.match(/:(\d+)$/);
  if (!portMatch) return "server.config.error_listen_address_format";
  const port = parseInt(portMatch[1], 10);
  if (port < 1 || port > 65535) return "server.config.error_port_range";
  return "";
}

/** log_level enum: trace / debug / info / warn / error or empty. */
export function validateLogLevel(v: string): string {
  if (LOG_LEVELS.has(v)) return "";
  return "server.config.error_log_level";
}

/** URL path: starts with `/`, alphanumeric + `/-_.`, 1-255 chars. */
export function validateUrlPath(v: string): string {
  if (!v) return "server.config.error_path_empty";
  if (v.length > 255) return "server.config.error_path_too_long";
  if (!v.startsWith("/")) return "server.config.error_path_format";
  if (!/^[/A-Za-z0-9._-]+$/.test(v)) return "server.config.error_path_invalid";
  return "";
}

/** auth_failure_status_code: 405 or 407 only (per upstream CONFIGURATION.md). */
export function validateAuthStatusCode(code: number): string {
  if (AUTH_STATUS_CODES.has(code)) return "";
  return "server.config.error_auth_status_code";
}

/**
 * FQDN whitelist for allowed_sni / hostname / Custom SNI.
 *
 * Mirror of `gui-pro/src-tauri/src/ssh/sanitize.rs::validate_fqdn_sni`.
 * Empty string accepted (field optional in some contexts; chip editor enforces non-empty separately).
 *
 * Extracted from `UserModal.tsx::validateCustomSni` (Phase 14.1) to enable reuse
 * by AllowedSniEditor (Plan 06) and any future SNI input.
 */
export function validateFqdnSni(v: string): string {
  if (!v) return "";
  if (/\s/.test(v)) return "server.config.error_sni_spaces";
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7F]/.test(v)) return "server.config.error_sni_ascii_only";
  if (v.length > 253) return "server.config.error_sni_too_long";
  if (v.startsWith(".") || v.endsWith(".") || v.includes(".."))
    return "server.config.error_sni_format";
  const labels = v.split(".");
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return "server.config.error_sni_format";
    if (label.startsWith("-") || label.endsWith("-")) return "server.config.error_sni_format";
    if (!/^[a-zA-Z0-9-]+$/.test(label)) return "server.config.error_sni_format";
  }
  return "";
}
