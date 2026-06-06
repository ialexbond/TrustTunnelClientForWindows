/**
 * userValidators — the 4 pure user-input validators for the UserModal data layer.
 *
 * Phase 04 Plan 05 extraction (PANEL-02 data layer): lifted VERBATIM from
 * `UserModal.tsx` so the validation logic can be unit-tested in isolation and
 * reused by the Wave-3/4 UserModal decomposition. Each validator is a pure
 * `(value: string) => i18nKey | ""` function — `""` means "valid", any other
 * string is the i18n key for the error message to show.
 *
 * SECURITY (T-04-13 / SAFETY-01): these frontend validators are UX-only — they
 * surface the error before the SSH roundtrip. The AUTHORITATIVE security boundary
 * is the backend whitelist in `gui-pro/src-tauri/src/ssh/sanitize.rs`. Do NOT let
 * the frontend become the security boundary, and do NOT loosen the intentional
 * rejections below (see the CF-05 note on `validatePassword`).
 */

/**
 * Username (TLV / `-c <name>`) — ASCII alphanumeric + `. _ - @`, no whitespace,
 * max 64 chars. Mirrors backend `validate_vpn_username`.
 *
 * IN-01: charset and length were previously tighter than the backend (32 chars,
 * no `@`), so a username the backend `validate_vpn_username` accepts (up to 64
 * chars, or containing `@` — the backend test `username_accepts_normal` asserts
 * `user@domain.com` is OK) was blocked at the UI with no workaround. Widened to
 * mirror the backend. STILL a whitelist (allowed-char set), only the set and cap
 * were widened — do NOT switch to blacklist or loosen further.
 */
export function validateUsername(v: string): string {
  if (!v) return "";
  if (/\s/.test(v)) return "server.users.username_spaces";
  if (!/^[a-zA-Z0-9._@-]+$/.test(v)) return "server.users.username_ascii_only";
  if (v.length > 64) return "server.users.username_too_long";
  return "";
}

/**
 * Password — no leading/trailing spaces, ASCII-only, and (CF-05) no `" ' \`.
 *
 * CF-05 (do NOT loosen): the `["'\\]` rejection is an INTENTIONAL
 * SSH-heredoc-injection defense. The backend `validate_vpn_password` in
 * sanitize.rs rejects the same characters, and the password is interpolated into
 * unquoted SSH command bodies — allowing a quote or backslash would let a crafted
 * password break out of the heredoc. Even though a permissive spec might allow
 * `"`, we reject it on purpose and mirror the backend whitelist.
 */
export function validatePassword(v: string): string {
  if (!v) return "";
  if (v !== v.trim()) return "server.users.password_no_edge_spaces";
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7F]/.test(v)) return "server.users.password_ascii_only";
  // CF-05: backend validate_vpn_password rejects ' " \. Mirror it on the frontend so
  // users see the error before hitting the SSH roundtrip. INTENTIONAL — do not loosen.
  if (/["'\\]/.test(v)) return "server.users.password_no_quotes_backslash";
  return "";
}

/**
 * Display name (TLV 0x0C) — mirrors backend `validate_display_name` so the user
 * sees the error before the SSH roundtrip.
 *
 * Allowed: any printable character (Cyrillic + spaces + emoji all OK).
 * Rejected: control characters, quotes, backticks, `$`, `\`, shell meta
 * `; | & ( ) < > \n \r \0`. Empty = valid (field omitted from deeplink).
 */
export function validateDisplayName(v: string): string {
  if (!v) return "";
  if (v.length > 64) return "server.users.display_name_too_long";
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(v)) return "server.users.display_name_control_chars";
  if (/["'`$\\;|&()<>]/.test(v)) return "server.users.display_name_bad_chars";
  return "";
}

/**
 * FQDN / hostname validation per CONTEXT.md D-4 (Custom SNI TLV 0x03).
 * RFC 1035 basic: ASCII alphanumeric + dots + hyphens, total <= 253 chars,
 * each label 1-63 chars, label doesn't start/end with hyphen. Empty = valid
 * (field is optional — omitted from deeplink).
 */
export function validateCustomSni(v: string): string {
  if (!v) return "";
  if (/\s/.test(v)) return "server.users.custom_sni_spaces";
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7F]/.test(v)) return "server.users.custom_sni_ascii_only";
  if (v.length > 253) return "server.users.custom_sni_too_long";
  if (v.startsWith(".") || v.endsWith(".") || v.includes(".."))
    return "server.users.custom_sni_invalid_fqdn";
  const labels = v.split(".");
  for (const label of labels) {
    if (label.length === 0 || label.length > 63)
      return "server.users.custom_sni_invalid_fqdn";
    if (label.startsWith("-") || label.endsWith("-"))
      return "server.users.custom_sni_invalid_fqdn";
    if (!/^[a-zA-Z0-9-]+$/.test(label))
      return "server.users.custom_sni_invalid_fqdn";
  }
  return "";
}
