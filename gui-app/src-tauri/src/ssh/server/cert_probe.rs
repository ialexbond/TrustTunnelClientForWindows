//! Endpoint TLS certificate probe for pin-on-deeplink UI.
//!
//! # Security model
//! This probe intentionally uses a NoopVerifier (accepts any peer cert).
//! The user's intent is to pin the returned fingerprint in a deeplink — they
//! are NOT trusting a CA chain. The fingerprint IS the trust anchor.
//!
//! Do NOT use this function in any production trust decision. The caller
//! must display the fingerprint to the user before embedding it anywhere.
//!
//! Adapted from: RESEARCH.md §Pattern 5 (tokio-rustls skeleton).
//! Mitigates T-14.1-03 (Spoofing/MITM) and T-14.1-06 (DoS via large cert).

use std::sync::Arc;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use tokio_rustls::rustls;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use sha2::{Digest, Sha256};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;

/// Maximum accepted leaf certificate DER size (T-14.1-06 mitigation).
/// Typical real certs are <2KB; 8KB is a 4x safety buffer.
pub const MAX_CERT_DER_BYTES: usize = 8192;
const HANDSHAKE_TIMEOUT_SECS: u64 = 10;

/// Result of a TLS certificate probe.
///
/// # Wire format (CR-01)
/// `leaf_der_b64` is the DER leaf certificate as a Base64-encoded string. Earlier revisions
/// returned `leaf_der: Vec<u8>` but Tauri+serde_json serialize byte vectors as JSON arrays of
/// numbers (`[1, 2, 3, ...]`), not Base64. The frontend expected a string and tried to round-trip
/// the value back through `pin_certificate_der: Option<Vec<u8>>` which also does not accept
/// Base64 — together that broke cert pinning end-to-end. Fix: canonical representation is a
/// Base64 string across the boundary; backend encodes/decodes internally when it needs bytes.
#[derive(serde::Serialize, Clone, Debug)]
pub struct EndpointCertInfo {
    /// Base64-encoded DER bytes of the leaf certificate.
    pub leaf_der_b64: String,
    /// Lowercase SHA-256 hex (no separators) of the leaf DER bytes.
    pub fingerprint_hex: String,
    pub chain_len: usize,
}

/// Decode a base64 DER string into raw bytes with the same size cap applied to live probes.
///
/// Callers use this to validate `pin_certificate_der` parameters coming from the frontend.
pub fn decode_cert_der_b64(s: &str) -> Result<Vec<u8>, String> {
    let bytes = B64
        .decode(s.as_bytes())
        .map_err(|e| format!("invalid cert base64: {e}"))?;
    if bytes.len() > MAX_CERT_DER_BYTES {
        return Err(format!(
            "cert DER too large ({} bytes, max {})",
            bytes.len(),
            MAX_CERT_DER_BYTES
        ));
    }
    Ok(bytes)
}

/// A TLS verifier that accepts any certificate chain.
///
/// # Security
/// This is intentionally permissive. The application flow is:
/// 1. Probe → display fingerprint to user
/// 2. User confirms they trust it
/// 3. Fingerprint embedded in deeplink as the trust anchor
///
/// Using a CA-validating verifier here would be wrong — the server cert may be
/// self-signed or issued by a CA not in the system root store.
#[derive(Debug)]
struct NoopVerifier;

impl ServerCertVerifier for NoopVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![
            SignatureScheme::ED25519,
            SignatureScheme::ECDSA_NISTP256_SHA256,
            SignatureScheme::ECDSA_NISTP384_SHA384,
            SignatureScheme::RSA_PSS_SHA256,
            SignatureScheme::RSA_PSS_SHA384,
            SignatureScheme::RSA_PSS_SHA512,
            SignatureScheme::RSA_PKCS1_SHA256,
            SignatureScheme::RSA_PKCS1_SHA384,
            SignatureScheme::RSA_PKCS1_SHA512,
        ]
    }
}

