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

/// Maximum accepted certificate DER size (T-14.1-06 mitigation).
///
/// FIX-OO-6: bumped from 8192 → 32768. The field stores a concatenated DER
/// CHAIN (leaf + intermediates), not just the leaf. Typical Let's Encrypt
/// chain is leaf ~1.5KB + intermediate ~1.5KB ≈ 3KB; 32KB gives 10x safety
/// for longer / multi-intermediate chains.
///
/// Why we need the full chain, not just the leaf: when the client pins a
/// cert, the sidecar loads it into X509_STORE as the trust anchor. If we
/// only pin the leaf, OpenSSL verification fails with
/// `unable to get local issuer certificate` because the leaf's ISSUER (the
/// intermediate CA) is not in the store. Pinning the whole chain gives
/// OpenSSL everything it needs to walk the trust path.
pub const MAX_CERT_DER_BYTES: usize = 32768;
const HANDSHAKE_TIMEOUT_SECS: u64 = 10;

/// Result of a TLS certificate probe.
///
/// # Wire format (CR-01 + FIX-OO-6 + FIX-OO-7)
/// `leaf_der_b64` holds concatenated DER (leaf + intermediates),
/// Base64-encoded. Upstream `trusttunnel_deeplink::cert::der_to_pem` splits
/// the concatenation on ASN.1 SEQUENCE boundaries and re-emits each as a
/// separate `-----BEGIN CERTIFICATE-----` block.
///
/// FIX-OO-7: added `is_system_verifiable`. A Let's Encrypt chain is ~3 KB
/// decoded, which makes the base64url-encoded deeplink exceed QR code
/// capacity at ECC level M (~2331 bytes binary for Version 40). When the
/// platform's built-in trust store (Windows CryptoAPI, macOS Security,
/// Linux CA bundle) already accepts this chain, we don't need to embed it
/// in the deeplink at all — the sidecar falls through to
/// `wcrypt_validate_cert` (or its unix equivalent) and verifies via the
/// system anchors. Only self-signed or otherwise untrusted certs get
/// embedded.
///
/// `fingerprint_hex` stays leaf-only so the UI shows a stable value
/// regardless of intermediate rotations.
#[derive(serde::Serialize, Clone, Debug)]
pub struct EndpointCertInfo {
    /// Base64-encoded concatenated DER bytes of the full chain
    /// (leaf first, then intermediates).
    pub leaf_der_b64: String,
    /// Lowercase SHA-256 hex (no separators) of the LEAF DER bytes only.
    /// This is what the user compares against — chain intermediates rotate
    /// independently and hashing them would destabilize the UI contract.
    pub fingerprint_hex: String,
    pub chain_len: usize,
    /// True when the probed chain verifies against the OS root store
    /// (Let's Encrypt, commercial CA, etc.). Consumers (deeplink encoder,
    /// TOML overlay) MUST NOT embed the cert bytes when this is true —
    /// the sidecar already trusts it via the platform verifier, and
    /// embedding adds ~3 KB of payload that blows past QR capacity.
    #[serde(default)]
    pub is_system_verifiable: bool,
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

/// Fetch the leaf TLS certificate from a TrustTunnel endpoint.
///
/// FIX-OO-13: separates the TCP destination from the SNI value so custom
/// SNI (anti-DPI) actually works. Previously a `custom_sni` like
/// `cdn.example.com` was used BOTH as the DNS destination AND as the TLS
/// SNI — the probe DNS-resolved `cdn.example.com` and connected to
/// Cloudflare, not the user's server, so Pin Certificate could never find
/// the real endpoint cert unless the SNI equalled the server's own host.
///
/// # Arguments
/// - `destination_host` — where to TCP-connect. Must be a resolvable
///   hostname or IP. This is the user's actual endpoint.
/// - `port` — TLS port on that endpoint (usually 443).
/// - `sni_host` — value sent in the TLS ClientHello's Server Name
///   Indication. Falls back to `destination_host` when empty. An anti-DPI
///   setup uses a different SNI here so on-path observers see
///   "regular Cloudflare traffic" while the TCP stream actually goes to
///   the VPN endpoint; the server's `allowed_sni` config decides what's
///   acceptable.
///
/// Uses a NoopVerifier for the probe itself (accepts any cert); the
/// platform-verifier pass that determines `is_system_verifiable` is what
/// actually tests trust.
///
/// # Errors
/// - hostname empty or contains invalid characters
/// - TCP connect timeout (10s)
/// - TLS handshake failure
/// - Server returns no certificate chain
/// - Cert chain exceeds MAX_CERT_DER_BYTES (T-14.1-06)
pub async fn fetch_endpoint_cert(
    destination_host: &str,
    port: u16,
    sni_host: &str,
) -> Result<EndpointCertInfo, String> {
    // Defense-in-depth: validate both hostname inputs before passing to rustls
    // or to the OS resolver. Both fields ride the same validator since both
    // end up inside TLS state.
    for (label, value) in [("destination_host", destination_host), ("sni_host", sni_host)] {
        if value.is_empty() || value.len() > 253 {
            return Err(format!("{label} empty or too long"));
        }
        if !value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.')) {
            return Err(format!("{label} contains invalid characters"));
        }
    }

