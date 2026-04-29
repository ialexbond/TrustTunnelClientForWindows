//! Phase 16 — SSH-key generation, keyring storage, deploy to authorized_keys.
//! Per CONTEXT.md D-1.1..D-1.4 (revised 2026-04-29 — keyring path).
//!
//! INVARIANT: keyring 2560-byte limit — only Ed25519 fits (~400 bytes).
//!            D-1.1 fixes algorithm to Ed25519, so this is safe.
//! INVARIANT (D-29): private PEM body MUST NEVER appear in any emit_log /
//!            activity log call. Only fingerprint и host могут быть logged.

use super::super::*;
use russh::client;
use ssh_key::rand_core::OsRng;
use ssh_key::{Algorithm, LineEnding, PrivateKey};

/// Service name для keyring entries — отличается от существующего
/// `KEYRING_SERVICE = "TrustTunnel"` в `ssh_commands.rs` (passwords).
/// Phase 16 SSH-key entries: target = host (per-server).
const KEYRING_SERVICE_KEY: &str = "trusttunnel-sshkey";

#[derive(serde::Serialize, Debug, Clone)]
pub struct GeneratedKey {
    /// OpenSSH PEM string (для keyring storage и backup export).
    /// MUST NOT be emitted to activity log (D-29 invariant).
    pub private_pem: String,
    /// `ssh-ed25519 BASE64 trusttunnel@<host>` — для authorized_keys append.
    pub public_openssh: String,
    /// `SHA256:abcdef...` — для UI display (public, safe to log).
    pub fingerprint: String,
}

/// Generates Ed25519 keypair locally with comment `trusttunnel@<host>`.
/// Returns OpenSSH-formatted private PEM, public key string, SHA256 fingerprint.
///
/// Pure function — no I/O, no SSH, no keyring. Caller persists/uploads.
pub fn generate_ssh_keypair(host: &str) -> Result<GeneratedKey, String> {
    let mut private = PrivateKey::random(&mut OsRng, Algorithm::Ed25519)
        .map_err(|e| format!("KEY_GEN_FAILED|{e}"))?;
    private.set_comment(format!("trusttunnel@{host}"));

    let private_pem = private
        .to_openssh(LineEnding::LF)
        .map_err(|e| format!("KEY_GEN_FAILED|pem_encode|{e}"))?
        .to_string();

    let public_openssh = private
        .public_key()
        .to_openssh()
        .map_err(|e| format!("KEY_GEN_FAILED|pub_encode|{e}"))?;

    let fingerprint = private
        .public_key()
        .fingerprint(ssh_key::HashAlg::Sha256)
        .to_string();

    Ok(GeneratedKey {
        private_pem,
        public_openssh,
        fingerprint,
    })
}

// ═══════════════════════════════════════════════════════════════
//   Keyring storage (Windows Credential Manager via DPAPI)
// ═══════════════════════════════════════════════════════════════

/// Save private PEM в Windows Credential Manager (keyring crate).
/// Per CONTEXT.md D-1.2/1.3 (revised 2026-04-29 — keyring path).
///
/// INVARIANT: PEM body MUST NEVER appear в any emit_log/activity log call (D-29).
/// Caller MUST log only fingerprint or operation status, not PEM content.
pub fn keyring_save_pem(host: &str, pem: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE_KEY, host)
        .map_err(|e| format!("KEY_ENTRY_FAILED|{e}"))?;
    entry
        .set_password(pem)
        .map_err(|e| format!("KEY_STORE_FAILED|{e}"))?;
    Ok(())
}

/// Load private PEM from Windows Credential Manager.
/// Returns Ok(None) when no entry exists (not an error — каждый сервер имеет
/// собственную entry, отсутствие = «ключ ещё не сгенерирован»).
pub fn keyring_load_pem(host: &str) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE_KEY, host)
        .map_err(|e| format!("KEY_ENTRY_FAILED|{e}"))?;
    match entry.get_password() {
        Ok(pem) => Ok(Some(pem)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("KEY_READ_FAILED|{e}")),
    }
}

/// Clear keyring entry (idempotent — no error if entry absent).
pub fn keyring_clear_pem(host: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE_KEY, host)
        .map_err(|e| format!("KEY_ENTRY_FAILED|{e}"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("KEY_DELETE_FAILED|{e}")),
    }
}

/// Validate user-provided OpenSSH PEM (import recovery flow per D-2.3).
/// Returns Ok(()) if valid, propagates parse error wrapped в `INVALID_PEM`.
pub fn validate_pem_format(pem: &str) -> Result<(), String> {
    russh_keys::decode_secret_key(pem, None).map_err(|e| format!("INVALID_PEM|{e}"))?;
    Ok(())
}

