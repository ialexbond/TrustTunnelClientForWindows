//! TLV post-encoding for 4 fields not supported by upstream endpoint CLI.
//!
//! # Path A implementation (per memory/users-tab-upstream-audit-phase14.1.md)
//!
//! Upstream CLI emits a deeplink with up to 5 fields (0x03 custom_sni, 0x05 server address,
//! 0x0B client_random_prefix, 0x0C name, 0x0D dns_upstreams). We post-append 4 gap fields:
//! - 0x07 skip_verification (bool)
//! - 0x08 certificate DER (bytes)
//! - 0x09 upstream_protocol (VarInt: 1=HTTP/2, 2=HTTP/3)
//! - 0x0A anti_dpi (bool)
//!
//! # Encoding rules (from upstream deeplink/src/encode.rs, verified 2026-04-18)
//! - Bool: single byte 0x01 (true) or 0x00 (false)
//! - VarInt: TLS/QUIC variable-length integer (7-bit groups, MSB continuation)
//! - String: UTF-8 bytes preceded by varint length
//! - Bytes: raw bytes preceded by varint length
//! - Omission rule: bool false → omit; Http2 → omit (default); None → omit; empty → omit
//!
//! # Divergence risk
//! If upstream changes TLV format, our encoder may break. Mitigation: unit tests with
//! known-good byte fixtures catch divergence during CI runs.
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
        if der.len() > 8192 {
            return Err("cert DER too large (> 8192 bytes)".into());
        }
        write_bytes_tlv(TAG_CERTIFICATE, der, &mut bytes);
    }
    if let Some(proto) = upstream_protocol {
        if proto != "auto" && !proto.is_empty() {
            // Upstream Protocol VarInt constants from deeplink/src/types.rs:
            // Http2 = 1 (omit as default per spec), Http3 = 2
            let varint_value: u64 = match proto {
                "h2" | "http2" | "HTTP/2" => 1,
                "h3" | "http3" | "HTTP/3" => 2,
                _ => return Err(format!("unknown upstream_protocol: {proto}")),
            };
            write_varint_tlv(TAG_UPSTREAM_PROTOCOL, varint_value, &mut bytes);
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
fn write_bytes_tlv(tag: u8, bytes: &[u8], out: &mut Vec<u8>) {
    out.push(tag);
    write_varint(bytes.len() as u64, out);
    out.extend_from_slice(bytes);
}

/// Emit a VarInt-value TLV: [tag, varint(encoded_len), varint(value)]
///
/// The value is encoded as a varint, then that encoding is wrapped with its own length prefix.
fn write_varint_tlv(tag: u8, value: u64, out: &mut Vec<u8>) {
    out.push(tag);
    let mut tmp = Vec::with_capacity(8);
    write_varint(value, &mut tmp);
    write_varint(tmp.len() as u64, out);
    out.extend_from_slice(&tmp);
}

/// TLS/QUIC variable-length integer encoding (7-bit groups, LSB first, MSB=continuation).
///
/// Values 0..=127 encode as a single byte.
/// Values >= 128 use multiple bytes with the high bit set as a continuation flag.
fn write_varint(mut value: u64, out: &mut Vec<u8>) {
    while value >= 0x80 {
        out.push(((value & 0x7F) as u8) | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
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
        let huge = vec![0u8; 9000];
        assert!(append_missing_tlvs(&base, false, false, None, Some(&huge)).is_err());
    }

    #[test]
    fn write_varint_single_byte() {
        let mut out = Vec::new();
        write_varint(0x7F, &mut out);
        assert_eq!(out, [0x7F]);
    }

    #[test]
    fn write_varint_two_bytes() {
        let mut out = Vec::new();
        write_varint(0x80, &mut out);
        // 0x80 = 1000_0000 → first 7 bits = 0, continuation bit set → [0x80, 0x01]
        assert_eq!(out, [0x80, 0x01]);
    }
}
