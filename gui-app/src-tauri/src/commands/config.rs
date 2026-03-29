use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ─── Typed config for validation and defaults ──────────────────

/// Known top-level fields in trusttunnel_client.toml.
/// Unknown keys are preserved via `extra` (C++ binary may use fields the GUI doesn't know).
#[derive(Debug, Deserialize, Serialize)]
#[serde(default)]
pub struct ClientConfig {
    pub loglevel: String,
    pub vpn_mode: String,
    pub killswitch_enabled: bool,
    pub killswitch_allow_ports: Vec<u16>,
    pub post_quantum_group_enabled: bool,
    #[serde(flatten)]
    pub extra: HashMap<String, toml::Value>,
}

impl Default for ClientConfig {
    fn default() -> Self {
        Self {
            loglevel: "info".to_string(),
            vpn_mode: "general".to_string(),
            killswitch_enabled: true,
            killswitch_allow_ports: vec![67, 68],
            post_quantum_group_enabled: true,
            extra: HashMap::new(),
        }
    }
}

impl ClientConfig {
    /// Validate and apply defaults to a parsed config.
    pub fn validate(content: &str) -> Result<Self, String> {
        toml::from_str::<ClientConfig>(content)
            .map_err(|e| format!("Invalid config: {e}"))
    }

    /// Ensure DHCP ports are present in killswitch_allow_ports.
    pub fn ensure_dhcp_ports(&mut self) {
        if !self.killswitch_allow_ports.contains(&67) {
            self.killswitch_allow_ports.push(67);
        }
        if !self.killswitch_allow_ports.contains(&68) {
            self.killswitch_allow_ports.push(68);
        }
    }
}

/// Copy a file to a user-chosen destination (for "Save As" functionality).
#[tauri::command]
pub fn copy_file(source: String, destination: String) -> Result<(), String> {
    std::fs::copy(&source, &destination)
        .map_err(|e| format!("Failed to copy file: {e}"))?;
    Ok(())
}

/// Copy a config file into the app directory (next to the executable).
/// Returns the new path. If the file is already in the app dir, returns it as-is.
#[tauri::command]
pub fn copy_config_to_app_dir(source_path: String) -> Result<String, String> {
    let src = std::path::Path::new(&source_path);
    if !src.exists() {
        return Err(format!("Source file does not exist: {source_path}"));
    }
    let exe = std::env::current_exe().map_err(|e| format!("Cannot find exe path: {e}"))?;
    let app_dir = exe.parent().ok_or("Cannot determine app directory")?;
    let src_dir = src.parent().unwrap_or(std::path::Path::new(""));

    // Already in app dir — no copy needed
    if src_dir == app_dir {
        return Ok(source_path);
    }

    let file_name = src
        .file_name()
        .ok_or("Cannot determine file name")?;
    let dest = app_dir.join(file_name);

    std::fs::copy(src, &dest)
        .map_err(|e| format!("Failed to copy config: {e}"))?;

    Ok(dest.to_string_lossy().to_string())
}

/// Find .toml config files next to the executable
#[tauri::command]
pub fn auto_detect_config() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    for entry in std::fs::read_dir(dir).ok()? {
        if let Ok(e) = entry {
            let path = e.path();
            if path.extension().and_then(|s| s.to_str()) == Some("toml")
                && path.file_name().and_then(|s| s.to_str()) != Some("Cargo.toml")
            {
                // Verify it looks like a trusttunnel config (has [endpoint] or [listener])
                if let Ok(content) = std::fs::read_to_string(&path) {
                    if content.contains("[endpoint]") || content.contains("[listener") {
                        return Some(path.to_string_lossy().to_string());
                    }
                }
            }
        }
    }
    None
}

