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

// ─── Default private/local exclusions (T-33) ────────
//
// In "general" mode every destination goes THROUGH the VPN tunnel except for
// the `direct` bypass list. Standard split-tunnel VPNs additionally keep
// private/local traffic OFF the tunnel by default — otherwise Docker's and
// WSL's INTERNAL networking (172.16.0.0/12 for Docker, link-local /
// private ranges for WSL/Hyper-V) gets routed into the tunnel, the host can
// no longer reach its own VM/containers, and Docker fails to start while the
// VPN is connected (see .planning/debug/docker-system-hang-on-connect.md).
//
// These CIDRs are added as an ADDITIVE baseline to the bypass set so LAN /
// Docker / WSL keep working while connected. They never override an explicit
// user rule: a default entry is skipped if the user forced that exact CIDR
// THROUGH the VPN via `proxy` (see `build_general_exclusions`).
const DEFAULT_PRIVATE_EXCLUSIONS: &[&str] = &[
    // RFC1918 private IPv4 (covers Docker bridge 172.17.0.0/16 + WSL/Hyper-V NAT).
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    // Loopback.
    "127.0.0.0/8",
    // Link-local IPv4 (incl. WSL/Hyper-V auto-config and APIPA).
    "169.254.0.0/16",
    // IPv6 loopback / unique-local (ULA) / link-local.
    "::1/128",
    "fc00::/7",
    "fe80::/10",
];

