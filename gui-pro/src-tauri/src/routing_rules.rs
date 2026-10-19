use crate::geodata::group_cache_path_pub;
use crate::geodata_v2ray::{self, GeoDataState};
use crate::ssh::user_data_dir;
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

/// The persisted routing document.
///
/// SITE BLOCKING BY DOMAIN WAS REMOVED ON 2026-09-03 (owner decision). The two fields it owned —
/// `block: Vec<RuleEntry>` and `block_enabled: bool` — are gone from this struct, and the removal
/// has one hazard on each side of the file:
///
///   * READ. Every rules file already on disk carries both keys. Serde ignores unknown fields by
///     default, so those documents still deserialize — which matters more than it sounds: a rules
///     file that will not parse ABORTS THE CONNECT (D-02), so a `deny_unknown_fields` here would
///     have shipped a build that refuses to connect for everyone who ever opened the Routing tab.
///     `legacy_block_keys_still_deserialize` pins that.
///   * WRITE. `save_routing_rules` serializes this struct, so a plain save would rewrite the
///     document WITHOUT those keys and the user's hand-typed block list would be gone for good.
///     See `CARRIED_LEGACY_KEYS` — the data is carried forward untouched. The feature was removed;
///     the user's data was not.
///
/// Why the feature went: in TUN mode the C++ core can only block a name by DROPPING its DNS query,
/// it answers with silence rather than NXDOMAIN (so Windows simply re-asks through another
/// adapter), and its connection-refusal gate compares IP only. It never blocked anything — the
/// core logged not one `[ROUTE] BLOCKED` in thirteen days of real logs. Full analysis in
/// `.planning/milestones/v3.0-phases/30.1-*/30.1-BLOCKING-DIAGNOSIS.md`; if the feature ever returns it returns as
/// a filtering DNS on the user's own server (`.planning/research/site-blocking-approaches/`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoutingRules {
    #[serde(default)]
    pub direct: Vec<RuleEntry>,
    #[serde(default)]
    pub proxy: Vec<RuleEntry>,
    #[serde(
        default = "default_process_mode",
        deserialize_with = "deserialize_process_mode"
    )]
    pub process_mode: String, // "exclude" | "only"
    #[serde(default)]
    pub processes: Vec<String>,
}

fn default_process_mode() -> String {
    "exclude".to_string()
}

fn validate_process_mode(mode: &str) -> Result<(), String> {
    match mode {
        "exclude" | "only" => Ok(()),
        _ => Err("Unsupported routing process mode; expected 'exclude' or 'only'".to_string()),
    }
}

fn deserialize_process_mode<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let mode = String::deserialize(deserializer)?;
    validate_process_mode(&mode).map_err(serde::de::Error::custom)?;
    Ok(mode)
}

/// Keys that belonged to the removed site-blocking feature and are carried through every save
/// VERBATIM rather than dropped.
///
/// The read side needs nothing (serde ignores unknown fields). This is purely about the write
/// side: `save_routing_rules` re-serializes the whole document from a struct that no longer has
/// these fields, so without this the FIRST save after the upgrade — an unrelated rule edit, an
/// auto-save, a connect — would silently delete a list of domains the user typed by hand. The
/// decision was «remove the feature, keep the data»: blocking may come back as a filtering
/// DNS on the server, and ignoring the data costs nothing while destroying it is irreversible.
///
/// AN EXPLICIT ALLOW-LIST, not «carry every unknown key». A blanket carry-forward would resurrect
/// whatever a FUTURE removal deliberately drops and would make this document impossible to shrink
/// ever again. Two named keys, one named reason.
const CARRIED_LEGACY_KEYS: [&str; 2] = ["block", "block_enabled"];

/// Copy `CARRIED_LEGACY_KEYS` from the document currently on disk into the one about to replace it.
///
/// Pure and parameterised by the previous TEXT rather than reading the file itself, so the whole
/// behaviour is testable without a data dir — the shape this module already uses for
/// `load_routing_rules_from`.
///
/// A previous document that will not parse contributes nothing and is NOT an error: that is the
/// corrupt-file case, whose only sanctioned exit is the D-02 reset — and a reset must not resurrect
/// fragments of the very file the user asked to throw away.
fn carry_forward_legacy_keys(previous: &str, next: &mut serde_json::Value) {
    let Ok(serde_json::Value::Object(old)) = serde_json::from_str::<serde_json::Value>(previous)
    else {
        return;
    };
    let Some(obj) = next.as_object_mut() else {
        return;
    };
    for key in CARRIED_LEGACY_KEYS {
        if let Some(value) = old.get(key) {
            obj.insert(key.to_string(), value.clone());
        }
    }
}

impl Default for RoutingRules {
    fn default() -> Self {
        Self {
            direct: Vec::new(),
            proxy: Vec::new(),
            process_mode: "exclude".to_string(),
            processes: Vec::new(),
        }
    }
}

// ─── File paths ─────────────────────────────────────

fn routing_rules_path() -> PathBuf {
    user_data_dir().join("routing_rules.json")
}

fn resolved_dir() -> PathBuf {
    let dir = user_data_dir().join("resolved");
    std::fs::create_dir_all(&dir).ok();
    dir
}

fn exclusions_file_path() -> PathBuf {
    resolved_dir().join("exclusions.txt")
}

// NOTE — there is deliberately no `blocked_file_path()` here any more. The resolved
// `blocked.txt` belonged to the removed site-blocking feature; `process_block.txt` below is a
// DIFFERENT feature (process filtering) that stays, despite the shared word in its name.

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
    load_routing_rules_from(&routing_rules_path())
}

/// The real loader, parameterised by path so the absent / healthy / CORRUPT triple can be
/// exercised against a temp directory instead of the live data dir (D-02, 30.1 blocker 2).
///
/// Mirrors `app_settings.rs`'s `load_app_settings_from` split, and exists for the same reason:
/// the corrupt branch is the one the connect path now REFUSES on, so it has to be reachable
/// from a test that owns its own file rather than racing every other test for the one real
/// `routing_rules.json` beside the test binary.
///
/// The two error dispositions here are deliberately different and must stay that way:
///   * no file at all → `Ok(default)`. Nothing has ever been routed; there is no policy to
///     misread, so a fresh install connects.
///   * an unreadable or invalid file → `Err`. Something IS written there and we cannot read it.
///     Answering `default` would be the app inventing an empty routing policy and attributing
///     it to the user, which is the exact lie this phase exists to remove.
pub fn load_routing_rules_from(path: &std::path::Path) -> Result<RoutingRules, String> {
    match std::fs::read_to_string(path) {
        Ok(content) => {
            let rules: RoutingRules = serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse routing_rules.json: {e}"))?;
            eprintln!(
                "[routing] Loaded: {} direct, {} proxy, {} processes (mode={})",
                rules.direct.len(), rules.proxy.len(),
                rules.processes.len(), rules.process_mode
            );
            Ok(rules)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("[routing] No routing_rules.json found, returning defaults");
            Ok(RoutingRules::default())
        }
        Err(e) => Err(format!("Failed to read routing_rules.json: {e}")),
    }
}

#[tauri::command]
pub fn save_routing_rules(rules: RoutingRules) -> Result<(), String> {
    save_routing_rules_to(&routing_rules_path(), &rules)
}