/// Import recovery flow per D-2.3: validate PEM → persist в keyring under host.
/// Caller (Tauri command) уже считал bytes from .pem file selected by user.
pub fn import_pem_and_persist(host: &str, pem: &str) -> Result<(), String> {
    validate_pem_format(pem)?;
    keyring_save_pem(host, pem)?;
    Ok(())
}

// ═══════════════════════════════════════════════════════════════
//   Public key deployment to ~/.ssh/authorized_keys
// ═══════════════════════════════════════════════════════════════

/// Append public key к ~/.ssh/authorized_keys idempotently.
///
/// Defence stack:
///  - V13: re-validate `public_openssh` через `validate_ed25519_armored_pubkey`
///    (Tauri IPC = trust boundary).
///  - S-04: UUID heredoc delimiter — attacker не может guess delim для injection.
///  - Idempotency: `grep -qxF` skip-ает append если pubkey уже на сервере.
///  - Permissions: ~/.ssh = 700, authorized_keys = 600 (sshd refuses иначе).
///
/// Caller: `generate_and_deploy` (Tauri command `security_generate_ssh_key`).
pub async fn upload_public_key(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    public_openssh: &str,
) -> Result<(), String> {
    // V13 — backend re-validates user-provided pubkey
    crate::ssh::sanitize::validate_ed25519_armored_pubkey(public_openssh)
        .map_err(|e| format!("INVALID_ED25519_PUBKEY|{e}"))?;

    let trimmed = public_openssh.trim();
    let delim = format!("AKEY_EOF_{}", uuid::Uuid::new_v4().simple());

    // mkdir + chmod ~/.ssh, touch + chmod authorized_keys, then idempotent append.
    // Single-quoted heredoc body — no shell expansion of $/`/\\ inside pubkey.
    let cmd = format!(
        "mkdir -p ~/.ssh && chmod 700 ~/.ssh && \
         touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && \
         (grep -qxF '{}' ~/.ssh/authorized_keys || \
          tee -a ~/.ssh/authorized_keys >/dev/null <<'{}'\n{}\n{})",
        trimmed, delim, trimmed, delim,
    );

    let (_, code) = exec_command(handle, app, &cmd).await?;
    if code != 0 {
        return Err("AUTHORIZED_KEYS_WRITE_FAILED".into());
    }
    Ok(())
}

/// High-level orchestrator for `security_generate_ssh_key` Tauri command.
///
/// Steps:
///   1. Generate Ed25519 locally (no SSH).
///   2. Save private PEM to keyring (no SSH — Windows Cred Manager via DPAPI).
///   3. Upload public key to ~/.ssh/authorized_keys via SSH.
///
/// Returns fingerprint + public key для UI display.
///
/// D-29 — log ONLY fingerprint + host, NEVER PEM body.
pub async fn generate_and_deploy(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    host: String,
) -> Result<serde_json::Value, String> {
    let key = generate_ssh_keypair(&host)?;
    keyring_save_pem(&host, &key.private_pem)?;
    upload_public_key(app, handle, &key.public_openssh).await?;

    // D-29 — log fingerprint, NEVER PEM body
    crate::ssh::emit_log(
        app,
        "INFO",
        &format!(
            "ssh_key.generated host={host} fingerprint={}",
            key.fingerprint
        ),
    );

    Ok(serde_json::json!({
        "fingerprint": key.fingerprint,
        "publicKey": key.public_openssh,
        "generated": true,
    }))
}

