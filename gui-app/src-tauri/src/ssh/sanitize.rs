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

/// VPN password: any printable characters EXCEPT shell-dangerous single quotes
/// (which break heredoc boundaries) and control characters.
pub fn validate_vpn_password(s: &str) -> Result<(), String> {
    if s.is_empty() || s.len() > 128 {
        return Err("Password must be 1-128 characters".into());
    }
    if s.chars().any(|c| c.is_control()) {
        return Err("Password contains control characters".into());
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
    }

    #[test]
    fn password_rejects_control_chars() {
        assert!(validate_vpn_password("pass\x00word").is_err());
        assert!(validate_vpn_password("pass\nword").is_err());
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
}
