//! Input validators for user-supplied values used in SSH commands.
//! All values interpolated into shell commands on remote servers MUST be
//! validated through these functions before use. This prevents command
//! injection attacks (RCE).

/// VPN username: alphanumeric + limited punctuation, no shell metacharacters.
///
/// CF-06 (conformance/01-deeplink-users.md): the DEEP_LINK.md / CONFIGURATION.md
/// spec imposes NO charset restriction on usernames (any TOML/UTF-8 string). Our
/// rejection of shell metacharacters, control chars, AND whitespace is an
/// INTENTIONAL SSH-injection / CLI-safety defense, NOT a spec requirement — the
/// username is interpolated UNQUOTED into the endpoint CLI `-c <name>` flag, so a
/// space would split the argument and a metacharacter could break out of the
/// command. We accept the resulting divergence from spec (a username with a space
/// or non-ASCII char cannot be created via our UI) as a deliberate security
/// tradeoff. `is_whitespace()` is included so the backend matches the frontend
/// `validateUsername` (which rejects `\s`) — closing the prior CF-06 mismatch
/// where the backend silently allowed spaces the frontend rejected. Do NOT loosen.
pub fn validate_vpn_username(s: &str) -> Result<(), String> {
    if s.is_empty() || s.len() > 64 {
        return Err("Username must be 1-64 characters".into());
    }
    if s.chars().any(|c| {
        // CF-06: reject whitespace too (was previously allowed on the backend but
        // rejected by the frontend) — a space breaks the unquoted `-c <name>` flag.
        c.is_control() || c.is_whitespace()
            || matches!(c, '\'' | '"' | '`' | '$' | '\\' | ';' | '|' | '&'
            | '(' | ')' | '{' | '}' | '<' | '>' | '\n' | '\r' | '\0')
    }) {
        return Err("Username contains invalid characters".into());
    }
    Ok(())
}

/// VPN password: any printable characters EXCEPT backslash, single quote, and
/// control characters.
///
/// CF-05 (conformance/01-deeplink-users.md): the spec (`CONFIGURATION.md`
/// credentials.toml, DEEP_LINK.md TLV 0x06) places NO charset restriction on the
/// password — it is a plain TOML/UTF-8 string. Our rejection of `"`, `'`, `\` and
/// control chars is therefore STRICTER THAN SPEC and is an INTENTIONAL
/// SSH-heredoc-injection defense, NOT a spec requirement. A spec-valid password
/// containing `"` cannot be imported via our UI; we accept that divergence as a
/// deliberate security tradeoff (a future SFTP/SCP credential-write path that
/// avoids shell interpolation could relax this — tracked in BACKLOG). Do NOT
/// loosen these rejections to "conform" to the spec.
///
/// CR-03 mitigation: the password is embedded in both a TOML double-quoted string
/// and a python single-quoted string literal inside a single-quoted heredoc body.
/// Backslash is banned because it introduces escape sequences in both contexts
/// (e.g. `\"` closes the TOML value, `\\'` would terminate the python literal and
/// still open the door to injection through the regex replacement). Single quote
/// is banned because it terminates the python literal directly.
///
/// Double quote (`"`), dollar (`$`), backtick (`` ` ``) remain permitted — they
/// are safe inside the single-quoted heredoc body (no shell expansion), and the
/// TOML value uses double quotes so `"` is escaped via the regex match boundary
/// (rejected already by the regex `[^"]*` replacement pattern).
pub fn validate_vpn_password(s: &str) -> Result<(), String> {
    if s.is_empty() || s.len() > 128 {
        return Err("Password must be 1-128 characters".into());
    }
    if s.chars().any(|c| c.is_control() || matches!(c, '\\' | '\'' | '"')) {
        return Err("Password contains invalid characters".into());
    }
    Ok(())
}

/// Domain: valid hostname characters only.
pub fn validate_domain(s: &str) -> Result<(), String> {
    if s.is_empty() {
        return Ok(()); // empty = use default
    }
    if s.len() > 253 {
        return Err("Domain too long".into());
    }
    if !s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.')) {
        return Err("Domain contains invalid characters".into());
    }
    Ok(())
}

/// SSH host (hostname / IPv4 / IPv6) used as the `-a {addr}` argument when
/// exporting the client config (S-4). The operator types this when connecting,
/// and it crosses into a generated SSH command string, so it must be
/// whitelist-validated before interpolation (CLAUDE.md SAFETY-01, whitelist-first).
///
/// Accepts the union of hostname, IPv4, and IPv6 character sets:
/// - ASCII alphanumeric
/// - `-` `.` (hostname / IPv4)
/// - `:` (IPv6) and `[` `]` (bracketed IPv6 literal)
///
/// Every shell metacharacter (`;`, `|`, `&`, `$`, backtick, quotes, `(` `)`,
/// `{` `}`, `<` `>`, whitespace, control chars, `\0`) is therefore rejected by
/// omission from the whitelist — an injected `host;rm -rf /` cannot pass.
pub fn validate_ssh_host(s: &str) -> Result<(), String> {
    if s.is_empty() {
        return Err("SSH host must not be empty".into());
    }
    if s.len() > 253 {
        return Err("SSH host too long (max 253 chars)".into());
    }
    if !s
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | ':' | '[' | ']'))
    {
        return Err("SSH host contains invalid characters".into());
    }
    // WR-02 (04-REVIEW.md): the char-whitelist alone lets bracket-mismatched /
    // malformed IPv6 literals through (`]2001:db8[`, `1.2.3.4]`, `:::::`). None of
    // the permitted chars are shell metacharacters, so this is a robustness/UX
    // defect, not an injection — but a structurally broken `-a {host}` produces an
    // opaque SSH_EXPORT_FAILED downstream. Enforce bracket balance and require that,
    // when brackets are used, a single `[` opens at index 0 and a single matching
    // `]` closes the IPv6 body (whitelist-spirit: brackets are only valid as the
    // enclosing pair of a literal). A bracketless value must contain no stray bracket.
    let open = s.matches('[').count();
    let close = s.matches(']').count();
    if open != close {
        return Err("SSH host has mismatched IPv6 brackets".into());
    }
    if open > 0 {
        // Exactly one enclosing pair, `[` first and `]` last, with a non-empty body.
        if open != 1
            || !s.starts_with('[')
            || !s.ends_with(']')
            || s.len() < 3
        {
            return Err("SSH host has malformed IPv6 brackets".into());
        }
    }
    // `:::` (three+ consecutive colons) is never a valid IPv6 literal — the `::`
    // zero-compression token may appear at most once and is exactly two colons.
    // This rejects degenerate inputs like `:::::` that the char-whitelist allows.
    if s.contains(":::") {
        return Err("SSH host has malformed IPv6 (invalid colon run)".into());
    }
    Ok(())
}

