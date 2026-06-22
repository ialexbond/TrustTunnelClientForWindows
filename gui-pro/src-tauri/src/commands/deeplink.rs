use crate::ssh::portable_data_dir;
use trusttunnel_settings::{endpoint_from_deeplink_config, trusttunnel_deeplink};

/// Decode a trusttunnel:// deeplink URL and return the TOML config content.
///
/// Supports two payload formats:
/// 1. Base64-encoded TOML text (legacy)
/// 2. Binary protocol parsed by the upstream `trusttunnel-deeplink` crate
///    (supports all fields: client_random_prefix, custom_sni, certificate, etc.)
#[tauri::command]
pub async fn decode_deeplink(url: String) -> Result<String, String> {
    let trimmed = url.trim();

    // ── 1. Try upstream binary decoder first ──────────────────────
    //    trusttunnel_deeplink::decode handles tt:// and tt://? schemes
    if let Ok(config) = trusttunnel_deeplink::decode(trimmed) {
        let endpoint = endpoint_from_deeplink_config(config)
            .map_err(|e| format!("Failed to convert deeplink config: {e}"))?;
        let endpoint_toml =
            toml::to_string(&endpoint).map_err(|e| format!("Failed to serialize endpoint: {e}"))?;

        // Wrap [endpoint] block into a full client config
        return Ok(crate::ssh::build_client_config(&endpoint_toml, "Imported from deeplink"));
    }

    // ── 2. Fallback: base64-encoded TOML ─────────────────────────
    let after_proto = if let Some(rest) = trimmed.strip_prefix("trusttunnel://") {
        rest.trim_start_matches('/')
    } else if let Some(rest) = trimmed.strip_prefix("tt://") {
        rest.trim_start_matches('/')
    } else {
        return Err("Invalid deeplink: must start with trusttunnel:// or tt://".into());
    };

    // Extract base64 payload from query or path
    let config_b64 = if let Some(query) = after_proto.split('?').nth(1) {
        query
            .split('&')
            .find_map(|p| p.strip_prefix("config="))
            .unwrap_or(query)
    } else {
        after_proto
    };

    // URL-decode into a BYTE buffer (CR-01). The base64 payload is binary text;
    // decoding `%XX` escapes into a String via `byte as char` corrupted any byte
    // >= 0x80 (it became a multi-byte UTF-8 sequence), feeding the base64 engines
    // a mangled payload. Decoding to bytes and base64-decoding those bytes
    // directly keeps the payload exact.
    let decoded_url = urlencoding_decode_bytes(&config_b64.replace('+', " "));

    // Base64 decode — try all variants
    use base64::Engine;
    let engines: &[base64::engine::GeneralPurpose] = &[
        base64::engine::general_purpose::STANDARD,
        base64::engine::general_purpose::URL_SAFE,
        base64::engine::general_purpose::STANDARD_NO_PAD,
        base64::engine::general_purpose::URL_SAFE_NO_PAD,
    ];

    let bytes = engines
        .iter()
        .find_map(|engine| engine.decode(&decoded_url).ok())
        .ok_or_else(|| "Failed to decode base64 config".to_string())?;

    // WR-05: only return the decoded text VERBATIM as a client config when it
    // actually parses as a TrustTunnel client config (a non-empty top-level
    // `[endpoint]` table). The old substring sniff (contains "hostname" /
    // "[endpoint]" / "username") shipped ANY base64 blob whose decoded text
    // merely mentioned those words — on the UNTRUSTED deeplink path. This
    // tightens the boundary to a structured shape check (the same discriminator
    // `save_client_config` and `import_config_from_string` use).
    if let Ok(text) = String::from_utf8(bytes.clone()) {
        if is_trusttunnel_client_config(&text) {
            return Ok(text);
        }
    }

    // Last resort: try to decode base64 payload as binary deeplink
    // Reconstruct a tt://? URI so the upstream parser can handle it
    let re_encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&bytes);
    let synthetic_uri = format!("tt://?{re_encoded}");
    if let Ok(config) = trusttunnel_deeplink::decode(&synthetic_uri) {
        let endpoint = endpoint_from_deeplink_config(config)
            .map_err(|e| format!("Failed to convert deeplink config: {e}"))?;
        let endpoint_toml =
            toml::to_string(&endpoint).map_err(|e| format!("Failed to serialize endpoint: {e}"))?;
        return Ok(crate::ssh::build_client_config(&endpoint_toml, "Imported from deeplink"));
    }

    Err("Could not parse deeplink: unrecognized format".into())
}