fn save_routing_rules_to(path: &std::path::Path, rules: &RoutingRules) -> Result<(), String> {
    validate_process_mode(&rules.process_mode)?;
    let mut document =
        serde_json::to_value(rules).map_err(|e| format!("Failed to serialize: {e}"))?;
    // The removed feature's data rides through. Best-effort by construction: no previous file (a
    // fresh install) and an unreadable one (the D-02 corrupt case, whose only exit is a reset that
    // must NOT resurrect fragments) both contribute nothing, and neither is an error.
    if let Ok(previous) = std::fs::read_to_string(path) {
        carry_forward_legacy_keys(&previous, &mut document);
    }
    let json = serde_json::to_string_pretty(&document)
        .map_err(|e| format!("Failed to serialize: {e}"))?;
    // F4 (30.1 milestone review, blocker 4): atomic write — `routing_rules.json` is the ONLY
    // durable home of the user's hand-built rule list, and `resolve_and_apply` rewrites it on the
    // vpn_connect hot path. A truncate-then-write cut short by a crash / power loss / ENOSPC leaves
    // invalid JSON, and `load_routing_rules` turns invalid JSON into a hard error (:164) — i.e. the
    // user silently loses every rule they ever typed. temp → fsync → rename → parent-dir fsync
    // swaps the file in whole or not at all. D-29: the writer never logs the bytes.
    crate::commands::manifest::write_bytes_atomic(path, json.as_bytes())
        .map_err(|e| format!("Failed to write routing_rules.json: {e}"))?;
    eprintln!(
        "[routing] Saved: {} direct, {} proxy, {} processes",
        rules.direct.len(), rules.proxy.len(), rules.processes.len()
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
        // F4 (30.1 milestone review, blocker 4): this is THE ONE `std::fs::write` in this module
        // that is deliberately NOT converted to `manifest::write_bytes_atomic`, and it must stay
        // that way. Every other write here targets our own data dir; this one targets a path the
        // USER picked in a save dialog — their Documents folder, a USB stick, anywhere. The atomic
        // writer `create_dir_all`s the parent and stages `<name>.<pid>.<seq>.tmp` NEXT TO the
        // destination, so converting this would litter the user's own folder with temp files (and
        // silently create directories there). There is also nothing to protect: this file is a
        // copy for the user, never read back by the app and never read by the C++ core, so a
        // half-written export costs the user a re-export, not their data. Leave it alone.
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
    let exclusions_json = user_data_dir().join("exclusions.json");
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

/// Separate unavailable data from invalid rules or a failed policy write.
#[derive(Debug)]
pub struct RoutingPreparationError {
    pub reason: &'static str,
    pub detail: String,
}

fn required_geodata_missing(rules: &RoutingRules, state: &GeoDataState) -> Result<bool, String> {
    let entries = || rules.direct.iter().chain(rules.proxy.iter());
    let geoip_missing = entries().any(|entry| entry.entry_type == "geoip")
        && state.geoip_data.lock().map_err(|e| e.to_string())?
            .as_ref().is_none_or(Vec::is_empty);
    let geosite_missing = entries().any(|entry| entry.entry_type == "geosite")
        && state.geosite_data.lock().map_err(|e| e.to_string())?
            .as_ref().is_none_or(Vec::is_empty);
    Ok(geoip_missing || geosite_missing)
}

async fn prepare_required_routing_data(
    rules: &RoutingRules,
    state: &Arc<GeoDataState>,
    app: Option<&tauri::AppHandle>,
) -> Result<(), String> {
    if required_geodata_missing(rules, state)? {
        // Join an existing update, then recheck its result before requesting any download.
        // The scheduler releases this lock before acquiring lifecycle_flow, so no cycle forms.
        let _update_guard = state.update_in_flight.lock().await;
        let cached_state = Arc::clone(state);
        tokio::task::spawn_blocking(move || geodata_v2ray::load_cached_geodata(&cached_state))
            .await.map_err(|e| format!("Cached geodata load task failed: {e}"))??;
        if required_geodata_missing(rules, state)? {
            let app = app.ok_or("Required geodata is not available")?;
            let _busy = geodata_v2ray::BusyFlag::acquire();
            geodata_v2ray::download_geodata_locked(app, state).await?;
        }
        if required_geodata_missing(rules, state)? {
            return Err("Required geodata was not loaded".into());
        }
    }

    let mut seen = HashSet::new();
    for entry in rules.direct.iter().chain(rules.proxy.iter()) {
        if entry.entry_type != "iplist_group" { continue; }
        let group = entry.value.strip_prefix("iplist_group:").unwrap_or(&entry.value);
        if !seen.insert(group) || group_cache_path_pub(group).exists() { continue; }
        if app.is_none() { return Err("A required group is not available".into()); }
        // Reuse the existing validation, source selection, parse guard and atomic cache writer.
        if matches!(
            crate::geodata::refresh_group_cache_if_stale(group, std::time::Duration::ZERO).await?,
            crate::geodata::GroupRefreshOutcome::Rejected
        ) {
            return Err("A required group download was rejected".into());
        }
    }
    Ok(())
}

/// Prepare required lists before applying policy. `false` means the user cancelled the connect.
/// A download never becomes a terminal routing error merely because it is still in progress.
pub async fn prepare_and_apply_for_connect(
    config_path: &str,
    rules: &RoutingRules,
    state: &Arc<GeoDataState>,
    app: Option<&tauri::AppHandle>,
    generation: &std::sync::atomic::AtomicU64,
    expected_generation: u64,
) -> Result<bool, RoutingPreparationError> {
    use std::sync::atomic::Ordering;
    if generation.load(Ordering::SeqCst) != expected_generation { return Ok(false); }
    // A cancelled connection must not drop an updater's lock while its blocking atomic
    // commit is still running. Keep data preparation alive independently; only this caller
    // may apply policy or proceed to the VPN spawn after preparation has completed.
    let prepare_rules = rules.clone();
    let prepare_state = Arc::clone(state);
    let prepare_app = app.cloned();
    let preparing = tokio::spawn(async move {
        prepare_required_routing_data(&prepare_rules, &prepare_state, prepare_app.as_ref()).await
    });
    let cancelled = async {
        while generation.load(Ordering::SeqCst) == expected_generation {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    };
    tokio::select! {
        biased;
        _ = cancelled => return Ok(false),
        prepared = preparing => {
            if generation.load(Ordering::SeqCst) != expected_generation { return Ok(false); }
            prepared.map_err(|e| RoutingPreparationError {
                reason: crate::lifecycle::ROUTING_DATA_UNAVAILABLE_REASON,
                detail: format!("Routing data preparation task failed: {e}"),
            })?.map_err(|detail| RoutingPreparationError {
                reason: crate::lifecycle::ROUTING_DATA_UNAVAILABLE_REASON, detail,
            })?;
        }
    }
    if generation.load(Ordering::SeqCst) != expected_generation { return Ok(false); }
    let applied = resolve_and_apply_reporting(config_path, rules, state, app);
    if generation.load(Ordering::SeqCst) != expected_generation { return Ok(false); }
    applied.map_err(|detail| RoutingPreparationError {
            reason: crate::lifecycle::ROUTING_RULES_APPLY_FAILED_REASON, detail,
        })?;
    Ok(generation.load(Ordering::SeqCst) == expected_generation)
}

/// Resolve and write a complete policy. Background refreshes never initiate downloads here.
pub fn resolve_and_apply_inner(
    config_path: &str,
    rules: &RoutingRules,
    state: &GeoDataState,
) -> Result<(), String> {
    resolve_and_apply_reporting(config_path, rules, state, None)
}

/// `resolve_and_apply_inner` plus a front-end handle to REPORT skipped entries on (item 13).
///
/// The handle is optional because two of the five call sites legitimately have nowhere to report
/// to — a background timer has no user watching it and no connect to annotate. Passing `None`
/// there is a decision, not an oversight: those paths still collect the skips, they simply have no
/// channel, and the next connect re-resolves and reports.
pub fn resolve_and_apply_reporting(
    config_path: &str,
    rules: &RoutingRules,
    state: &GeoDataState,
    app: Option<&tauri::AppHandle>,
) -> Result<(), String> {
    // Reject an unsupported mode before resolving or replacing any policy files.
    let (process_direct, process_proxy, process_block) = resolve_process_rules(rules)?;
    eprintln!("[routing] Resolving rules and generating config files...");

    // Item 13: accumulated across BOTH lists, so one notice names everything that is not in force
    // rather than two notices naming half of it each.
    let mut unresolved: Vec<String> = Vec::new();

    // Resolve direct entries
    let direct_entries = resolve_entries_collecting(&rules.direct, state, &mut unresolved)?;
    // Resolve proxy entries (these also go to exclusions in selective mode)
    let proxy_entries = resolve_entries_collecting(&rules.proxy, state, &mut unresolved)?;

    // Item 13: tell the user WHICH entries are not in force, on the channel the connect already
    // uses for its own warning line six lines further down the caller. The collected names are shown before the complete policy is refused below.
    if let (Some(app), Some(notice)) = (app, unresolved_entries_notice(&unresolved)) {
        use tauri::Emitter;
        crate::logging::log_app("WARN", &format!("[routing] {notice}"));
        app.emit(
            "vpn-log",
            serde_json::json!({ "message": notice, "level": "warn" }),
        )
        .ok();
    }

    if !crate::routing_policy::resolution_is_complete(&unresolved) {
        return Err("One or more routing lists could not be resolved; refusing a partial policy".to_string());
    }

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
    let explicit_entries = |entries: &[RuleEntry]| -> Vec<String> {
        entries.iter().flat_map(|entry| match entry.entry_type.as_str() {
            "domain" => crate::domain_scope::expand_domain_rule(&entry.value),
            "ip" | "cidr" => vec![entry.value.clone()],
            _ => Vec::new(),
        }).collect()
    };
    let resolved_exclusions = crate::routing_policy::build_policy(
        &vpn_mode, &direct_entries, &proxy_entries,
        &explicit_entries(&rules.direct), &explicit_entries(&rules.proxy),
    );

    let exclusions_content = resolved_exclusions.join("\n");

    // Write resolved files.
    //
    // F4 (30.1 milestone review, blocker 4): all four resolved files go through the atomic writer.
    // These are read by the C++ VPN core at spawn — a truncate-then-write interrupted by a crash /
    // power loss / ENOSPC would hand the core a HALF file, i.e. a silently incomplete bypass or
    // process list, which is a routing decision the user never made. temp → fsync → rename →
    // parent-dir fsync means the core sees the old file or the new one, never a mixture.
    //
    // (It was five files until site blocking was removed on 2026-09-03; `blocked.txt` is no longer
    // written and the TOML no longer points at one — see `update_toml_config`.)
    //
    // ORDERING IS LOAD-BEARING and survives the conversion: the four .txt files below are written
    // BEFORE `update_toml_config` writes the TOML that POINTS AT them. A pointer must never become
    // durable before its target, or a crash between the two leaves the core following a path to a
    // stale/absent file.
    crate::commands::manifest::write_bytes_atomic(
        &exclusions_file_path(),
        exclusions_content.as_bytes(),
    )
    .map_err(|e| format!("Failed to write exclusions.txt: {e}"))?;

    eprintln!(
        "[routing] Written: exclusions={} entries, mode={}",
        exclusions_content.lines().filter(|l| !l.is_empty()).count(),
        vpn_mode
    );

    // Process filter files
    // F4 (30.1 milestone review, blocker 4): same atomic writer as the two files above. The joined
    // content is bound to a `let` first so the String outlives the borrow handed to the writer.
    let process_direct_content = process_direct.join("\n");
    let process_proxy_content = process_proxy.join("\n");
    let process_block_content = process_block.join("\n");
    crate::commands::manifest::write_bytes_atomic(
        &process_direct_file_path(),
        process_direct_content.as_bytes(),
    )
    .map_err(|e| format!("Failed to write process_direct.txt: {e}"))?;
    crate::commands::manifest::write_bytes_atomic(
        &process_proxy_file_path(),
        process_proxy_content.as_bytes(),
    )
    .map_err(|e| format!("Failed to write process_proxy.txt: {e}"))?;
    crate::commands::manifest::write_bytes_atomic(
        &process_block_file_path(),
        process_block_content.as_bytes(),
    )
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
        update_toml_config(config_path, &vpn_mode, &exclusions_for_toml)?;
    }

    // There is no blocking half here any more, and no OS-level one either — see the module note on
    // `RoutingRules` for why the feature went, and the hosts-file guard in the test module for why
    // the Windows hosts writer that once sat in this file is not coming back.

    Ok(())
}

/// Resolve all rules and generate config files for sidecar (Tauri command wrapper)
///
/// FAB-02: this command is the FIFTH writer of the five resolved rule files the C++ sidecar opens at
/// spawn, and it was the unserialized one. CR-01 fixed the background scheduler by giving it the
/// `lifecycle_flow` serializer the three lifecycle callers hold, on the premise that those three were
/// the only other writers — they were not. This command runs whenever the user edits routing rules
/// (including the silent autosave), and the scheduler's first cycle fires eight seconds after launch,
/// which is exactly when a user is likely to be editing. Two concurrent writers of the same files
/// mean the sidecar can be handed a mixed generation.
///
/// `lock().await`, not `try_lock`: this one is user-initiated and must not be silently dropped. The
/// scheduler uses `try_lock` because a background refresh may skip a cycle; a click may not. No
/// deadlock is possible — every other holder takes this lock alone or (in the scheduler's case) after
/// `update_in_flight`, and this path takes no other lock, so no cycle can form.
#[tauri::command]
pub async fn resolve_and_apply(
    config_path: String,
    rules: RoutingRules,
    state: tauri::State<'_, Arc<GeoDataState>>,
    app_state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    let lifecycle_flow = Arc::clone(&app_state.lifecycle_flow);
    let _flow_guard = lifecycle_flow.lock().await;

    // Save rules first
    save_routing_rules(rules.clone())?;

    resolve_and_apply_inner(&config_path, &rules, state.as_ref())
}

/// How many unresolved entries the notice names before it starts counting instead.
///
/// A geodata database that failed to download makes EVERY geo entry skip at once, and a rules file
/// can hold hundreds. Without a cap the message would be the user's whole rule list pasted onto the
/// log channel on every connect.
const UNRESOLVED_NOTICE_MAX_ENTRIES: usize = 8;

/// Longest single identifier the notice will show. The identifiers are the user's own typed rule
/// values, so their length is not ours to trust.
const UNRESOLVED_NOTICE_MAX_ID_LEN: usize = 40;

/// Build the user-facing notice for entries that did not resolve — `None` when nothing was skipped
/// (item 13, 30.1 review).
///
/// Pure, so the two properties that matter are assertions rather than hopes: it is BOUNDED however
/// many entries failed, and it carries NOTHING that could spell a path or a credential.
///
/// **D-29.** Every identifier is a rule value the user typed and a hand-edited `routing_rules.json`
/// can hold anything at all, so this sanitizes rather than trusts. Only characters that can spell a
/// rule identifier survive — letters, digits, `_ - . :` — which by construction cannot form a path
/// separator, a quote, a newline or a `key=value`. The resolver's own error text is never included:
/// it is English, developer-facing, and the geodata paths appear in it.
///
/// The message is English because it lands on the `vpn-log` channel, which is the app's technical
/// log — the same place the C++ core's own English output goes. This is not the localized error
/// surface; a reason code would be the shape to use there (see `lifecycle.rs`).
fn unresolved_entries_notice(unresolved: &[String]) -> Option<String> {
    if unresolved.is_empty() {
        return None;
    }

    let safe: Vec<String> = unresolved
        .iter()
        .take(UNRESOLVED_NOTICE_MAX_ENTRIES)
        .map(|id| {
            let cleaned: String = id
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ':'))
                .take(UNRESOLVED_NOTICE_MAX_ID_LEN)
                .collect();
            if cleaned.is_empty() {
                "<unnamed>".replace(['<', '>'], "")
            } else {
                cleaned
            }
        })
        .collect();

    // The TOTAL is always stated, so a truncated list is never mistaken for the whole answer —
    // showing part of a list as if it were all of it is the same class of lie as the rest of this
    // phase.
    let mut message = format!(
        "{} routing entr{} could not be resolved and {} NOT in force: {}",
        unresolved.len(),
        if unresolved.len() == 1 { "y" } else { "ies" },
        if unresolved.len() == 1 { "is" } else { "are" },
        safe.join(", "),
    );
    if unresolved.len() > safe.len() {
        message.push_str(&format!(" (+{} more)", unresolved.len() - safe.len()));
    }
    Some(message)
}

