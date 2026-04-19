//! Per-user advanced TLV parameters persisted on the server in
//! `{ENDPOINT_DIR}/users-advanced.toml` — our own sidecar file (FIX-NN).
//!
//! # Why this file exists
//! The upstream TrustTunnel protocol does NOT persist deeplink TLV params.
//! `rules.toml` holds cidr + client_random_prefix. `credentials.toml` holds
//! username+password. Everything else (display_name, custom_sni,
//! upstream_protocol, skip_verification, pin_certificate, dns_upstreams)
//! was session-scoped — gone after the Add modal closed. That meant:
//!   - Edit modal showed defaults, not what the user entered on Add
//!   - FileText reopen fetched a stripped basic deeplink
//!   - Download .toml produced a config without the user's TLV choices
//!
//! This module owns the persistence layer so those three flows stay in
//! sync with what the user last saved.
//!
//! # File format
//! ```toml
//! [[user]]
//! username = "swift-fox"
//! display_name = "Home"
//! custom_sni = "cdn.example.com"
//! upstream_protocol = "h2"        # omitted when "auto"
//! skip_verification = false
//! pin_cert_der_b64 = "MIIB..."    # omitted when no pin
//! dns_upstreams = ["8.8.8.8", "1.1.1.1"]
//! anti_dpi = true
//! ```
//!
//! `cidr` and `client_random_prefix` deliberately live in `rules.toml` —
//! do NOT duplicate them here.
//!
//! # Concurrency
//! Last-write-wins — mirrors `rules.toml` semantics. Two concurrent Pro
//! instances editing the same user will clobber each other; docs note
//! this limitation (see 14.1-CONTEXT.md).

use super::super::*;
use super::super::sanitize::*;
use russh::client;

pub const USERS_ADVANCED_FILE: &str = "users-advanced.toml";

/// Server-persisted advanced parameters for a single user.
///
/// Serialized as-is into TOML. Field names match the TOML keys, so the
/// default serde snake_case is deliberate — DO NOT add
/// `#[serde(rename_all = "camelCase")]`: it would break the on-disk file
/// format and the Tauri command payload shape the frontend sends.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct UserAdvanced {
    pub username: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_sni: Option<String>,
    /// `Some("h2")` / `Some("h3")` / `None`. `"auto"` is normalized to `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_protocol: Option<String>,
    #[serde(default)]
    pub skip_verification: bool,
    /// Base64-encoded DER leaf certificate. `None` = no pin.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pin_cert_der_b64: Option<String>,
    #[serde(default)]
    pub dns_upstreams: Vec<String>,
    /// Duplicated from rules.toml for UX simplicity — the frontend already
    /// surfaces this as part of the "deeplink params" section.
    #[serde(default)]
    pub anti_dpi: bool,
}

#[derive(serde::Serialize, serde::Deserialize, Default, Debug)]
struct Wrapper {
    #[serde(default)]
    user: Vec<UserAdvanced>,
}

/// Validate every user-controlled string. Runs before write AND is used by
/// the (future) read-side integrity check if a sysadmin hand-edited the file.
/// Re-uses the existing `sanitize` helpers so the rules stay centralized.
fn validate_user_advanced(u: &UserAdvanced) -> Result<(), String> {
    validate_vpn_username(&u.username)?;
    if let Some(n) = &u.display_name {
        validate_display_name(n)?;
    }
    if let Some(s) = &u.custom_sni {
        validate_fqdn_sni(s)?;
    }
    validate_dns_list(&u.dns_upstreams)?;
    if let Some(b64) = &u.pin_cert_der_b64 {
        if !b64.is_empty() {
            // Re-use the size cap + base64 validation from cert_probe.
            super::decode_cert_der_b64(b64)?;
        }
    }
    if let Some(proto) = &u.upstream_protocol {
        match proto.as_str() {
            "h2" | "h3" | "auto" => {}
            other => return Err(format!("Invalid upstream_protocol: {other}")),
        }
    }
    Ok(())
}

/// Parse raw TOML content. Missing section / empty file / malformed file
/// all collapse to an empty list — the Edit/Reopen flows fall back to
/// defaults so a bad manual edit doesn't brick the whole UI.
pub fn parse_all(content: &str) -> Vec<UserAdvanced> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    toml::from_str::<Wrapper>(trimmed)
        .map(|w| w.user)
        .unwrap_or_default()
}

pub fn serialize_all(users: &[UserAdvanced]) -> Result<String, String> {
    let wrapper = Wrapper { user: users.to_vec() };
    toml::to_string(&wrapper).map_err(|e| format!("Serialize users-advanced.toml: {e}"))
}

