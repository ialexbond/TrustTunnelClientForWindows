use toml_edit::{DocumentMut, value, Array};
use crate::ssh::portable_data_dir;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::time::{Duration, SystemTime};

const WHITELIST_URLS: &[&str] = &[
    "https://raw.githubusercontent.com/hxehex/russia-mobile-internet-whitelist/main/whitelist.txt",
    "https://raw.githubusercontent.com/RockBlack-VPN/ip-address/main/RU-RU/ozon/ozon_domain",
    "https://raw.githubusercontent.com/RockBlack-VPN/ip-address/main/RU-RU/rutube/rutube_domain",
    "https://raw.githubusercontent.com/RockBlack-VPN/ip-address/main/RU-RU/vk/vk_domain",
    "https://raw.githubusercontent.com/RockBlack-VPN/ip-address/main/RU-RU/wildberries/wildberries_domain",
];

const IPLIST_BASE_URL: &str = "https://iplist.opencck.org";

/// The reserved cache key for the RU whitelist. It is not an iplist group — it is the union of the
/// five `WHITELIST_URLS` — but it is stored under the same cache directory and the same id rules
/// (lowercase + underscore, so `is_valid_group_id` accepts it with no special case). Named here
/// because Plan 23-03 gave it a second call site: the scheduler branches on it to pick the fetcher.
pub(crate) const RU_WHITELIST_GROUP_ID: &str = "ru_whitelist";

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

/// Manual entry point: fetch the RU whitelist and commit it to the cache.
///
/// The fetch itself lives in `fetch_whitelist_domains_inner` so the automatic path
/// (`refresh_group_cache_if_stale`) can inspect the result BEFORE anything is written — the same
/// "download returns data, a separate guarded step owns the write" shape Plan 23-01 introduced for
/// the `.dat` files. Previously the write was inline here and its error was swallowed with `.ok()`.
#[tauri::command]
pub async fn fetch_whitelist_domains() -> Result<Vec<String>, String> {
    let domains = fetch_whitelist_domains_inner().await?;
    // D-15/D-18: what used to stand here was a plain truncate-then-write of the ru_whitelist cache
    // file whose error was dropped with `.ok()`. It is replaced by the shared atomic writer
    // (`write_bytes_atomic`, reached through `commit_group_cache`), and the error is propagated. A
    // truncate-then-write cut short leaves a resolve reading half a domain list; a rename cannot.
    commit_group_cache(RU_WHITELIST_GROUP_ID, &domains)?;
    Ok(domains)
}