/// Email: basic format check, no shell metacharacters.
pub fn validate_email(s: &str) -> Result<(), String> {
    if s.is_empty() {
        return Ok(()); // empty = use default
    }
    if s.len() > 254 {
        return Err("Email too long".into());
    }
    if !s.contains('@') || !s.contains('.') {
        return Err("Invalid email format".into());
    }
    if s.chars().any(|c| {
        matches!(c, '\'' | '"' | '`' | '$' | '\\' | ';' | '|' | '&'
            | '(' | ')' | '{' | '}' | '<' | '>' | '\n' | '\r' | ' ')
    }) {
        return Err("Email contains invalid characters".into());
    }
    Ok(())
}

/// Client name: alphanumeric + dash/underscore only.
pub fn validate_client_name(s: &str) -> Result<(), String> {
    if s.is_empty() || s.len() > 64 {
        return Err("Client name must be 1-64 characters".into());
    }
    if !s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) {
        return Err("Client name contains invalid characters".into());
    }
    Ok(())
}

/// Server-side file path: no shell metacharacters, basic path chars only.
pub fn validate_server_path(s: &str) -> Result<(), String> {
    if s.is_empty() || s.len() > 512 {
        return Err("Path must be 1-512 characters".into());
    }
    if s.chars().any(|c| {
        matches!(c, '\'' | '"' | '`' | '$' | ';' | '|' | '&'
            | '(' | ')' | '{' | '}' | '<' | '>' | '\n' | '\r' | '\0')
    }) {
        return Err("Path contains shell metacharacters".into());
    }
    Ok(())
}

/// Listen address: IP:port format only, no shell metacharacters.
pub fn validate_listen_address(s: &str) -> Result<(), String> {
    if s.is_empty() {
        return Err("Listen address required".into());
    }
    if s.len() > 64 {
        return Err("Listen address too long".into());
    }
    if s.chars().any(|c| {
        matches!(c, '\'' | '"' | '`' | '$' | ';' | '|' | '&'
            | '(' | ')' | '{' | '}' | '<' | '>' | '\n' | '\r')
    }) {
        return Err("Listen address contains invalid characters".into());
    }
    Ok(())
}

/// Version string: semver-like format only (digits, dots, optional 'v' prefix).
pub fn validate_version(s: &str) -> Result<(), String> {
    if s.is_empty() || s.len() > 32 {
        return Err("Version must be 1-32 characters".into());
    }
    if !s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+')) {
        return Err("Version contains invalid characters".into());
    }
    Ok(())
}

/// CIDR notation: IPv4 `X.X.X.X/N` (N in 0..=32) — or empty string meaning "no restriction".
///
/// Defense-in-depth layer; frontend also validates octet bounds separately. This function:
/// - Accepts empty string (no rule)
/// - Requires total length <= 18 chars ("255.255.255.255/32" = 18)
/// - Requires only `[0-9./]` ASCII chars
/// - Splits on '/', requires exactly 2 parts
/// - Splits IP part on '.', requires exactly 4 octets, each parseable as u8 and <= 255
/// - Parses prefix as u32, requires 0..=32
///
/// Rejects malicious strings like `"0.0.0.0/0; rm -rf /"` via char whitelist.
pub fn validate_cidr(s: &str) -> Result<(), String> {
    if s.is_empty() {
        return Ok(());
    }
    if s.len() > 18 {
        return Err("CIDR too long (max 18 chars)".into());
    }
    if !s.chars().all(|c| c.is_ascii_digit() || matches!(c, '.' | '/')) {
        return Err("CIDR contains invalid characters (only 0-9, '.', '/' allowed)".into());
    }
    let parts: Vec<&str> = s.split('/').collect();
    if parts.len() != 2 {
        return Err("CIDR must be X.X.X.X/N".into());
    }
    let octets: Vec<&str> = parts[0].split('.').collect();
    if octets.len() != 4 {
        return Err("IP must have exactly 4 octets".into());
    }
    for oct in &octets {
        if oct.is_empty() {
            return Err("Empty octet".into());
        }
        // WR-03 (04-REVIEW.md): reject redundant leading zeros (`010`, `00`) so the
        // backend agrees with the frontend octet validator on the canonical decimal
        // form. Without this the backend silently accepts octal-looking input that
        // the UI blocked, letting a UI-rejected value reach the backend with a
        // different interpretation.
        if oct.len() > 1 && oct.starts_with('0') {
            return Err(format!("Octet '{oct}' has a redundant leading zero"));
        }
        let n: u32 = oct.parse().map_err(|_| "Invalid octet (must be number)".to_string())?;
        if n > 255 {
            return Err(format!("Octet {n} exceeds 255"));
        }
    }
    if parts[1].is_empty() {
        return Err("Prefix missing".into());
    }
    let prefix: u32 = parts[1].parse().map_err(|_| "Invalid prefix".to_string())?;
    if prefix > 32 {
        return Err(format!("Prefix {prefix} exceeds 32"));
    }
    Ok(())
}

/// DNS upstream list. Each non-empty line must not contain control chars or shell metacharacters.
/// Empty lines are silently skipped (caller's responsibility to filter), not rejected.
/// Length cap per entry: 253 chars (RFC 1035 FQDN limit).
pub fn validate_dns_list(lines: &[String]) -> Result<(), String> {
    for line in lines {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if t.len() > 253 {
            return Err(format!("DNS entry too long (max 253 chars): {t}"));
        }
        if t.chars().any(|c| {
            c.is_control() || matches!(c, ' ' | ';' | '|' | '$' | '`' | '&' | '\'' | '"' | '\\' | '\0')
        }) {
            return Err(format!("DNS entry contains invalid characters: {t}"));
        }
    }
    Ok(())
}

