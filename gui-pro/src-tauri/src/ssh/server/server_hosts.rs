//! Phase 15 REQ-15.A: SSH-side mutation path for /opt/trusttunnel/hosts.toml
//!
//! Read path lives in `server_config.rs` (`get_allowed_sni_list`, shipped in
//! Phase 14.1 M-01). This module owns the WRITE path: editing the
//! `allowed_sni` array of a specific `[[main_hosts]]` entry, format-preserving,
//! shell-injection-safe.
//!
//! Pattern follows `server_config.rs` typed mutations (Plan 01):
//!   1. Per-entry char-whitelist (sanitize.rs::validate_fqdn_sni)
//!   2. Read current hosts.toml via single SSH channel
//!   3. Edit via toml_edit::DocumentMut (preserves comments + entry order)
//!   4. Write via UUID-randomized heredoc tee (S-04)
//!   5. systemctl --no-block restart trusttunnel

use super::super::sanitize::validate_fqdn_sni;
use super::super::*;
use russh::client;

/// Pure helper: rewrite `[[main_hosts]]` entry's `allowed_sni` array.
///
/// Returns `Err` if:
/// - hostname or any new SNI fails char-whitelist validation
/// - `raw_toml` cannot be parsed as TOML
/// - `main_hosts` table is missing or not an array of tables
/// - hostname is not present in any `[[main_hosts]]` entry
///
/// Preserves comments + sibling-host entries by editing via `toml_edit::DocumentMut`.
pub fn update_hosts_in_toml(
    raw_toml: &str,
    hostname: &str,
    new_allowed_sni: &[String],
) -> Result<String, String> {
    // Layer 1: char-whitelist hostname (validate_fqdn_sni already accepts empty
    // string, so we add an explicit non-empty check).
    if hostname.is_empty() {
        return Err("hostname cannot be empty".into());
    }
    validate_fqdn_sni(hostname)?;
    // Layer 1: char-whitelist each new SNI entry.
    for sni in new_allowed_sni {
        validate_fqdn_sni(sni)?;
    }

    // Layer 2: parse via toml_edit (rejects malformed TOML, preserves comments).
    let mut doc: toml_edit::DocumentMut = raw_toml
        .parse()
        .map_err(|e: toml_edit::TomlError| format!("Parse hosts.toml: {e}"))?;

    let arr = doc
        .get_mut("main_hosts")
        .ok_or_else(|| "hosts.toml missing main_hosts table".to_string())?
        .as_array_of_tables_mut()
        .ok_or_else(|| "main_hosts is not array of tables".to_string())?;

    let mut found = false;
    for entry in arr.iter_mut() {
        let hn = entry.get("hostname").and_then(|v| v.as_str());
        if hn == Some(hostname) {
            let mut new_arr = toml_edit::Array::new();
            for s in new_allowed_sni {
                new_arr.push(s.as_str());
            }
            entry["allowed_sni"] = toml_edit::value(new_arr);
            found = true;
            break;
        }
    }

    if !found {
        return Err(format!("host not found in hosts.toml: {hostname}"));
    }

    Ok(doc.to_string())
}

