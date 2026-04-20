//! TLV post-encoding for 4 fields not supported by upstream endpoint CLI.
//!
//! # Path A implementation (per memory/users-tab-upstream-audit-phase14.1.md)
//!
//! Upstream CLI emits a deeplink with up to 5 fields (0x03 custom_sni, 0x05 server address,
//! 0x0B client_random_prefix, 0x0C name, 0x0D dns_upstreams). We post-append 4 gap fields:
//! - 0x07 skip_verification (bool)
//! - 0x08 certificate DER (bytes)
//! - 0x09 upstream_protocol (1-byte enum: 1=HTTP/2, 2=HTTP/3)
//! - 0x0A anti_dpi (bool)
//!
//! # Encoding rules (from upstream deeplink/src/encode.rs + varint.rs, 2026-04-18)
//! - Bool: single byte 0x01 (true) or 0x00 (false)
//! - Protocol: single RAW byte (0x01 / 0x02) — NOT varint-wrapped.
//! - VarInt (used for tags and lengths): **QUIC/TLS variable-length integer
//!   per RFC 9000 §16**. Top 2 bits encode the byte length:
//!     - 00xxxxxx → 1 byte  (0..=63)
//!     - 01xxxxxx xxxxxxxx → 2 bytes (0..=16383)
//!     - 10xxxxxx ... (4 bytes) (0..=2^30-1)
//!     - 11xxxxxx ... (8 bytes) (0..=2^62-1)
//!   Earlier revisions of this module used LEB128 varint instead, which matches
//!   QUIC for values ≤63 but diverges for anything larger — that broke certificate
//!   TLV decoding (cert length is typically 500-2000 bytes, i.e. always ≥64).
//!   Result: upstream decoder misread the length prefix, consumed cert bytes
//!   as the remaining length octets, and produced "unrecognized format" or a
//!   TruncatedTlv error downstream.
//! - String: UTF-8 bytes preceded by varint length
//! - Bytes: raw bytes preceded by varint length
//! - Omission rule: bool false → omit; Http2 → omit (default); None → omit; empty → omit
//!
//! # Divergence risk
//! If upstream changes TLV format, our encoder may break. Mitigation: roundtrip
//! tests (below) decode our output with the upstream crate's parser — any
//! drift breaks CI.
//!
//! # Security (T-14.1-01)
//! `base_deeplink` is treated as untrusted input: total decoded size capped at 16384 bytes.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine as _};

const MAX_DEEPLINK_BYTES: usize = 16384;

const TAG_SKIP_VERIFICATION: u8 = 0x07;
const TAG_CERTIFICATE: u8 = 0x08;
const TAG_UPSTREAM_PROTOCOL: u8 = 0x09;
const TAG_ANTI_DPI: u8 = 0x0A;

/// Append the 4 gap TLV fields to a deeplink produced by the upstream endpoint CLI.
///
/// # Arguments
/// - `base_deeplink`: raw "tt://?<base64url>" string from upstream CLI
/// - `anti_dpi`: TLV 0x0A — bool, omitted if false (default)
/// - `skip_verification`: TLV 0x07 — bool, omitted if false (default)
/// - `upstream_protocol`: TLV 0x09 — "h2"→1, "h3"→2, None/"auto"→omit
/// - `certificate_der`: TLV 0x08 — raw DER bytes with varint length prefix; None→omit
///
/// # Returns
/// New deeplink string with appended TLVs, or an error if input is malformed.
pub fn append_missing_tlvs(
    base_deeplink: &str,
    anti_dpi: bool,
    skip_verification: bool,
    upstream_protocol: Option<&str>,
    certificate_der: Option<&[u8]>,
) -> Result<String, String> {
    let raw = base_deeplink
        .strip_prefix("tt://?")
        .ok_or("deeplink missing tt://? prefix")?;
    let mut bytes = B64.decode(raw).map_err(|e| format!("base64 decode: {e}"))?;
    if bytes.len() > MAX_DEEPLINK_BYTES {
        return Err("deeplink too large".into());
    }

    // Append in canonical order (ascending tag number)
    if skip_verification {
        write_bool_tlv(TAG_SKIP_VERIFICATION, true, &mut bytes);
    }
    if let Some(der) = certificate_der {
        // FIX-OO-6: cap bumped 8192 → 32768 to accommodate the full cert
        // chain (leaf + intermediates), not just the leaf. Pinning leaf-only
        // caused OpenSSL to fail verification because the leaf's issuer
        // wasn't in the trust store. Chain size = sum of all certs in
        // `fetch_endpoint_cert` result.
        if der.len() > 32768 {
            return Err("cert DER too large (> 32768 bytes)".into());
        }
        write_bytes_tlv(TAG_CERTIFICATE, der, &mut bytes);
    }
    if let Some(proto) = upstream_protocol {
        if proto != "auto" && !proto.is_empty() {
            // Protocol enum from deeplink/src/types.rs: Http2 = 1, Http3 = 2.
            // Upstream encoder OMITS this TLV when value is Http2 (default) but
            // the decoder accepts it either way. We write it explicitly for both
            // branches so the on-wire representation stays self-describing —
            // useful when someone imports the deeplink into a manual parser /
            // debugger that doesn't know the default.
            let proto_byte: u8 = match proto {
                "h2" | "http2" | "HTTP/2" => 1,
                "h3" | "http3" | "HTTP/3" => 2,
                _ => return Err(format!("unknown upstream_protocol: {proto}")),
            };
            write_protocol_tlv(TAG_UPSTREAM_PROTOCOL, proto_byte, &mut bytes);
        }
    }
    if anti_dpi {
        write_bool_tlv(TAG_ANTI_DPI, true, &mut bytes);
    }

    if bytes.len() > MAX_DEEPLINK_BYTES {
        return Err("deeplink exceeds size cap after TLV append".into());
    }
    Ok(format!("tt://?{}", B64.encode(&bytes)))
}