/// Display name for deeplink TLV 0x0C (`-n` flag of endpoint CLI). Printable ASCII,
/// no shell metacharacters, no control chars. Empty string accepted (field optional).
///
/// CR-02 mitigation: backend interpolated this value into `... -n "{escaped_n}" ...`
/// inside a double-quoted shell context, escaping only `"`. Without this validator a
/// payload like `x"; rm -rf /; echo "y` would close the outer quotes and run arbitrary
/// commands as sudo. We now reject every shell-metachar at the validation layer.
pub fn validate_display_name(s: &str) -> Result<(), String> {
    if s.is_empty() {
        return Ok(()); // empty = field omitted
    }
    if s.len() > 64 {
        return Err("Display name too long (max 64 chars)".into());
    }
    if s.chars().any(|c| {
        c.is_control()
            || matches!(
                c,
                '\'' | '"' | '`' | '$' | '\\' | ';' | '|' | '&'
                    | '(' | ')' | '<' | '>' | '\n' | '\r' | '\0'
            )
    }) {
        return Err("Display name contains invalid characters".into());
    }
    Ok(())
}

/// Phase 16 — Ed25519 OpenSSH armored public key for authorized_keys append.
///
/// Format: `ssh-ed25519 BASE64 [optional comment]`
///
/// Defence stack (S-02 char-whitelist invariant):
///  - Layer 1: length cap 1..=200 chars (Ed25519 OpenSSH = ~80 chars + comment).
///  - Layer 2: shape check — must be `ssh-ed25519` prefix + base64 body + optional comment.
///  - Layer 3: base64 body restricted to `[A-Za-z0-9+/=]`.
///  - Layer 4: comment field rejects shell-metachars (control chars + `' " ` $ \ ; | & \n \r`).
///
/// Backend re-validates per V13 invariant (Tauri IPC = trust boundary). Caller
/// embeds validated pubkey в UUID heredoc per S-04 (`upload_public_key`).
pub fn validate_ed25519_armored_pubkey(s: &str) -> Result<(), String> {
    if s.is_empty() || s.len() > 200 {
        return Err("Pubkey length out of range (1..=200)".into());
    }
    let parts: Vec<&str> = s.splitn(3, ' ').collect();
    if parts.len() < 2 {
        return Err("Pubkey shape invalid (expected 'ssh-ed25519 BASE64 [comment]')".into());
    }
    if parts[0] != "ssh-ed25519" {
        return Err("Pubkey type must be ssh-ed25519".into());
    }
    if !parts[1]
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '='))
    {
        return Err("Pubkey base64 invalid".into());
    }
    if let Some(comment) = parts.get(2) {
        if comment.chars().any(|c| {
            c.is_control()
                || matches!(c, '\'' | '"' | '`' | '$' | '\\' | ';' | '|' | '&' | '\n' | '\r')
        }) {
            return Err("Pubkey comment contains invalid characters".into());
        }
    }
    Ok(())
}

/// Phase 16 — Protocol enum для UFW firewall rules (REQ-16-FW).
///
/// Allowed values: `"tcp"` | `"udp"` | `"any"` | `""` (empty == "any" by default).
/// Char-whitelist на enum-уровне: shell-metachar никогда не пройдёт через `matches!()`.
///
/// Defence stack (S-02 char-whitelist invariant):
///  - Layer 1: enum membership check (implicit whitelist).
///  - Layer 2: backend re-validates via existing `is_safe_proto` в server_security.rs (V13).
///
/// Aligns с frontend `validators.ts:validateProtocolEnum` (mirror — V13 trust boundary).
pub fn validate_protocol_enum(s: &str) -> Result<(), String> {
    if matches!(s, "tcp" | "udp" | "any" | "") {
        Ok(())
    } else {
        Err(format!("Invalid protocol '{s}' (allowed: tcp, udp, any)"))
    }
}

/// Phase 16 — Fail2Ban numeric configuration range guard (REQ-16-F2B-PRESETS).
///
/// `label`: human-readable name для error message (`"maxretry"` / `"bantime"` / `"findtime"`).
/// `value`: parsed `u32` from frontend (фактически already type-narrow via Tauri IPC).
/// `max`: upper inclusive bound (e.g. maxretry max=1000, bantime max=86400, findtime max=86400).
///
/// Rejects `value == 0` (would disable jail entirely — never desired) и `value > max`.
/// Aligns с frontend `validators.ts:validateFail2banInt` (mirror — V13 trust boundary).
pub fn validate_fail2ban_int(label: &str, value: u32, max: u32) -> Result<(), String> {
    if value == 0 || value > max {
        return Err(format!(
            "Fail2ban {label} out of range (1..={max}, got {value})"
        ));
    }
    Ok(())
}

/// FQDN for `custom_sni` TLV field — letters, digits, dots, hyphens only.
/// Empty string accepted (field optional).
/// Max length 253 chars (RFC 1035).
pub fn validate_fqdn_sni(s: &str) -> Result<(), String> {
    if s.is_empty() {
        return Ok(());
    }
    if s.len() > 253 {
        return Err("SNI too long (max 253 chars)".into());
    }
    if !s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.')) {
        return Err("SNI contains invalid characters (only a-z, A-Z, 0-9, '-', '.' allowed)".into());
    }
    Ok(())
}

/// Phase 17.1 — TLS domain validator (S-02 char-whitelist).
///
/// Accepts: domain (`[a-zA-Z0-9.-]+` 1-253 chars) OR IPv4 (`[0-9.]+`).
/// Rejects: empty (telemt requires non-empty), slashes, spaces, shell metachars
/// (`'`, `"`, `` ` ``, `$`, `\`, `;`, `|`, `&` и т.д.).
///
/// Maps to telemt's `tls_domain` constraint per CONFIG_PARAMS.ru.md:
/// "Не должно быть пустым. Не должно содержать пробелы или `/`."
///
/// Unlike `validate_fqdn_sni` (which permits empty), this validator REJECTS empty
/// because telemt requires `[censorship] tls_domain = "..."` to be non-empty for
/// TLS-camouflage mode. Char-whitelist mirrors `validate_fqdn_sni`: only
/// alphanumeric + `-` + `.` allowed.
pub fn validate_tls_domain(s: &str) -> Result<(), String> {
    if s.is_empty() {
        return Err("tls_domain must be non-empty".into());
    }
    if s.len() > 253 {
        return Err("tls_domain too long (max 253 chars)".into());
    }
    if !s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.')) {
        return Err("tls_domain contains invalid characters (only a-z, A-Z, 0-9, '-', '.' allowed)".into());
    }
    Ok(())
}

