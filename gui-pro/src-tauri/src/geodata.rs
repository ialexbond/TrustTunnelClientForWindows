use toml_edit::{DocumentMut, value, Array};
use crate::ssh::portable_data_dir;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

const WHITELIST_URLS: &[&str] = &[
    "https://raw.githubusercontent.com/hxehex/russia-mobile-internet-whitelist/main/whitelist.txt",
    "https://raw.githubusercontent.com/RockBlack-VPN/ip-address/main/RU-RU/ozon/ozon_domain",
    "https://raw.githubusercontent.com/RockBlack-VPN/ip-address/main/RU-RU/rutube/rutube_domain",
    "https://raw.githubusercontent.com/RockBlack-VPN/ip-address/main/RU-RU/vk/vk_domain",
    "https://raw.githubusercontent.com/RockBlack-VPN/ip-address/main/RU-RU/wildberries/wildberries_domain",
];

const IPLIST_BASE_URL: &str = "https://iplist.opencck.org";

/// Available iplist.opencck.org groups (English labels — frontend localizes via i18n)
const IPLIST_GROUPS: &[(&str, &str)] = &[
    ("anime", "Anime"),
    ("art", "Art"),
    ("casino", "Casino"),
    ("discord", "Discord"),
    ("education", "Education"),
    ("games", "Games"),
    ("jetbrains", "JetBrains"),
    ("messengers", "Messengers"),
    ("music", "Music"),
    ("news", "News"),
    ("porn", "18+"),
    ("shop", "Shopping"),
    ("socials", "Social Media"),
    ("tools", "Tools"),
    ("torrent", "Torrents"),
    ("video", "Video"),
    ("youtube", "YouTube"),
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IplistGroup {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ActiveGroups {
    pub ru_whitelist: bool,
    pub iplist_groups: Vec<String>,
}

fn exclusions_json_path() -> std::path::PathBuf {
    portable_data_dir().join("exclusions.json")
}

fn active_groups_path() -> std::path::PathBuf {
    portable_data_dir().join("active_groups.json")
}

/// Whitelist guard for a manual `iplist_group:<id>` id before it becomes a filesystem cache
/// path or a fetch URL/filename. Per CLAUDE.md security rule, validators use a WHITELIST of
/// allowed characters, NOT a blacklist. An id is accepted only when it is non-empty, ≤64 chars,
/// and every char is ASCII lowercase / ASCII digit / `_` / `-`. This rejects the path-traversal
/// vector (`../etc`, `a/b`, `a\b`), separators, uppercase, over-length, and any prefixed value
/// like `iplist_group:games` (the colon is not in the whitelist) — closing threat T-22-01. The
/// special `ru_whitelist` cache key (see fetch_whitelist_domains) already satisfies this shape
/// (lowercase + underscore), so it passes without a special case. This is the backend belt to the
/// frontend `validateEntry` suspenders (defense-in-depth, Security V5/V12).
fn is_valid_group_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 64 {
        return false;
    }
    id.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

fn group_cache_path(group_id: &str) -> std::path::PathBuf {
    let cache_dir = portable_data_dir().join("group_cache");
    std::fs::create_dir_all(&cache_dir).ok();
    // Sanitize before joining: a rejected id (e.g. `../etc`, `a/b`) must NEVER build a path that
    // traverses out of the cache dir. Return a fixed sentinel INSIDE the cache dir whose name
    // carries no user bytes — its `.exists()` is always false, so a load reads nothing and a
    // write (only reached after fetch, which errors first on an invalid id) targets a dead file.
    if !is_valid_group_id(group_id) {
        return cache_dir.join("__invalid_group__.nonexistent");
    }
    cache_dir.join(format!("{group_id}.json"))
}

/// Public accessor for group_cache_path (used by routing_rules module)
pub fn group_cache_path_pub(group_id: &str) -> std::path::PathBuf {
    group_cache_path(group_id)
}

#[tauri::command]
pub fn load_exclusion_json() -> Result<Vec<String>, String> {
    let path = exclusions_json_path();
    match std::fs::read_to_string(&path) {
        Ok(content) => {
            let domains: Vec<String> = serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse exclusions.json: {e}"))?;
            Ok(domains)
        }
        Err(_) => Ok(Vec::new()),
    }
}

#[tauri::command]
pub fn save_exclusion_json(domains: Vec<String>) -> Result<(), String> {
    let path = exclusions_json_path();
    let json = serde_json::to_string_pretty(&domains)
        .map_err(|e| format!("Failed to serialize: {e}"))?;
    std::fs::write(&path, json)
        .map_err(|e| format!("Failed to write exclusions.json: {e}"))?;
    eprintln!("[exclusions] {} domains backed up to {}", domains.len(), path.display());
    Ok(())
}

#[tauri::command]
pub fn load_exclusion_list(config_path: String) -> Result<Vec<String>, String> {
    let content = match std::fs::read_to_string(&config_path) {
        Ok(c) => c,
        Err(_) => return Ok(Vec::new()),
    };
    let doc: DocumentMut = content
        .parse()
        .map_err(|e: toml_edit::TomlError| format!("Failed to parse config: {e}"))?;
    let domains = doc
        .get("exclusions")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    Ok(domains)
}

#[tauri::command]
pub fn save_exclusion_list(config_path: String, domains: Vec<String>) -> Result<(), String> {
    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config: {e}"))?;
    let mut doc: DocumentMut = content
        .parse()
        .map_err(|e: toml_edit::TomlError| format!("Failed to parse config: {e}"))?;

    let mut arr = Array::new();
    for d in &domains {
        arr.push(d.as_str());
    }
    doc["exclusions"] = value(arr);

    // F4 (17-review): atomic write — this rewrites the ACTIVE password-bearing config; a
    // truncate-then-write cut short by ENOSPC / power loss would strand the endpoint
    // host/login/password. Route through the same temp → fsync → rename → parent-dir fsync writer
    // every other .toml save uses (PP-1), so the file is swapped in whole or not at all. D-29: the
    // writer never logs the bytes (the eprintln below carries only the count + path, no content).
    crate::commands::manifest::write_bytes_atomic(
        std::path::Path::new(&config_path),
        doc.to_string().as_bytes(),
    )
    .map_err(|e| format!("Failed to write config: {e}"))?;
    eprintln!("[exclusions] {} domains saved to {}", domains.len(), config_path);

    // Also backup to JSON for persistence across config deletions
    let json_path = exclusions_json_path();
    if let Ok(json) = serde_json::to_string_pretty(&domains) {
        std::fs::write(&json_path, json).ok();
    }

    Ok(())
}

#[tauri::command]
pub async fn fetch_whitelist_domains() -> Result<Vec<String>, String> {
    let mut all = HashSet::new();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    for url in WHITELIST_URLS {
        eprintln!("[whitelist] Fetching {url}");
        match client.get(*url).send().await {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(text) = resp.text().await {
                    let count_before = all.len();
                    for line in text.lines() {
                        let d = line.trim().to_lowercase();
                        if !d.is_empty() && !d.starts_with('#') {
                            all.insert(d);
                        }
                    }
                    eprintln!("[whitelist]   +{} domains from {url}", all.len() - count_before);
                }
            }
            Ok(resp) => eprintln!("[whitelist]   HTTP {} for {url}", resp.status()),
            Err(e) => eprintln!("[whitelist]   Error fetching {url}: {e}"),
        }
    }

    if all.is_empty() {
        return Err("Failed to load domains from any source".into());
    }

    let mut domains: Vec<String> = all.into_iter().collect();
    domains.sort();
    eprintln!("[whitelist] Total: {} unique domains from {} sources", domains.len(), WHITELIST_URLS.len());
    // Cache RU-whitelist domains
    if let Ok(json) = serde_json::to_string_pretty(&domains) {
        std::fs::write(group_cache_path("ru_whitelist"), json).ok();
    }
    Ok(domains)
}

#[tauri::command]
pub fn get_iplist_groups() -> Vec<IplistGroup> {
    IPLIST_GROUPS
        .iter()
        .map(|(id, label)| IplistGroup {
            id: id.to_string(),
            label: label.to_string(),
        })
        .collect()
}

#[tauri::command]
pub async fn fetch_iplist_group_domains(group_id: String) -> Result<Vec<String>, String> {
    // Backend belt (T-22-01): reject an invalid id BEFORE it is interpolated into the request URL
    // or a cache filename. A manual `iplist_group:<id>` entry is user-controlled; without this a
    // value like `../etc` would traverse the cache dir and taint the fetch URL. Whitelist-only.
    if !is_valid_group_id(&group_id) {
        return Err(format!("Invalid group id: {group_id}"));
    }

    let url = format!("{IPLIST_BASE_URL}/?format=json&data=domains&group={group_id}");
    eprintln!("[iplist] Fetching group '{group_id}' from {url}");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }

    let text = resp.text().await.map_err(|e| format!("Read error: {e}"))?;

    // Parse JSON: {"portal": ["domain1", "domain2", ...], ...}
    let portal_map: HashMap<String, Vec<String>> =
        serde_json::from_str(&text).map_err(|e| format!("Parse error: {e}"))?;

    // Extract unique base domains, filtering out massive subdomain lists
    let mut domains = HashSet::new();
    for (portal_key, subdomains) in &portal_map {
        // Always include portal key if it looks like a domain
        if portal_key.contains('.') {
            domains.insert(portal_key.to_lowercase());
        }
        for d in subdomains {
            let d_lower = d.trim().to_lowercase();
            if d_lower.is_empty() {
                continue;
            }
            // Skip massive numbered regional subdomains (e.g. atlanta1068.discord.gg)
            // Keep only domains that don't match pattern: word+digits.domain
            if is_numbered_subdomain(&d_lower) {
                continue;
            }
            // Skip googlevideo.com CDN subdomains (rr1---sn-xxx.googlevideo.com)
            if d_lower.contains(".googlevideo.com") && d_lower.starts_with("rr") {
                continue;
            }
            // Skip yandexwebcache.org subdomains
            if d_lower.contains(".yandexwebcache.org") {
                continue;
            }
            domains.insert(d_lower);
        }
    }

    let mut result: Vec<String> = domains.into_iter().collect();
    result.sort();
    eprintln!(
        "[iplist] Group '{}': {} unique domains from {} portals",
        group_id,
        result.len(),
        portal_map.len()
    );

    // Cache group domains
    if let Ok(json) = serde_json::to_string_pretty(&result) {
        std::fs::write(group_cache_path(&group_id), json).ok();
    }

    Ok(result)
}