/// The fetch half of the RU whitelist: five sources unioned, per-source failure tolerated, empty
/// total rejected. Writes nothing.
async fn fetch_whitelist_domains_inner() -> Result<Vec<String>, String> {
    let mut all = HashSet::new();
    // CR-02: the SHARED geodata client, not a bare `reqwest::Client::builder()`. The bare builder
    // inherits reqwest's default `Policy::limited(10)` — ten redirects to any host, https → http
    // downgrade included — which reduced the `validate_geodata_url` call below to a first-hop-only
    // check. `geodata_http_client` re-validates every hop against the same allowlist and caps the
    // chain, so a hijacked source cannot redirect a whitelist fetch to attacker-controlled bytes
    // that then land in `group_cache/ru_whitelist.json` and steer what bypasses the tunnel.
    let client = crate::geodata_v2ray::geodata_http_client(15)?;

    for url in WHITELIST_URLS {
        // T-23-17: HTTPS + host allowlist, reusing the geodata validator rather than adding a third
        // one. These five URLs are compile-time constants, so this is defence against future drift,
        // not a fix for a live injection. A rejected URL is skipped like any other unreachable
        // source — the shrunken result is then caught by `refresh_is_acceptable` on the auto path.
        if let Err(e) = crate::geodata_v2ray::validate_geodata_url(url) {
            eprintln!("[whitelist]   Refusing {url}: {e}");
            continue;
        }
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

/// Manual entry point: fetch one iplist group and commit it to the cache.
///
/// Split like `fetch_whitelist_domains` so the automatic path can apply its guards before any
/// write; see `fetch_whitelist_domains` for the reasoning.
#[tauri::command]
pub async fn fetch_iplist_group_domains(group_id: String) -> Result<Vec<String>, String> {
    let result = fetch_iplist_group_domains_inner(&group_id).await?;
    // D-15/D-18: replaces the inline non-atomic write of the group cache file, whose error was
    // dropped, with the shared atomic writer (`write_bytes_atomic`, via `commit_group_cache`).
    commit_group_cache(&group_id, &result)?;
    Ok(result)
}

/// The fetch half of an iplist group: validate, fetch, filter, reject an empty result. Writes
/// nothing.
async fn fetch_iplist_group_domains_inner(group_id: &str) -> Result<Vec<String>, String> {
    // Backend belt (T-22-01): reject an invalid id BEFORE it is interpolated into the request URL
    // or a cache filename. A manual `iplist_group:<id>` entry is user-controlled; without this a
    // value like `../etc` would traverse the cache dir and taint the fetch URL. Whitelist-only.
    if !is_valid_group_id(group_id) {
        return Err(format!("Invalid group id: {group_id}"));
    }

    let url = format!("{IPLIST_BASE_URL}/?format=json&data=domains&group={group_id}");
    // T-23-17: validate the URL AFTER interpolation, so the guard sees exactly what will be
    // requested. The id inside it is already whitelist-guarded above, so this is defence in depth
    // on the host (HTTPS + allowlist), not a fix for a live injection.
    crate::geodata_v2ray::validate_geodata_url(&url)?;
    eprintln!("[iplist] Fetching group '{group_id}' from {url}");

    // CR-02: the shared geodata client (see `fetch_whitelist_domains_inner` for the reasoning). The
    // iplist host is the one geodata source that is NOT GitHub, so a first-hop-only check here was
    // the weakest link: the fetched JSON becomes `group_cache/<id>.json` verbatim.
    let client = crate::geodata_v2ray::geodata_http_client(30)?;

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

    // D-16, the gap this plan closes: upstream JSON that parses to an empty map (or to portals
    // whose entries are all filtered out) used to be cached as an empty list, which silently
    // deletes a working group from routing. `fetch_whitelist_domains_inner` has always rejected
    // this; the iplist fetcher did not. Nothing beats an empty answer, so refuse it here and let
    // the previous cache stand.
    if result.is_empty() {
        return Err(format!("iplist group '{group_id}' returned no domains"));
    }

    Ok(result)
}

/// The ONE writer for a group cache file (D-15/D-18).
///
/// Routes through `crate::commands::manifest::write_bytes_atomic` (temp → fsync → rename →
/// parent-dir fsync), so `routing_rules::resolve_entries` — which reads these files from disk on
/// every resolve — sees either the whole old file or the whole new one, never a truncated prefix.
/// The id is re-validated here as well: `group_cache_path` would otherwise hand back its sentinel
/// path and we would create a junk file rather than report the problem.
fn commit_group_cache(group_id: &str, domains: &[String]) -> Result<(), String> {
    if !is_valid_group_id(group_id) {
        return Err(format!("Invalid group id: {group_id}"));
    }
    // The on-disk shape stays a bare JSON array of strings. TWO independent deserializers read it
    // (`load_group_cache` here and the `iplist_group` arm in routing_rules), so any envelope would
    // be a two-reader migration; see `cache_is_stale` for why freshness lives in the mtime instead.
    let json = serde_json::to_string_pretty(domains)
        .map_err(|e| format!("Failed to serialize cache for {group_id}: {e}"))?;
    crate::commands::manifest::write_bytes_atomic(&group_cache_path(group_id), json.as_bytes())
        .map_err(|e| format!("Failed to write cache for {group_id}: {e}"))
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

// ─── Automatic refresh (D-14) ───────────────────────
//
// Until Phase 23 a group cache was fetched once, when the group was added, and never again. These
// items are the update path: a clock, two guards and one public entry point. The single consumer
// is `geodata_scheduler::run_cycle`.

/// What one refresh attempt did. `Rejected` is NOT an error: the fetch succeeded but its result was
/// refused by a guard, and the previous cache is still live — the caller logs a count and moves on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GroupRefreshOutcome {
    Fresh,
    Refreshed { domains: usize },
    Rejected,
}

/// Is a cache due for a refresh? Pure, so the TTL rule is testable without a clock or a filesystem.
///
/// **Why the modification time is the clock, and not a field inside the file.** The cache is a bare
/// JSON array of strings read by TWO independent deserializers — `load_group_cache` here and the
/// `iplist_group` arm of `routing_rules::resolve_entries`. Wrapping it in a
/// `{ domains, fetched_at }` envelope would mean changing both readers plus a
/// backward-compatibility branch for every cache file already on disk: a real migration, for a
/// freshness heuristic. `std::fs::metadata(path)?.modified()?` answers the same question with zero
/// format change and zero migration.
///
/// The mtime can lie in exactly two benign ways, and neither costs anything worse than one cycle:
/// an atomic rename stamps the new file with "now" (correct here — the content IS new), and a
/// backup/restore tool can carry a stale timestamp forward, which triggers one extra refresh. A
/// clock that has jumped backwards makes `duration_since` fail; that reads as "fresh" and costs at
/// most one skipped refresh, which the next cycle takes.
///
/// A missing timestamp means "no cache yet, or an unreadable one" and returns true — refreshing
/// something already fresh is cheap, leaving a hole unfilled forever is not.
pub fn cache_is_stale(now: SystemTime, modified: Option<SystemTime>, ttl: Duration) -> bool {
    match modified {
        None => true,
        Some(modified) => match now.duration_since(modified) {
            Ok(elapsed) => elapsed > ttl,
            Err(_) => false,
        },
    }
}

/// The cache file's modification time, or `None` when there is no file or its metadata is
/// unreadable. The id is validated by `group_cache_path`, whose sentinel never exists.
fn cache_age(group_id: &str) -> Option<SystemTime> {
    std::fs::metadata(group_cache_path(group_id))
        .ok()
        .and_then(|meta| meta.modified().ok())
}

/// May an AUTOMATIC refresh replace a cache of `previous_len` domains with one of `new_len`?
///
/// Emptiness alone is not enough here, and that is the whole reason this guard exists.
/// `fetch_whitelist_domains_inner` deliberately tolerates per-source failure across five URLs: with
/// four of them unreachable it returns a much-shrunk but non-empty list, which the empty check
/// waves through and which would then overwrite a good cache with a fraction of it. Half the
/// previous size is the line — a legitimate upstream slimming stays well above it, a partial
/// outage lands well below.
///
/// Plan 23-01 deliberately declined a collapse heuristic for the `.dat` files, and the asymmetry is
/// justified by the fetchers, not by taste: the `.dat` download is all-or-nothing (a failed fetch
/// is an error, never a smaller file), while the whitelist fetcher is a best-effort union.
///
/// **WR-03 — and that same reasoning is why this is applied to the whitelist ONLY.** See
/// `automatic_refresh_is_acceptable`.
///
/// Automatic path only. A manual click is an explicit user act with a visible result; refusing it
/// because the answer shrank would be a surprise the user cannot act on.
pub fn refresh_is_acceptable(previous_len: usize, new_len: usize) -> bool {
    new_len > 0 && new_len.saturating_mul(2) >= previous_len
}

/// Which guard applies to an automatic refresh of `group_id` (WR-03).
///
/// The collapse guard above was applied uniformly, but its justification is specific to the
/// whitelist's best-effort five-source union. The iplist fetcher is all-or-nothing —
/// `fetch_iplist_group_domains_inner` returns `Err` on an HTTP failure AND on an empty result — so
/// it has exactly the "a failed fetch is an error, never a smaller file" property that made Plan
/// 23-01 decline a collapse heuristic for the `.dat` files. A smaller iplist answer is a real
/// upstream edit, not an outage.
///
/// Applying the half-size rule there had no escape hatch and no way out. A `Rejected` refresh does
/// not touch the cache file, so its mtime does not advance and `cache_is_stale` reports stale again
/// next cycle. A group whose upstream legitimately halves — entirely plausible for the smaller
/// groups, where 10 domains becoming 4 is a normal edit — entered a permanent state of: fetch every
/// 24 h, reject, keep the stale cache, tell the user nothing (D-08). Forever, with a wasted daily
/// fetch, and no exit but removing and re-adding the group by hand.
///
/// The fix is scoping rather than a counter on purpose. Counting consecutive rejections and
/// eventually accepting would be the failure counter D-08 explicitly rules out, and surfacing it
/// would break D-04's silence. Scoping the guard to the fetcher whose shape justifies it needs
/// neither.
///
/// D-16 still holds for both: an empty result is never a valid update.
pub fn automatic_refresh_is_acceptable(group_id: &str, previous_len: usize, new_len: usize) -> bool {
    if group_id == RU_WHITELIST_GROUP_ID {
        refresh_is_acceptable(previous_len, new_len)
    } else {
        new_len > 0
    }
}

/// How many domains the current cache holds; 0 when there is none or it will not parse.
fn cached_domain_count(group_id: &str) -> usize {
    load_group_cache(group_id.to_string())
        .map(|domains| domains.len())
        .unwrap_or(0)
}

/// The ONE public entry point for the automatic path (the scheduler, Plan 23-03 Task 2).
///
/// Deliberately the only new export: `is_valid_group_id` stays module-private, as Phase 22 decided,
/// so no caller can reach a cache path while skipping the checks that surround it. This wrapper
/// validates internally instead — the same shape as the narrow `group_cache_path_pub` above.
///
/// Returns `Fresh` when the cache is younger than `ttl`, `Rejected` when a guard refused the result
/// (previous cache untouched), and `Refreshed` after an atomic commit.
pub async fn refresh_group_cache_if_stale(
    group_id: &str,
    ttl: Duration,
) -> Result<GroupRefreshOutcome, String> {
    if !is_valid_group_id(group_id) {
        return Err(format!("Invalid group id: {group_id}"));
    }

    if !cache_is_stale(SystemTime::now(), cache_age(group_id), ttl) {
        return Ok(GroupRefreshOutcome::Fresh);
    }

    let previous_len = cached_domain_count(group_id);

    // The reserved whitelist id is the union of five sources; everything else is one iplist group.
    let fetched = if group_id == RU_WHITELIST_GROUP_ID {
        fetch_whitelist_domains_inner().await?
    } else {
        fetch_iplist_group_domains_inner(group_id).await?
    };

    // WR-03: the collapse guard applies to the whitelist only — the iplist fetch is all-or-nothing,
    // so a smaller list from it is a real upstream edit, and refusing it stranded the group on a
    // stale cache forever (a rejection does not advance the mtime, so it is re-fetched and
    // re-rejected every cycle, silently).
    if !automatic_refresh_is_acceptable(group_id, previous_len, fetched.len()) {
        eprintln!(
            "[groups] Refresh of '{group_id}' rejected: {} domains vs {previous_len} cached",
            fetched.len()
        );
        return Ok(GroupRefreshOutcome::Rejected);
    }

    commit_group_cache(group_id, &fetched)?;
    Ok(GroupRefreshOutcome::Refreshed {
        domains: fetched.len(),
    })
}

// ─── Tests ──────────────────────────────────────────
//
// The security whitelist sanitizer `is_valid_group_id` (Phase 22, T-22-01). A manual
// `iplist_group:<id>` entry is user-controlled input that reaches `group_cache_path(<id>)` →
// `portable_data_dir().join("group_cache").join("<id>.json")`. Without a whitelist a value like
// `../etc` or `a/b` would traverse out of the cache dir (tampering / info-disclosure). The
// mitigation is a `[a-z0-9_-]`-only, ≤64-char, non-empty allowlist that also accepts the 17 known
// iplist group ids + `ru_whitelist`.
//
// The validator is module-PRIVATE and stays that way: Phase 22 decided that exporting it would
// invite call sites that reach a cache path while skipping the checks around it. Phase 23 needed a
// caller outside this module and added the re-validating `refresh_group_cache_if_stale` wrapper
// rather than reversing that decision. (This banner used to describe a Wave-0 RED state in which
// the function did not exist yet; it has existed since Plan 22-03.)
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_valid_group_id_accepts_known_ids_and_rejects_traversal() {
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

    // ─── Phase 23 (D-14): the automatic refresh rules ───
    //
    // Three pure rules decide whether a group cache is touched at all, and they are the only thing
    // standing between a partial upstream outage and a routing table that lost most of its domains.
    // All three are tested with no clock, no filesystem and no network, which is why they were
    // extracted as pure functions in the first place.

    /// The TTL rule. The missing-timestamp case is the one that matters most: it is what makes a
    /// group added before Phase 23 (or one whose metadata is unreadable) get a first refresh at all
    /// instead of being treated as eternally fresh.
    #[test]
    fn cache_staleness_is_decided_by_the_modification_time() {
        let ttl = Duration::from_secs(24 * 60 * 60);
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);

        assert!(
            cache_is_stale(now, None, ttl),
            "no readable timestamp must refresh rather than assume fresh"
        );
        assert!(
            cache_is_stale(now, Some(now - Duration::from_secs(25 * 60 * 60)), ttl),
            "older than the TTL is stale"
        );
        assert!(
            !cache_is_stale(now, Some(now - Duration::from_secs(23 * 60 * 60)), ttl),
            "inside the TTL is fresh"
        );
        assert!(
            !cache_is_stale(now, Some(now), ttl),
            "just written is fresh"
        );
        assert!(
            !cache_is_stale(now, Some(now + Duration::from_secs(60)), ttl),
            "a timestamp in the future (clock skew) costs at most one skipped refresh, not a spin"
        );
    }

    /// The collapse guard for the automatic path. The middle case is the real one: four of the five
    /// whitelist sources unreachable returns a non-empty list that the emptiness check would let
    /// through and that would overwrite a working cache with a fraction of itself.
    #[test]
    fn refresh_is_acceptable_rejects_empty_and_collapsed_results() {
        assert!(!refresh_is_acceptable(1000, 0), "an empty fetch never replaces a cache");
        assert!(!refresh_is_acceptable(0, 0), "empty is refused even with no previous cache");
        assert!(!refresh_is_acceptable(1000, 499), "under half the previous size is a collapse");
        assert!(refresh_is_acceptable(1000, 500), "exactly half is accepted");
        assert!(refresh_is_acceptable(1000, 990), "a small legitimate slimming is accepted");
        assert!(refresh_is_acceptable(1000, 5000), "growth is always accepted");
        assert!(refresh_is_acceptable(0, 42), "a first fetch has nothing to collapse from");
        assert!(
            !refresh_is_acceptable(usize::MAX, 1),
            "no overflow panic on an absurd previous size"
        );
    }

    /// WR-03: the collapse guard is scoped to the fetcher whose shape justifies it.
    ///
    /// A rejection leaves the cache file untouched, so its mtime does not advance and the group is
    /// stale again next cycle — meaning a rejection is not "retry later", it is a permanent silent
    /// stall plus a wasted fetch every 24 hours. The whitelist earns that risk (a best-effort union
    /// of five sources genuinely can return a fraction of itself during an outage). The iplist
    /// fetcher cannot produce a partial result at all — it errors on HTTP failure and on an empty
    /// map — so a smaller list from it is an upstream edit, and 10 domains becoming 4 is a normal
    /// one for the smaller groups.
    #[test]
    fn the_collapse_guard_applies_to_the_whitelist_and_not_to_the_iplist_groups() {
        // The whitelist keeps the half-size rule: a four-of-five-sources outage is refused.
        assert!(
            !automatic_refresh_is_acceptable(RU_WHITELIST_GROUP_ID, 1000, 200),
            "a collapsed whitelist union must still be refused — that is what the guard is for"
        );
        assert!(
            automatic_refresh_is_acceptable(RU_WHITELIST_GROUP_ID, 1000, 900),
            "a legitimate whitelist slimming is still accepted"
        );

        // An iplist group legitimately halving is accepted, not stranded forever.
        assert!(
            automatic_refresh_is_acceptable("games", 10, 4),
            "an all-or-nothing fetcher returning fewer domains is an upstream edit, not an outage"
        );
        assert!(
            automatic_refresh_is_acceptable("youtube", 5000, 1),
            "even a drastic shrink is a real answer when a failed fetch would have been an error"
        );

        // D-16 still holds on BOTH paths: nothing beats an empty answer.
        assert!(
            !automatic_refresh_is_acceptable("games", 10, 0),
            "an empty iplist result is a rejected update (D-16)"
        );
        assert!(
            !automatic_refresh_is_acceptable(RU_WHITELIST_GROUP_ID, 10, 0),
            "an empty whitelist result is a rejected update (D-16)"
        );
        // ...including on a first fetch, where there is nothing to collapse from.
        assert!(!automatic_refresh_is_acceptable("games", 0, 0));
        assert!(automatic_refresh_is_acceptable("games", 0, 42));
    }

    /// T-23-17: every URL this module fetches must survive the shared geodata allowlist. Asserted
    /// against the real constants, so editing `WHITELIST_URLS` or `IPLIST_BASE_URL` to an
    /// off-allowlist host fails here rather than silently skipping the source at runtime.
    ///
    /// CR-02 — the limit of this test, stated so it is not mistaken for coverage again: it checks
    /// the FIRST hop only. It passed while both fetchers used a bare `reqwest::Client::builder()`
    /// that followed ten redirects to any host. The client-level control is asserted separately in
    /// `geodata_v2ray::tests::the_geodata_client_refuses_an_off_policy_redirect_hop`.
    #[test]
    fn every_group_fetch_url_passes_the_geodata_allowlist() {
        use crate::geodata_v2ray::validate_geodata_url;

        for url in WHITELIST_URLS {
            assert!(
                validate_geodata_url(url).is_ok(),
                "whitelist source must be on the allowlist: {url}"
            );
        }
        let group_url = format!("{IPLIST_BASE_URL}/?format=json&data=domains&group=games");
        assert!(
            validate_geodata_url(&group_url).is_ok(),
            "the interpolated iplist group URL must be on the allowlist"
        );

        // A non-HTTPS scheme and a suffix look-alike must both be refused — the look-alike is why
        // the validator matches `host == d || host.ends_with(".{d}")` rather than `contains`.
        assert!(validate_geodata_url("http://iplist.opencck.org/?group=games").is_err());
        assert!(validate_geodata_url("https://iplist.opencck.org.evil.com/?group=games").is_err());
        assert!(validate_geodata_url("https://evil-githubusercontent.com/x").is_err());
    }
}
