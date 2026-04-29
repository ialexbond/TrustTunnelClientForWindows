//! Phase 16 — SSH-key generation, keyring storage, deploy to authorized_keys.
//! Per CONTEXT.md D-1.1..D-1.4 (revised 2026-04-29 — keyring path).
//!
//! INVARIANT: keyring 2560-byte limit — only Ed25519 fits (~400 bytes).
//!            D-1.1 fixes algorithm to Ed25519, so this is safe.
//! INVARIANT (D-29): private PEM body MUST NEVER appear in any emit_log /
//!            activity log call. Only fingerprint и host могут быть logged.

use ssh_key::rand_core::OsRng;
use ssh_key::{Algorithm, LineEnding, PrivateKey};

/// Service name для keyring entries — отличается от существующего
/// `KEYRING_SERVICE = "TrustTunnel"` в `ssh_commands.rs` (passwords).
/// Phase 16 SSH-key entries: target = host (per-server).
#[allow(dead_code)] // Used by Task 2/3 keyring helpers (added in subsequent commits)
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
}