/// Shared shape-check (WR-05 + WR-06): is `content` a TrustTunnel client config?
///
/// A legitimate client config — whether produced by `build_client_config`
/// (ssh/mod.rs) or a hand-exported `trusttunnel_client.toml` — always carries a
/// non-empty top-level `[endpoint]` table. We require exactly that: the content
/// must parse as TOML AND expose a non-empty `endpoint` table. This is the SAME
/// discriminator `save_client_config` enforces (config.rs), so it never rejects
/// a config the app itself would write. Used on BOTH untrusted import paths
/// (the deeplink base64 fallback and the clipboard `import_config_from_string`)
/// so the trust boundary is hardened in one place.
fn is_trusttunnel_client_config(content: &str) -> bool {
    let Ok(value) = toml::from_str::<toml::Value>(content) else {
        return false;
    };
    value
        .get("endpoint")
        .and_then(|e| e.as_table())
        .is_some_and(|t| !t.is_empty())
}

/// Import a config string (TOML content) and save it to the app data directory.
#[tauri::command]
pub async fn import_config_from_string(content: String, source: String) -> Result<String, String> {
    // WR-06: parsing as TOML is NOT enough — the clipboard import path is
    // UNTRUSTED, and any valid-TOML paste would otherwise be written verbatim as
    // the active config and then fail opaquely at connect time. Require the same
    // client-config shape (a non-empty `[endpoint]` table) the deeplink fallback
    // (WR-05) and `save_client_config` require, via the shared helper.
    if !is_trusttunnel_client_config(&content) {
        return Err("Config is missing the [endpoint] section".into());
    }

    let config_dir = portable_data_dir();
    std::fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create config dir: {e}"))?;

    let config_path = config_dir.join("trusttunnel_client.toml");
    std::fs::write(&config_path, &content)
        .map_err(|e| format!("Failed to write config: {e}"))?;

    // D-29 invariant: log ONLY the source label + the destination file path —
    // NEVER `content`. The decoded payload carries the user's VPN credentials
    // (host/username/secret), and a deep-link import is exactly the untrusted
    // path most likely to be tailed in a support log. Adding `content` here (or
    // anywhere on the deep-link route) would leak secrets to the log channel.
    eprintln!(
        "[deeplink] Config imported from {source}: {}",
        config_path.display()
    );

    Ok(config_path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // C-22 / D-14 regression guard: the incoming tt:// URL is UNTRUSTED external
    // input. `decode_deeplink` is the trusted validation boundary — a URL that is
    // not a trusttunnel://`/`tt:// scheme, or whose payload is unparseable, MUST be
    // rejected HERE (scheme guard at L27-33, final Err at L81), never deeper where a
    // malformed config could be written. These tests prove rejection happens at the
    // boundary so the frontend pre-fill path (which only carries the raw URL to the
    // modal) can never silently import garbage.

    #[tokio::test]
    async fn rejects_non_tt_scheme() {
        // A plain https URL is not a deep-link scheme → rejected by the scheme guard.
        let result = decode_deeplink("https://evil.example/x".into()).await;
        assert!(result.is_err(), "non-tt scheme must be rejected at decode");
    }

    #[tokio::test]
    async fn rejects_garbage_url() {
        // Not even a URL → rejected (no scheme prefix).
        let result = decode_deeplink("not-a-url".into()).await;
        assert!(result.is_err(), "garbage input must be rejected at decode");
    }

    #[tokio::test]
    async fn rejects_tt_scheme_with_unparseable_payload() {
        // Correct scheme but the payload is not valid base64/binary deeplink →
        // rejected at the final Err (L81), not written as a config.
        let result = decode_deeplink("tt://!!!not-base64!!!".into()).await;
        assert!(
            result.is_err(),
            "tt:// with an unparseable payload must be rejected at decode"
        );
    }

    // CR-01 regression: percent-decoding MUST operate on raw bytes. The old
    // `byte as char` reinterpreted each decoded byte as a Unicode scalar
    // (Latin-1), so any byte >= 0x80 was re-encoded as a multi-byte UTF-8
    // sequence — corrupting the payload before base64 decode. This test feeds a
    // `%XX` sequence with XX >= 0x80 and asserts the EXACT bytes come back. The
    // pre-fix `urlencoding_decode` returned a String whose `.as_bytes()` was the
    // mangled UTF-8 (0xC3 0xBF for %FF), failing this assertion.
    #[test]
    fn urlencoding_decode_bytes_preserves_high_bytes() {
        // %FF (0xFF) and %80 (0x80) are both >= 0x80 — the exact bytes that the
        // old char-based decoder corrupted.
        let out = urlencoding_decode_bytes("%FF%80%41");
        assert_eq!(out, vec![0xFF_u8, 0x80_u8, 0x41_u8]);
    }

    #[test]
    fn urlencoding_decode_bytes_passes_through_plain_ascii() {
        // Non-percent bytes pass through untouched; an invalid `%` escape is kept
        // verbatim (no panic, no swallow).
        let out = urlencoding_decode_bytes("ab%2Fcd%zz");
        assert_eq!(out, b"ab/cd%zz".to_vec());
    }

    // WR-05 / WR-06 shared shape-check: the discriminator must REJECT random
    // valid TOML (the over-broad substring sniff accepted anything mentioning
    // "username"/"hostname") and ACCEPT a real-shaped client config.
    #[test]
    fn shape_check_rejects_random_valid_toml() {
        // Valid TOML, but NOT a client config — no [endpoint] table. The old
        // substring sniff would have accepted this because it mentions "username".
        let blob = "title = \"hello\"\nusername = \"someone\"\n[server]\nport = 8080\n";
        assert!(toml::from_str::<toml::Value>(blob).is_ok(), "fixture must be valid TOML");
        assert!(
            !is_trusttunnel_client_config(blob),
            "random valid TOML mentioning 'username' must be rejected"
        );
    }

    #[test]
    fn shape_check_rejects_empty_endpoint_table() {
        // An [endpoint] header with no keys is not a usable config.
        let blob = "loglevel = \"info\"\n[endpoint]\n";
        assert!(!is_trusttunnel_client_config(blob), "empty [endpoint] must be rejected");
    }

    #[test]
    fn shape_check_rejects_non_toml() {
        assert!(!is_trusttunnel_client_config("not = = toml ]["), "garbage must be rejected");
    }

    #[test]
    fn shape_check_accepts_real_client_config() {
        // The exact shape build_client_config (ssh/mod.rs) produces: a non-empty
        // top-level [endpoint] table. This MUST be accepted so a legitimate
        // imported config is never wrongly rejected.
        let config = crate::ssh::build_client_config(
            "host = \"1.2.3.4\"\nport = 443\nusername = \"alice\"\npassword = \"secret\"\n",
            "test",
        );
        assert!(
            is_trusttunnel_client_config(&config),
            "a real build_client_config output must be accepted"
        );
    }

    // WR-06: the clipboard import command must reject any valid TOML that is not
    // a client config (was: accepted ANY valid TOML and wrote it verbatim).
    #[tokio::test]
    async fn import_rejects_valid_toml_without_endpoint() {
        let blob = "title = \"random\"\n[whatever]\nx = 1\n".to_string();
        let result = import_config_from_string(blob, "clipboard-toml".into()).await;
        assert!(
            result.is_err(),
            "valid TOML without an [endpoint] table must be rejected at import"
        );
    }
}

/// Percent-decode `input` into a raw byte buffer (CR-01).
///
/// Operates entirely on bytes: a valid `%XX` escape pushes the decoded byte
/// verbatim (including high bytes >= 0x80, which the old String-based decoder
/// corrupted via `byte as char`). An invalid/short `%` escape is preserved
/// literally. This is the correct primitive for a base64 payload, which is
/// binary text — not a Unicode string.
fn urlencoding_decode_bytes(input: &str) -> Vec<u8> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(
                std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""),
                16,
            ) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}