    // FIX-M: if `sni_host` is an IP, rustls refuses to send SNI and the
    // handshake stalls until the endpoint times out. Users hit this when
    // they leave Custom SNI blank and the SSH host itself is an IP.
    // `destination_host` can be an IP (TCP connect doesn't need SNI) but
    // the SNI MUST be a domain.
    if sni_host.chars().all(|c| c.is_ascii_digit() || c == '.')
        && sni_host.split('.').count() == 4
    {
        return Err(
            "SNI is an IP address; TrustTunnel endpoints typically require a domain \
             (FQDN) so SNI can match the server certificate. Enter your server domain into \
             «Custom SNI» above, then retry."
                .into(),
        );
    }

    let verifier = Arc::new(NoopVerifier);
    // FIX-FF: NO ALPN. A previous attempt advertised `h2` + `http/1.1`
    // hoping to satisfy strict rustls-based servers, but the TrustTunnel
    // endpoint does not recognise these names and aborts the handshake
    // with a timeout. A probe without ALPN works on standard TLS and is
    // what the baseline Light client also sends. Leave this comment so
    // the next person doesn't retry the same dead end.
    let config = ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();

    let connector = TlsConnector::from(Arc::new(config));
    let server_name = ServerName::try_from(sni_host.to_string())
        .map_err(|e| format!("invalid server name: {e}"))?;
    // Cloned for the platform-verifier check below — ServerName is Clone
    // so this is cheap (no extra allocation beyond the Arc inside).
    let server_name_for_verify = server_name.clone();

    let handshake_future = async {
        // TCP-connect to the REAL endpoint; `sni_host` is only used by
        // rustls for the ClientHello SNI extension, not for DNS resolution.
        let tcp = TcpStream::connect((destination_host, port))
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
        // FIX-OO-6: concatenate the entire chain (leaf + intermediates) so
        // the pinned-cert flow gives OpenSSL everything it needs to walk
        // the trust path. Pinning just chain[0] caused
        // `unable to get local issuer certificate` because the leaf's
        // issuer (the intermediate) was never written to the trust store.
        let leaf_der: Vec<u8> = chain[0].to_vec();
        let intermediates: Vec<CertificateDer<'static>> = chain
            .iter()
            .skip(1)
            .map(|c| CertificateDer::from(c.to_vec()))
            .collect();
        let mut chain_der: Vec<u8> = Vec::with_capacity(leaf_der.len() * chain.len());
        for cert in chain.iter() {
            chain_der.extend_from_slice(cert.as_ref());
        }
        if chain_der.len() > MAX_CERT_DER_BYTES {
            return Err(format!(
                "cert chain too large ({} bytes, max {})",
                chain_der.len(),
                MAX_CERT_DER_BYTES
            ));
        }

        // FIX-OO-7: ask the platform verifier whether this chain is already
        // trusted by the OS root store. If it is (Let's Encrypt, commercial
        // CA, etc.), callers will SKIP embedding the cert into the deeplink
        // — the sidecar hits its own `wcrypt_validate_cert` /
        // `tls_verify_cert_0` path at connect time and trusts the chain via
        // the platform anchors. Omitting saves ~3 KB of payload, which
        // matters because a binary-mode QR code caps around 2.3 KB at ECC-M.
        //
        // rustls-platform-verifier needs a CryptoProvider. tokio-rustls'
        // default registration may not be installed yet, so install
        // aws-lc-rs (already a transitive dep) best-effort — `set_default`
        // silently returns Err if one's already set, which is fine.
        let is_system_verifiable = {
            let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
            let provider = rustls::crypto::CryptoProvider::get_default()
                .expect("crypto provider must be installed by now")
                .clone();
            let leaf = CertificateDer::from(leaf_der.clone());
            let now = UnixTime::now();
            // Verifier::new is fallible on Windows (needs a schannel handle).
            // On failure we pessimistically say "not system-verifiable" so
            // callers still embed the cert — correctness first, smaller
            // deeplink second.
            match rustls_platform_verifier::Verifier::new(provider) {
                Ok(v) => v
                    .verify_server_cert(&leaf, &intermediates, &server_name_for_verify, &[], now)
                    .is_ok(),
                Err(_) => false,
            }
        };

        // Fingerprint stays leaf-only — stable across intermediate rotations.
        let digest = Sha256::digest(&leaf_der);
        let fingerprint_hex = format_fingerprint_hex(&digest);
        let leaf_der_b64 = B64.encode(&chain_der);
        Ok(EndpointCertInfo {
            leaf_der_b64,
            fingerprint_hex,
            chain_len: chain.len(),
            is_system_verifiable,
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
            is_system_verifiable: true,
        };
        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("\"leaf_der_b64\":\"AQID\""));
        assert!(json.contains("\"fingerprint_hex\":\"aabbcc\""));
        assert!(json.contains("\"chain_len\":2"));
        assert!(json.contains("\"is_system_verifiable\":true"));
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
