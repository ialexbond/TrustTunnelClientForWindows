use crate::portable_data_dir;

/// Decode a trusttunnel:// deeplink URL and return the TOML config content.
/// Format: trusttunnel://import?config=BASE64_ENCODED_TOML
#[tauri::command]
pub async fn decode_deeplink(url: String) -> Result<String, String> {
    let trimmed = url.trim();

    // Strip protocol prefix and any extra slashes
    let after_proto = if let Some(rest) = trimmed.strip_prefix("trusttunnel://") {
        rest.trim_start_matches('/')
    } else if let Some(rest) = trimmed.strip_prefix("tt://") {
        rest.trim_start_matches('/')
    } else {
        return Err("Invalid deeplink: must start with trusttunnel:// or tt://".into());
    };

    // Parse: try multiple deeplink formats
    // Format 1: tt://?config=BASE64
    // Format 2: tt://?BASE64  (raw base64 after ?)
    // Format 3: tt://BASE64   (raw base64 as path)
    // Format 4: trusttunnel://import?config=BASE64
    let config_b64 = if let Some(query) = after_proto.split('?').nth(1) {
        // Has query string — try config= param first, then raw query
        query
            .split('&')
            .find_map(|p| p.strip_prefix("config="))
            .unwrap_or(query)
    } else {
        // No query — entire path is the base64 config
        after_proto
    };

    // URL-decode (+ → space, %XX → char)
    let decoded_url = config_b64.replace('+', " ");
    let decoded_url = urlencoding_decode(&decoded_url);

    // Base64 decode — try all variants (standard, URL-safe, with/without padding)
    use base64::Engine;
    let engines: &[base64::engine::GeneralPurpose] = &[
        base64::engine::general_purpose::STANDARD,
        base64::engine::general_purpose::URL_SAFE,
        base64::engine::general_purpose::STANDARD_NO_PAD,
        base64::engine::general_purpose::URL_SAFE_NO_PAD,
    ];

    let mut bytes: Option<Vec<u8>> = None;
    for engine in engines {
        if let Ok(decoded) = engine.decode(decoded_url.as_bytes()) {
            bytes = Some(decoded);
            break;
        }
    }
    let bytes = bytes.ok_or_else(|| "Failed to decode base64 config".to_string())?;

    // TrustTunnel deeplinks can be either:
    // 1. TOML text (base64-encoded)
    // 2. Binary protocol format (starts with non-text bytes)
    // Try UTF-8 first; if it looks like TOML, use it directly
    if let Ok(text) = String::from_utf8(bytes.clone()) {
        if text.contains("hostname") || text.contains("[endpoint]") || text.contains("username") {
            return Ok(text);
        }
    }

    // Binary format: TrustTunnel proprietary deeplink encoding
    // Parse binary fields: each field is [type_byte][length_byte][data...]
    let mut pos = 0;
    let data = &bytes;
    let mut hostname = String::new();
    let mut username = String::new();
    let mut password = String::new();
    let mut address = String::new();

    while pos < data.len() {
        if pos + 2 > data.len() { break; }
        let field_type = data[pos];
        let field_len = data[pos + 1] as usize;
        pos += 2;
        if pos + field_len > data.len() { break; }
        let value = String::from_utf8_lossy(&data[pos..pos + field_len]).to_string();
        pos += field_len;

        match field_type {
            0x01 => hostname = value,
            0x02 => address = value,
            0x05 => username = value,
            0x06 => password = value,
            _ => {} // skip unknown fields
        }
    }

    if hostname.is_empty() && address.is_empty() {
        return Err("Could not parse deeplink: no hostname or address found".into());
    }

    // If address has host:port but hostname is empty, use address host
    if hostname.is_empty() && !address.is_empty() {
        hostname = address.split(':').next().unwrap_or(&address).to_string();
    }

    // Build addresses array
    let addr = if address.is_empty() {
        format!("{}:443", hostname)
    } else {
        address.clone()
    };

    // Generate TOML config
    let toml_config = format!(
        r#"# TrustTunnel Client Configuration
# Imported from deeplink

loglevel = "info"
vpn_mode = "general"
killswitch_enabled = true
killswitch_allow_ports = [67, 68]
post_quantum_group_enabled = true

[endpoint]
hostname = "{hostname}"
addresses = ["{addr}"]
username = "{username}"
password = "{password}"
upstream_protocol = "http2"
anti_dpi = true
skip_verification = false
custom_sni = ""
has_ipv6 = true

[listener.tun]
mtu_size = 1280
change_system_dns = true
included_routes = ["0.0.0.0/0"]
excluded_routes = []
"#
    );

    Ok(toml_config)
}

/// Import a config string (TOML content) and save it to the app data directory.
#[tauri::command]
pub async fn import_config_from_string(content: String, source: String) -> Result<String, String> {
    // Validate TOML
    let _: toml::Value = toml::from_str(&content)
        .map_err(|e| format!("Invalid TOML config: {e}"))?;

    let config_dir = portable_data_dir();
    std::fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create config dir: {e}"))?;

    let config_path = config_dir.join("trusttunnel_client.toml");
    std::fs::write(&config_path, &content)
        .map_err(|e| format!("Failed to write config: {e}"))?;

    eprintln!("[deeplink] Config imported from {source}: {}", config_path.display());

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
