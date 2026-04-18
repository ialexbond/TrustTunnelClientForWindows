/// Input validators for user-supplied values used in SSH commands.
/// All values interpolated into shell commands on remote servers MUST be
/// validated through these functions before use. This prevents command
/// injection attacks (RCE).

/// VPN username: alphanumeric + limited punctuation, no shell metacharacters.
pub fn validate_vpn_username(s: &str) -> Result<(), String> {
    if s.is_empty() || s.len() > 64 {
        return Err("Username must be 1-64 characters".into());
    }
    if s.chars().any(|c| {
        c.is_control() || matches!(c, '\'' | '"' | '`' | '$' | '\\' | ';' | '|' | '&'
            | '(' | ')' | '{' | '}' | '<' | '>' | '\n' | '\r' | '\0')
    }) {
        return Err("Username contains invalid characters".into());
    }
    Ok(())
}

/// VPN password: any printable characters EXCEPT backslash, single quote, and
/// control characters.
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
}
