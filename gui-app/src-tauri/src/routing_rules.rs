use crate::geodata::group_cache_path_pub;
use crate::geodata_v2ray::{self, GeoDataState};
use crate::ssh_deploy::portable_data_dir;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use toml_edit::{value, Array, DocumentMut};

// ─── Data model ─────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuleEntry {
    pub id: String,
    #[serde(rename = "type")]
    pub entry_type: String, // "domain"|"ip"|"cidr"|"geoip"|"geosite"|"iplist_group"
    pub value: String,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoutingRules {
    #[serde(default)]
    pub direct: Vec<RuleEntry>,
    #[serde(default)]
    pub proxy: Vec<RuleEntry>,
    #[serde(default)]
    pub block: Vec<RuleEntry>,
    #[serde(default = "default_process_mode")]
    pub process_mode: String, // "exclude" | "only"
    #[serde(default)]
    pub processes: Vec<String>,
}

fn default_process_mode() -> String {
    "exclude".to_string()
}

impl Default for RoutingRules {
    fn default() -> Self {
        Self {
            direct: Vec::new(),
            proxy: Vec::new(),
            block: Vec::new(),
            process_mode: "exclude".to_string(),
            processes: Vec::new(),
        }
    }
}

// ─── File paths ─────────────────────────────────────

fn routing_rules_path() -> PathBuf {
    portable_data_dir().join("routing_rules.json")
}

fn resolved_dir() -> PathBuf {
    let dir = portable_data_dir().join("resolved");
    std::fs::create_dir_all(&dir).ok();
    dir
}

fn exclusions_file_path() -> PathBuf {
    resolved_dir().join("exclusions.txt")
}

fn blocked_file_path() -> PathBuf {
    resolved_dir().join("blocked.txt")
}

fn process_direct_file_path() -> PathBuf {
    resolved_dir().join("process_direct.txt")
}

fn process_proxy_file_path() -> PathBuf {
    resolved_dir().join("process_proxy.txt")
}

fn process_block_file_path() -> PathBuf {
    resolved_dir().join("process_block.txt")
}

// ─── Tauri commands ─────────────────────────────────

#[tauri::command]
pub fn load_routing_rules() -> Result<RoutingRules, String> {
    let path = routing_rules_path();
    match std::fs::read_to_string(&path) {
        Ok(content) => {
            let rules: RoutingRules = serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse routing_rules.json: {e}"))?;
            eprintln!(
                "[routing] Loaded: {} direct, {} proxy, {} block, {} processes (mode={})",
                rules.direct.len(), rules.proxy.len(), rules.block.len(),
                rules.processes.len(), rules.process_mode
            );
            Ok(rules)
        }
        Err(_) => {
            eprintln!("[routing] No routing_rules.json found, returning defaults");
            Ok(RoutingRules::default())
        }
    }
}

#[tauri::command]
pub fn save_routing_rules(rules: RoutingRules) -> Result<(), String> {
    let path = routing_rules_path();
    let json = serde_json::to_string_pretty(&rules)
        .map_err(|e| format!("Failed to serialize: {e}"))?;
    std::fs::write(&path, &json)
        .map_err(|e| format!("Failed to write routing_rules.json: {e}"))?;
    eprintln!(
        "[routing] Saved: {} direct, {} proxy, {} block, {} processes",
        rules.direct.len(), rules.proxy.len(), rules.block.len(), rules.processes.len()
    );
    Ok(())
}

#[tauri::command]
pub async fn export_routing_rules(
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let path = routing_rules_path();
    if !path.exists() {
        return Err("No routing rules to export".into());
    }

    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read routing_rules.json: {e}"))?;

    // Use Tauri dialog to pick save location
    let file_path = app.dialog()
        .file()
        .set_file_name("routing_rules.json")
        .add_filter("JSON", &["json"])
        .blocking_save_file();

    if let Some(fp) = file_path {
        let target = fp.as_path().ok_or("Invalid file path")?;
        std::fs::write(target, &content)
            .map_err(|e| format!("Failed to export: {e}"))?;
        eprintln!("[routing] Exported to {}", target.display());
        Ok(Some(target.display().to_string()))
    } else {
        Ok(None) // User cancelled
    }
}