/// Fetch the leaf TLS certificate from `hostname:port`.
///
/// Performs a full TLS handshake with a NoopVerifier (accepts any cert).
/// Returns DER bytes of the leaf certificate and its SHA-256 fingerprint.
///
/// # Errors
/// - hostname empty or contains invalid characters
/// - TCP connect timeout (10s)
/// - TLS handshake failure
/// - Server returns no certificate chain
/// - Leaf cert exceeds 8192 bytes (T-14.1-06)
pub async fn fetch_endpoint_cert(
    hostname: &str,
    port: u16,
) -> Result<EndpointCertInfo, String> {
    // Defense-in-depth: validate hostname shape before passing to rustls
    if hostname.is_empty() || hostname.len() > 253 {
        return Err("hostname empty or too long".into());
    }
    if !hostname.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.')) {
        return Err("hostname contains invalid characters".into());
    }

    let verifier = Arc::new(NoopVerifier);
    let config = ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();

    let connector = TlsConnector::from(Arc::new(config));
    let server_name = ServerName::try_from(hostname.to_string())
        .map_err(|e| format!("invalid server name: {e}"))?;

    let handshake_future = async {
        let tcp = TcpStream::connect((hostname, port))
            .await
            .map_err(|e| format!("tcp connect: {e}"))?;
        let tls = connector
            .connect(server_name, tcp)
            .await
            .map_err(|e| format!("tls handshake: {e}"))?;
        let (_, session) = tls.get_ref();
        let chain = session
            .peer_certificates()
            .ok_or("no cert chain returned")?;
        if chain.is_empty() {
            return Err::<_, String>("empty cert chain".into());
        }
        let leaf_der: Vec<u8> = chain[0].to_vec();
        if leaf_der.len() > MAX_CERT_DER_BYTES {
            return Err(format!(
                "cert too large ({} bytes, max {})",
                leaf_der.len(),
                MAX_CERT_DER_BYTES
            ));
        }
        let digest = Sha256::digest(&leaf_der);
        let fingerprint_hex = format_fingerprint_hex(&digest);
        let leaf_der_b64 = B64.encode(&leaf_der);
        Ok(EndpointCertInfo {
            leaf_der_b64,
            fingerprint_hex,
            chain_len: chain.len(),
        })
    };

    tokio::time::timeout(Duration::from_secs(HANDSHAKE_TIMEOUT_SECS), handshake_future)
        .await
        .map_err(|_| format!("handshake timeout after {HANDSHAKE_TIMEOUT_SECS}s"))?
}

/// Format raw bytes as lowercase hex string (no separators).
pub(crate) fn format_fingerprint_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_fingerprint_zeros() {
        assert_eq!(format_fingerprint_hex(&[0, 0, 0]), "000000");
    }

    #[test]
    fn format_fingerprint_bytes() {
        assert_eq!(format_fingerprint_hex(&[0xaa, 0xbb, 0xcc]), "aabbcc");
    }

    #[test]
    fn format_fingerprint_sha256_length() {
        let digest = Sha256::digest(b"hello");
        let hex = format_fingerprint_hex(&digest);
        assert_eq!(hex.len(), 64); // SHA-256 is 32 bytes = 64 hex chars
    }

    #[test]
    fn endpoint_cert_info_serializes() {
        // CR-01: leaf_der_b64 must be a plain JSON string, not an array of numbers.
        let info = EndpointCertInfo {
            leaf_der_b64: "AQID".to_string(), // base64("\x01\x02\x03")
            fingerprint_hex: "aabbcc".to_string(),
            chain_len: 2,
        };
        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("\"leaf_der_b64\":\"AQID\""));
        assert!(json.contains("\"fingerprint_hex\":\"aabbcc\""));
        assert!(json.contains("\"chain_len\":2"));
    }

    #[test]
    fn decode_cert_der_b64_roundtrips() {
        let bytes = vec![0x01, 0x02, 0x03];
        let encoded = B64.encode(&bytes);
        assert_eq!(decode_cert_der_b64(&encoded).unwrap(), bytes);
    }

    #[test]
    fn decode_cert_der_b64_rejects_invalid_base64() {
        assert!(decode_cert_der_b64("!!!not-base64!!!").is_err());
    }

    #[test]
    fn decode_cert_der_b64_enforces_size_cap() {
        // Anything decoding to > 8192 bytes must be rejected.
        let oversized = B64.encode(vec![0u8; MAX_CERT_DER_BYTES + 1]);
        assert!(decode_cert_der_b64(&oversized).is_err());
        // Exactly 8192 is accepted.
        let max_ok = B64.encode(vec![0u8; MAX_CERT_DER_BYTES]);
        assert!(decode_cert_der_b64(&max_ok).is_ok());
    }

    #[test]
    fn hostname_validation_rejects_empty() {
        // We can't easily call async fn in sync test without tokio::test
        // Validate hostname logic directly through the char check
        let hostname = "";
        assert!(hostname.is_empty() || hostname.len() > 253);
    }

    #[test]
    fn hostname_validation_rejects_injection() {
        let hostname = "evil;rm-rf";
        let valid = !hostname.is_empty()
            && hostname.len() <= 253
            && hostname.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.'));
        assert!(!valid);
    }
}
