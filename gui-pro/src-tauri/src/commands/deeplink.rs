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

    // URL-decode
    let decoded_url = urlencoding_decode(&config_b64.replace('+', " "));

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
        .find_map(|engine| engine.decode(decoded_url.as_bytes()).ok())
        .ok_or_else(|| "Failed to decode base64 config".to_string())?;

    // If it looks like TOML text, use it directly
    if let Ok(text) = String::from_utf8(bytes.clone()) {
        if text.contains("hostname") || text.contains("[endpoint]") || text.contains("username") {
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

/// Import a config string (TOML content) and save it to the app data directory.
#[tauri::command]
pub async fn import_config_from_string(content: String, source: String) -> Result<String, String> {
    // Validate TOML
    let _: toml::Value =
        toml::from_str(&content).map_err(|e| format!("Invalid TOML config: {e}"))?;

    let config_dir = portable_data_dir();
    std::fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create config dir: {e}"))?;

    let config_path = config_dir.join("trusttunnel_client.toml");
    std::fs::write(&config_path, &content)
        .map_err(|e| format!("Failed to write config: {e}"))?;

    eprintln!(
        "[deeplink] Config imported from {source}: {}",
        config_path.display()
    );

    Ok(config_path.to_string_lossy().to_string())
}

fn urlencoding_decode(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut chars = input.chars();
    while let Some(c) = chars.next() {
        if c == '%' {
            let hex: String = chars.by_ref().take(2).collect();
            if let Ok(byte) = u8::from_str_radix(&hex, 16) {
                result.push(byte as char);
            } else {
                result.push('%');
                result.push_str(&hex);
            }
        } else {
            result.push(c);
        }
    }
    result
}