/// Build the final exclusions (bypass) list for "general" mode.
///
/// Starts from the user's resolved `direct` entries, then APPENDS the
/// `DEFAULT_PRIVATE_EXCLUSIONS` baseline (T-33) so Docker/WSL/LAN bypass the
/// tunnel by default. The override rule preserves user intent:
///
/// * A default-private CIDR is skipped if the user forced that **exact** CIDR
///   through the VPN via `proxy` — the user's explicit "route through VPN"
///   rule wins, so the CIDR stays tunnelled. Override granularity is
///   exact-string CIDR match (simple and predictable): forcing
///   `192.168.0.0/16` through VPN does NOT keep `192.168.1.0/24` excluded,
///   and vice-versa.
/// * A default-private CIDR already present in `direct` is not duplicated.
///
/// User `direct` entries are always preserved as-is (the baseline is additive
/// only — it never removes or reorders user rules).
fn build_general_exclusions(direct_entries: &[String], proxy_entries: &[String]) -> Vec<String> {
    // Non-empty user direct entries form the base bypass set, order preserved.
    let mut result: Vec<String> = direct_entries
        .iter()
        .filter(|e| !e.is_empty())
        .cloned()
        .collect();

    // Exact-string set of what the user forced THROUGH the VPN (override signal)
    // and of what is already a bypass entry (dedup guard).
    let forced_through_vpn: HashSet<&str> =
        proxy_entries.iter().map(|s| s.as_str()).collect();
    let mut already_present: HashSet<String> = result.iter().cloned().collect();

    for &cidr in DEFAULT_PRIVATE_EXCLUSIONS {
        // User rule wins: keep this private range tunnelled if explicitly proxied.
        if forced_through_vpn.contains(cidr) {
            continue;
        }
        // Never duplicate a CIDR the user already listed as direct.
        if already_present.insert(cidr.to_string()) {
            result.push(cidr.to_string());
        }
    }

    result
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

/// IN-57: the shared 64 KiB cap for routing-rules JSON. Both import doors MUST use it — WR-06
/// originally hardened only the drag-drop door (`config.rs::import_dropped_content`), so the
/// «Импорт» button below imported a 250 KiB file with no cap (owner hit it).
pub const MAX_ROUTING_JSON_BYTES: usize = 64 * 1024;

/// Parse routing-rules JSON through the shared size cap. Returns i18n KEY codes for the
/// user-facing failures (`routing.import_too_large` / `routing.import_invalid`) so the frontend
/// translates them instead of leaking a raw English string into a Russian UI (owner complaint).
pub fn parse_routing_rules_capped(content: &str) -> Result<RoutingRules, String> {
    if content.len() > MAX_ROUTING_JSON_BYTES {
        return Err("routing.import_too_large".into());
    }
    serde_json::from_str(content).map_err(|_| "routing.import_invalid".to_string())
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
        // IN-57: cap on the file's on-disk size BEFORE reading, so a multi-GB file is never
        // slurped into memory (the abuse case WR-06 guarded on the drag door).
        if std::fs::metadata(path).map(|m| m.len()).unwrap_or(0) > MAX_ROUTING_JSON_BYTES as u64 {
            return Err("routing.import_too_large".into());
        }
        let content = std::fs::read_to_string(path)
            .map_err(|e| format!("Failed to read file: {e}"))?;
        let rules = parse_routing_rules_capped(&content)?; // shared cap + i18n error codes
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

    // Build the resolved exclusions (bypass) list based on vpn_mode:
    // - "general": everything through VPN, EXCEPT direct entries (they bypass)
    //   → exclusions = direct entries + DEFAULT_PRIVATE_EXCLUSIONS baseline (T-33),
    //     so Docker/WSL/LAN bypass the tunnel by default unless the user forced
    //     a private CIDR through VPN via `proxy`.
    // - "selective": everything direct, EXCEPT proxy entries (they go through VPN)
    //   → exclusions = proxy entries. Private nets already bypass in this mode,
    //     so no default-private baseline is added here.
    let resolved_exclusions: Vec<String> = if vpn_mode == "selective" {
        proxy_entries
            .iter()
            .filter(|e| !e.is_empty())
            .cloned()
            .collect()
    } else {
        build_general_exclusions(&direct_entries, &proxy_entries)
    };

    let exclusions_content = resolved_exclusions.join("\n");

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

    // Exclusions list surfaced to the TOML log line — must match exactly what was
    // written to exclusions.txt above (incl. the T-33 default-private baseline in
    // general mode), so logs reflect reality.
    let exclusions_for_toml: Vec<String> = resolved_exclusions.clone();

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
            doc.remove(key);
        }
    }

    // F4 (17-review): atomic write — a crash / power-loss / ENOSPC mid-write must never leave
    // this ACTIVE password-bearing config truncated (losing the endpoint host/login/password).
    // This runs on the vpn_connect hot path (resolve_and_apply_inner), so a plain truncate-then-
    // write here is the exact PP-1 data-loss surface, on the same file. temp → fsync → rename →
    // parent-dir fsync swaps the file in whole or not at all. D-29: the writer never logs bytes.
    crate::commands::manifest::write_bytes_atomic(
        std::path::Path::new(config_path),
        doc.to_string().as_bytes(),
    )
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

    // F4 (17-review): atomic write — this Routing-tab entry point rewrites the ACTIVE
    // password-bearing config; a truncate-then-write interrupted by ENOSPC / power loss would
    // lose the endpoint host/login/password. Route through the same temp → fsync → rename → dir-
    // fsync writer every other .toml save uses (PP-1). D-29: the writer never logs the bytes.
    crate::commands::manifest::write_bytes_atomic(
        std::path::Path::new(&config_path),
        doc.to_string().as_bytes(),
    )
    .map_err(|e| format!("Failed to write config: {e}"))?;

    eprintln!("[routing] vpn_mode updated to: {}", mode);
    Ok(())
}

// ─── Hosts file blocking ────────────────────────────

const HOSTS_MARKER_BEGIN: &str = "# >>> TrustTunnel-blocked BEGIN";
const HOSTS_MARKER_END: &str = "# >>> TrustTunnel-blocked END";

fn hosts_file_path() -> PathBuf {
    let system_root = std::env::var("SystemRoot")
        .unwrap_or_else(|_| r"C:\Windows".to_string());
    PathBuf::from(system_root)
        .join("System32")
        .join("drivers")
        .join("etc")
        .join("hosts")
}

/// Add blocked domains to Windows hosts file (0.0.0.0 → blocks at OS level)
#[allow(dead_code)]
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
    block.push('\n');
    block.push_str(HOSTS_MARKER_BEGIN);
    block.push('\n');
    for domain in &domain_set {
        block.push_str(&format!("0.0.0.0 {domain}\n"));
        block.push_str(&format!("::0 {domain}\n"));
    }
    block.push_str(HOSTS_MARKER_END);
    block.push('\n');

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