/// Check if a domain is a numbered regional subdomain like "atlanta1068.discord.gg"
fn is_numbered_subdomain(domain: &str) -> bool {
    if let Some(first_part) = domain.split('.').next() {
        // Pattern: letters followed by digits (e.g. atlanta1068, brazil104, russia34)
        let has_letters = first_part.chars().any(|c| c.is_ascii_alphabetic());
        let has_digits = first_part.chars().any(|c| c.is_ascii_digit());
        let has_hyphen = first_part.contains('-');
        // "us-east1234" or "atlanta1234" but not "cdn" or "api"
        if has_letters && has_digits && first_part.len() > 4 {
            // Count trailing digits
            let digit_count = first_part.chars().rev().take_while(|c| c.is_ascii_digit()).count();
            if digit_count >= 2 && !has_hyphen {
                return true;
            }
            // Patterns like "us-east1234.discord.gg" or "buenos-aires500.discord.gg"
            if has_hyphen && digit_count >= 1 {
                // check if it ends with digits after a word
                let without_digits: String = first_part.chars().take(first_part.len() - digit_count).collect();
                if without_digits.ends_with(|c: char| c.is_ascii_alphabetic()) {
                    return true;
                }
            }
        }
    }
    false
}

#[tauri::command]
pub fn load_active_groups() -> Result<ActiveGroups, String> {
    let path = active_groups_path();
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse active_groups.json: {e}")),
        Err(_) => Ok(ActiveGroups::default()),
    }
}