/// Idempotent upsert: replace existing entry with matching username, or
/// append a new one. Preserves order of other entries.
pub fn upsert_in_place(users: &mut Vec<UserAdvanced>, new_user: UserAdvanced) {
    if let Some(existing) = users.iter_mut().find(|u| u.username == new_user.username) {
        *existing = new_user;
    } else {
        users.push(new_user);
    }
}

/// Remove the entry matching `username`. Returns `true` if something was
/// removed (used for skipping a pointless write).
pub fn remove_in_place(users: &mut Vec<UserAdvanced>, username: &str) -> bool {
    let before = users.len();
    users.retain(|u| u.username != username);
    before != users.len()
}

pub fn find_in_slice<'a>(users: &'a [UserAdvanced], username: &str) -> Option<&'a UserAdvanced> {
    users.iter().find(|u| u.username == username)
}

async fn read_remote_file(
    handle: &client::Handle<SshHandler>,
    app: &tauri::AppHandle,
) -> Result<String, String> {
    let sudo = detect_sudo(handle, app).await;
    let (content, _) = exec_command(
        handle, app,
        &format!(
            "{sudo}cat {dir}/{file} 2>/dev/null || echo ''",
            dir = ENDPOINT_DIR,
            file = USERS_ADVANCED_FILE,
        ),
    ).await?;
    Ok(content)
}

async fn write_remote_file(
    handle: &client::Handle<SshHandler>,
    app: &tauri::AppHandle,
    content: &str,
) -> Result<(), String> {
    let sudo = detect_sudo(handle, app).await;

    // UUID-based heredoc delimiter (WR-04 pattern from server_install.rs):
    // user-controlled values like `display_name` can't collide with a random
    // per-write sentinel. Single-quoted heredoc does no expansion, so no
    // escaping of $, `, or " is required inside the body. validate_*
    // functions already rejected backslash in every user-supplied string so
    // backslash-in-TOML is a non-issue.
    let delim = format!("USERSADV_EOF_{}", uuid::Uuid::new_v4().simple());
    let cmd = format!(
        "{sudo}tee {dir}/{file} > /dev/null << '{delim}'\n{content}\n{delim}\n\
         {sudo}chmod 644 {dir}/{file}",
        dir = ENDPOINT_DIR,
        file = USERS_ADVANCED_FILE,
    );
    let (_, code) = exec_command(handle, app, &cmd).await?;
    if code != 0 {
        return Err(format!("SSH_USERS_ADVANCED_WRITE_FAILED|{code}"));
    }
    Ok(())
}

pub async fn get_user_advanced(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    username: String,
) -> Result<Option<UserAdvanced>, String> {
    validate_vpn_username(&username)?;
    let content = read_remote_file(handle, app).await?;
    let users = parse_all(&content);
    Ok(find_in_slice(&users, &username).cloned())
}

/// Batch read — return ALL entries from users-advanced.toml in one SSH
/// roundtrip. Powers A-displayName list in UsersSection: N per-user reads
/// would have been N SSH hops, this is 1.
pub async fn list_user_advanced(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
) -> Result<Vec<UserAdvanced>, String> {
    let content = read_remote_file(handle, app).await?;
    Ok(parse_all(&content))
}

/// M-11: сверяет users-advanced.toml с credentials.toml и удаляет orphan
/// записи (те, для которых нет соответствующего пользователя в credentials).
///
/// Вызывается UsersSection'ом при активации таба, безопасен к запуску
/// многократно. credentials.toml — source of truth для «юзер существует»;
/// orphan'ы в users-advanced.toml появляются если админ удалил юзера
/// напрямую через SSH в обход Pro UI. Кол-во удалённых возвращается
/// фронту для observability, в activity.log Pro пишет результат.
pub async fn reconcile_users_advanced(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
) -> Result<usize, String> {
    // Cheap grep на credentials.toml — избегаем полноценного TOML parse,
    // тут достаточно списка usernames. Same pattern как в server_install.rs.
    let sudo = detect_sudo(handle, app).await;
    let (creds_raw, _) = exec_command(
        handle, app,
        &format!(
            "{sudo}grep -oP 'username\\s*=\\s*\"\\K[^\"]+' {dir}/credentials.toml 2>/dev/null || echo ''",
            dir = ENDPOINT_DIR,
        ),
    ).await?;
    let active_users: std::collections::HashSet<String> = creds_raw
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();

    let adv_content = read_remote_file(handle, app).await?;
    let mut users = parse_all(&adv_content);
    let before = users.len();
    users.retain(|u| active_users.contains(&u.username));
    let removed = before - users.len();

    if removed == 0 {
        return Ok(0);
    }

    let serialized = serialize_all(&users)?;
    write_remote_file(handle, app, &serialized).await?;
    emit_log(
        app,
        "info",
        &format!("users-advanced.toml reconciled: removed {removed} orphan entries"),
    );
    Ok(removed)
}