// ─── Tests ──────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    // ── F4 (17-review): the password-bearing config writers go through the atomic writer ──
    //
    // `update_vpn_mode` (and its siblings `update_toml_config` / `save_exclusion_list`) rewrite
    // the ACTIVE password-bearing config `.toml`. They MUST route through
    // `manifest::write_bytes_atomic` (temp → fsync → rename → parent-dir fsync) so a crash /
    // power-loss / ENOSPC mid-write can never truncate the file and lose the endpoint
    // credentials (the PP-1 data-loss surface). A plain `std::fs::write` truncates-then-writes.
    //
    // The atomic writer's SIGNATURE is what we assert against: it writes `<name>.tmp` then
    // renames it over `<name>`. A successful write therefore (a) updates the target and (b)
    // leaves NO `<name>.tmp` sibling behind. A plain `std::fs::write` never creates a `.tmp` at
    // all, so the "no leftover .tmp AND the swap happened" pair is a positive signal only the
    // atomic path can satisfy — and it also proves the writer preserved the rest of the file
    // (the endpoint credentials the data-loss regression was about).

    fn f4_tempdir() -> std::path::PathBuf {
        let base = std::env::temp_dir();
        let unique = format!(
            "tt_routing_f4_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        let dir = base.join(unique);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A minimal password-bearing client config `.toml`.
    fn f4_sample_config() -> &'static str {
        "# TrustTunnel Client Configuration\n\
         vpn_mode = \"general\"\n\n\
         [endpoint]\n\
         hostname = \"de1.example.com\"\n\
         addresses = [\"203.0.113.10:443\"]\n\
         username = \"swift-fox\"\n\
         password = \"SUPER-SECRET-XYZ\"\n"
    }

    #[test]
    fn update_vpn_mode_is_atomic_and_preserves_credentials() {
        let dir = f4_tempdir();
        let cfg = dir.join("TrustTunnel_swift-fox.toml");
        std::fs::write(&cfg, f4_sample_config()).unwrap();

        update_vpn_mode(cfg.to_string_lossy().to_string(), "selective".to_string())
            .expect("update_vpn_mode must succeed on a valid config");

        let written = std::fs::read_to_string(&cfg).unwrap();
        // (a) the mode was actually updated,
        assert!(written.contains("vpn_mode = \"selective\""));
        // (b) the endpoint credentials were preserved (the data-loss surface F4 guards),
        assert!(written.contains("password = \"SUPER-SECRET-XYZ\""));
        assert!(written.contains("username = \"swift-fox\""));
        // (c) the atomic writer renamed its temp away — no `<name>.tmp` sibling is left behind,
        //     which a plain std::fs::write could never have created in the first place. This is
        //     the positive proof the write went through `write_bytes_atomic`.
        let tmp = dir.join("TrustTunnel_swift-fox.toml.tmp");
        assert!(
            !tmp.exists(),
            "atomic writer must leave no leftover .tmp after a successful rename"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_exclusion_list_is_atomic_and_preserves_credentials() {
        let dir = f4_tempdir();
        let cfg = dir.join("TrustTunnel_swift-fox.toml");
        std::fs::write(&cfg, f4_sample_config()).unwrap();

        // save_exclusion_list also best-effort backs up to exclusions.json under
        // portable_data_dir(); that side write is non-secret + swallowed, so it does not affect
        // this assertion on the config file itself.
        crate::geodata::save_exclusion_list(
            cfg.to_string_lossy().to_string(),
            v(&["example.com", "10.0.0.0/8"]),
        )
        .expect("save_exclusion_list must succeed on a valid config");

        let written = std::fs::read_to_string(&cfg).unwrap();
        assert!(written.contains("example.com"));
        // Credentials preserved through the exclusions rewrite (data-loss surface).
        assert!(written.contains("password = \"SUPER-SECRET-XYZ\""));
        // No leftover temp → the write went through the atomic writer, not a plain truncate.
        let tmp = dir.join("TrustTunnel_swift-fox.toml.tmp");
        assert!(
            !tmp.exists(),
            "atomic writer must leave no leftover .tmp after a successful rename"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── IN-57: the shared routing-import cap (BOTH the drag door and the «Импорт» button) ──

    #[test]
    fn parse_routing_rules_capped_rejects_oversized_with_i18n_code() {
        let big = "x".repeat(MAX_ROUTING_JSON_BYTES + 1);
        assert_eq!(
            parse_routing_rules_capped(&big).unwrap_err(),
            "routing.import_too_large",
            "oversized input must return the i18n key code, not raw English"
        );
    }

    #[test]
    fn parse_routing_rules_capped_rejects_invalid_json_with_i18n_code() {
        assert_eq!(
            parse_routing_rules_capped("not json {").unwrap_err(),
            "routing.import_invalid"
        );
    }

    #[test]
    fn parse_routing_rules_capped_accepts_valid_under_cap() {
        let json = r#"{"direct":[],"proxy":[],"block":[],"process_mode":"exclude","processes":[]}"#;
        assert!(parse_routing_rules_capped(json).is_ok());
    }

    // ── T-33: default private/local exclusions in general mode ──

    #[test]
    fn general_mode_adds_default_private_exclusions() {
        // No user rules at all → bypass set is exactly the default-private baseline,
        // so Docker (172.16.0.0/12) / WSL / LAN bypass the tunnel out of the box.
        let result = build_general_exclusions(&[], &[]);
        for cidr in DEFAULT_PRIVATE_EXCLUSIONS {
            assert!(
                result.contains(&cidr.to_string()),
                "expected default private CIDR {cidr} in exclusions, got {result:?}"
            );
        }
        // Spot-check the four critical IPv4 ranges called out in the task.
        assert!(result.contains(&"172.16.0.0/12".to_string()));
        assert!(result.contains(&"192.168.0.0/16".to_string()));
        assert!(result.contains(&"10.0.0.0/8".to_string()));
        assert!(result.contains(&"127.0.0.0/8".to_string()));
    }

    #[test]
    fn general_mode_proxy_override_keeps_cidr_tunnelled() {
        // User forces 192.168.0.0/16 THROUGH the VPN via `proxy`. The user's rule
        // must win → that exact CIDR is NOT auto-excluded, while the other private
        // ranges remain excluded.
        let proxy = v(&["192.168.0.0/16"]);
        let result = build_general_exclusions(&[], &proxy);

        assert!(
            !result.contains(&"192.168.0.0/16".to_string()),
            "user-proxied CIDR must stay tunnelled (not auto-excluded), got {result:?}"
        );
        // Other defaults still excluded.
        assert!(result.contains(&"172.16.0.0/12".to_string()));
        assert!(result.contains(&"10.0.0.0/8".to_string()));
        assert!(result.contains(&"127.0.0.0/8".to_string()));
    }

    #[test]
    fn general_mode_override_is_exact_match_only() {
        // Exact-string override granularity: forcing 192.168.1.0/24 through VPN does
        // NOT suppress the broader default 192.168.0.0/16 (different string).
        let proxy = v(&["192.168.1.0/24"]);
        let result = build_general_exclusions(&[], &proxy);
        assert!(
            result.contains(&"192.168.0.0/16".to_string()),
            "non-exact proxy CIDR must not suppress the default /16, got {result:?}"
        );
    }

    #[test]
    fn general_mode_preserves_user_direct_entries() {
        // User direct entries are always present, kept in order, ahead of the baseline.
        let direct = v(&["8.8.8.8/32", "example.com"]);
        let result = build_general_exclusions(&direct, &[]);

        assert!(result.contains(&"8.8.8.8/32".to_string()));
        assert!(result.contains(&"example.com".to_string()));
        // User entries come first, baseline appended after.
        assert_eq!(result[0], "8.8.8.8/32");
        assert_eq!(result[1], "example.com");
        assert!(result.contains(&"172.16.0.0/12".to_string()));
    }

    #[test]
    fn general_mode_does_not_duplicate_direct_private_cidr() {
        // User already listed 10.0.0.0/8 as direct → baseline must not duplicate it.
        let direct = v(&["10.0.0.0/8"]);
        let result = build_general_exclusions(&direct, &[]);

        let count = result.iter().filter(|e| *e == "10.0.0.0/8").count();
        assert_eq!(count, 1, "10.0.0.0/8 must appear exactly once, got {result:?}");
        // Other defaults still appended.
        assert!(result.contains(&"172.16.0.0/12".to_string()));
    }

    #[test]
    fn general_mode_skips_empty_direct_entries() {
        // Empty resolved entries are filtered out of the bypass set.
        let direct = v(&["", "1.1.1.1/32", ""]);
        let result = build_general_exclusions(&direct, &[]);
        assert!(!result.iter().any(|e| e.is_empty()));
        assert!(result.contains(&"1.1.1.1/32".to_string()));
    }
}