#[tauri::command]
pub fn read_client_config(config_path: String) -> Result<serde_json::Value, String> {
    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config: {e}"))?;

    // Parse and validate via typed struct (applies defaults for missing fields)
    let mut cfg = match ClientConfig::validate(&content) {
        Ok(c) => c,
        Err(_first_err) => {
            // Attempt recovery: strip malformed exclusions blocks and re-parse
            eprintln!("[config] Parse error: {_first_err}. Attempting recovery...");
            let mut lines: Vec<&str> = Vec::new();
            let mut skip = false;
            for line in content.lines() {
                let t = line.trim();
                if t.starts_with("exclusions") && t.contains('[') {
                    skip = true;
                    continue;
                }
                if skip {
                    if t == "]" { skip = false; continue; }
                    if t.starts_with('"') || t.is_empty() || t.starts_with('#') { continue; }
                    skip = false;
                }
                lines.push(line);
            }
            let fixed = lines.join("\n");
            match ClientConfig::validate(&fixed) {
                Ok(c) => {
                    let _ = std::fs::write(&config_path, &fixed);
                    eprintln!("[config] Recovery successful, fixed config saved");
                    c
                }
                Err(e) => return Err(format!("Failed to parse config: {e}")),
            }
        }
    };

    // Ensure DHCP ports are present
    let had_dhcp = cfg.killswitch_allow_ports.contains(&67);
    cfg.ensure_dhcp_ports();

    // Auto-patch file if DHCP ports were missing
    if !had_dhcp {
        if let Ok(mut doc) = std::fs::read_to_string(&config_path)
            .unwrap_or_default()
            .parse::<toml_edit::DocumentMut>()
        {
            let mut ports = toml_edit::Array::new();
            for p in &cfg.killswitch_allow_ports {
                ports.push(*p as i64);
            }
            doc["killswitch_allow_ports"] = toml_edit::value(ports);
            let _ = std::fs::write(&config_path, doc.to_string());
            eprintln!("[config] Auto-patched: killswitch_allow_ports with DHCP ports");
        }
    }

    // Convert to JSON via serde (typed → json preserves all fields including `extra`)
    serde_json::to_value(&cfg)
        .map_err(|e| format!("Failed to convert: {e}"))
}

#[tauri::command]
pub fn save_client_config(config_path: String, config: serde_json::Value) -> Result<(), String> {
    // Read existing routing keys before overwriting — they are managed by RoutingPanel
    // via resolve_and_apply and must not be lost when SettingsPanel saves.
    let existing_doc: Option<toml_edit::DocumentMut> = std::fs::read_to_string(&config_path)
        .ok()
        .and_then(|c| c.parse::<toml_edit::DocumentMut>().ok());

    // Preserve routing-managed keys
    let existing_exclusions: Vec<String> = existing_doc.as_ref()
        .and_then(|doc| {
            doc.get("exclusions")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        })
        .unwrap_or_default();

    let routing_keys_to_preserve: Vec<(&str, Option<String>)> = {
        let keys = ["exclusions_file", "blocked_file",
                     "process_direct_file", "process_proxy_file", "process_block_file",
                     "vpn_mode"];
        keys.iter().map(|&k| {
            let val = existing_doc.as_ref()
                .and_then(|doc| doc.get(k).and_then(|v| v.as_str()).map(String::from));
            (k, val)
        }).collect()
    };

    // Convert JSON back to toml::Value then serialize
    let toml_val: toml::Value = serde_json::from_value(config)
        .map_err(|e| format!("Failed to convert config: {e}"))?;
    let content = toml::to_string_pretty(&toml_val)
        .map_err(|e| format!("Failed to serialize TOML: {e}"))?;
    std::fs::write(&config_path, &content)
        .map_err(|e| format!("Failed to write config: {e}"))?;

    // Re-apply exclusions and ensure killswitch_allow_ports includes DHCP
    {
        let fresh = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to re-read config: {e}"))?;
        let mut doc: toml_edit::DocumentMut = fresh
            .parse()
            .map_err(|e: toml_edit::TomlError| format!("Failed to re-parse config: {e}"))?;

        if !existing_exclusions.is_empty() {
            let mut arr = toml_edit::Array::new();
            for d in &existing_exclusions {
                arr.push(d.as_str());
            }
            doc["exclusions"] = toml_edit::value(arr);
        }

        // Restore routing file paths managed by RoutingPanel
        for (key, val) in &routing_keys_to_preserve {
            if let Some(v) = val {
                doc[*key] = toml_edit::value(v.as_str());
            }
        }

        // Ensure DHCP ports (67, 68) are always in killswitch_allow_ports
        // so Kill Switch doesn't block DHCP lease renewal
        let mut ports = toml_edit::Array::new();
        ports.push(67);
        ports.push(68);
        doc["killswitch_allow_ports"] = toml_edit::value(ports);

        std::fs::write(&config_path, doc.to_string())
            .map_err(|e| format!("Failed to write config back: {e}"))?;
    }

    Ok(())
}