#[tauri::command]
pub async fn import_routing_rules(
    app: tauri::AppHandle,
) -> Result<Option<RoutingRules>, String> {
    use tauri_plugin_dialog::DialogExt;

    let file_path = app.dialog()
        .file()
        .add_filter("JSON", &["json"])
        .blocking_pick_file();

    if let Some(fp) = file_path {
        let path = fp.as_path().ok_or("Invalid file path")?;
        let content = std::fs::read_to_string(path)
            .map_err(|e| format!("Failed to read file: {e}"))?;
        let rules: RoutingRules = serde_json::from_str(&content)
            .map_err(|e| format!("Invalid routing rules format: {e}"))?;

        // Save imported rules
        save_routing_rules(rules.clone())?;
        eprintln!("[routing] Imported from {}", path.display());
        Ok(Some(rules))
    } else {
        Ok(None) // User cancelled
    }
}

#[tauri::command]
pub fn migrate_legacy_exclusions(config_path: String) -> Result<RoutingRules, String> {
    // Check if routing_rules.json already exists
    if routing_rules_path().exists() {
        return load_routing_rules();
    }

    let mut rules = RoutingRules::default();

    // Try loading from exclusions.json backup
    let exclusions_json = portable_data_dir().join("exclusions.json");
    let mut domains: Vec<String> = if let Ok(content) = std::fs::read_to_string(&exclusions_json) {
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        Vec::new()
    };

    // If no JSON backup, try loading from TOML config
    if domains.is_empty() && !config_path.is_empty() {
        if let Ok(content) = std::fs::read_to_string(&config_path) {
            if let Ok(doc) = content.parse::<DocumentMut>() {
                if let Some(arr) = doc.get("exclusions").and_then(|v| v.as_array()) {
                    domains = arr.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect();
                }
            }
        }
    }

    if !domains.is_empty() {
        eprintln!("[routing] Migrating {} legacy exclusions to routing_rules.json", domains.len());

        // Determine VPN mode from config to decide which block to put entries in
        let vpn_mode = if !config_path.is_empty() {
            std::fs::read_to_string(&config_path)
                .ok()
                .and_then(|c| c.parse::<DocumentMut>().ok())
                .and_then(|doc| doc.get("vpn_mode").and_then(|v| v.as_str()).map(String::from))
                .unwrap_or_else(|| "general".to_string())
        } else {
            "general".to_string()
        };

        let entries: Vec<RuleEntry> = domains.iter().map(|d| {
            let entry_type = if d.contains('/') {
                "cidr"
            } else if d.parse::<std::net::IpAddr>().is_ok() {
                "ip"
            } else {
                "domain"
            };
            RuleEntry {
                id: uuid_v4(),
                entry_type: entry_type.to_string(),
                value: d.clone(),
                label: None,
            }
        }).collect();

        // In general mode, exclusions = direct bypass
        // In selective mode, exclusions = proxy through VPN
        if vpn_mode == "selective" {
            rules.proxy = entries;
        } else {
            rules.direct = entries;
        }

        save_routing_rules(rules.clone())?;
    }

    Ok(rules)
}