/// Resolve rule entries, COLLECTING the ones that could not be resolved (item 13, 30.1 review).
///
/// **The defect this replaces.** All three geo arms below used to swallow their failure into an
/// `eprintln!` and an empty vector, and the resolve still returned `Ok`. A packaged Windows build
/// has no console attached, so that print went nowhere: the app knew a preset had stopped routing
/// and threw the fact away, while the chip naming that preset stayed on screen looking active.
///
/// A collector can return partial entries for diagnostics. The application must refuse the
/// complete policy if this list is nonempty: omitting one protected group can silently select
/// DIRECT, even when every other group resolved correctly.
///
/// `unresolved` is appended to, never cleared, so one call site can accumulate across the direct
/// and proxy lists.
fn resolve_entries_collecting(
    entries: &[RuleEntry],
    state: &GeoDataState,
    unresolved: &mut Vec<String>,
) -> Result<Vec<String>, String> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();

    for entry in entries {
        let resolved = match entry.entry_type.as_str() {
            // ROUTE-10. `domain` used to share this arm with `ip`/`cidr`, which is precisely why
            // nothing domain-shaped ever happened to it: the value went to the C++ core byte for
            // byte, and the core reads a bare name as «this exact host and its www. twin»
            // (`core/src/domain_filter.cpp:74-82`). A user who typed `maxmind.com` meant the SITE
            // — owner's ruling, 2026-09-03 — so the name is expanded into the pair the core merges
            // into one key carrying both match modes. All the guards (a wildcard the user typed,
            // an address, a dotless or malformed value) live in `domain_scope` beside the citation
            // that justifies each one.
            "domain" => crate::domain_scope::expand_domain_rule(&entry.value),
            // Untouched, and the reason it must stay untouched is not symmetry: `*.1.2.3.4` would
            // be filed in the core's DOMAIN table instead of its address table and match nothing.
            "ip" | "cidr" => {
                vec![entry.value.clone()]
            }
            "geoip" => {
                // value = "geoip:ru" → category = "ru"
                let category = entry.value
                    .strip_prefix("geoip:")
                    .unwrap_or(&entry.value);
                match geodata_v2ray::resolve_geoip(state, category) {
                    Ok(cidrs) => cidrs,
                    Err(_) => {
                        // The resolver's own error text is NOT carried: it is developer detail and
                        // can quote a file path. What the user needs is WHICH RULE is not in force.
                        unresolved.push(format!("geoip:{category}"));
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
                    Err(_) => {
                        unresolved.push(format!("geosite:{category}"));
                        Vec::new()
                    }
                }
            }
            "iplist_group" => {
                // value = "iplist_group:games" → group = "games"
                // Mirror the geoip/geosite arms: the persisted value carries the
                // `iplist_group:` prefix (re-added by the FE serializeEntry, see T-26/D-04),
                // but the group cache is keyed by the BARE id. `unwrap_or(&entry.value)`
                // keeps this arm tolerant of legacy bare values too.
                let group = entry.value
                    .strip_prefix("iplist_group:")
                    .unwrap_or(&entry.value);
                // Load from cached group data
                let cache_path = group_cache_path_pub(group);
                if cache_path.exists() {
                    let content = std::fs::read_to_string(&cache_path)
                        .map_err(|e| format!("Failed to read group cache '{}': {e}", group))?;
                    let domains: Vec<String> = serde_json::from_str(&content)
                        .map_err(|e| format!("Failed to parse group cache '{}': {e}", group))?;
                    // ROUTE-10, and this one is a JUDGEMENT CALL rather than a transcription.
                    // A group cache is a list of fully-qualified hostnames with NO type
                    // information attached — `socials.json` is 673 entries and zero wildcards —
                    // so nothing in the data says whether `4pda.to` means the site or that single
                    // host. A hand-typed `4pda.to` now means the site; a preset group is the same
                    // user asking for the same thing with one click. Leaving groups exact would
                    // make the meaning of a name depend on WHICH DOOR it came through, which is
                    // invisible from the UI and is exactly the «works for my rule, not for the
                    // preset» report this fix exists to end.
                    domains
                        .iter()
                        .flat_map(|d| crate::domain_scope::expand_domain_rule(d))
                        .collect()
                } else {
                    unresolved.push(format!("iplist_group:{group}"));
                    Vec::new()
                }
            }
            _ => {
                // NOT a skip, and deliberately not reported to the user: the entry IS applied,
                // as a domain, which is the sensible reading of a type this build does not know.
                // Nothing silently stops working, so there is nothing to warn about — but the
                // `eprintln!` still went to a console that does not exist in a packaged build, so
                // it goes to the real log sink instead. D-29: the TYPE only, never the value,
                // which is the user's own rule text.
                crate::logging::log_app(
                    "WARN",
                    &format!(
                        "[routing] unknown entry type '{}' — treating it as a domain",
                        entry.entry_type.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').take(32).collect::<String>(),
                    ),
                );
                // «As a domain» has to mean the same thing here as it does in the `domain` arm
                // above, or an unknown type would quietly get a NARROWER scope than the type it
                // is standing in for — a second, invisible version of ROUTE-10.
                crate::domain_scope::expand_domain_rule(&entry.value)
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
type ResolvedProcessRules = (Vec<String>, Vec<String>, Vec<String>);

fn resolve_process_rules(rules: &RoutingRules) -> Result<ResolvedProcessRules, String> {
    validate_process_mode(&rules.process_mode)?;
    let mut direct = Vec::new();
    let mut proxy = Vec::new();
    let block = Vec::new(); // No UI for blocking processes yet, but supported

    if rules.processes.is_empty() {
        return Ok((direct, proxy, block));
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
        _ => return Err("Unsupported routing process mode".to_string()),
    }

    Ok((direct, proxy, block))
}

/// Update TOML config with resolved routing rules.
/// Uses file paths for the exclusions and process lists (C++ core reads from files).
fn update_toml_config(
    config_path: &str,
    vpn_mode: &str,
    exclusions: &[String],
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
    if crate::routing_policy::requires_override_support(exclusions) {
        doc["routing_policy_version"] = value(1);
        // Inspect a fresh TLS/QUIC connection before choosing DIRECT when DNS is external.
        doc["exclusions_tcp_early_ack_enabled"] = value(true);
    } else {
        doc.remove("routing_policy_version");
    }

    // SITE BLOCKING IS GONE (2026-09-03), and these two removals are LEGACY CLEANUP rather than
    // leftovers of the feature. A config written by any earlier build still carries
    // `blocked_file = ".../resolved/blocked.txt"`, and the C++ core opens whatever that key names
    // at spawn. Merely not writing the key would leave the old pointer — and the old resolved file
    // beside it — in place, so the user would keep being blocked by a feature the app no longer
    // has and no longer offers any way to edit. Both keys are therefore removed UNCONDITIONALLY,
    // every time this function runs.
    doc.remove("blocked");
    doc.remove("blocked_file");

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
        "[routing] TOML updated: vpn_mode={}, exclusions_file={}",
        vpn_mode,
        exclusions.len()
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

// ─── Tests ──────────────────────────────────────────

#[cfg(test)]
mod tests {
    use crate::routing_policy::{build_general_exclusions, DEFAULT_PRIVATE_EXCLUSIONS};
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

    #[test]
    fn security_missing_routing_file_keeps_fresh_install_defaults() {
        let dir = f4_tempdir();
        let rules = load_routing_rules_from(&dir.join("missing.json")).unwrap();
        assert_eq!(rules.process_mode, "exclude");
        assert!(rules.direct.is_empty() && rules.proxy.is_empty() && rules.processes.is_empty());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn security_unreadable_routing_path_is_not_an_empty_policy() {
        let dir = f4_tempdir();
        let policy = dir.join("routing_rules.json");
        std::fs::create_dir(&policy).unwrap();
        let error = load_routing_rules_from(&policy).unwrap_err();
        assert!(error.starts_with("Failed to read routing_rules.json:"), "{error}");
        assert!(policy.is_dir(), "a failed read must leave the existing path intact");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn security_invalid_utf8_routing_file_is_not_an_empty_policy() {
        let dir = f4_tempdir();
        let policy = dir.join("routing_rules.json");
        let original = [0xff, 0xfe, 0x80];
        std::fs::write(&policy, original).unwrap();
        let error = load_routing_rules_from(&policy).unwrap_err();
        assert!(error.starts_with("Failed to read routing_rules.json:"), "{error}");
        assert_eq!(std::fs::read(&policy).unwrap(), original);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn security_corrupt_routing_json_remains_an_error() {
        let dir = f4_tempdir();
        let policy = dir.join("routing_rules.json");
        std::fs::write(&policy, "{not valid json").unwrap();
        let error = load_routing_rules_from(&policy).unwrap_err();
        assert!(error.starts_with("Failed to parse routing_rules.json:"), "{error}");
        assert_eq!(std::fs::read_to_string(&policy).unwrap(), "{not valid json");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn security_supported_process_modes_preserve_existing_routing() {
        let dir = f4_tempdir();
        let policy = dir.join("routing_rules.json");
        for mode in ["exclude", "only"] {
            let json = serde_json::json!({
                "direct": [{"id":"d1", "type":"domain", "value":"example.org", "label":null}],
                "proxy": [{"id":"p1", "type":"cidr", "value":"203.0.113.0/24", "label":null}],
                "process_mode": mode,
                "processes": ["chrome.exe"],
                "block": [],
                "block_enabled": true
            });
            let original = json.to_string();
            std::fs::write(&policy, &original).unwrap();
            let rules = load_routing_rules_from(&policy).unwrap();
            assert_eq!(rules.process_mode, mode);
            assert_eq!(rules.direct[0].value, "example.org");
            assert_eq!(rules.proxy[0].value, "203.0.113.0/24");
            assert_eq!(rules.processes, v(&["chrome.exe"]));
            assert_eq!(std::fs::read_to_string(&policy).unwrap(), original);
            assert_eq!(parse_routing_rules_capped(&original).unwrap().process_mode, mode);

            save_routing_rules_to(&policy, &rules).unwrap();
            let saved: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(&policy).unwrap()).unwrap();
            assert_eq!(saved["block"], json["block"]);
            assert_eq!(saved["block_enabled"], json["block_enabled"]);
            assert_eq!(saved["direct"], json["direct"]);
            assert_eq!(saved["proxy"], json["proxy"]);
            assert_eq!(saved["processes"], json["processes"]);
            assert_eq!(saved["process_mode"], json["process_mode"]);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn security_absent_process_mode_keeps_legacy_default() {
        let dir = f4_tempdir();
        let policy = dir.join("routing_rules.json");
        let original = r#"{"processes":["chrome.exe"],"block":[],"block_enabled":true}"#;
        std::fs::write(&policy, original).unwrap();
        let rules = load_routing_rules_from(&policy).unwrap();
        assert_eq!(rules.process_mode, "exclude");
        assert_eq!(rules.processes, v(&["chrome.exe"]));
        assert_eq!(parse_routing_rules_capped(original).unwrap().process_mode, "exclude");
        let (direct, proxy, block) = resolve_process_rules(&rules).unwrap();
        assert_eq!(direct, v(&["chrome.exe"]));
        assert!(proxy.is_empty() && block.is_empty());
        assert_eq!(std::fs::read_to_string(&policy).unwrap(), original);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn security_unsupported_process_modes_reject_load_and_both_import_doors() {
        let dir = f4_tempdir();
        let policy = dir.join("routing_rules.json");
        for mode in ["", "direct", "include", "ONLY", " only", "exclude "] {
            let json = serde_json::json!({"process_mode": mode, "processes": ["chrome.exe"]})
                .to_string();
            std::fs::write(&policy, &json).unwrap();
            let error = load_routing_rules_from(&policy).unwrap_err();
            assert!(error.contains("Unsupported routing process mode"), "{mode:?}: {error}");
            assert_eq!(parse_routing_rules_capped(&json).unwrap_err(), "routing.import_invalid");
            assert!(serde_json::from_str::<RoutingRules>(&json).is_err());
            assert_eq!(std::fs::read_to_string(&policy).unwrap(), json);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn security_unsupported_process_mode_cannot_replace_saved_rules() {
        let dir = f4_tempdir();
        let policy = dir.join("routing_rules.json");
        let original = r#"{"process_mode":"only","processes":["protected.exe"]}"#;
        std::fs::write(&policy, original).unwrap();
        let invalid = RoutingRules {
            process_mode: "unknown".to_string(),
            processes: v(&["protected.exe"]),
            ..RoutingRules::default()
        };
        assert!(save_routing_rules_to(&policy, &invalid).is_err());
        assert_eq!(std::fs::read_to_string(&policy).unwrap(), original);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn security_unsupported_process_mode_never_resolves_to_direct() {
        for processes in [Vec::new(), v(&["protected.exe"])] {
            let invalid = RoutingRules {
                process_mode: "unknown".to_string(),
                processes,
                ..RoutingRules::default()
            };
            assert!(resolve_process_rules(&invalid).is_err());
        }
    }

    #[test]
    fn security_supported_process_modes_keep_their_direction() {
        let processes = v(&["chrome.exe", "helper.exe"]);
        let mut rules = RoutingRules { processes: processes.clone(), ..RoutingRules::default() };
        assert_eq!(resolve_process_rules(&rules).unwrap(), (processes.clone(), Vec::new(), Vec::new()));
        rules.process_mode = "only".to_string();
        assert_eq!(resolve_process_rules(&rules).unwrap(), (Vec::new(), processes, Vec::new()));
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
        // (c) the writer renamed its temp away — no `.tmp` sibling of any shape is left behind.
        //     T-23-04 note: this was written as "positive proof the write went through
        //     write_bytes_atomic", on the reasoning that a plain `fs::write` never creates a
        //     `<name>.tmp` at all. That reasoning no longer holds — temp names are unique per call
        //     now, so the literal `<name>.tmp` is never created by anyone and asserting its absence
        //     proved nothing. Kept as a hygiene check (no temp survives a successful write); the
        //     atomicity itself is pinned where it belongs, in `atomic_write`'s own tests.
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|f| f.ends_with(".tmp"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "atomic writer must leave no leftover temp after a successful rename, found: {leftovers:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_exclusion_list_is_atomic_and_preserves_credentials() {
        let dir = f4_tempdir();
        let cfg = dir.join("TrustTunnel_swift-fox.toml");
        std::fs::write(&cfg, f4_sample_config()).unwrap();

        // save_exclusion_list also best-effort backs up to exclusions.json under
        // user_data_dir(); that side write is non-secret + swallowed, so it does not affect
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
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|f| f.ends_with(".tmp"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "atomic writer must leave no leftover temp after a successful rename, found: {leftovers:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── F4 (30.1 milestone review, blocker 4): the data-dir writers are atomic ──
    //
    // (Six of them when this was written; five since site blocking was removed on 2026-09-03 and
    // `blocked.txt` stopped being written at all.)
    //
    // The resolved `.txt` files and `routing_rules.json` were plain `std::fs::write`, i.e.
    // truncate-then-write. The C++ VPN core opens the resolved files at spawn, so a crash mid-write
    // could hand it a HALF list — a routing decision the user never made — and a half-written
    // `routing_rules.json` fails to parse, which `load_routing_rules` turns into a hard error:
    // every rule the user ever typed, gone.
    //
    // Two tests, on purpose. The behavioural one proves the writer produces the right bytes and
    // cleans up after itself TODAY; the source-text guard proves nobody quietly reverts a call
    // tomorrow. Neither alone is enough: the behavioural test passes on a plain `fs::write` too
    // (it also leaves the right bytes when nothing goes wrong), and the guard would happily pass
    // over a module that no longer resolves anything.

    /// Serializes the tests that drive the REAL data dir. `resolved_dir()` is
    /// `user_data_dir()/resolved` — under `cargo test` that is the test binary's own folder,
    /// and the four file names are FIXED. Two such tests running on different threads would
    /// overwrite each other's fixture and fail for reasons unrelated to the property under test.
    static DATA_DIR_TESTS: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn readiness_rules() -> RoutingRules {
        RoutingRules {
            direct: vec![f4_entry("geoip", "geoip:ru")],
            ..RoutingRules::default()
        }
    }

    fn readiness_state() -> Arc<GeoDataState> {
        let state = Arc::new(GeoDataState::new());
        *state.geoip_data.lock().unwrap() = Some(vec![geodata_v2ray::GeoIP {
            country_code: "ru".into(),
            cidrs: vec![geodata_v2ray::CidrEntry { ip: vec![203, 0, 113, 0], prefix: 24 }],
        }]);
        state
    }

    fn readiness_fixture() -> std::path::PathBuf {
        let root = crate::ssh::user_data_dir();
        assert!(root.starts_with(std::env::temp_dir()), "tests must use the private data root");
        assert!(root.file_name().unwrap().to_string_lossy().starts_with("tt-test-data-"));
        let dir = root.join("geodata");
        std::fs::create_dir_all(&dir).unwrap();
        for name in ["geoip.dat", "geosite.dat"] {
            let path = dir.join(name);
            if path.exists() { std::fs::remove_file(path).unwrap(); }
        }
        std::fs::write(exclusions_file_path(), "previous-policy").unwrap();
        dir
    }

    #[test]
    fn routing_readiness_loads_saved_lists_before_the_routing_tab_is_opened() {
        let _guard = DATA_DIR_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        let dir = readiness_fixture();
        // One real protobuf GeoIP category with the documentation-only 203.0.113.0/24 subnet.
        std::fs::write(dir.join("geoip.dat"), b"\x0a\x0e\x0a\x02ru\x12\x08\x0a\x04\xcb\x00\x71\x00\x10\x18").unwrap();
        let state = Arc::new(GeoDataState::new());
        let generation = std::sync::atomic::AtomicU64::new(1);
        let result = tokio::runtime::Runtime::new().unwrap().block_on(
            prepare_and_apply_for_connect("", &readiness_rules(), &state, None, &generation, 1)
        );
        assert!(result.unwrap(), "saved lists must work without a download or a mounted UI");
        assert!(std::fs::read_to_string(exclusions_file_path()).unwrap().contains("203.0.113.0/24"));
        std::fs::remove_file(dir.join("geoip.dat")).unwrap();
    }

    #[test]
    fn routing_readiness_waits_for_an_existing_download_then_applies_all_rules() {
        let _guard = DATA_DIR_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        readiness_fixture();
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let state = Arc::new(GeoDataState::new());
            let update = state.update_in_flight.lock().await;
            let rules = readiness_rules();
            let generation = std::sync::atomic::AtomicU64::new(1);
            let mut preparing = Box::pin(prepare_and_apply_for_connect("", &rules, &state, None, &generation, 1));
            assert!(tokio::time::timeout(std::time::Duration::from_millis(25), &mut preparing).await.is_err());
            assert_eq!(std::fs::read_to_string(exclusions_file_path()).unwrap(), "previous-policy");
            *state.geoip_data.lock().unwrap() = readiness_state().geoip_data.lock().unwrap().clone();
            drop(update);
            assert!(tokio::time::timeout(std::time::Duration::from_secs(2), preparing).await.unwrap().unwrap());
            assert!(std::fs::read_to_string(exclusions_file_path()).unwrap().contains("203.0.113.0/24"));
        });
    }

    #[test]
    fn routing_readiness_cancel_during_a_download_never_applies_or_resumes_the_connection() {
        let _guard = DATA_DIR_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        readiness_fixture();
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let state = Arc::new(GeoDataState::new());
            let update = state.update_in_flight.lock().await;
            let rules = readiness_rules();
            let generation = std::sync::atomic::AtomicU64::new(1);
            let mut preparing = Box::pin(prepare_and_apply_for_connect("", &rules, &state, None, &generation, 1));
            assert!(tokio::time::timeout(std::time::Duration::from_millis(25), &mut preparing).await.is_err());
            generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            assert!(!tokio::time::timeout(std::time::Duration::from_secs(1), preparing).await.unwrap().unwrap());
            *state.geoip_data.lock().unwrap() = readiness_state().geoip_data.lock().unwrap().clone();
            drop(update);
            let _completed = tokio::time::timeout(std::time::Duration::from_secs(1), state.update_in_flight.lock()).await.unwrap();
            assert_eq!(std::fs::read_to_string(exclusions_file_path()).unwrap(), "previous-policy");
        });
    }

    #[test]
    fn routing_readiness_uses_available_lists_without_waiting_for_an_optional_update() {
        let _guard = DATA_DIR_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        readiness_fixture();
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let state = readiness_state();
            let _update = state.update_in_flight.lock().await;
            let generation = std::sync::atomic::AtomicU64::new(1);
            assert!(tokio::time::timeout(std::time::Duration::from_secs(1),
                prepare_and_apply_for_connect("", &readiness_rules(), &state, None, &generation, 1)
            ).await.unwrap().unwrap());
        });
    }

    #[test]
    fn routing_readiness_cancel_wins_over_a_simultaneous_download_failure() {
        let _guard = DATA_DIR_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        readiness_fixture();
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let state = Arc::new(GeoDataState::new());
            let update = state.update_in_flight.lock().await;
            let rules = readiness_rules();
            let generation = std::sync::atomic::AtomicU64::new(1);
            let mut preparing = Box::pin(prepare_and_apply_for_connect("", &rules, &state, None, &generation, 1));
            assert!(tokio::time::timeout(std::time::Duration::from_millis(25), &mut preparing).await.is_err());
            generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            drop(update);
            // The unavailable-data result can arrive before the cancellation poll wakes up.
            assert!(!tokio::time::timeout(std::time::Duration::from_secs(1), preparing).await.unwrap().unwrap());
            assert_eq!(std::fs::read_to_string(exclusions_file_path()).unwrap(), "previous-policy");
        });
    }

    #[test]
    fn routing_readiness_unavailable_lists_preserve_the_previous_policy() {
        let _guard = DATA_DIR_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        readiness_fixture();
        let state = Arc::new(GeoDataState::new());
        let generation = std::sync::atomic::AtomicU64::new(1);
        let error = tokio::runtime::Runtime::new().unwrap().block_on(
            prepare_and_apply_for_connect("", &readiness_rules(), &state, None, &generation, 1)
        ).unwrap_err();
        assert_eq!(error.reason, crate::lifecycle::ROUTING_DATA_UNAVAILABLE_REASON);
        assert_eq!(std::fs::read_to_string(exclusions_file_path()).unwrap(), "previous-policy");
    }

    #[test]
    fn routing_readiness_invalid_categories_are_not_misreported_as_a_download() {
        let _guard = DATA_DIR_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        readiness_fixture();
        let state = readiness_state();
        let generation = std::sync::atomic::AtomicU64::new(1);
        let rules = RoutingRules {
            direct: vec![f4_entry("geoip", "geoip:not-a-real-category")],
            ..RoutingRules::default()
        };
        let error = tokio::runtime::Runtime::new().unwrap().block_on(
            prepare_and_apply_for_connect("", &rules, &state, None, &generation, 1)
        ).unwrap_err();
        assert_eq!(error.reason, crate::lifecycle::ROUTING_RULES_APPLY_FAILED_REASON);
        assert_eq!(std::fs::read_to_string(exclusions_file_path()).unwrap(), "previous-policy");
    }

    #[test]
    fn routing_readiness_requires_group_lists_and_reuses_a_ready_cache() {
        let _guard = DATA_DIR_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        readiness_fixture();
        let group = format!("readiness_{}", Uuid::new_v4().simple());
        let path = group_cache_path_pub(&group);
        let rules = RoutingRules {
            direct: vec![f4_entry("iplist_group", &format!("iplist_group:{group}"))],
            ..RoutingRules::default()
        };
        let state = Arc::new(GeoDataState::new());
        let generation = std::sync::atomic::AtomicU64::new(1);
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let error = runtime.block_on(prepare_and_apply_for_connect("", &rules, &state, None, &generation, 1)).unwrap_err();
        assert_eq!(error.reason, crate::lifecycle::ROUTING_DATA_UNAVAILABLE_REASON);
        assert_eq!(std::fs::read_to_string(exclusions_file_path()).unwrap(), "previous-policy");
        std::fs::write(&path, r#"["example.test"]"#).unwrap();
        assert!(runtime.block_on(prepare_and_apply_for_connect("", &rules, &state, None, &generation, 1)).unwrap());
        let applied = std::fs::read_to_string(exclusions_file_path()).unwrap();
        assert!(applied.contains("example.test") && applied.contains("*.example.test"));
        std::fs::remove_file(path).unwrap();
    }

    fn f4_entry(entry_type: &str, value: &str) -> RuleEntry {
        RuleEntry {
            id: Uuid::new_v4().to_string(),
            entry_type: entry_type.to_string(),
            value: value.to_string(),
            label: None,
        }
    }

    /// Temp files staged by `atomic_write` are named `<name>.<pid>.<seq>.tmp`, so a leftover from
    /// THIS write is any sibling starting with the target's file name and ending in `.tmp`. Scoped
    /// by prefix because `user_data_dir()` under test is the shared build-output folder.
    fn f4_leftover_temps(dir: &std::path::Path, file_name: &str) -> Vec<String> {
        std::fs::read_dir(dir)
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .filter(|f| f.starts_with(file_name) && f.ends_with(".tmp"))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// A config TOML as an earlier build left it: it already POINTS the C++ core at a resolved
    /// block list. Used by the removal tests below — the pointer is the thing that has to go.
    fn f4_config_with_blocked_pointer() -> String {
        // Inserted beside `vpn_mode`, NOT appended: everything after the `[endpoint]` header
        // belongs to that table, so a pointer tacked onto the end would be `endpoint.blocked_file`
        // — a key the core never reads and this test could never see.
        f4_sample_config().replace(
            "vpn_mode = \"general\"\n",
            "vpn_mode = \"general\"\nblocked_file = \"C:/stale/resolved/blocked.txt\"\n",
        )
    }

    /// Read the `blocked_file` pointer out of a config TOML. `None` = the key is absent, which is
    /// what every resolve must now produce.
    fn f4_toml_blocked_file(config_path: &std::path::Path) -> Option<String> {
        let doc: DocumentMut = std::fs::read_to_string(config_path).unwrap().parse().unwrap();
        doc.get("blocked_file")
            .and_then(|v| v.as_str())
            .map(String::from)
    }

    #[test]
    fn a_resolve_writes_every_data_dir_file_and_leaves_no_temp_sibling() {
        let _serial = DATA_DIR_TESTS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        let dir = f4_tempdir();
        let cfg = dir.join("TrustTunnel_swift-fox.toml");
        std::fs::write(&cfg, f4_sample_config()).unwrap();

        let rules = RoutingRules {
            direct: vec![f4_entry("domain", "direct.example.com")],
            proxy: Vec::new(),
            process_mode: "exclude".to_string(),
            processes: vec!["chrome.exe".to_string()],
        };

        // The rules JSON is the sixth writer and lives on its own command, so drive it explicitly.
        save_routing_rules(rules.clone()).expect("save_routing_rules must succeed");

        let state = geodata_v2ray::GeoDataState::new();
        resolve_and_apply_inner(&cfg.to_string_lossy(), &rules, &state)
            .expect("resolve_and_apply_inner must succeed on a valid config");

        // (a) every one of the six files carries the bytes the resolve computed.
        let exclusions = std::fs::read_to_string(exclusions_file_path()).unwrap();
        assert!(
            exclusions.lines().any(|l| l == "direct.example.com"),
            "exclusions.txt must carry the user's direct entry, got: {exclusions:?}"
        );
        assert!(
            exclusions.lines().any(|l| l == "10.0.0.0/8"),
            "exclusions.txt must still carry the T-33 default-private baseline"
        );
        assert_eq!(
            std::fs::read_to_string(process_direct_file_path()).unwrap(),
            "chrome.exe",
            "process_direct.txt must carry the excluded process (process_mode=exclude)"
        );
        assert_eq!(
            std::fs::read_to_string(process_proxy_file_path()).unwrap(),
            "",
            "process_proxy.txt must be written EMPTY, not left stale — the core reads it either way"
        );
        assert_eq!(
            std::fs::read_to_string(process_block_file_path()).unwrap(),
            "",
            "process_block.txt must be written EMPTY, not left stale"
        );
        let saved: RoutingRules =
            serde_json::from_str(&std::fs::read_to_string(routing_rules_path()).unwrap())
                .expect("routing_rules.json must be valid JSON after the write");
        assert_eq!(
            saved.direct.len(),
            1,
            "the rules JSON must round-trip"
        );

        // (b) no staging temp survived any of the five renames.
        let resolved = resolved_dir();
        for name in [
            "exclusions.txt",
            "process_direct.txt",
            "process_proxy.txt",
            "process_block.txt",
        ] {
            let leftovers = f4_leftover_temps(&resolved, name);
            assert!(
                leftovers.is_empty(),
                "the atomic writer must leave no temp beside {name}, found: {leftovers:?}"
            );
        }
        let leftovers = f4_leftover_temps(&user_data_dir(), "routing_rules.json");
        assert!(
            leftovers.is_empty(),
            "the atomic writer must leave no temp beside routing_rules.json, found: {leftovers:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn every_data_dir_write_in_this_module_goes_through_the_atomic_writer() {
        let source = include_str!("./routing_rules.rs");

        // Production body only: `mod tests` legitimately stages fixtures with `std::fs::write`.
        // WHOLE-LINE comments are stripped before counting — the comment at the export door
        // literally spells out `std::fs::write` to explain why that call stays, and a rule that
        // trips on the comment documenting it is a rule nobody can keep. Trailing comments on a
        // code line are left alone: they cannot introduce a call.
        let production: Vec<(usize, &str)> = source
            .lines()
            .enumerate()
            .map(|(i, line)| (i + 1, line))
            .take_while(|(_, line)| !line.trim_start().starts_with("#[cfg(test)]"))
            .filter(|(_, line)| !line.trim_start().starts_with("//"))
            .collect();
        assert!(
            production.len() > 200,
            "guard has lost its subject: could not slice the production body of routing_rules.rs \
             (got {} lines) — did the `#[cfg(test)]` marker move?",
            production.len()
        );

        // The ONE write that is deliberately NOT atomic, identified by what it writes TO:
        // `target` is the path the user picked in the export save dialog, and converting it would
        // drop a temp file in a folder that belongs to the user.
        //
        // There used to be a SECOND sanctioned exception here: two writes to the Windows hosts
        // file, from helpers nothing ever called. DEFENDER-2026-09-03 deleted them — see
        // `no_hosts_file_code_survives_in_the_shipped_binary` below for the evidence and the
        // reason. Its exclusion is REMOVED rather than left standing: an exclusion whose subject
        // no longer exists is a guard that has quietly stopped measuring, which is the exact
        // shape this phase has already caught five times.
        const EXPORT_DOOR: &str = "std::fs::write(target, ";

        let writes: Vec<(usize, &str)> = production
            .iter()
            .copied()
            .filter(|(_, line)| line.contains("std::fs::write("))
            .collect();

        // Locate-its-subject-first. If an excluded door is renamed or removed, this guard must go
        // RED rather than quietly guarding nothing — Phase 30 shipped two gates that passed while
        // the property they named did not hold, and both were vacuous for exactly this reason.
        assert_eq!(
            writes
                .iter()
                .filter(|(_, line)| line.contains(EXPORT_DOOR))
                .count(),
            1,
            "guard has lost its subject: expected exactly ONE export-door write matching \
             `{EXPORT_DOOR}` in export_routing_rules. If the export door moved, update this guard \
             deliberately — do not delete the exclusion."
        );
        let offenders: Vec<String> = writes
            .iter()
            .filter(|(_, line)| !line.contains(EXPORT_DOOR))
            .map(|(n, line)| format!("routing_rules.rs:{n}: {}", line.trim()))
            .collect();
        assert!(
            offenders.is_empty(),
            "every data-dir write in routing_rules.rs must go through \
             `manifest::write_bytes_atomic` (F4, 30.1 blocker 4) — the C++ core reads these files \
             and a truncate-then-write can hand it a half list. Found truncating write(s):\n{}",
            offenders.join("\n")
        );
    }

    // ── DEFENDER-2026-09-03: the hosts-file code is GONE, and stays gone ──
    //
    // WHY THIS GUARD EXISTS. Windows Defender flagged the shipped `3.0.0-r8kq3v` build as
    // `Trojan:Win32/Bearfoos.A!ml` seconds after a VPN reconnect. The verdict is a false positive
    // driven by a behavioural profile (unsigned binary, elevated process, a child that installs a
    // network driver, route and DNS rewrites) — the real remedy is Authenticode signing. But this
    // module was contributing a gratuitous signal on top of it: `%SystemRoot%\System32\drivers\etc\
    // hosts` and `0.0.0.0 {domain}` sat in the shipped binary as literals, and a read of that file
    // ran on EVERY disconnect, for code that could not possibly find anything to clean.
    //
    // It could not, and this is the evidence the deletion rests on: across the whole git history the
    // only Rust line that ever contained `apply_hosts_block` is its own signature
    // (`git log --all -G apply_hosts_block -p -- '*.rs'` yields exactly two added lines, both the
    // `fn` line — one for Pro, one for Light). The writer was born dead in `1b9059922` (v2.0.0), in
    // the same commit that moved blocking down to the C++ core's DNS handler. No released build ever
    // wrote a `# >>> TrustTunnel-blocked` block into anyone's hosts file, so removing the cleanup
    // strands nothing on any user's machine.
    //
    // WHY A SOURCE SCAN AND NOT A BEHAVIOUR TEST. The property is an ABSENCE, and absence has no
    // call site to exercise. A guard on an absence has one characteristic failure — passing
    // vacuously over a string it is not actually reading — so this one carries a positive control
    // per file: a sentinel that MUST be present. If the slice ever goes empty or the file is
    // renamed, the guard goes red saying it cannot measure, instead of quietly going green.
    #[test]
    fn no_hosts_file_code_survives_in_the_shipped_binary() {
        // (file label, source, sentinel that proves we are reading the real production half)
        let subjects: [(&str, &str, &str); 4] = [
            (
                "routing_rules.rs",
                include_str!("./routing_rules.rs"),
                // Sentinel changed from `fn blocked_file_path()` on 2026-09-03: that helper
                // belonged to the removed site-blocking feature, and a sentinel that no longer
                // exists turns this whole guard into a CANNOT-MEASURE. `exclusions_file_path` is
                // the resolved-file helper that stays.
                "fn exclusions_file_path()",
            ),
            ("lib.rs", include_str!("./lib.rs"), "invoke_handler"),
            ("tray.rs", include_str!("./tray.rs"), "restore_system_dns"),
            (
                "commands/vpn.rs",
                include_str!("./commands/vpn.rs"),
                "restore_system_dns",
            ),
        ];

        // Assembled from fragments so this ban list is not itself a hit when the guard is pointed
        // at its own file — and, more to the point, so nobody "fixes" a future red by editing the
        // literal. Each entry is a distinct way the removed code could come back: the helper names,
        // the hosts-file marker, the blackhole line it wrote, and the path it wrote them to.
        let banned: [(String, &str); 5] = [
            (
                format!("{}_{}", "hosts", "block"),
                "the hosts-block helpers or a call to them",
            ),
            (
                format!("{}_{}_{}", "hosts", "file", "path"),
                "the hosts-file path builder",
            ),
            (
                format!("{}-{}", "TrustTunnel", "blocked"),
                "the hosts-file block marker",
            ),
            (
                format!("{} {{", "0.0.0.0"),
                "the blackhole line the writer emitted",
            ),
            (
                format!(".join({:?})", "drivers"),
                "the path segment walk towards drivers/etc/hosts",
            ),
        ];

        let mut offenders: Vec<String> = Vec::new();

        for (label, source, sentinel) in subjects {
            // Production half only. Test modules legitimately quote these strings — this very test
            // does, and `commands/config.rs` uses the hosts path as its canonical "outside both
            // allowed roots" fixture. `#[cfg(test)]` code is not compiled into a release binary, so
            // it cannot put a string in what Defender scans.
            let production: Vec<(usize, &str)> = source
                .lines()
                .enumerate()
                .map(|(i, line)| (i + 1, line))
                .take_while(|(_, line)| !line.trim_start().starts_with("#[cfg(test)]"))
                // WHOLE-LINE comments only, same conservative rule the atomic-writer guard uses:
                // prose explaining why the hosts code is absent must remain writable, and a comment
                // cannot introduce a string into the binary anyway.
                .filter(|(_, line)| !line.trim_start().starts_with("//"))
                .collect();

            // Positive control. Both arms, because either alone is satisfiable by an empty slice.
            assert!(
                production.len() > 50,
                "guard has lost its subject: the production half of {label} is only {} lines — \
                 did the file move or did `#[cfg(test)]` climb to the top?",
                production.len()
            );
            assert!(
                production.iter().any(|(_, l)| l.contains(sentinel)),
                "guard has lost its subject: `{sentinel}` is no longer in the production half of \
                 {label}, so this scan is no longer reading the code it claims to guard"
            );

            for (needle, what) in &banned {
                for (n, line) in &production {
                    if line.contains(needle.as_str()) {
                        offenders.push(format!("{label}:{n}: {}  <- {what}", line.trim()));
                    }
                }
            }
        }

        assert!(
            offenders.is_empty(),
            "the Windows hosts file is not ours to touch and no released build ever wrote to it \
             (see the note above this test). Reintroducing a read or a write puts \
             `System32/drivers/etc/hosts` back into the shipped binary as a literal and hands \
             Defender's ML classifier a signal for code that does nothing. Blocking is enforced by \
             the C++ core's DNS handler. Found:\n{}",
            offenders.join("\n")
        );
    }

    // ── SITE BLOCKING IS REMOVED (2026-09-03, owner decision) ──
    //
    // The feature never worked and could not be made to work without changing the frozen C++ core
    // or standing up a filtering DNS on the user's own server: in TUN mode the core can only block
    // a name by DROPPING its DNS query, it answers with SILENCE rather than NXDOMAIN (so Windows
    // simply re-asks through another adapter), and its connection-refusal gate compares IP only.
    // Thirteen days of the logs contain not one `[ROUTE] BLOCKED`. Full analysis in
    // `.planning/milestones/v3.0-phases/30.1-*/30.1-BLOCKING-DIAGNOSIS.md`.
    //
    // REMOVING a feature has two failure modes and these tests pin one each, because either alone
    // ships a real defect:
    //
    //   * BREAKING EVERY EXISTING USER. Their `routing_rules.json` carries `block` and
    //     `block_enabled` right now. A rules file that will not parse ABORTS THE CONNECT (D-02,
    //     plan 06) — so if dropping the fields made those documents unreadable, this change would
    //     be a build that refuses to connect for everyone who ever opened the Routing tab. That is
    //     the most important property in the whole removal.
    //   * DELETING THEIR DATA. The save path re-serializes the entire document from a struct that
    //     no longer has those fields, so the FIRST save after the upgrade — an unrelated rule edit,
    //     an auto-save, a connect — would erase a list of domains somebody typed by hand. Ignoring
    //     the data costs nothing; destroying it is irreversible, and the owner left the door open
    //     for the feature to return as a filtering DNS.
    //
    // Plus a third fact, about the machines where the feature is currently ENFORCED: a config TOML
    // written by an earlier build still points the C++ core at `blocked.txt`, and the core opens
    // whatever that key names at spawn. Not writing the key is NOT enough — the stale pointer has
    // to be actively removed, or the user goes on being blocked by a feature the app no longer has
    // and no longer offers any way to edit.

    #[test]
    fn legacy_block_keys_still_deserialize() {
        // The verbatim shape of a `routing_rules.json` sitting on a user's disk today: BOTH removed
        // keys present, `block` carrying real entries, `block_enabled` true.
        let existing = r#"{
            "direct": [{"id":"d1","type":"domain","value":"example.org","label":null}],
            "proxy": [],
            "block": [{"id":"1","type":"domain","value":"ads.example.com","label":null}],
            "process_mode": "exclude",
            "processes": ["chrome.exe"],
            "block_enabled": true
        }"#;

        let rules: RoutingRules = serde_json::from_str(existing).expect(
            "a rules file carrying the removed block keys must still parse — an unparseable rules \
             file aborts the connect (D-02), so a strict struct here ships a build that refuses to \
             connect for every user who ever opened the Routing tab",
        );

        // …and the rest of the document is READ, not merely tolerated: a parse that silently
        // produced defaults would satisfy the line above while losing everything else.
        assert_eq!(rules.direct.len(), 1, "the direct list must survive");
        assert_eq!(rules.direct[0].value, "example.org");
        assert_eq!(rules.processes, vec!["chrome.exe".to_string()]);
        assert_eq!(rules.process_mode, "exclude");
    }

    #[test]
    fn saving_rules_does_not_delete_the_stored_block_list() {
        let _serial = DATA_DIR_TESTS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        // A document as it sits on a real Windows install right now.
        let existing = r#"{
            "direct": [],
            "proxy": [],
            "block": [
                {"id":"1","type":"domain","value":"ads.example.com","label":null},
                {"id":"2","type":"domain","value":"tracker.example.net","label":null}
            ],
            "process_mode": "exclude",
            "processes": [],
            "block_enabled": true
        }"#;
        std::fs::write(routing_rules_path(), existing).unwrap();

        // An ORDINARY, unrelated edit — the user adds one bypass rule. This is the save that would
        // silently take their block list away.
        let rules = RoutingRules {
            direct: vec![f4_entry("domain", "example.org")],
            ..RoutingRules::default()
        };
        save_routing_rules(rules).expect("save_routing_rules must succeed");

        let written: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(routing_rules_path()).unwrap()).unwrap();
        let kept: Vec<&str> = written["block"]
            .as_array()
            .expect("the removed feature's entries must still be in the document")
            .iter()
            .map(|e| e["value"].as_str().unwrap())
            .collect();
        assert_eq!(
            kept,
            vec!["ads.example.com", "tracker.example.net"],
            "removing the feature must not delete a single domain the user typed"
        );
        assert_eq!(
            written["block_enabled"],
            serde_json::json!(true),
            "the companion key rides through untouched too — carrying half the pair forward would \
             leave a document that no build, old or new, describes"
        );
        // …while the live half of the document is the NEW state, not the old one. Without this the
        // carry-forward could satisfy everything above by simply not writing at all.
        assert_eq!(
            written["direct"][0]["value"],
            serde_json::json!("example.org"),
            "the carry-forward must not overwrite what the save was actually for"
        );
    }

    #[test]
    fn a_corrupt_previous_document_carries_nothing_forward() {
        let _serial = DATA_DIR_TESTS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        // The D-02 corrupt case. Its only sanctioned exit is the reset, which writes an empty
        // document — and a reset must not resurrect fragments of the file the user threw away.
        std::fs::write(routing_rules_path(), "{ this is not json").unwrap();
        save_routing_rules(RoutingRules::default()).expect("the reset write must still succeed");

        let written: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(routing_rules_path()).unwrap())
                .expect("the reset must leave a document load_routing_rules can parse");
        assert!(
            written.get("block").is_none() && written.get("block_enabled").is_none(),
            "an unreadable previous document contributes nothing, got: {written}"
        );
    }

    #[test]
    fn a_resolve_removes_the_stale_blocked_pointer_from_an_existing_config() {
        let _serial = DATA_DIR_TESTS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        let dir = f4_tempdir();
        let cfg = dir.join("TrustTunnel_swift-fox.toml");
        // A config an earlier build wrote: the core is currently pointed at a block list.
        std::fs::write(&cfg, f4_config_with_blocked_pointer()).unwrap();
        assert!(
            f4_toml_blocked_file(&cfg).is_some(),
            "fixture check: the config must START OUT pointing at a block list, or this test \
             proves nothing"
        );

        let state = geodata_v2ray::GeoDataState::new();
        resolve_and_apply_inner(&cfg.to_string_lossy(), &RoutingRules::default(), &state)
            .expect("a resolve over a legacy config must succeed");

        assert_eq!(
            f4_toml_blocked_file(&cfg),
            None,
            "the stale blocked_file pointer must be REMOVED, not merely left unwritten — the C++ \
             core opens whatever that key names at spawn, so leaving it in place keeps a removed \
             feature enforcing on every machine that already had it on"
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

    // ── T-26 / D-04: an iplist_group value resolves with its prefix stripped ──
    //
    // The frontend persists an iplist_group entry WITH its `iplist_group:` prefix in `value`, so
    // the entry round-trips through save→reload without being mis-detected as a plain domain (see
    // useRoutingState.test.ts). The group cache, meanwhile, is keyed by the BARE id: its files are
    // written as `<id>.json`. `resolve_entries` is therefore the place the two spellings must meet,
    // and it strips the prefix before the cache lookup — exactly as the geoip:/geosite: arms do.
    // Without that strip the arm looks for a file named after the whole "iplist_group:<id>" string,
    // never finds it, and the entry silently resolves to nothing: a preset group that routes no
    // traffic while the UI shows it as active.
    //
    // This test writes a fixture under the bare id, hands `resolve_entries` the PREFIXED value and
    // asserts the cached domains come back — so a regression that drops the strip fails here rather
    // than in a user's routing table.
    //
    // Note on isolation: `group_cache_path_pub` is rooted at `user_data_dir()` (the test
    // binary's dir under cargo test), which cannot be redirected in-process; we therefore use a
    // unique, test-scoped bare id so the fixture never clobbers a real user cache, and remove it
    // after the assertion.
    // ── Item 13 (30.1 milestone review): a skipped geo entry reaches the user ──

    /// The pre-item-13 signature, for the cases that do not care about skips.
    ///
    /// Lives HERE and not beside the production function on purpose: a `#[cfg(test)]` item placed
    /// in the production half of this file truncates every source-text guard that trims at the
    /// first `#[cfg(test)]` — which is how the atomic-writer guard from 30.1-01 lost its subject
    /// the moment this wrapper was first written up there. It failed loudly rather than passing
    /// vacuously, which is the whole reason that guard has a locate-first arm.
    fn resolve_entries(entries: &[RuleEntry], state: &GeoDataState) -> Result<Vec<String>, String> {
        let mut ignored = Vec::new();
        resolve_entries_collecting(entries, state, &mut ignored)
    }

    #[test]
    fn an_entry_that_will_not_resolve_is_collected_instead_of_discarded() {
        // The defect: all three skip arms swallowed the failure into an `eprintln!` and an empty
        // vector, and the resolve still returned Ok. In a packaged build stderr goes nowhere, so
        // «этот пресет больше не маршрутизируется» was information the app had and threw away —
        // while the chip naming the group stayed on screen looking active.
        let state = geodata_v2ray::GeoDataState::new();
        let entries = vec![
            RuleEntry {
                id: "e1".to_string(),
                entry_type: "domain".to_string(),
                value: "example.com".to_string(),
                label: None,
            },
            RuleEntry {
                id: "e2".to_string(),
                // No geodata database is loaded in this fixture, so this cannot resolve.
                entry_type: "geoip".to_string(),
                value: "geoip:ru".to_string(),
                label: None,
            },
            RuleEntry {
                id: "e3".to_string(),
                // No cache file exists for this group id.
                entry_type: "iplist_group".to_string(),
                value: format!("iplist_group:absent_group_{}", std::process::id()),
                label: None,
            },
        ];

        let mut unresolved = Vec::new();
        let resolved = resolve_entries_collecting(&entries, &state, &mut unresolved)
            .expect("a skipped entry must not fail the whole resolve");

        // The healthy entry still resolves — reporting a skip must not cost the entries that worked.
        assert!(resolved.contains(&"example.com".to_string()));

        assert_eq!(
            unresolved.len(),
            2,
            "both the geoip entry and the uncached group must be REPORTED, not discarded; got \
             {unresolved:?}",
        );
        assert!(unresolved.iter().any(|u| u.contains("geoip:ru")));
        assert!(unresolved.iter().any(|u| u.contains("absent_group")));
    }

    #[test]
    fn a_resolve_in_which_everything_succeeds_reports_nothing() {
        // The other half: the notice must be silent on a healthy machine. A warning the user sees
        // on every connect is a warning they stop reading.
        let state = geodata_v2ray::GeoDataState::new();
        let entries = vec![RuleEntry {
            id: "e1".to_string(),
            entry_type: "domain".to_string(),
            value: "example.com".to_string(),
            label: None,
        }];

        let mut unresolved = Vec::new();
        resolve_entries_collecting(&entries, &state, &mut unresolved).unwrap();

        assert!(unresolved.is_empty());
        assert_eq!(unresolved_entries_notice(&unresolved), None);
    }

    #[test]
    fn the_unresolved_notice_carries_identifiers_only_and_never_a_path() {
        // D-29. The identifiers are the user's OWN typed rule values, so the notice is sanitized
        // rather than trusted: a path separator, a quote or a newline could otherwise ride a
        // hand-edited rules file onto the log channel.
        let notice = unresolved_entries_notice(&[
            "geoip:ru".to_string(),
            r"geosite:C:\Users\tester\AppData\secret.toml".to_string(),
            "iplist_group:games/../../etc/passwd".to_string(),
            "password=hunter2 \"quoted\"\nsecond line".to_string(),
        ])
        .expect("a non-empty list must produce a notice");

        // Spaces are deliberately NOT forbidden — the notice is a sentence and its prose has them.
        // What must never appear is anything that can SPELL a path or a credential.
        for forbidden in ['/', '\\', '"', '\'', '\n', '\r', '='] {
            assert!(
                !notice.contains(forbidden),
                "the notice must carry no {forbidden:?} — it names ENTRIES, and anything that can \
                 spell a path or a credential has no business on this channel (D-29). Got: {notice}",
            );
        }
        // Scope note, so the assertion above is not mistaken for more than it is: what survives
        // sanitization is the user's OWN typed rule value, echoed back to their own log — that is
        // the entry they need named. What must never appear is anything the APP derived: a config
        // path, a geodata path, or the resolver's error text, all of which the old `eprintln!`
        // carried. The identifier can no longer SPELL any of them, and nothing derived is passed
        // in at all — the arms push `format!("geoip:{category}")` and nothing else.
        assert!(!notice.contains("Failed to"), "no resolver error text: {notice}");
        assert!(!notice.contains("geodata"), "nothing derived from our own paths: {notice}");
        // It still has to be USEFUL: the entry the user recognises must survive sanitization.
        assert!(notice.contains("geoip:ru"));
    }

    #[test]
    fn the_unresolved_notice_is_bounded_however_many_entries_failed() {
        // A rules file can hold hundreds of entries. A geodata database that failed to download
        // makes EVERY geo entry skip at once, so the unbounded version of this message would be
        // the whole rule list pasted into the log on every connect.
        let many: Vec<String> = (0..200).map(|i| format!("geoip:cc{i}")).collect();
        let notice = unresolved_entries_notice(&many).expect("must produce a notice");

        assert!(
            notice.len() < 400,
            "the notice must stay bounded regardless of how many entries failed; got {} chars",
            notice.len(),
        );
        // …and it must say that it truncated, rather than quietly showing a partial list as if it
        // were the whole answer — which is the same class of lie this phase is about.
        assert!(notice.contains("200"), "the notice must state the TOTAL: {notice}");
    }

    #[test]
    fn the_three_skip_arms_no_longer_print_to_a_console_nobody_reads() {
        // A print is not a user-facing signal: in a packaged Windows build there is no console
        // attached, so `eprintln!` is indistinguishable from doing nothing at all.
        // Located directly rather than by first trimming at `#[cfg(test)]`: the test-only
        // `resolve_entries` wrapper carries that attribute and sits ABOVE the subject, so trimming
        // there would cut the function this rule is about out of the text and pass vacuously. (It
        // did exactly that on the first run.)
        let source = include_str!("./routing_rules.rs");
        let needle = format!("\nfn resolve_entries_{}(", "collecting");
        assert_eq!(
            source.matches(needle.as_str()).count(),
            1,
            "cannot measure the skip arms: expected exactly one definition of \
             `resolve_entries_collecting`. This is a FAILURE, not a pass.",
        );
        let arms = source.split(needle.as_str()).nth(1).expect("located above");
        let arms = &arms[..arms.find("\nfn ").unwrap_or(arms.len())];
        // Whole-line comments blanked: the comment explaining WHY the print was removed has to
        // name `eprintln!` to be worth reading, and a rule that fails on its own documentation is
        // a rule the next reader learns to ignore. Only lines whose first non-space characters are
        // `//` are dropped, so no code can hide behind a mid-line comment.
        let arms: String = arms
            .lines()
            .map(|l| if l.trim_start().starts_with("//") { "" } else { l })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            !arms.contains("eprintln!"),
            "a skipped entry must be REPORTED to the front end, not printed to stderr",
        );
    }

    #[test]
    fn resolve_entries_iplist_group_strips_prefix_before_cache_lookup() {
        let bare_id = format!("iplist_group_prefix_fixture_{}", std::process::id());
        let cache_path = group_cache_path_pub(&bare_id);
        let cached = vec![
            "games.example.com".to_string(),
            "play.example.org".to_string(),
        ];
        std::fs::write(&cache_path, serde_json::to_string(&cached).unwrap())
            .expect("must be able to write the group_cache fixture");

        let state = geodata_v2ray::GeoDataState::new();
        let entries = vec![RuleEntry {
            id: "g1".to_string(),
            // The PREFIXED value the T-26 FE fix now persists on disk/wire.
            entry_type: "iplist_group".to_string(),
            value: format!("iplist_group:{bare_id}"),
            label: None,
        }];

        let resolved = resolve_entries(&entries, &state)
            .expect("resolve_entries must not error for a cached iplist_group");

        // Clean up the fixture regardless of the assertion outcome below.
        let _ = std::fs::remove_file(&cache_path);

        // An arm that keyed off the full "iplist_group:<id>" string would find no cache file and
        // return an empty list, so this assertion is what holds the strip in place.
        assert!(
            resolved.contains(&"games.example.com".to_string())
                && resolved.contains(&"play.example.org".to_string()),
            "resolve_entries should strip the `iplist_group:` prefix and load the cached \
             bare-id domains; got {resolved:?}"
        );
    }

    // ── ROUTE-10: a bare domain rule means the domain AND all of its subdomains ──
    //
    // The ruling, 2026-09-03: «Я добавляю просто домен, допустим `maxmind.com`. И я ожидаю,
    // что все поддомены — mail.maxmind.com, geoip.maxmind.com — тоже идут напрямую.»
    //
    // WHY THESE TESTS ASSERT THROUGH A MODEL OF THE CORE AND NOT THROUGH THE BYTES.
    //   `exclusions.txt` carried the line `maxmind.com` before this fix and carries it after; a test
    //   asserting that line proves DELIVERY and says nothing about EFFECT — the exact failure phase
    //   30.1 was called to remove. What changed is what the frozen C++ core DOES with those bytes,
    //   so the core's own rule is transcribed in `domain_scope::core_matcher` (from
    //   `core/src/domain_filter.cpp`, pinned against `core/test/test_domain_filter.cpp`) and the
    //   assertions below are phrased in its terms: which hostnames actually bypass the tunnel.

    use crate::domain_scope::core_matcher::{core_match_domain, entry_kind, EntryKind};

    #[test]
    fn a_domain_rule_covers_the_site_and_every_subdomain_of_it() {
        let state = geodata_v2ray::GeoDataState::new();
        let resolved = resolve_entries(
            &[f4_entry("domain", "maxmind.com")],
            &state,
        )
        .expect("a plain domain rule must resolve");

        // The exact bytes `exclusions.txt` receives (`resolve_and_apply_reporting` joins on "\n").
        let exclusions = resolved.join("\n");

        for host in [
            "maxmind.com",          // the site itself
            "www.maxmind.com",      // its www. twin — the one case that already worked
            "mail.maxmind.com",     // documentation examples
            "geoip.maxmind.com",
            "dev.eu.maxmind.com",   // and arbitrarily deep, which `sub.sub.` pins in the core suite
        ] {
            assert!(
                core_match_domain(&exclusions, host),
                "the core must route {host} by this rule — the user asked for the SITE. \
                 Bytes written: {exclusions:?}"
            );
        }

        // …and no wider than that. A rule must not capture a name that merely LOOKS related: the
        // matcher walks dot-separated suffixes, so both of these are real ways a sloppy expansion
        // (a bare suffix string, or a `*` with no dot) would over-match.
        for host in ["notmaxmind.com", "maxmind.com.evil.test", "maxmind.co"] {
            assert!(
                !core_match_domain(&exclusions, host),
                "{host} is a different site and must NOT be routed by a rule for maxmind.com"
            );
        }
    }

    #[test]
    fn a_wildcard_the_user_typed_is_left_alone_and_keeps_meaning_subdomains_only() {
        // `*.x` is the form the app accepts today (AddRuleInput.tsx:73) and the ONLY way to say
        // «subdomains but not the apex». Two properties, and the second is the sharp one: prefixing
        // it again yields `*.*.maxmind.com`, which fails the core's character whitelist
        // (domain_filter.cpp:62-70) and is DISCARDED — the rule would silently stop routing.
        let state = geodata_v2ray::GeoDataState::new();
        let resolved = resolve_entries(&[f4_entry("domain", "*.maxmind.com")], &state).unwrap();
        let exclusions = resolved.join("\n");

        assert_eq!(
            entry_kind("*.*.maxmind.com"),
            EntryKind::Malformed,
            "premise of this test: the core throws a double-prefixed entry away"
        );
        assert!(
            !exclusions.contains("*.*."),
            "no line may be double-prefixed; got {exclusions:?}"
        );
        assert!(
            core_match_domain(&exclusions, "geoip.maxmind.com"),
            "the user's wildcard must still route subdomains"
        );
        assert!(
            !core_match_domain(&exclusions, "maxmind.com"),
            "…and must still NOT route the apex — that is what the user asked for by typing the \
             wildcard, and it is the only way left to express it"
        );
    }

    #[test]
    fn an_address_rule_is_written_byte_for_byte_and_never_wildcarded() {
        // `domain` used to share an arm with `ip`/`cidr`, so the split is the change; this is the
        // half that must NOT move. A wildcarded IP does not merely fail to help — `*.1.2.3.4` is
        // filed in the core's DOMAIN table instead of its address table and matches nothing at all.
        let state = geodata_v2ray::GeoDataState::new();
        let resolved = resolve_entries(
            &[
                f4_entry("ip", "1.2.3.4"),
                f4_entry("cidr", "10.0.0.0/8"),
                f4_entry("ip", "2001:db8::1"),
            ],
            &state,
        )
        .unwrap();

        assert_eq!(
            resolved,
            vec![
                "1.2.3.4".to_string(),
                "10.0.0.0/8".to_string(),
                "2001:db8::1".to_string(),
            ],
            "an ip/cidr rule must reach the core exactly as typed"
        );
        for entry in &resolved {
            assert_eq!(
                entry_kind(entry),
                EntryKind::AddressOrCidr,
                "{entry} must still be filed in the core's address/CIDR table"
            );
        }
    }

    #[test]
    fn a_dotless_domain_rule_gains_no_nonsense_wildcard() {
        // Reachable despite AddRuleInput's own dot check: an imported rules file, or a legacy one,
        // can carry anything. `*.youtube` would be a second line the matcher can never reach.
        let state = geodata_v2ray::GeoDataState::new();
        let resolved = resolve_entries(&[f4_entry("domain", "youtube")], &state).unwrap();
        assert_eq!(resolved, vec!["youtube".to_string()]);
    }

    #[test]
    fn a_group_of_bare_sites_carries_the_same_scope_as_a_hand_typed_rule() {
        // THE JUDGEMENT CALL, made explicit. An `iplist_group` cache is a list of fully-qualified
        // hostnames with NO type information — nobody has said whether `4pda.to` means the site or
        // that one host. A hand-typed `4pda.to` now means the site, and a group is the same user
        // asking for the same thing with one click, so it means the site here too. Leaving groups
        // exact would have made scope depend on WHICH DOOR a name came through — invisible, and
        // exactly the kind of «works for my typed rule, not for the preset» report this fix exists
        // to end. (Type-3 geosite entries are the one exception, and only because their publisher
        // said «exact» out loud — see `domain_scope`.)
        let bare_id = format!("route10_group_scope_{}", std::process::id());
        let cache_path = group_cache_path_pub(&bare_id);
        let cached = vec!["4pda.to".to_string(), "*.vk.com".to_string(), "1.2.3.4".to_string()];
        std::fs::write(&cache_path, serde_json::to_string(&cached).unwrap()).unwrap();

        let state = geodata_v2ray::GeoDataState::new();
        let resolved = resolve_entries(
            &[f4_entry("iplist_group", &format!("iplist_group:{bare_id}"))],
            &state,
        )
        .expect("a cached group must resolve");
        let _ = std::fs::remove_file(&cache_path);

        let exclusions = resolved.join("\n");
        assert!(
            core_match_domain(&exclusions, "forum.4pda.to"),
            "a group's bare site must cover its subdomains; got {exclusions:?}"
        );
        assert!(
            core_match_domain(&exclusions, "4pda.to"),
            "…and the site itself"
        );
        assert!(
            !exclusions.contains("*.*."),
            "an entry a group already spells with a wildcard must not be double-prefixed"
        );
        assert!(
            !exclusions.contains("*.1.2.3.4"),
            "an address inside a group must not be wildcarded either"
        );
    }

    #[test]
    fn the_exclusions_file_the_core_reads_routes_the_subdomain_the_card_promises() {
        // End to end, through the real writer and the real file: the bytes asserted here are the
        // bytes the sidecar opens (`trusttunnel/src/config.cpp:294-310` reads `exclusions_file`
        // whole, with no size cap on either side). The card says «Трафик к этим адресам пойдёт
        // напрямую»; this is the test that makes that sentence true rather than aspirational.
        let _serial = DATA_DIR_TESTS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        let dir = f4_tempdir();
        let cfg = dir.join("TrustTunnel_swift-fox.toml");
        std::fs::write(&cfg, f4_sample_config()).unwrap();

        let rules = RoutingRules {
            direct: vec![f4_entry("domain", "maxmind.com")],
            proxy: Vec::new(),
            process_mode: "exclude".to_string(),
            processes: Vec::new(),
        };

        let state = geodata_v2ray::GeoDataState::new();
        resolve_and_apply_inner(&cfg.to_string_lossy(), &rules, &state)
            .expect("resolve_and_apply_inner must succeed on a valid config");

        let written = std::fs::read_to_string(exclusions_file_path()).unwrap();
        assert!(
            core_match_domain(&written, "device.maxmind.com"),
            "the file on disk must make the core bypass the tunnel for a subdomain of a rule the \
             user typed; got {written:?}"
        );
        // The T-33 private baseline is IP-shaped and must survive this change untouched.
        assert!(
            written.lines().any(|l| l == "10.0.0.0/8"),
            "the default-private baseline must still be written verbatim"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}