pub async fn upsert_user_advanced(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    params: UserAdvanced,
) -> Result<(), String> {
    validate_user_advanced(&params)?;
    let content = read_remote_file(handle, app).await?;
    let mut users = parse_all(&content);
    upsert_in_place(&mut users, params);
    let serialized = serialize_all(&users)?;
    write_remote_file(handle, app, &serialized).await
}

pub async fn delete_user_advanced(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    username: String,
) -> Result<(), String> {
    validate_vpn_username(&username)?;
    let content = read_remote_file(handle, app).await?;
    let mut users = parse_all(&content);
    if !remove_in_place(&mut users, &username) {
        // Nothing to delete — file missing, empty, or user never saved
        // advanced params. Idempotent no-op.
        return Ok(());
    }
    let serialized = serialize_all(&users)?;
    write_remote_file(handle, app, &serialized).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(username: &str) -> UserAdvanced {
        UserAdvanced {
            username: username.to_string(),
            display_name: Some("Home".into()),
            custom_sni: Some("cdn.example.com".into()),
            upstream_protocol: Some("h2".into()),
            skip_verification: false,
            pin_cert_der_b64: None,
            dns_upstreams: vec!["8.8.8.8".into(), "1.1.1.1".into()],
            anti_dpi: true,
        }
    }

    // ── Parse edge cases ──────────────────────────────

    #[test]
    fn parse_empty_returns_empty() {
        assert!(parse_all("").is_empty());
        assert!(parse_all("   \n").is_empty());
    }

    #[test]
    fn parse_missing_user_section_returns_empty() {
        // File present but no [[user]] → wrapper deserializes user = vec![].
        assert!(parse_all("# header only\n").is_empty());
    }

    #[test]
    fn parse_malformed_falls_back_to_empty() {
        // Intentional invariant: bad manual edits don't brick Edit/Reopen.
        assert!(parse_all("not = [valid toml").is_empty());
    }

    // ── Roundtrip ─────────────────────────────────────

    #[test]
    fn roundtrip_single_user() {
        let u = sample("alice");
        let s = serialize_all(std::slice::from_ref(&u)).unwrap();
        let parsed = parse_all(&s);
        assert_eq!(parsed, vec![u]);
    }

    #[test]
    fn roundtrip_multiple_users() {
        let users = vec![sample("alice"), sample("bob"), sample("carol")];
        let s = serialize_all(&users).unwrap();
        let parsed = parse_all(&s);
        assert_eq!(parsed, users);
    }

    #[test]
    fn roundtrip_with_optional_fields_absent() {
        let u = UserAdvanced {
            username: "minimal".into(),
            display_name: None,
            custom_sni: None,
            upstream_protocol: None,
            skip_verification: false,
            pin_cert_der_b64: None,
            dns_upstreams: vec![],
            anti_dpi: false,
        };
        let s = serialize_all(std::slice::from_ref(&u)).unwrap();
        // skip_serializing_if = "Option::is_none" means omitted keys.
        assert!(!s.contains("display_name"));
        assert!(!s.contains("custom_sni"));
        assert!(!s.contains("upstream_protocol"));
        assert!(!s.contains("pin_cert_der_b64"));
        // Boolean is always emitted even when false (toml crate behavior).
        assert!(s.contains("skip_verification = false"));
        assert!(s.contains("anti_dpi = false"));

        let parsed = parse_all(&s);
        assert_eq!(parsed, vec![u]);
    }

    // ── Upsert ────────────────────────────────────────

    #[test]
    fn upsert_creates_new_in_empty() {
        let mut users = Vec::new();
        upsert_in_place(&mut users, sample("alice"));
        assert_eq!(users.len(), 1);
        assert_eq!(users[0].username, "alice");
    }

    #[test]
    fn upsert_replaces_existing_in_place() {
        let mut users = vec![sample("alice"), sample("bob")];
        let mut alice_v2 = sample("alice");
        alice_v2.display_name = Some("Home-Updated".into());
        upsert_in_place(&mut users, alice_v2);
        assert_eq!(users.len(), 2);
        let alice = find_in_slice(&users, "alice").unwrap();
        assert_eq!(alice.display_name.as_deref(), Some("Home-Updated"));
        // Preserved entry stays untouched.
        let bob = find_in_slice(&users, "bob").unwrap();
        assert_eq!(bob.display_name.as_deref(), Some("Home"));
    }

    #[test]
    fn upsert_preserves_order_of_others() {
        let mut users = vec![sample("alice"), sample("bob"), sample("carol")];
        let mut bob_v2 = sample("bob");
        bob_v2.custom_sni = Some("new.example.com".into());
        upsert_in_place(&mut users, bob_v2);
        assert_eq!(users[0].username, "alice");
        assert_eq!(users[1].username, "bob");
        assert_eq!(users[1].custom_sni.as_deref(), Some("new.example.com"));
        assert_eq!(users[2].username, "carol");
    }

    #[test]
    fn upsert_appends_to_tail_when_new() {
        let mut users = vec![sample("alice")];
        upsert_in_place(&mut users, sample("bob"));
        assert_eq!(users[0].username, "alice");
        assert_eq!(users[1].username, "bob");
    }

    #[test]
    fn upsert_is_idempotent() {
        let mut users = vec![sample("alice")];
        let snap = users.clone();
        upsert_in_place(&mut users, sample("alice"));
        assert_eq!(users, snap);
    }

    // ── Remove ────────────────────────────────────────

    #[test]
    fn remove_deletes_by_username() {
        let mut users = vec![sample("alice"), sample("bob")];
        assert!(remove_in_place(&mut users, "alice"));
        assert_eq!(users.len(), 1);
        assert_eq!(users[0].username, "bob");
    }

    #[test]
    fn remove_nonexistent_returns_false() {
        let mut users = vec![sample("alice")];
        assert!(!remove_in_place(&mut users, "ghost"));
        assert_eq!(users.len(), 1);
    }

    #[test]
    fn remove_does_not_match_prefix_substring() {
        // Same invariant as CR-04 in rules.toml — deleting "alice" must
        // not delete "alice_jr". Exact username compare guards against it.
        let mut users = vec![sample("alice"), sample("alice_jr")];
        assert!(remove_in_place(&mut users, "alice"));
        assert_eq!(users.len(), 1);
        assert_eq!(users[0].username, "alice_jr");
    }

    // ── Validation ────────────────────────────────────

    #[test]
    fn validate_accepts_sample() {
        assert!(validate_user_advanced(&sample("alice")).is_ok());
    }

    #[test]
    fn validate_rejects_shell_injection_in_display_name() {
        // CR-02 guard — re-use validate_display_name.
        let mut u = sample("alice");
        u.display_name = Some(r#"x"; rm -rf /;"#.into());
        assert!(validate_user_advanced(&u).is_err());
    }

    #[test]
    fn validate_rejects_shell_injection_in_sni() {
        let mut u = sample("alice");
        u.custom_sni = Some("evil.com; ls".into());
        assert!(validate_user_advanced(&u).is_err());
    }

    #[test]
    fn validate_rejects_shell_injection_in_dns() {
        let mut u = sample("alice");
        u.dns_upstreams = vec!["1.1.1.1; rm -rf /".into()];
        assert!(validate_user_advanced(&u).is_err());
    }

    #[test]
    fn validate_rejects_bad_upstream_protocol() {
        let mut u = sample("alice");
        u.upstream_protocol = Some("http1".into());
        assert!(validate_user_advanced(&u).is_err());
    }

    #[test]
    fn validate_accepts_auto_upstream_protocol() {
        // "auto" normalizes to None on the caller side, but persisted
        // files may still carry it — accept for forward compatibility.
        let mut u = sample("alice");
        u.upstream_protocol = Some("auto".into());
        assert!(validate_user_advanced(&u).is_ok());
    }

    #[test]
    fn validate_rejects_bad_cert_b64() {
        let mut u = sample("alice");
        u.pin_cert_der_b64 = Some("!!!not-base64!!!".into());
        assert!(validate_user_advanced(&u).is_err());
    }

    #[test]
    fn validate_accepts_empty_optional_cert() {
        let mut u = sample("alice");
        u.pin_cert_der_b64 = Some(String::new());
        assert!(validate_user_advanced(&u).is_ok());
    }

    #[test]
    fn validate_rejects_empty_username() {
        let mut u = sample("alice");
        u.username = String::new();
        assert!(validate_user_advanced(&u).is_err());
    }
}