/// Resolve all rules and generate config files for sidecar
#[tauri::command]
pub async fn resolve_and_apply(
    config_path: String,
    rules: RoutingRules,
    state: tauri::State<'_, Arc<GeoDataState>>,
) -> Result<(), String> {
    eprintln!("[routing] Resolving rules and generating config files...");

    // Save rules first
    save_routing_rules(rules.clone())?;

    // Resolve direct entries
    let direct_entries = resolve_entries(&rules.direct, &state)?;
    // Resolve proxy entries (these also go to exclusions in selective mode)
    let proxy_entries = resolve_entries(&rules.proxy, &state)?;
    // Resolve blocked entries
    let blocked_entries = resolve_entries(&rules.block, &state)?;

    // Determine vpn_mode
    // If user has both direct and proxy entries, use general mode
    // (direct = exclusions, proxy = covered by default tunnel behavior)
    let has_direct = !direct_entries.is_empty();
    let has_proxy = !proxy_entries.is_empty();

    let vpn_mode = if has_proxy && !has_direct {
        "selective" // Only proxy entries → selective mode (only listed goes through VPN)
    } else {
        "general" // Default: everything through VPN except direct entries
    };

    // Build exclusions file content
    let exclusions_content = if vpn_mode == "selective" {
        // In selective mode, proxy entries are the "exclusions" (what goes through VPN)
        proxy_entries.join("\n")
    } else {
        // In general mode, direct entries are the "exclusions" (what bypasses VPN)
        direct_entries.join("\n")
    };

    // Build blocked file content — also resolve domains to IPs for CONNECT-level blocking
    let mut blocked_with_ips = blocked_entries.clone();
    for entry in &blocked_entries {
        // If it's a domain (not IP/CIDR), resolve it to IPs
        if !entry.contains('/') && entry.parse::<std::net::IpAddr>().is_err() {
            if let Ok(addrs) = std::net::ToSocketAddrs::to_socket_addrs(&(entry.as_str(), 80)) {
                for addr in addrs {
                    let ip = addr.ip().to_string();
                    if !blocked_with_ips.contains(&ip) {
                        eprintln!("[routing] Resolved blocked domain {} -> {}", entry, ip);
                        blocked_with_ips.push(ip);
                    }
                }
            }
        }
    }
    let blocked_content = blocked_with_ips.join("\n");

    // Write resolved files
    std::fs::write(exclusions_file_path(), &exclusions_content)
        .map_err(|e| format!("Failed to write exclusions.txt: {e}"))?;
    std::fs::write(blocked_file_path(), &blocked_content)
        .map_err(|e| format!("Failed to write blocked.txt: {e}"))?;

    eprintln!(
        "[routing] Written: exclusions={} entries, blocked={} entries, mode={}",
        exclusions_content.lines().filter(|l| !l.is_empty()).count(),
        blocked_content.lines().filter(|l| !l.is_empty()).count(),
        vpn_mode
    );

    // Process filter files
    let (process_direct, process_proxy, process_block) = resolve_process_rules(&rules);
    std::fs::write(process_direct_file_path(), process_direct.join("\n"))
        .map_err(|e| format!("Failed to write process_direct.txt: {e}"))?;
    std::fs::write(process_proxy_file_path(), process_proxy.join("\n"))
        .map_err(|e| format!("Failed to write process_proxy.txt: {e}"))?;
    std::fs::write(process_block_file_path(), process_block.join("\n"))
        .map_err(|e| format!("Failed to write process_block.txt: {e}"))?;

    if !rules.processes.is_empty() {
        eprintln!(
            "[routing] Process rules: {} processes, mode={}",
            rules.processes.len(), rules.process_mode
        );
    }

    // Build the exclusions list for TOML inline array
    let exclusions_for_toml: Vec<String> = if vpn_mode == "selective" {
        proxy_entries.clone()
    } else {
        direct_entries.clone()
    };

    // Update TOML config with inline arrays + file paths
    if !config_path.is_empty() {
        update_toml_config(&config_path, vpn_mode, &exclusions_for_toml, &blocked_entries)?;
    }

    Ok(())
}

