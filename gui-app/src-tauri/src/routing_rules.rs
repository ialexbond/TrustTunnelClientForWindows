use crate::geodata::group_cache_path_pub;
use crate::geodata_v2ray::{self, GeoDataState};
use crate::ssh::portable_data_dir;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use toml_edit::{value, Array, DocumentMut};
use uuid::Uuid;

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
                id: Uuid::new_v4().to_string(),
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

/// Core logic: resolve all rules and generate config files for sidecar.
/// Called both from the Tauri command and from vpn_connect before sidecar spawn.
pub fn resolve_and_apply_inner(
    config_path: &str,
    rules: &RoutingRules,
    state: &GeoDataState,
) -> Result<(), String> {
    eprintln!("[routing] Resolving rules and generating config files...");

    // Resolve direct entries
    let direct_entries = resolve_entries(&rules.direct, state)?;
    // Resolve proxy entries (these also go to exclusions in selective mode)
    let proxy_entries = resolve_entries(&rules.proxy, state)?;
    // Resolve blocked entries
    let blocked_entries = resolve_entries(&rules.block, state)?;

    // Read the vpn_mode chosen by the user in Settings (don't override it!)
    let vpn_mode = if !config_path.is_empty() {
        std::fs::read_to_string(config_path)
            .ok()
            .and_then(|c| c.parse::<DocumentMut>().ok())
            .and_then(|doc| doc.get("vpn_mode").and_then(|v| v.as_str()).map(String::from))
            .unwrap_or_else(|| "general".to_string())
    } else {
        "general".to_string()
    };

    // Build exclusions file content based on vpn_mode:
    // - "general": everything through VPN, EXCEPT direct entries (they bypass)
    //   → exclusions = direct entries
    // - "selective": everything direct, EXCEPT proxy entries (they go through VPN)
    //   → exclusions = proxy entries
    let exclusions_content = if vpn_mode == "selective" {
        proxy_entries.iter()
    } else {
        direct_entries.iter()
    }
    .filter(|e| !e.is_empty())
    .cloned()
    .collect::<Vec<_>>()
    .join("\n");

    // Build blocked file content — domains/IPs/CIDRs for C++ core DNS-level blocking.
    // No DNS resolution needed — the VPN core blocks at DNS query level (match_domain).
    let blocked_content = blocked_entries.iter()
        .filter(|e| !e.is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join("\n");

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
    let (process_direct, process_proxy, process_block) = resolve_process_rules(rules);
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

    // Build the exclusions list (same as file content, used for logging)
    let exclusions_for_toml: Vec<String> = if vpn_mode == "selective" {
        proxy_entries.clone()
    } else {
        direct_entries.clone()
    };

    // Update TOML config — preserve vpn_mode from Settings, write file paths
    if !config_path.is_empty() {
        update_toml_config(config_path, &vpn_mode, &exclusions_for_toml, &blocked_entries)?;
    }

    // Blocking is handled at VPN core DNS level (dns_handler.cpp) — no hosts file needed

    Ok(())
}

/// Resolve all rules and generate config files for sidecar (Tauri command wrapper)
#[tauri::command]
pub async fn resolve_and_apply(
    config_path: String,
    rules: RoutingRules,
    state: tauri::State<'_, Arc<GeoDataState>>,
) -> Result<(), String> {
    // Save rules first
    save_routing_rules(rules.clone())?;

    resolve_and_apply_inner(&config_path, &rules, state.as_ref())
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
                        eprintln!("[routing] Warning: failed to resolve geoip:{} — {}. Skipping.", category, e);
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
                        eprintln!("[routing] Warning: failed to resolve geosite:{} — {}. Skipping.", category, e);
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

/// Update TOML config with resolved routing rules.
/// Uses file paths for exclusions and blocked lists (C++ core reads from files).
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

    // Exclusions: empty inline array + file path (avoids duplication, C++ core reads both)
    // Use forward slashes to avoid TOML escaping issues with backslashes on Windows
    doc["exclusions"] = value(Array::new());
    doc["exclusions_file"] = value(exclusions_file_path().to_string_lossy().replace('\\', "/"));

    // Blocked: file-based only (C++ core only supports blocked_file, not inline blocked)
    doc.remove("blocked");
    if !blocked.is_empty() {
        doc["blocked_file"] = value(blocked_file_path().to_string_lossy().replace('\\', "/"));
    } else {
        doc.remove("blocked_file");
    }

    // Process filter files: write paths if files have content
    let process_files: [(&str, PathBuf); 3] = [
        ("process_direct_file", process_direct_file_path()),
        ("process_proxy_file", process_proxy_file_path()),
        ("process_block_file", process_block_file_path()),
    ];
    for (key, path) in &process_files {
        let has_content = path.exists()
            && std::fs::read_to_string(path)
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);
        if has_content {
            doc[*key] = value(path.to_string_lossy().replace('\\', "/"));
        } else {
            doc.remove(*key);
        }
    }

    std::fs::write(config_path, doc.to_string())
        .map_err(|e| format!("Failed to write config: {e}"))?;

    eprintln!(
        "[routing] TOML updated: vpn_mode={}, exclusions_file={}, blocked_file={}",
        vpn_mode,
        exclusions.len(),
        if blocked.is_empty() { "none" } else { "set" }
    );
    Ok(())
}