#[tauri::command]
pub fn save_active_groups(groups: ActiveGroups) -> Result<(), String> {
    let path = active_groups_path();
    let json = serde_json::to_string_pretty(&groups)
        .map_err(|e| format!("Failed to serialize: {e}"))?;
    std::fs::write(&path, json)
        .map_err(|e| format!("Failed to write active_groups.json: {e}"))?;
    eprintln!(
        "[groups] Saved: ru_whitelist={}, iplist={:?}",
        groups.ru_whitelist, groups.iplist_groups
    );
    Ok(())
}

#[tauri::command]
pub fn load_group_cache(group_id: String) -> Result<Vec<String>, String> {
    let path = group_cache_path(&group_id);
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse cache for {group_id}: {e}")),
        Err(_) => Ok(Vec::new()),
    }
}

// ─── Tests ──────────────────────────────────────────
//
// Wave 0 RED (Plan 22-01): the security whitelist sanitizer `is_valid_group_id` is exercised
// here BEFORE it exists. A manual `iplist_group:<id>` entry (D-03) is user-controlled input that
// reaches `group_cache_path(<id>)` → `portable_data_dir().join("group_cache").join("<id>.json")`.
// Without a whitelist a value like `../etc` or `a/b` would traverse out of the cache dir
// (threat T-22-01: tampering / info-disclosure). The mitigation is a `[a-z0-9_-]`-only,
// ≤64-char, non-empty allowlist that also accepts the 17 known iplist group ids + `ru_whitelist`.
//
// This whole `mod tests` DOES NOT COMPILE yet: `is_valid_group_id` is not defined. That is the
// intended RED state — Plan 22-03 ADDS `pub fn is_valid_group_id(&str) -> bool` to this module
// and turns this test green. Do NOT define the function here.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_valid_group_id_accepts_known_ids_and_rejects_traversal() {
        // Wave 0 RED: is_valid_group_id added in Plan 03.

        // Accepts every known iplist group id (the 17 in IPLIST_GROUPS)…
        for (id, _label) in IPLIST_GROUPS {
            assert!(
                is_valid_group_id(id),
                "known iplist group id '{id}' must be accepted"
            );
        }
        // …plus the special ru_whitelist cache key (not in IPLIST_GROUPS, see fetch_whitelist_domains).
        assert!(is_valid_group_id("ru_whitelist"));
        // …and shape-valid lowercase ids with digits / hyphen / underscore.
        assert!(is_valid_group_id("a"));
        assert!(is_valid_group_id("group-1_x"));

        // Rejects path traversal and separators (the core threat).
        assert!(!is_valid_group_id("../etc"), "path traversal must be rejected");
        assert!(!is_valid_group_id("a/b"), "forward slash must be rejected");
        assert!(!is_valid_group_id("a\\b"), "backslash must be rejected");
        // Rejects uppercase (ids are lowercase in IPLIST_GROUPS).
        assert!(!is_valid_group_id("A"), "uppercase must be rejected");
        assert!(!is_valid_group_id("Games"), "mixed case must be rejected");
        // Rejects empty and over-length (>64 chars).
        assert!(!is_valid_group_id(""), "empty must be rejected");
        assert!(
            !is_valid_group_id(&"a".repeat(65)),
            "a 65-char id must be rejected"
        );
        // Rejects any other non-[a-z0-9_-] character.
        assert!(!is_valid_group_id("a.b"), "dot must be rejected");
        assert!(!is_valid_group_id("a b"), "space must be rejected");
        assert!(!is_valid_group_id("a;b"), "semicolon must be rejected");
        assert!(!is_valid_group_id("iplist_group:games"), "prefixed value must be rejected");
    }
}