/// Resolve a list of rule entries into flat domain/IP/CIDR strings
fn resolve_entries(
    entries: &[RuleEntry],
    state: &GeoDataState,
) -> Result<Vec<String>, String> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();

    for entry in entries {
        let resolved = match entry.entry_type.as_str() {
            "domain" | "ip" | "cidr" => {
                vec![entry.value.clone()]
            }
            "geoip" => {
                // value = "geoip:ru" → category = "ru"
                let category = entry.value
                    .strip_prefix("geoip:")
                    .unwrap_or(&entry.value);
                match geodata_v2ray::resolve_geoip(state, category) {
                    Ok(cidrs) => cidrs,
                    Err(e) => {
                        eprintln!("[routing] Предупреждение: не удалось резолвить geoip:{} — {}. Пропускаю.", category, e);
                        Vec::new()
                    }
                }
            }
            "geosite" => {
                // value = "geosite:discord" → category = "discord"
                let category = entry.value
                    .strip_prefix("geosite:")
                    .unwrap_or(&entry.value);
                match geodata_v2ray::resolve_geosite(state, category) {
                    Ok(domains) => domains,
                    Err(e) => {
                        eprintln!("[routing] Предупреждение: не удалось резолвить geosite:{} — {}. Пропускаю.", category, e);
                        Vec::new()
                    }
                }
            }
            "iplist_group" => {
                // Load from cached group data
                let cache_path = group_cache_path_pub(&entry.value);
                if cache_path.exists() {
                    let content = std::fs::read_to_string(&cache_path)
                        .map_err(|e| format!("Failed to read group cache '{}': {e}", entry.value))?;
                    let domains: Vec<String> = serde_json::from_str(&content)
                        .map_err(|e| format!("Failed to parse group cache '{}': {e}", entry.value))?;
                    domains
                } else {
                    eprintln!("[routing] Warning: no cache for iplist group '{}', skipping", entry.value);
                    Vec::new()
                }
            }
            _ => {
                eprintln!("[routing] Unknown entry type '{}', treating as domain", entry.entry_type);
                vec![entry.value.clone()]
            }
        };

        for item in resolved {
            if seen.insert(item.clone()) {
                result.push(item);
            }
        }
    }

    Ok(result)
}

/// Determine process filter files based on process_mode
fn resolve_process_rules(rules: &RoutingRules) -> (Vec<String>, Vec<String>, Vec<String>) {
    let mut direct = Vec::new();
    let mut proxy = Vec::new();
    let block = Vec::new(); // No UI for blocking processes yet, but supported

    if rules.processes.is_empty() {
        return (direct, proxy, block);
    }

    match rules.process_mode.as_str() {
        "exclude" => {
            // Exclude these processes from VPN → they go direct
            direct = rules.processes.clone();
        }
        "only" => {
            // Only these processes go through VPN → they go proxy
            proxy = rules.processes.clone();
        }
        _ => {
            eprintln!("[routing] Unknown process_mode '{}', defaulting to exclude", rules.process_mode);
            direct = rules.processes.clone();
        }
    }

    (direct, proxy, block)
}

/// Update TOML config with resolved routing rules
/// Uses BOTH inline arrays AND file paths for compatibility with old and new binaries
fn update_toml_config(
    config_path: &str,
    vpn_mode: &str,
    exclusions: &[String],
    blocked: &[String],
) -> Result<(), String> {
    let content = std::fs::read_to_string(config_path)
        .map_err(|e| format!("Failed to read config: {e}"))?;
    let mut doc: DocumentMut = content
        .parse()
        .map_err(|e: toml_edit::TomlError| format!("Failed to parse config: {e}"))?;

    // Set vpn_mode
    doc["vpn_mode"] = value(vpn_mode);

    // Write exclusions INLINE in TOML array (works with ALL binary versions)
    let mut exc_arr = Array::new();
    for entry in exclusions {
        exc_arr.push(entry.as_str());
    }
    doc["exclusions"] = value(exc_arr);

    // Remove any file-based fields that old binaries don't support
    doc.remove("blocked");
    doc.remove("exclusions_file");
    doc.remove("blocked_file");
    doc.remove("process_direct_file");
    doc.remove("process_proxy_file");
    doc.remove("process_block_file");

    std::fs::write(config_path, doc.to_string())
        .map_err(|e| format!("Failed to write config: {e}"))?;

    eprintln!(
        "[routing] TOML updated: vpn_mode={}, exclusions={} inline, blocked={} inline",
        vpn_mode, exclusions.len(), blocked.len()
    );
    Ok(())
}

/// Simple UUID v4 generator (no external dependency)
fn uuid_v4() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    // Not cryptographically secure, but fine for UI keys
    let r = t ^ (t >> 17) ^ (t << 13);
    format!(
        "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        (r & 0xFFFFFFFF) as u32,
        ((r >> 32) & 0xFFFF) as u16,
        ((r >> 48) & 0x0FFF) as u16,
        (((r >> 60) & 0x3F) | 0x80) as u16 | (((r >> 66) & 0xFF) as u16) << 8,
        (r >> 74) & 0xFFFFFFFFFFFF,
    )
}