/// Status check for SshKeyModal: keyring entry exists + authorized_keys contains
/// our pubkey + sshd_config currently disables PasswordAuthentication?
pub async fn get_ssh_key_status(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    host: String,
) -> Result<serde_json::Value, String> {
    let stored_pem = keyring_load_pem(&host)?;
    let generated = stored_pem.is_some();
    let mut pubkey_fingerprint: Option<String> = None;
    let mut authorized = false;

    if let Some(pem) = stored_pem {
        // Recompute fingerprint от persisted private PEM
        if let Ok(parsed) = ssh_key::PrivateKey::from_openssh(&pem) {
            let pub_str = parsed.public_key().to_openssh().unwrap_or_default();
            pubkey_fingerprint = Some(
                parsed
                    .public_key()
                    .fingerprint(ssh_key::HashAlg::Sha256)
                    .to_string(),
            );
            // Check if authorized_keys contains our pubkey.
            // SAFE: pubkey computed from validated PrivateKey via ssh-key crate
            // (no shell metachars possible); single-line OpenSSH format,
            // single-quote escape sufficient for one-line bash test.
            // S-04 (UUID heredoc) requirement применим к multi-line — not here.
            let trimmed = pub_str.trim();
            let safe = trimmed.replace('\'', "'\\''"); // shell-quote (key validated)
            let cmd = format!(
                "grep -qxF '{}' ~/.ssh/authorized_keys 2>/dev/null && echo present || echo absent",
                safe
            );
            let (out, _) = exec_command(handle, app, &cmd)
                .await
                .unwrap_or((String::new(), 1));
            authorized = out.trim() == "present";
        }
    }

    // Also check whether PasswordAuthentication is currently disabled
    let (pw_status, _) = exec_command(
        handle,
        app,
        "grep -E '^\\s*PasswordAuthentication\\s+no' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null | head -1",
    )
    .await
    .unwrap_or((String::new(), 1));
    let password_auth_disabled = !pw_status.trim().is_empty();

    Ok(serde_json::json!({
        "generated": generated,
        "authorized_on_server": authorized,
        "pubkey_fingerprint": pubkey_fingerprint,
        "password_auth_disabled": password_auth_disabled,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_ed25519_format() {
        let result = generate_ssh_keypair("test-host").expect("generation must succeed");
        assert!(
            result.private_pem.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----"),
            "PEM must use OpenSSH format, got: {}",
            &result.private_pem[..50.min(result.private_pem.len())]
        );
        assert!(
            result.public_openssh.starts_with("ssh-ed25519 "),
            "Public key must be ssh-ed25519 type, got: {}",
            &result.public_openssh[..30.min(result.public_openssh.len())]
        );
        assert!(
            result.fingerprint.starts_with("SHA256:"),
            "Fingerprint must start with SHA256:, got: {}",
            result.fingerprint
        );
        assert!(
            result.public_openssh.contains("trusttunnel@test-host"),
            "Public key must contain comment trusttunnel@test-host"
        );
    }

    #[test]
    fn generate_then_parse_roundtrip() {
        // R-6 mitigation: cross-crate compat ssh-key generated → russh-keys parseable.
        // Critical: SSH connect helper в `ssh/mod.rs` использует russh-keys
        // для key-based auth, поэтому PEM сгенерированный ssh-key 0.6 должен
        // быть совместим с парсером russh-keys 0.46.
        let result = generate_ssh_keypair("roundtrip-host").expect("generation must succeed");
        let parsed = russh_keys::decode_secret_key(&result.private_pem, None);
        assert!(
            parsed.is_ok(),
            "russh-keys must parse ssh-key generated PEM, got error: {:?}",
            parsed.err()
        );
    }

    // ─── Keyring storage (D-1.2/1.3) ────────────────────

    #[test]
    fn keyring_roundtrip_preserves_pem() {
        // Real Cred Manager call. Test-isolated host name (UUID-like) — не пересекается
        // с реальными production entries.
        let host = "test-rt-host-16-01-task2";
        let pem = generate_ssh_keypair(host).unwrap().private_pem;

        // Save → load → assert byte-exact
        keyring_save_pem(host, &pem).expect("save must succeed");
        let loaded = keyring_load_pem(host).expect("load must succeed");
        assert_eq!(loaded.as_deref(), Some(pem.as_str()));

        // Cleanup — leave Cred Manager clean for next test runs
        keyring_clear_pem(host).expect("cleanup must succeed");
    }

    #[test]
    fn keyring_load_returns_none_for_missing() {
        let host = "nonexistent-host-uuid-xyz-9999";
        // Ensure clean slate
        let _ = keyring_clear_pem(host);
        let result = keyring_load_pem(host).expect("must not error");
        assert!(result.is_none(), "Expected None for missing entry");
    }

    #[test]
    fn keyring_clear_idempotent() {
        let host = "another-nonexistent-host-uuid-zzz";
        let _ = keyring_clear_pem(host);
        // Calling clear again should still be Ok (NoEntry path)
        keyring_clear_pem(host).expect("clear must be idempotent");
    }

    // ─── Import recovery (D-2.3) ────────────────────────

    #[test]
    fn import_pem_validates_then_persists() {
        let host = "test-import-host-16-01-task2";
        let valid_pem = generate_ssh_keypair("temp").unwrap().private_pem;

        // Valid PEM accepted
        import_pem_and_persist(host, &valid_pem).expect("valid PEM must persist");

        // Invalid PEM rejected
        let bad = "not a valid PEM at all";
        let err = import_pem_and_persist(host, bad).unwrap_err();
        assert!(err.contains("INVALID_PEM"), "Got: {err}");

        // Cleanup
        keyring_clear_pem(host).expect("cleanup must succeed");
    }
}