/// Emit a boolean TLV: [tag, 0x01, 0x01/0x00]
fn write_bool_tlv(tag: u8, value: bool, out: &mut Vec<u8>) {
    out.push(tag);
    out.push(0x01); // length = 1 byte
    out.push(if value { 0x01 } else { 0x00 });
}

/// Emit a bytes TLV: [tag, varint(len), bytes...]
///
/// Length is QUIC/TLS varint, NOT LEB128 — earlier revisions used LEB128 and
/// cert TLVs (length ≥ 64 bytes) broke `trusttunnel_deeplink::decode`.
fn write_bytes_tlv(tag: u8, bytes: &[u8], out: &mut Vec<u8>) {
    out.push(tag);
    write_varint(bytes.len() as u64, out);
    out.extend_from_slice(bytes);
}

/// Emit a 1-byte protocol TLV: [tag, 0x01, proto_byte]
///
/// Upstream `encode_protocol_field` writes the byte RAW (not varint-wrapped) —
/// mirror that. Decoder's `decode_protocol` expects `value.len() == 1` and
/// reads `value[0]` as the u8 Protocol id.
fn write_protocol_tlv(tag: u8, proto_byte: u8, out: &mut Vec<u8>) {
    out.push(tag);
    out.push(0x01); // length = 1 byte
    out.push(proto_byte);
}

