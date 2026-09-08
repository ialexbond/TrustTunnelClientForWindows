/**
 * Shared frontend log-sanitizer (SAFETY-02 / D-29, T-04-16).
 *
 * A Rust `Err(String)` echoed verbatim into the activity-log channel can leak
 * the VPN user's password — e.g. a backend error like
 * `invalid password value: S3cr3tP@ss` or a TOML dump containing
 * `password = "S3cr3tP@ss"`. Every credential error/persist-failed path that
 * writes a backend error string into the log MUST route it through this ONE
 * helper first, so there is a single, tested redaction contract instead of
 * bespoke per-call-site regexes that drift apart over time.
 *
 * What it does:
 *   1. Redacts credential-shaped substrings (the secret VALUE is replaced with
 *      a fixed `[redacted]` marker — the key name stays so the log is still
 *      diagnosable). Handles:
 *        - `password = "..."` / `password: "..."` (any spacing, quoted/unquoted)
 *        - mixed-case / prefixed keys: `Password`, `vpnPassword`, `newPassword`,
 *          `VpnPassword`, `new_password`, etc.
 *        - JSON payloads: `{"password":"..."}`
 *   2. Truncates the result to MAX_LOG_LEN (mirrors the existing
 *      `cert_fp_derive_failed` `.slice(0, 80)` precedent in UserModal) so a huge
 *      backend dump can't flood the log channel.
 *
 * The user-VISIBLE error message is NOT sanitized by this helper — only the
 * string that reaches the log channel. Call sites keep their own raw `formatError`
 * value for the on-screen message and pass it through here only for `activityLog`.
 */

/** Truncation length — mirrors UserModal's `cert_fp_derive_failed` `.slice(0, 80)`. */
export const MAX_LOG_LEN = 80;

const REDACTED = "[redacted]";

/**
 * Matches a credential key (password, with optional prefix like vpn/new and an
 * optional camelCase boundary) followed by an assignment (`=`, `:`) and a value
 * that is either quoted (`"..."` / `'...'`) or a bare run of non-space,
 * non-delimiter characters. The KEY (group 1) + separator (group 2) are kept;
 * the VALUE is dropped.
 *
 * Built as a single source-string so we can recompile per call (regex /g state
 * is stateful and `sanitizeLogMessage` may run concurrently across renders).
 */
const CREDENTIAL_KEY = "(?:[a-z]*_?)?password";
// Separator between the key and the secret value. Handles:
//   - direct assignment:  `password=`, `password:` (any spacing)
//   - JSON key close:      `"password":`  (optional closing quote)
//   - a short descriptive word in between: `password value:` / `password is:`
//     (the Rust errors phrase it as `invalid password value: <secret>`). We
//     allow at most two short lowercase words so a long sentence can't pull an
//     unrelated trailing token in as a "secret".
const SEPARATOR = "[\"']?(?:\\s+[a-z]+){0,2}\\s*[:=]\\s*";
// quoted value (double or single) OR a bare token up to a delimiter/whitespace
const VALUE = `(?:"[^"]*"|'[^']*'|[^\\s,;}"']+)`;

function buildRedactor(): RegExp {
  // `i` → mixed-case keys (Password, VpnPassword); `g` → every occurrence.
  return new RegExp(`(${CREDENTIAL_KEY})(${SEPARATOR})(${VALUE})`, "gi");
}

/**
 * Strip credential-shaped substrings WITHOUT truncating.
 *
 * Split out of `sanitizeLogMessage` for G-32-12. `panel.load.failed` in
 * useServerState logs the RAW backend error on purpose (G-07: translateSshError
 * reclassifies transport failures as «неверный пароль», so the raw string is the
 * only honest record of what actually happened) and budgets 300 characters for
 * it. Routing that line through `sanitizeLogMessage` would have clamped it to
 * MAX_LOG_LEN=80 and gutted the diagnosis the line exists to provide. The
 * redaction contract is what matters there, not the truncation, so the two are
 * now separable — `sanitizeLogMessage` still composes both and its contract is
 * unchanged.
 */
export function redactCredentialShapes(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) return "";
  return raw.replace(
    buildRedactor(),
    (_full, key: string, sep: string) => `${key}${sep}${REDACTED}`,
  );
}

/**
 * Replace every occurrence of a KNOWN secret with the redaction marker.
 *
 * `redactCredentialShapes` is shape-based: it needs a `password: <value>` /
 * `password = "<value>"` pattern to recognise a secret. That covers the errors
 * the backend is known to produce, but not free prose — a message reading
 * `authentication with password hunter2 failed` has no `:` or `=` and sails
 * straight through. Where the call site HOLDS the credential (useServerState
 * has `sshPassword` in hand), identity beats shape: we can scrub the exact
 * value regardless of how the surrounding sentence is worded.
 *
 * The secret never leaves memory — it is only ever compared against, and what
 * lands in the log is a fixed marker that carries neither the value nor its
 * length. A short/empty secret is ignored rather than being replaced globally,
 * which would shred the message into markers for no security gain.
 */
export function redactSecretValue(raw: string, secret: string | undefined | null): string {
  if (typeof raw !== "string" || raw.length === 0) return "";
  if (typeof secret !== "string" || secret.length < 3) return raw;
  return raw.split(secret).join(REDACTED);
}

/**
 * Strip credential-shaped substrings and truncate. Stable contract — see file
 * header. Non-secret messages pass through unchanged (truncated only if over
 * MAX_LOG_LEN).
 */
export function sanitizeLogMessage(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) return "";

  const redacted = redactCredentialShapes(raw);

  return redacted.length > MAX_LOG_LEN
    ? redacted.slice(0, MAX_LOG_LEN)
    : redacted;
}