/// Log level enum: trace / debug / info / warn / error.
/// Empty string accepted (means "use default"). Case-sensitive (matches upstream CONFIGURATION.md).
///
/// Whitelist defense (S-02): rejects shell metachars even though enum-comparison would also reject.
pub fn validate_log_level(s: &str) -> Result<(), String> {
    if s.is_empty() {
        return Ok(());
    }
    let allowed = ["trace", "debug", "info", "warn", "error"];
    if !allowed.contains(&s) {
        return Err(format!(
            "Invalid log_level '{}' (allowed: {})",
            s,
            allowed.join(", ")
        ));
    }
    Ok(())
}

/// HTTP status code: 405 or 407 only (per upstream CONFIGURATION.md `auth_failure_status_code`).
pub fn validate_auth_status_code(code: u16) -> Result<(), String> {
    if code == 405 || code == 407 {
        Ok(())
    } else {
        Err(format!(
            "auth_failure_status_code must be 405 or 407 (got {code})"
        ))
    }
}

/// URL path subset for ping_path / speedtest_path:
/// - MUST start with `/`
/// - 1 .. 255 chars total
/// - Allowed chars: ASCII alphanumeric + `/` + `-` + `_` + `.`
///
/// Rejects shell injection (`;`, `$`, backticks, spaces) and path traversal (allowed because
/// `..` is two `.` chars but NOT a directory separator at the shell level — server-side TrustTunnel
/// treats this string as URL path, not filesystem path; defence in depth nonetheless).
pub fn validate_url_path(s: &str) -> Result<(), String> {
    if s.is_empty() || s.len() > 255 {
        return Err("Path must be 1-255 characters".into());
    }
    if !s.starts_with('/') {
        return Err("Path must start with '/'".into());
    }
    if !s
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | '.'))
    {
        return Err("Path contains invalid characters (only A-Z, a-z, 0-9, '/', '-', '_', '.' allowed)".into());
    }
    Ok(())
}

// ── Phase 15.1: TOML content validators (REQ-15.6) ────────────────────────
//
// Schema-driven Configuration tab batches edits across vpn.toml / hosts.toml /
// rules.toml через единый Tauri command (server_save_config_file). Каждый
// validator реализует defence stack:
//   Layer 1: size cap 64 KiB (matches `write_vpn_toml_raw` historical limit)
//   Layer 2: toml_edit parse — rejects malformed TOML (structural integrity)
//   Layer 3: defence-in-depth для rules.toml — cidr fields обязательно проходят
//            existing `validate_cidr` char-whitelist (no shell metachars)
//
// Все три validators вызываются на backend стороне save_config_file (V13 trust
// boundary invariant — backend re-validates даже если frontend pre-validated).
// Shell-injection risk smiered through UUID heredoc delim в save layer
// (S-04 invariant from Phase 14.1 — random delimiter cannot be guessed by
// user-controlled TOML content).

/// REQ-15.6 — Phase 15.1 generic content validator для vpn.toml batch save.
///
/// Defence stack:
///   Layer 1: size cap 64 KiB (matches `write_vpn_toml_raw` historical limit)
///   Layer 2: toml_edit parse (rejects malformed TOML; structural validation)
///   Layer 3: char-whitelist на shell-metachars вне TOML strings — covered by
///            toml_edit's structural parse + UUID heredoc delim в save_config_file
///
/// V13 trust boundary: backend re-validates даже если frontend pre-validated.
pub fn validate_vpn_toml_content(content: &str) -> Result<(), String> {
    if content.is_empty() {
        return Err("vpn.toml content cannot be empty".into());
    }
    if content.len() > 65536 {
        return Err("vpn.toml content too large (max 64 KiB)".into());
    }
    let _: toml_edit::DocumentMut = content
        .parse()
        .map_err(|e: toml_edit::TomlError| format!("Invalid TOML in vpn.toml: {e}"))?;
    Ok(())
}

/// REQ-15.6 + REQ-15.A — hosts.toml content validator (Phase 15.1).
///
/// Same defence stack as `validate_vpn_toml_content`. hosts.toml typical shape:
/// [[main_hosts]] / [[ping_hosts]] / [[speedtest_hosts]] / [[reverse_proxy_hosts]]
/// — все array-of-tables проверяются на структурную корректность через toml_edit.
pub fn validate_hosts_toml_content(content: &str) -> Result<(), String> {
    if content.is_empty() {
        return Err("hosts.toml content cannot be empty".into());
    }
    if content.len() > 65536 {
        return Err("hosts.toml content too large (max 64 KiB)".into());
    }
    let _: toml_edit::DocumentMut = content
        .parse()
        .map_err(|e: toml_edit::TomlError| format!("Invalid TOML in hosts.toml: {e}"))?;
    Ok(())
}