/// Update `[[main_hosts]] → allowed_sni` for one host. Restart-required.
///
/// Reads `/opt/trusttunnel/hosts.toml` via a single SSH channel, edits the
/// entry matching `hostname`, writes the file back via UUID-randomized heredoc
/// (S-04), and triggers `systemctl --no-block restart trusttunnel` (mirrors
/// `server_config.rs::write_vpn_toml_via_heredoc` pattern).
///
/// Errors are operation-kind + exit-code only (`HOSTS_TOML_WRITE_FAILED|code=N`)
/// to avoid leaking raw stderr or hostname through the activity log
/// (T-15.02-02 information-disclosure mitigation).
pub async fn update_hosts_allowed_sni(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    hostname: String,
    allowed_sni: Vec<String>,
) -> Result<(), String> {
    let sudo = detect_sudo(handle, app).await;
    let dir = ENDPOINT_DIR;

    // Read current hosts.toml.
    let (raw, _) = exec_command(handle, app, &format!("{sudo}cat {dir}/hosts.toml")).await?;

    // Edit via pure helper (validation + toml_edit roundtrip).
    let new_content = update_hosts_in_toml(&raw, &hostname, &allowed_sni)?;

    // Write back via UUID-randomized heredoc (S-04).
    let delim = format!("HOSTS_TOML_EOF_{}", uuid::Uuid::new_v4().simple());
    let cmd = format!(
        "{sudo}tee {dir}/hosts.toml > /dev/null << '{delim}'\n{new_content}\n{delim}"
    );
    let (_, code) = exec_command(handle, app, &cmd).await?;
    if code != 0 {
        return Err(format!("HOSTS_TOML_WRITE_FAILED|code={code}"));
    }

    // Restart sidecar to apply (--no-block prevents SSH channel hang).
    let _ = exec_command(
        handle,
        app,
        &format!("{sudo}systemctl --no-block restart trusttunnel"),
    )
    .await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_HOSTS_TOML: &str = r#"# server hosts
[[main_hosts]]
hostname = "a.example.com"
allowed_sni = ["cdn1.example.com", "cdn2.example.com"]

[[main_hosts]]
hostname = "b.example.com"
allowed_sni = ["y.example.com"]
"#;

    #[test]
    fn update_hosts_in_toml_replaces_allowed_sni() {
        let new_list = vec!["fresh.example.com".to_string()];
        let updated =
            update_hosts_in_toml(SAMPLE_HOSTS_TOML, "a.example.com", &new_list).unwrap();
        assert!(updated.contains("fresh.example.com"));
        assert!(!updated.contains("cdn1.example.com"));
        assert!(!updated.contains("cdn2.example.com"));
        // Sibling host MUST stay untouched.
        assert!(updated.contains("y.example.com"));
        assert!(updated.contains("b.example.com"));
    }

    #[test]
    fn update_hosts_in_toml_preserves_comments() {
        let updated = update_hosts_in_toml(
            SAMPLE_HOSTS_TOML,
            "a.example.com",
            &["new.com".to_string()],
        )
        .unwrap();
        assert!(
            updated.contains("# server hosts"),
            "comment must survive roundtrip; got:\n{updated}"
        );
    }

    #[test]
    fn update_hosts_in_toml_rejects_unknown_hostname() {
        let result = update_hosts_in_toml(SAMPLE_HOSTS_TOML, "missing.example.com", &[]);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("host not found"), "got: {err}");
    }

    #[test]
    fn update_hosts_in_toml_validates_each_sni_entry() {
        let bad_list = vec!["valid.com".to_string(), "$(whoami)".to_string()];
        let result = update_hosts_in_toml(SAMPLE_HOSTS_TOML, "a.example.com", &bad_list);
        assert!(
            result.is_err(),
            "shell-metachar SNI must be rejected by validate_fqdn_sni"
        );
    }

    #[test]
    fn update_hosts_in_toml_validates_hostname_arg() {
        let result = update_hosts_in_toml(SAMPLE_HOSTS_TOML, "evil$;.com", &[]);
        assert!(
            result.is_err(),
            "shell-metachar hostname must be rejected by validate_fqdn_sni"
        );
    }

    #[test]
    fn update_hosts_in_toml_allows_empty_list() {
        let updated =
            update_hosts_in_toml(SAMPLE_HOSTS_TOML, "a.example.com", &[]).unwrap();
        assert!(updated.contains("a.example.com"));
        assert!(
            updated.contains("allowed_sni = []"),
            "empty list must serialize as `allowed_sni = []`; got:\n{updated}"
        );
    }

    #[test]
    fn update_hosts_in_toml_rejects_empty_hostname() {
        // Defensive: empty hostname is rejected before validate_fqdn_sni
        // (which itself accepts empty string for the optional custom_sni use case).
        let result = update_hosts_in_toml(SAMPLE_HOSTS_TOML, "", &[]);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("hostname cannot be empty"), "got: {err}");
    }

    #[test]
    fn update_hosts_in_toml_rejects_malformed_toml() {
        let bad = "this is not [[ valid toml [[ at all";
        let result = update_hosts_in_toml(bad, "a.example.com", &[]);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.starts_with("Parse hosts.toml:"), "got: {err}");
    }
}