/// Update vpn_mode in TOML config without touching other fields
#[tauri::command]
pub fn update_vpn_mode(config_path: String, mode: String) -> Result<(), String> {
    if config_path.is_empty() {
        return Err("No config path".into());
    }
    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config: {e}"))?;
    let mut doc: DocumentMut = content
        .parse()
        .map_err(|e: toml_edit::TomlError| format!("Failed to parse config: {e}"))?;

    doc["vpn_mode"] = value(mode.as_str());

    std::fs::write(&config_path, doc.to_string())
        .map_err(|e| format!("Failed to write config: {e}"))?;

    eprintln!("[routing] vpn_mode updated to: {}", mode);
    Ok(())
}

// ─── Hosts file blocking ────────────────────────────

const HOSTS_MARKER_BEGIN: &str = "# >>> TrustTunnel-blocked BEGIN";
const HOSTS_MARKER_END: &str = "# >>> TrustTunnel-blocked END";

fn hosts_file_path() -> PathBuf {
    PathBuf::from(r"C:\Windows\System32\drivers\etc\hosts")
}

/// Add blocked domains to Windows hosts file (0.0.0.0 → blocks at OS level)
fn apply_hosts_block(domains: &[String]) -> Result<(), String> {
    // First clean any existing entries
    cleanup_hosts_block_inner()?;

    if domains.is_empty() {
        return Ok(());
    }

    // Deduplicate domain names (skip IPs, CIDRs — hosts file only handles domains)
    let mut domain_set = HashSet::new();
    for d in domains {
        let d = d.trim();
        if d.is_empty() || d.contains('/') || d.parse::<std::net::IpAddr>().is_ok() {
            continue;
        }
        domain_set.insert(d.to_lowercase());
    }

    if domain_set.is_empty() {
        return Ok(());
    }

    let mut block = String::new();
    block.push_str("\n");
    block.push_str(HOSTS_MARKER_BEGIN);
    block.push_str("\n");
    for domain in &domain_set {
        block.push_str(&format!("0.0.0.0 {domain}\n"));
        block.push_str(&format!("::0 {domain}\n"));
    }
    block.push_str(HOSTS_MARKER_END);
    block.push_str("\n");

    let hosts = hosts_file_path();
    let existing = std::fs::read_to_string(&hosts)
        .unwrap_or_default();

    let mut content = existing;
    content.push_str(&block);

    std::fs::write(&hosts, &content)
        .map_err(|e| format!("Failed to write hosts file: {e}"))?;

    eprintln!("[routing] Hosts file: blocked {} domains", domain_set.len());
    Ok(())
}

fn cleanup_hosts_block_inner() -> Result<(), String> {
    let hosts = hosts_file_path();
    let content = match std::fs::read_to_string(&hosts) {
        Ok(c) => c,
        Err(_) => return Ok(()), // No hosts file = nothing to clean
    };

    if !content.contains(HOSTS_MARKER_BEGIN) {
        return Ok(());
    }

    let mut result = String::with_capacity(content.len());
    let mut skip = false;
    for line in content.lines() {
        if line.trim() == HOSTS_MARKER_BEGIN {
            skip = true;
            continue;
        }
        if line.trim() == HOSTS_MARKER_END {
            skip = false;
            continue;
        }
        if !skip {
            result.push_str(line);
            result.push('\n');
        }
    }

    // Remove trailing empty lines we may have added
    let trimmed = result.trim_end_matches('\n');
    let mut final_content = trimmed.to_string();
    if !final_content.is_empty() {
        final_content.push('\n');
    }

    std::fs::write(&hosts, &final_content)
        .map_err(|e| format!("Failed to clean hosts file: {e}"))?;

    eprintln!("[routing] Hosts file: cleaned TrustTunnel entries");
    Ok(())
}

/// Public cleanup — called on VPN disconnect and app exit
#[tauri::command]
pub fn cleanup_hosts_block() -> Result<(), String> {
    cleanup_hosts_block_inner()
}