/// REQ-15.6 + REQ-15.8 — rules.toml content validator (Phase 15.1).
///
/// Defence stack как у vpn/hosts +
///   Layer 3 (defence-in-depth): walk array-of-tables `[[rule]]` and validate
///   `cidr` field via existing `validate_cidr` (char-whitelist `[0-9./]`).
///   Phase 14.1 anti-DPI rules используют `client_random_prefix` без cidr —
///   эти entries разрешены (cidr field optional).
///
/// Frontend pre-merges по D-2.3 ownership rules перед save; backend validates
/// merged content here.
pub fn validate_rules_toml_content(content: &str) -> Result<(), String> {
    if content.is_empty() {
        // rules.toml CAN have zero [[rule]] entries (comment-only file is valid TOML)
        // but raw_content sent from frontend must not be 0-byte — that signals a bug.
        return Err(
            "rules.toml content cannot be empty (use comment-only file if no rules)".into(),
        );
    }
    if content.len() > 65536 {
        return Err("rules.toml content too large (max 64 KiB)".into());
    }
    let doc: toml_edit::DocumentMut = content
        .parse()
        .map_err(|e: toml_edit::TomlError| format!("Invalid TOML in rules.toml: {e}"))?;

    // Defence in depth: walk [[rule]] array-of-tables and validate cidr fields.
    // T-15.1-07: even though TOML parses, validate_cidr blocks shell metachars
    // in cidr values. Phase 14.1 anti-DPI rules без cidr — те entries skip-аются.
    if let Some(rules_arr) = doc.get("rule").and_then(|i| i.as_array_of_tables()) {
        for (idx, table) in rules_arr.iter().enumerate() {
            if let Some(cidr_val) = table.get("cidr").and_then(|i| i.as_str()) {
                validate_cidr(cidr_val)
                    .map_err(|e| format!("rules.toml [[rule]] #{}: {}", idx + 1, e))?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─── Username ─────────────────────────────────────

    #[test]
    fn username_accepts_normal() {
        assert!(validate_vpn_username("alice").is_ok());
        assert!(validate_vpn_username("user-name_01").is_ok());
        assert!(validate_vpn_username("user@domain.com").is_ok());
    }

    #[test]
    fn username_rejects_shell_injection() {
        assert!(validate_vpn_username(r#"user"; rm -rf / #"#).is_err());
        assert!(validate_vpn_username("$(whoami)").is_err());
        assert!(validate_vpn_username("user`id`").is_err());
        assert!(validate_vpn_username("user;ls").is_err());
        assert!(validate_vpn_username("user|cat /etc/passwd").is_err());
        assert!(validate_vpn_username("user'injection").is_err());
    }

    #[test]
    fn username_rejects_empty_and_long() {
        assert!(validate_vpn_username("").is_err());
        assert!(validate_vpn_username(&"a".repeat(65)).is_err());
    }

    #[test]
    fn username_rejects_whitespace() {
        // CF-06: the backend now matches the frontend and rejects whitespace —
        // a space would split the unquoted `-c <name>` CLI flag.
        assert!(validate_vpn_username("alice bob").is_err());
        assert!(validate_vpn_username("alice\tbob").is_err());
        assert!(validate_vpn_username(" alice").is_err());
        assert!(validate_vpn_username("alice ").is_err());
        // Sanity: a no-space username still passes (not over-tightened).
        assert!(validate_vpn_username("alice").is_ok());
    }

    // ─── Password ─────────────────────────────────────

    #[test]
    fn password_accepts_complex() {
        assert!(validate_vpn_password("P@ssw0rd!#%^&*").is_ok());
        assert!(validate_vpn_password("simple").is_ok());
        assert!(validate_vpn_password("with spaces ok").is_ok());
        // CR-03: dollar/backtick/double-quote stay allowed — safe inside
        // single-quoted heredoc body and the TOML value uses "[^\"]*".
        assert!(validate_vpn_password("dollar$sign").is_ok());
        assert!(validate_vpn_password("back`tick").is_ok());
    }

    #[test]
    fn password_rejects_control_chars() {
        assert!(validate_vpn_password("pass\x00word").is_err());
        assert!(validate_vpn_password("pass\nword").is_err());
    }

    #[test]
    fn password_rejects_shell_unsafe_chars() {
        // CR-03: backslash breaks both TOML value and python literal escaping.
        assert!(validate_vpn_password(r"pass\word").is_err());
        // Single quote terminates the python string literal.
        assert!(validate_vpn_password("pass'word").is_err());
        // Double quote terminates the TOML value.
        assert!(validate_vpn_password("pass\"word").is_err());
        // Injection attempts from CR-03 proof-of-exploit
        assert!(validate_vpn_password(r#"evil"; rm -rf /; #"#).is_err());
    }

    #[test]
    fn password_rejects_empty_and_long() {
        assert!(validate_vpn_password("").is_err());
        assert!(validate_vpn_password(&"a".repeat(129)).is_err());
    }

    // ─── Domain ───────────────────────────────────────

    #[test]
    fn domain_accepts_valid() {
        assert!(validate_domain("example.com").is_ok());
        assert!(validate_domain("sub-domain.example.com").is_ok());
        assert!(validate_domain("").is_ok()); // empty = default
    }

    #[test]
    fn domain_rejects_injection() {
        assert!(validate_domain("example.com; rm -rf /").is_err());
        assert!(validate_domain("$(whoami).com").is_err());
        assert!(validate_domain("test`id`.com").is_err());
    }

    // ─── SSH host (S-4) ───────────────────────────────

    #[test]
    fn validate_ssh_host_accepts_hostname_ipv4_ipv6() {
        assert!(validate_ssh_host("example.com").is_ok());
        assert!(validate_ssh_host("vpn-1.example.com").is_ok());
        assert!(validate_ssh_host("203.0.113.7").is_ok());
        assert!(validate_ssh_host("2001:db8::1").is_ok());
        assert!(validate_ssh_host("[2001:db8::1]").is_ok());
    }

    #[test]
    fn validate_ssh_host_rejects_injection() {
        assert!(validate_ssh_host("host; rm -rf /").is_err());
        assert!(validate_ssh_host("$(whoami)").is_err());
        assert!(validate_ssh_host("host`id`").is_err());
        assert!(validate_ssh_host("host|cat /etc/passwd").is_err());
        assert!(validate_ssh_host("host'sq").is_err());
        assert!(validate_ssh_host("host with space").is_err());
        assert!(validate_ssh_host("").is_err());
    }

    #[test]
    fn validate_ssh_host_rejects_malformed_ipv6_brackets() {
        // WR-02: bracket-mismatched / structurally broken IPv6 literals are
        // rejected even though they contain only whitelisted characters.
        assert!(validate_ssh_host("]2001:db8[").is_err());
        assert!(validate_ssh_host("1.2.3.4]").is_err());
        assert!(validate_ssh_host("[2001:db8::1").is_err());
        assert!(validate_ssh_host("2001:db8::1]").is_err());
        assert!(validate_ssh_host("[[2001:db8::1]]").is_err());
        assert!(validate_ssh_host(":::::").is_err());
        // Well-formed values still pass (not over-tightened).
        assert!(validate_ssh_host("[2001:db8::1]").is_ok());
        assert!(validate_ssh_host("2001:db8::1").is_ok());
        assert!(validate_ssh_host("1.2.3.4").is_ok());
        assert!(validate_ssh_host("example.com").is_ok());
    }

    // ─── Email ────────────────────────────────────────

    #[test]
    fn email_accepts_valid() {
        assert!(validate_email("user@example.com").is_ok());
        assert!(validate_email("").is_ok()); // empty = default
    }

    #[test]
    fn email_rejects_injection() {
        assert!(validate_email("user@ex.com; rm -rf /").is_err());
        assert!(validate_email("user@$(whoami).com").is_err());
        assert!(validate_email("user@test`id`.com").is_err());
    }

    // ─── Client Name ──────────────────────────────────

    #[test]
    fn client_name_accepts_valid() {
        assert!(validate_client_name("client-01").is_ok());
        assert!(validate_client_name("my_device").is_ok());
    }

    #[test]
    fn client_name_rejects_injection() {
        assert!(validate_client_name("client; rm -rf /").is_err());
        assert!(validate_client_name("$(whoami)").is_err());
        assert!(validate_client_name("").is_err());
    }

    // ─── Server Path ──────────────────────────────────

    #[test]
    fn server_path_accepts_valid() {
        assert!(validate_server_path("/etc/ssl/cert.pem").is_ok());
        assert!(validate_server_path("/home/user/certs/key.pem").is_ok());
    }

    #[test]
    fn server_path_rejects_injection() {
        assert!(validate_server_path("/tmp/$(whoami)").is_err());
        assert!(validate_server_path("/tmp/file; rm -rf /").is_err());
    }

    // ─── Listen Address ───────────────────────────────

    #[test]
    fn listen_address_accepts_valid() {
        assert!(validate_listen_address("0.0.0.0:443").is_ok());
        assert!(validate_listen_address("[::]:443").is_ok());
    }

    #[test]
    fn listen_address_rejects_injection() {
        assert!(validate_listen_address("0.0.0.0; rm -rf /").is_err());
        assert!(validate_listen_address("").is_err());
    }

    // ─── Version ──────────────────────────────────────

    #[test]
    fn version_accepts_valid() {
        assert!(validate_version("1.0.33").is_ok());
        assert!(validate_version("v1.0.33").is_ok());
        assert!(validate_version("2.0.0-beta.1").is_ok());
    }

    #[test]
    fn version_rejects_injection() {
        assert!(validate_version("1.0; rm -rf /").is_err());
        assert!(validate_version("$(whoami)").is_err());
        assert!(validate_version("").is_err());
    }

    // ─── CIDR ─────────────────────────────────────────

    #[test]
    fn validate_cidr_accepts_valid() {
        assert!(validate_cidr("").is_ok());
        assert!(validate_cidr("0.0.0.0/0").is_ok());
        assert!(validate_cidr("10.0.0.0/24").is_ok());
        assert!(validate_cidr("192.168.1.0/16").is_ok());
        assert!(validate_cidr("255.255.255.255/32").is_ok());
    }

    #[test]
    fn validate_cidr_rejects_malicious() {
        assert!(validate_cidr("10.0.0.0/24; rm -rf /").is_err());
        assert!(validate_cidr("10.0.0.0/24`$(whoami)`").is_err());
        assert!(validate_cidr("not.an.ip/24").is_err());
        assert!(validate_cidr("10.0.0.256/24").is_err());
        assert!(validate_cidr("10.0.0.0/33").is_err());
        assert!(validate_cidr("10.0.0.0").is_err());
        assert!(validate_cidr("/24").is_err());
        assert!(validate_cidr("10..0.0/24").is_err());
        assert!(validate_cidr(" 10.0.0.0/24").is_err());
    }

    #[test]
    fn validate_cidr_octet_boundaries() {
        assert!(validate_cidr("0.0.0.0/0").is_ok());
        assert!(validate_cidr("255.255.255.255/32").is_ok());
        assert!(validate_cidr("256.0.0.0/0").is_err());
        assert!(validate_cidr("0.0.0.0/33").is_err());
    }

    #[test]
    fn validate_cidr_rejects_leading_zero_octets() {
        // WR-03: backend now matches the frontend octet validator and rejects
        // redundant leading zeros so a UI-blocked value cannot reach the backend
        // with a different (octal-looking) interpretation.
        assert!(validate_cidr("010.0.0.0/8").is_err());
        assert!(validate_cidr("00.0.0.0/8").is_err());
        assert!(validate_cidr("10.01.0.0/8").is_err());
        // A single zero octet is the canonical form and stays valid.
        assert!(validate_cidr("10.0.0.0/8").is_ok());
        assert!(validate_cidr("0.0.0.0/0").is_ok());
    }

    // ─── DNS list ─────────────────────────────────────

    #[test]
    fn validate_dns_list_accepts_valid() {
        assert!(validate_dns_list(&[]).is_ok());
        assert!(validate_dns_list(&["1.1.1.1".to_string()]).is_ok());
        assert!(validate_dns_list(&["1.1.1.1".to_string(), "8.8.8.8".to_string()]).is_ok());
        assert!(validate_dns_list(&["dns.example.com".to_string()]).is_ok());
        assert!(validate_dns_list(&["2001:db8::1".to_string()]).is_ok());
    }

    #[test]
    fn validate_dns_list_skips_empty() {
        assert!(validate_dns_list(&["".to_string(), "   ".to_string(), "1.1.1.1".to_string()]).is_ok());
    }

    #[test]
    fn validate_dns_list_rejects_injection() {
        assert!(validate_dns_list(&["1.1.1.1; rm -rf /".to_string()]).is_err());
        assert!(validate_dns_list(&["$(whoami)".to_string()]).is_err());
        assert!(validate_dns_list(&["1.1.1.1 # comment".to_string()]).is_err());
    }

    // ─── FQDN SNI ─────────────────────────────────────

    #[test]
    fn validate_fqdn_sni_accepts_valid() {
        assert!(validate_fqdn_sni("").is_ok());
        assert!(validate_fqdn_sni("example.com").is_ok());
        assert!(validate_fqdn_sni("a-b.c-d.example.org").is_ok());
    }

    #[test]
    fn validate_fqdn_sni_rejects_injection() {
        assert!(validate_fqdn_sni("example.com; ls").is_err());
        assert!(validate_fqdn_sni("ex ample.com").is_err());
        assert!(validate_fqdn_sni("example`com`").is_err());
    }

    // ─── Phase 17.1: tls_domain ───────────────────────

    #[test]
    fn validate_tls_domain_accepts_domain() {
        assert!(validate_tls_domain("example.com").is_ok());
        assert!(validate_tls_domain("vpn.example.com").is_ok());
        assert!(validate_tls_domain("a-b.c-d.example.org").is_ok());
    }

    #[test]
    fn validate_tls_domain_accepts_ipv4() {
        assert!(validate_tls_domain("1.2.3.4").is_ok());
        assert!(validate_tls_domain("192.168.1.100").is_ok());
        assert!(validate_tls_domain("8.8.8.8").is_ok());
    }

    #[test]
    fn validate_tls_domain_rejects_empty() {
        // telemt CONFIG_PARAMS: "Не должно быть пустым" — unlike validate_fqdn_sni
        // which permits empty, validate_tls_domain REJECTS empty.
        let err = validate_tls_domain("").unwrap_err();
        assert!(err.contains("non-empty"), "Got: {err}");
    }

    #[test]
    fn validate_tls_domain_rejects_too_long() {
        let long = "a".repeat(254);
        let err = validate_tls_domain(&long).unwrap_err();
        assert!(err.contains("too long"), "Got: {err}");
    }

    #[test]
    fn validate_tls_domain_rejects_shell_metachars() {
        assert!(validate_tls_domain("evil.com; rm -rf /").is_err());
        assert!(validate_tls_domain("$(whoami).com").is_err());
        assert!(validate_tls_domain("test`id`.com").is_err());
        assert!(validate_tls_domain("name'sq").is_err());
        assert!(validate_tls_domain("name|pipe").is_err());
    }

    #[test]
    fn validate_tls_domain_rejects_slashes_and_spaces() {
        // telemt CONFIG_PARAMS: "Не должно содержать пробелы или `/`"
        assert!(validate_tls_domain("example.com/path").is_err());
        assert!(validate_tls_domain("ex ample.com").is_err());
        assert!(validate_tls_domain("test\\back").is_err());
    }

    // ─── Phase 16: Ed25519 armored pubkey (S-02 + V13) ─

    #[test]
    fn validate_ed25519_armored_pubkey_accepts_canonical() {
        let pk = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPxJiNqOoQYjA6KmHnxuHXDxLRC2gP9z8z+TGsj1V5sw trusttunnel@example.com";
        assert!(validate_ed25519_armored_pubkey(pk).is_ok());
    }

    #[test]
    fn validate_ed25519_armored_pubkey_rejects_shell_metachars() {
        let pk = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPxJ comment;rm -rf /";
        let err = validate_ed25519_armored_pubkey(pk).unwrap_err();
        assert!(err.contains("invalid characters"), "Got: {err}");
    }

    #[test]
    fn validate_ed25519_armored_pubkey_rejects_non_ed25519() {
        let pk = "ssh-rsa AAAAB3NzaC1yc2EAAAA user@host";
        let err = validate_ed25519_armored_pubkey(pk).unwrap_err();
        assert!(err.contains("ssh-ed25519"), "Got: {err}");
    }

    #[test]
    fn validate_ed25519_armored_pubkey_rejects_too_long() {
        let pk = format!("ssh-ed25519 AAAA{}", "A".repeat(300));
        let err = validate_ed25519_armored_pubkey(&pk).unwrap_err();
        assert!(err.contains("out of range"), "Got: {err}");
    }

    #[test]
    fn validate_ed25519_armored_pubkey_rejects_invalid_base64() {
        let pk = "ssh-ed25519 not-base64-?@! comment";
        let err = validate_ed25519_armored_pubkey(pk).unwrap_err();
        assert!(err.contains("base64"), "Got: {err}");
    }

    // ─── Phase 16: Protocol enum (UFW) + Fail2Ban int range ──

    #[test]
    fn validate_protocol_enum_accepts_canonical() {
        assert!(validate_protocol_enum("tcp").is_ok());
        assert!(validate_protocol_enum("udp").is_ok());
        assert!(validate_protocol_enum("any").is_ok());
        assert!(validate_protocol_enum("").is_ok()); // empty == "any" by default
    }

    #[test]
    fn validate_protocol_enum_rejects_invalid() {
        let err = validate_protocol_enum("icmp").unwrap_err();
        assert!(err.contains("allowed: tcp, udp, any"), "Got: {err}");
        let err = validate_protocol_enum("tcp;rm -rf /").unwrap_err();
        assert!(err.contains("Invalid protocol"), "Got: {err}");
        // Shell-injection attempts uniformly rejected via enum membership.
        assert!(validate_protocol_enum("$(whoami)").is_err());
        assert!(validate_protocol_enum("`id`").is_err());
    }

    #[test]
    fn validate_fail2ban_int_accepts_range() {
        assert!(validate_fail2ban_int("maxretry", 5, 1000).is_ok());
        assert!(validate_fail2ban_int("bantime", 600, 86400).is_ok());
        assert!(validate_fail2ban_int("findtime", 1, 1).is_ok()); // boundary value
        assert!(validate_fail2ban_int("maxretry", 1, 1000).is_ok()); // lower bound
        assert!(validate_fail2ban_int("bantime", 86400, 86400).is_ok()); // upper bound
    }

    #[test]
    fn validate_fail2ban_int_rejects_out_of_range() {
        let err = validate_fail2ban_int("maxretry", 0, 1000).unwrap_err();
        assert!(err.contains("out of range"), "Got: {err}");
        assert!(err.contains("got 0"), "Got: {err}");

        let err = validate_fail2ban_int("bantime", 100000, 86400).unwrap_err();
        assert!(err.contains("out of range"), "Got: {err}");
        assert!(err.contains("got 100000"), "Got: {err}");

        let err = validate_fail2ban_int("findtime", u32::MAX, 86400).unwrap_err();
        assert!(err.contains("out of range"), "Got: {err}");
    }

    // ─── Display name (CR-02) ─────────────────────────

    #[test]
    fn validate_display_name_accepts_normal() {
        assert!(validate_display_name("").is_ok());
        assert!(validate_display_name("My Phone").is_ok());
        assert!(validate_display_name("iPhone-15 Pro").is_ok());
        assert!(validate_display_name("Mac.Book/2026").is_ok());
        assert!(validate_display_name("device_01").is_ok());
    }

    #[test]
    fn validate_display_name_rejects_shell_injection() {
        // Closing-quote attack from CR-02
        assert!(validate_display_name(r#"x"; rm -rf /; echo "y"#).is_err());
        assert!(validate_display_name("$(whoami)").is_err());
        assert!(validate_display_name("`id`").is_err());
        assert!(validate_display_name("name; ls").is_err());
        assert!(validate_display_name("name|cat /etc/passwd").is_err());
        assert!(validate_display_name("name&background").is_err());
        assert!(validate_display_name("name'sq").is_err());
        assert!(validate_display_name("name\\nl").is_err());
        assert!(validate_display_name("name<input").is_err());
        assert!(validate_display_name("name(group)").is_err());
    }

    #[test]
    fn validate_display_name_rejects_control_chars_and_too_long() {
        assert!(validate_display_name("with\nnewline").is_err());
        assert!(validate_display_name("with\0null").is_err());
        assert!(validate_display_name(&"a".repeat(65)).is_err());
    }

    // ─── log_level ───────────────────────────────────────

    #[test]
    fn log_level_accepts_known() {
        assert!(validate_log_level("info").is_ok());
        assert!(validate_log_level("debug").is_ok());
        assert!(validate_log_level("warn").is_ok());
        assert!(validate_log_level("error").is_ok());
        assert!(validate_log_level("trace").is_ok());
        assert!(validate_log_level("").is_ok()); // empty = default
    }

    #[test]
    fn log_level_rejects_unknown() {
        assert!(validate_log_level("verbose").is_err());
        assert!(validate_log_level("INFO").is_err()); // case-sensitive
        assert!(validate_log_level("$(whoami)").is_err());
        assert!(validate_log_level("info; rm -rf /").is_err());
    }

    // ─── auth_status_code ────────────────────────────────

    #[test]
    fn auth_status_code_accepts_whitelist() {
        assert!(validate_auth_status_code(405).is_ok());
        assert!(validate_auth_status_code(407).is_ok());
    }

    #[test]
    fn auth_status_code_rejects_other() {
        assert!(validate_auth_status_code(200).is_err());
        assert!(validate_auth_status_code(401).is_err());
        assert!(validate_auth_status_code(403).is_err());
        assert!(validate_auth_status_code(500).is_err());
        assert!(validate_auth_status_code(0).is_err());
    }

    // ─── url_path ────────────────────────────────────────

    #[test]
    fn url_path_accepts_valid() {
        assert!(validate_url_path("/ping").is_ok());
        assert!(validate_url_path("/speedtest").is_ok());
        assert!(validate_url_path("/api/health.json").is_ok());
        assert!(validate_url_path("/v1/_internal-test").is_ok());
    }

    #[test]
    fn url_path_rejects_empty_or_missing_leading_slash() {
        assert!(validate_url_path("").is_err());
        assert!(validate_url_path("ping").is_err());
    }

    #[test]
    fn url_path_rejects_injection() {
        assert!(validate_url_path("/ping; rm -rf /").is_err());
        assert!(validate_url_path("/$(whoami)").is_err());
        assert!(validate_url_path("/path with spaces").is_err());
        assert!(validate_url_path("/`id`").is_err());
    }

    #[test]
    fn url_path_rejects_too_long() {
        let long = format!("/{}", "a".repeat(255));
        assert!(validate_url_path(&long).is_err());
    }

    // ─── Phase 15.1: TOML content validators ──────────────

    #[test]
    fn vpn_toml_content_accepts_valid() {
        assert!(validate_vpn_toml_content(
            "listen_address = \"0.0.0.0:443\"\nipv6_available = true\n"
        )
        .is_ok());
    }

    #[test]
    fn vpn_toml_content_rejects_empty() {
        assert!(validate_vpn_toml_content("").is_err());
    }

    #[test]
    fn vpn_toml_content_rejects_oversize() {
        let huge = "key = \"".to_string() + &"x".repeat(70000) + "\"";
        assert!(validate_vpn_toml_content(&huge).is_err());
    }

    #[test]
    fn vpn_toml_content_rejects_malformed() {
        // Layer 2 toml_edit parse rejects structurally invalid TOML.
        assert!(validate_vpn_toml_content("listen_address = \"unclosed").is_err());
        assert!(validate_vpn_toml_content("[[unclosed").is_err());
    }

    #[test]
    fn hosts_toml_content_accepts_valid() {
        let toml = "[[main_hosts]]\nhostname = \"a.com\"\ncert_chain_path = \"/etc/c.pem\"\nprivate_key_path = \"/etc/k.pem\"\n";
        assert!(validate_hosts_toml_content(toml).is_ok());
    }

    #[test]
    fn hosts_toml_content_rejects_empty() {
        assert!(validate_hosts_toml_content("").is_err());
    }

    #[test]
    fn rules_toml_content_accepts_valid() {
        let toml = "[[rule]]\ncidr = \"10.0.0.0/8\"\naction = \"allow\"\n";
        assert!(validate_rules_toml_content(toml).is_ok());
    }

    #[test]
    fn rules_toml_content_rejects_invalid_cidr() {
        // T-15.1-07: cidr field structural validation (defence in depth).
        let bad = "[[rule]]\ncidr = \"not.a.cidr\"\naction = \"allow\"\n";
        assert!(validate_rules_toml_content(bad).is_err());
    }

    #[test]
    fn rules_toml_content_rejects_shell_in_cidr() {
        // Defence in depth: even though TOML parses (cidr is just a string),
        // validate_cidr blocks shell metachars to prevent any downstream injection.
        let bad = "[[rule]]\ncidr = \"$(whoami)/24\"\naction = \"allow\"\n";
        assert!(validate_rules_toml_content(bad).is_err());
    }

    #[test]
    fn rules_toml_content_accepts_no_cidr_entries() {
        // Phase 14.1 anti-DPI rules use `client_random_prefix` без cidr — must validate.
        // D-2.3 ownership: Users tab owns client_random_prefix entries; Configuration
        // tab owns cidr entries. Validator must permit both shapes.
        let toml = "[[rule]]\nclient_random_prefix = \"abc123\"\naction = \"allow\"\n";
        assert!(validate_rules_toml_content(toml).is_ok());
    }
}