/// QUIC/TLS variable-length integer encoding (RFC 9000 §16).
///
/// Top 2 bits of the first byte encode the length:
/// - 00xxxxxx → 1 byte  (values 0..=63)
/// - 01xxxxxx xxxxxxxx → 2 bytes (0..=16383)
/// - 10xxxxxx ... (4 bytes) → 0..=1_073_741_823
/// - 11xxxxxx ... (8 bytes) → 0..=2^62-1
///
/// Mirrors `trusttunnel_deeplink::varint::encode_varint`. Values > 2^62-1 panic
/// with a debug-mode unreachable (same bound as upstream).
fn write_varint(value: u64, out: &mut Vec<u8>) {
    if value <= 0x3F {
        out.push(value as u8);
    } else if value <= 0x3FFF {
        // 2 bytes, big-endian, with 0b01 prefix in MSB of first byte.
        let v = (value | 0x4000) as u16;
        out.extend_from_slice(&v.to_be_bytes());
    } else if value <= 0x3FFF_FFFF {
        let v = (value | 0x8000_0000) as u32;
        out.extend_from_slice(&v.to_be_bytes());
    } else if value <= 0x3FFF_FFFF_FFFF_FFFF {
        let v = value | 0xC000_0000_0000_0000;
        out.extend_from_slice(&v.to_be_bytes());
    } else {
        // Upstream returns VarintOverflow; panicking here is fine because
        // callers (cert length ≤ 8192, enum values in 1..=2) never overflow.
        panic!("varint overflow: {value} > 2^62-1");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal valid deeplink payload for testing: just a dummy TLV entry.
    fn make_base_deeplink(payload: &[u8]) -> String {
        format!("tt://?{}", B64.encode(payload))
    }

    #[test]
    fn anti_dpi_appends_0a_01_01() {
        // Start with a dummy payload: tag=0x05 (server addr), len=5, "alice"
        let base = make_base_deeplink(&[0x05, 0x05, b'a', b'l', b'i', b'c', b'e']);
        let result = append_missing_tlvs(&base, true, false, None, None).unwrap();
        let raw = B64.decode(result.strip_prefix("tt://?").unwrap()).unwrap();
        // Must contain [0x0A, 0x01, 0x01] somewhere
        assert!(raw.windows(3).any(|w| w == [0x0A, 0x01, 0x01]),
            "Expected [0x0A, 0x01, 0x01] in {:?}", raw);
    }

    #[test]
    fn defaults_omitted() {
        let base = make_base_deeplink(&[0x05, 0x05, b'a', b'l', b'i', b'c', b'e']);
        let result = append_missing_tlvs(&base, false, false, None, None).unwrap();
        let raw = B64.decode(result.strip_prefix("tt://?").unwrap()).unwrap();
        // None of the gap tags should appear when all defaults
        assert!(!raw.contains(&TAG_SKIP_VERIFICATION), "0x07 should not appear");
        assert!(!raw.contains(&TAG_CERTIFICATE), "0x08 should not appear");
        assert!(!raw.contains(&TAG_UPSTREAM_PROTOCOL), "0x09 should not appear");
        assert!(!raw.contains(&TAG_ANTI_DPI), "0x0A should not appear");
    }

    #[test]
    fn skip_verification_appends_07_01_01() {
        let base = make_base_deeplink(&[0x05, 0x01, b'x']);
        let result = append_missing_tlvs(&base, false, true, None, None).unwrap();
        let raw = B64.decode(result.strip_prefix("tt://?").unwrap()).unwrap();
        assert!(raw.windows(3).any(|w| w == [0x07, 0x01, 0x01]),
            "Expected [0x07, 0x01, 0x01] in {:?}", raw);
    }

    #[test]
    fn cert_der_appends_0x08_with_correct_length() {
        let base = make_base_deeplink(&[0x05, 0x01, b'x']);
        let cert = vec![0xAAu8; 100];
        let result = append_missing_tlvs(&base, false, false, None, Some(&cert)).unwrap();
        let raw = B64.decode(result.strip_prefix("tt://?").unwrap()).unwrap();
        assert!(raw.contains(&TAG_CERTIFICATE), "0x08 tag should appear");
        // Count 0xAA bytes — should be exactly 100
        let aa_count = raw.iter().filter(|&&b| b == 0xAA).count();
        assert_eq!(aa_count, 100, "Expected 100 cert bytes");
    }

    #[test]
    fn upstream_protocol_h2_appends_0x09() {
        let base = make_base_deeplink(&[0x05, 0x01, b'x']);
        let result = append_missing_tlvs(&base, false, false, Some("h2"), None).unwrap();
        let raw = B64.decode(result.strip_prefix("tt://?").unwrap()).unwrap();
        assert!(raw.contains(&TAG_UPSTREAM_PROTOCOL), "0x09 should appear for h2");
    }

    #[test]
    fn upstream_protocol_auto_omitted() {
        let base = make_base_deeplink(&[0x05, 0x01, b'x']);
        let result = append_missing_tlvs(&base, false, false, Some("auto"), None).unwrap();
        let raw = B64.decode(result.strip_prefix("tt://?").unwrap()).unwrap();
        assert!(!raw.contains(&TAG_UPSTREAM_PROTOCOL), "0x09 should be omitted for auto");
    }

    #[test]
    fn missing_prefix_rejected() {
        assert!(append_missing_tlvs("not-a-deeplink", true, false, None, None).is_err());
    }

    #[test]
    fn invalid_base64_rejected() {
        assert!(append_missing_tlvs("tt://?@@not_valid_b64@@", true, false, None, None).is_err());
    }

    #[test]
    fn oversized_cert_rejected() {
        let base = make_base_deeplink(&[0x05]);
        // FIX-OO-6: cap is now 32768 — pick something comfortably above.
        let huge = vec![0u8; 40_000];
        assert!(append_missing_tlvs(&base, false, false, None, Some(&huge)).is_err());
    }

    #[test]
    fn write_varint_single_byte_small_value() {
        // QUIC 1-byte encoding: prefix 00xxxxxx, covers 0..=63
        let mut out = Vec::new();
        write_varint(0x3F, &mut out);
        assert_eq!(out, [0x3F]);
    }

    #[test]
    fn write_varint_two_byte_encoding_boundary() {
        // 64 is the smallest value needing 2 bytes. QUIC encoding: 0x40, 0x40.
        let mut out = Vec::new();
        write_varint(64, &mut out);
        assert_eq!(out, [0x40, 0x40]);
    }

    #[test]
    fn write_varint_matches_quic_spec_for_1500() {
        // Cert-length case (typical leaf DER ~1500 bytes):
        // 1500 ≤ 0x3FFF, so 2-byte encoding: (1500 | 0x4000) = 0x45DC → [0x45, 0xDC].
        // The previous LEB128 encoding produced [0xDC, 0x0B] which made
        // `trusttunnel_deeplink::decode_varint` read `0xDC` as an 8-byte varint
        // (prefix 0b11) and run off the end of the payload.
        let mut out = Vec::new();
        write_varint(1500, &mut out);
        assert_eq!(out, [0x45, 0xDC]);
    }

    // ── Roundtrip tests against the upstream decoder ────────────────────
    //
    // These lock the encoding to QUIC varint. If someone reintroduces LEB128
    // (or any other encoding) the upstream decoder rejects our output and
    // these tests fail, catching the regression before it ships.
    mod roundtrip_via_upstream {
        use super::super::*;
        use trusttunnel_settings::trusttunnel_deeplink::{decode, encode, DeepLinkConfig, Protocol};

        fn base_deeplink() -> String {
            let cfg = DeepLinkConfig::builder()
                .hostname("vpn.example.com".to_string())
                .addresses(vec!["1.2.3.4:443".to_string()])
                .username("alice".to_string())
                .password("s3cret".to_string())
                .build()
                .unwrap();
            encode(&cfg).unwrap()
        }

        #[test]
        fn bool_tlvs_decode_back_through_upstream() {
            let base = base_deeplink();
            let out = append_missing_tlvs(&base, true, true, None, None).unwrap();
            let decoded = decode(&out).unwrap();
            assert!(decoded.anti_dpi);
            assert!(decoded.skip_verification);
        }

        #[test]
        fn upstream_protocol_h3_decodes_back() {
            let base = base_deeplink();
            let out = append_missing_tlvs(&base, false, false, Some("h3"), None).unwrap();
            let decoded = decode(&out).unwrap();
            assert_eq!(decoded.upstream_protocol, Protocol::Http3);
        }

        #[test]
        fn upstream_protocol_h2_decodes_back() {
            let base = base_deeplink();
            let out = append_missing_tlvs(&base, false, false, Some("h2"), None).unwrap();
            let decoded = decode(&out).unwrap();
            assert_eq!(decoded.upstream_protocol, Protocol::Http2);
        }

        #[test]
        fn small_cert_decodes_back() {
            let base = base_deeplink();
            let cert = vec![0xAAu8; 50]; // < 64 — single-byte varint length
            let out = append_missing_tlvs(&base, false, false, None, Some(&cert)).unwrap();
            let decoded = decode(&out).unwrap();
            assert_eq!(decoded.certificate.as_deref(), Some(&cert[..]));
        }

        #[test]
        fn medium_cert_decodes_back() {
            // This is the case that broke pre-fix: LEB128 varint for ≥64
            // bytes doesn't match upstream's QUIC format, decoder misreads the
            // length prefix, the entire remainder of the payload becomes
            // garbage and decode() returns a parse error.
            let base = base_deeplink();
            let cert = vec![0xBBu8; 500];
            let out = append_missing_tlvs(&base, false, false, None, Some(&cert)).unwrap();
            let decoded = decode(&out).unwrap();
            assert_eq!(decoded.certificate.as_deref(), Some(&cert[..]));
        }

        #[test]
        fn large_cert_decodes_back() {
            let base = base_deeplink();
            // 8192 is the cap; 4096 is realistic for an EC cert chain.
            let cert = vec![0xCCu8; 4096];
            let out = append_missing_tlvs(&base, false, false, None, Some(&cert)).unwrap();
            let decoded = decode(&out).unwrap();
            assert_eq!(decoded.certificate.as_deref(), Some(&cert[..]));
        }

        #[test]
        fn all_four_tlvs_decode_back_together() {
            // The UAT failure path: user pins a cert AND opts into
            // anti-DPI + skip-verify + h3. All four gap TLVs present at once.
            let base = base_deeplink();
            let cert = vec![0xDDu8; 800];
            let out = append_missing_tlvs(&base, true, true, Some("h3"), Some(&cert)).unwrap();
            let decoded = decode(&out).unwrap();
            assert!(decoded.anti_dpi);
            assert!(decoded.skip_verification);
            assert_eq!(decoded.upstream_protocol, Protocol::Http3);
            assert_eq!(decoded.certificate.as_deref(), Some(&cert[..]));
            // Sanity: base fields preserved.
            assert_eq!(decoded.hostname, "vpn.example.com");
            assert_eq!(decoded.username, "alice");
        }
    }
}
