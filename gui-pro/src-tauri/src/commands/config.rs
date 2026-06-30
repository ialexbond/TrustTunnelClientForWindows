use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::Emitter;

use crate::routing_rules::RoutingRules;
use crate::ssh::portable_data_dir;

// WR-03: path-traversal validation now lives in one shared place (commands::paths) instead of
// three byte-similar copies. Re-export under the local name so the rest of this module reads
// unchanged.
use crate::commands::paths::validate_app_path;

// ─── Config file watcher state ───────────────────────────────

static CONFIG_WATCHER_STOP: Mutex<Option<std::sync::mpsc::Sender<()>>> = Mutex::new(None);

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

/// CR-01: allow-list the roots a frontend-supplied SAVE destination may land in.
///
/// A registered Tauri command is callable from ANY frontend JS — the `save()` picker is a
/// UI convention, not an enforced trust boundary (the SAME rationale the read twin
/// `read_config_file_for_import`/WR-04 already documents). Without this guard
/// `write_string_to_path` is an arbitrary-content, arbitrary-location file-write primitive
/// over IPC, e.g. dropping a `.bat` into the user's Startup folder — with the app's
/// privileges (the app runs elevated for VPN-core control, raising impact).
///
/// We constrain the destination to the user-reachable roots a legitimate Save-As actually
/// targets — the portable data dir, the user profile subtree (Desktop/Downloads/Documents
/// all live under `%USERPROFILE%`), and the OS temp dir (used by the unit tests + some
/// pickers) — and additionally reject NTFS reparse points / junctions in the resolved path
/// so a symlinked decoy under an allowed root cannot redirect the write into a system dir.
/// This intentionally does NOT replace the picker; it shrinks the blast radius of the
/// registered command (defense-in-depth, mirroring the read side).
fn validate_save_destination(destination: &str) -> Result<(), String> {
    let dest = std::path::Path::new(destination);

    // Resolve the destination to an absolute, symlink-free canonical path. The file does not
    // exist yet (Save-As creates it), so canonicalize the PARENT and re-append the file name.
    // Canonicalizing the parent also resolves any reparse point IN the parent chain, so a
    // junction planted mid-path is followed to its real target before the allow-list check —
    // the prefix test then sees the true location, not the lexical decoy.
    let parent = dest
        .parent()
        .ok_or_else(|| "Invalid destination path".to_string())?;
    let canonical_parent = std::fs::canonicalize(parent)
        .map_err(|e| format!("Invalid destination path: {e}"))?;
    let file_name = dest
        .file_name()
        .ok_or_else(|| "Invalid destination path".to_string())?;
    let canonical = canonical_parent.join(file_name);

    // Reject when the resolved parent IS a reparse point (junction/symlink). `canonicalize`
    // already followed it, but rejecting outright avoids relying on prefix math against a
    // target that may legitimately sit outside every allowed root.
    if let Ok(meta) = std::fs::symlink_metadata(parent) {
        if meta.file_type().is_symlink() {
            return Err("Access denied: destination resolves through a reparse point".into());
        }
    }

    // Build the allow-list of roots. Each is canonicalized so the prefix comparison is
    // symlink-free on both sides.
    let mut allowed_roots: Vec<std::path::PathBuf> = Vec::new();
    let mut push_root = |p: std::path::PathBuf| {
        if let Ok(c) = std::fs::canonicalize(&p) {
            allowed_roots.push(c);
        } else {
            allowed_roots.push(p);
        }
    };
    push_root(portable_data_dir());
    // %USERPROFILE% covers Desktop / Downloads / Documents — every Save-As the UI offers.
    if let Ok(profile) = std::env::var("USERPROFILE") {
        if !profile.is_empty() {
            push_root(std::path::PathBuf::from(profile));
        }
    }
    // OS temp dir — used by the picker on some systems and by the unit tests.
    push_root(std::env::temp_dir());

    if allowed_roots.iter().any(|root| canonical.starts_with(root)) {
        Ok(())
    } else {
        Err("Access denied: destination is outside the allowed save locations".into())
    }
}

/// Write a string to a user-chosen destination path (for "Download logs" functionality).
///
/// The destination originates from the native `save()` dialog — but a registered Tauri
/// command is callable from ANY frontend JS, so the destination is allow-list-validated
/// server-side via `validate_save_destination` (CR-01) rather than trusted blindly.
///
/// D-29: this command receives raw log content — caller must NOT include passwords
/// in the `content` string. Verified by LogsViewerModal.test.tsx spy assertions.
#[tauri::command]
pub async fn write_string_to_path(
    content: String,
    destination: String,
) -> Result<(), String> {
    // CR-01: constrain the destination to allow-listed roots + reject reparse points.
    validate_save_destination(&destination)?;
    tokio::fs::write(&destination, content.as_bytes())
        .await
        .map_err(|e| format!("WRITE_FAILED|{e}"))
}

/// Copy a file to a user-chosen destination (for "Save As" functionality).
///
/// The source MUST be inside the app data directory — prevents the frontend
/// from tricking the backend into reading arbitrary files.
///
/// The destination is NOT validated against the app data dir, because the
/// frontend only reaches this command via `tauri-plugin-dialog::save()` which
/// is the OS file picker — the user explicitly chose the path. Validating
/// destination here would break every Save-As flow (Desktop, Downloads, etc.).
#[tauri::command]
pub fn copy_file(source: String, destination: String) -> Result<(), String> {
    validate_app_path(&source)?;
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
    for e in std::fs::read_dir(dir).ok()?.flatten() {
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
    None
}

#[tauri::command]
pub fn config_file_exists(config_path: String) -> bool {
    std::path::Path::new(&config_path).is_file()
}

/// Start watching the config file's parent directory.
/// Emits "config-file-changed" with `{ exists: bool, path: String }` on create/remove/modify.
#[tauri::command]
pub fn watch_config_file(app: tauri::AppHandle, config_path: String) {
    use notify::{Watcher, RecursiveMode, Event, EventKind};

    // Stop any existing watcher
    if let Ok(mut guard) = CONFIG_WATCHER_STOP.lock() {
        if let Some(tx) = guard.take() {
            tx.send(()).ok();
        }
    }

    let path = std::path::PathBuf::from(&config_path);
    let dir = match path.parent() {
        Some(d) => d.to_path_buf(),
        None => return,
    };
    let file_name = match path.file_name() {
        Some(n) => n.to_os_string(),
        None => return,
    };

    let (tx_stop, rx_stop) = std::sync::mpsc::channel::<()>();
    if let Ok(mut guard) = CONFIG_WATCHER_STOP.lock() {
        *guard = Some(tx_stop);
    }

    std::thread::spawn(move || {
        let app_handle = app.clone();
        let watched_name = file_name.clone();
        let watched_path = config_path.clone();

        let mut watcher = match notify::recommended_watcher(
            move |res: Result<Event, notify::Error>| {
                if let Ok(event) = res {
                    match event.kind {
                        EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(_) => {
                            // Only react to our specific file
                            let relevant = event.paths.iter().any(|p| {
                                p.file_name().is_some_and(|n| n == watched_name)
                            });
                            if relevant {
                                let exists = std::path::Path::new(&watched_path).is_file();
                                app_handle.emit("config-file-changed", serde_json::json!({
                                    "exists": exists,
                                    "path": &watched_path,
                                })).ok();
                            }
                        }
                        _ => {}
                    }
                }
            },
        ) {
            Ok(w) => w,
            Err(_) => return,
        };

        if watcher.watch(&dir, RecursiveMode::NonRecursive).is_err() {
            return;
        }

        // Keep alive until stop signal
        loop {
            match rx_stop.recv_timeout(std::time::Duration::from_secs(60)) {
                Ok(()) => break,         // Stop requested
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            }
        }
    });
}

#[tauri::command]
pub fn unwatch_config_file() {
    if let Ok(mut guard) = CONFIG_WATCHER_STOP.lock() {
        if let Some(tx) = guard.take() {
            tx.send(()).ok();
        }
    }
}

#[tauri::command]
pub fn read_client_config(config_path: String) -> Result<serde_json::Value, String> {
    validate_app_path(&config_path)?;
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
                    // IN-01: do NOT overwrite the user's source file as a READ side effect. The
                    // recovery heuristic (stripping a malformed `exclusions` block) could drop
                    // legitimate content in an edge layout, and a destructive rewrite leaves no
                    // way back. Write the recovered config to a SIDE `.recovered` file instead so
                    // the original is preserved for inspection; the in-memory `c` is what this
                    // read returns, so the app still works with the recovered view this session.
                    let recovered_path = format!("{config_path}.recovered");
                    let _ = std::fs::write(&recovered_path, &fixed);
                    eprintln!(
                        "[config] Recovery successful; recovered copy written to {recovered_path} (original left intact)"
                    );
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

/// Convert a JSON scalar (or scalar array) into a `toml_edit::Value`.
///
/// Returns `None` for `null` (so a null in the payload leaves the on-disk value untouched) and
/// for arrays containing non-scalars / nested objects (handled via table recursion instead) — in
/// both cases the merge skips the key and keeps whatever is already on disk.
fn json_scalar_to_toml_edit(v: &serde_json::Value) -> Option<toml_edit::Value> {
    use serde_json::Value as J;
    match v {
        J::Null | J::Object(_) => None,
        J::Bool(b) => Some(toml_edit::Value::from(*b)),
        J::Number(n) => {
            if let Some(i) = n.as_i64() {
                Some(toml_edit::Value::from(i))
            } else {
                n.as_f64().map(toml_edit::Value::from)
            }
        }
        J::String(s) => Some(toml_edit::Value::from(s.as_str())),
        J::Array(arr) => {
            let mut out = toml_edit::Array::new();
            for el in arr {
                match el {
                    J::Bool(b) => out.push(*b),
                    J::Number(n) => {
                        if let Some(i) = n.as_i64() {
                            out.push(i);
                        } else if let Some(f) = n.as_f64() {
                            out.push(f);
                        } else {
                            return None;
                        }
                    }
                    J::String(s) => out.push(s.as_str()),
                    // Array of objects/arrays — don't attempt; keep the on-disk array.
                    _ => return None,
                }
            }
            Some(toml_edit::Value::Array(out))
        }
    }
}

/// Deep-merge a JSON object onto a `toml_edit` table WITHOUT deleting keys the payload omits.
///
/// This is the core of the config-mangling fix: for every key the editor sends we set/recurse,
/// but any key already on disk that the editor does NOT send is left exactly as-is (value,
/// comment and position preserved by toml_edit). `skip_keys` are never written from the payload
/// (used at the top level to protect RoutingPanel-managed keys) — they keep their on-disk value.
fn merge_json_into_table(
    table: &mut toml_edit::Table,
    obj: &serde_json::Map<String, serde_json::Value>,
    skip_keys: &[&str],
) {
    for (k, v) in obj {
        if skip_keys.contains(&k.as_str()) {
            continue;
        }
        match v {
            serde_json::Value::Object(child) => {
                // Ensure a sub-table exists, then merge into it (never deleting its other keys).
                if !table.get(k).map(|i| i.is_table()).unwrap_or(false) {
                    table.insert(k, toml_edit::Item::Table(toml_edit::Table::new()));
                }
                if let Some(sub) = table.get_mut(k).and_then(|i| i.as_table_mut()) {
                    // skip_keys only protects the top level — recurse with no skip.
                    merge_json_into_table(sub, child, &[]);
                }
            }
            // A null in the payload means "no change" — keep the on-disk value.
            serde_json::Value::Null => {}
            other => {
                if let Some(mut val) = json_scalar_to_toml_edit(other) {
                    match table.get_mut(k) {
                        // Key already on disk: mutate the value IN PLACE so the key's entry
                        // (its leading `# comment` + spacing decor) is preserved. A plain
                        // `insert` rebuilds the entry and strips those comments — that was how
                        // the config lost its header comments on every save.
                        Some(item) => {
                            if let Some(existing_val) = item.as_value() {
                                *val.decor_mut() = existing_val.decor().clone();
                            }
                            *item = toml_edit::Item::Value(val);
                        }
                        None => {
                            table.insert(k, toml_edit::value(val));
                        }
                    }
                }
            }
        }
    }
}

/// Apply an editor's config payload onto the existing on-disk TOML *without* losing anything the
/// payload omits.
///
/// The previous implementation re-serialized the whole config from the frontend JSON, so any
/// field the editor didn't echo back — most damagingly the entire `[listener.tun]` routing block
/// (`included_routes`, `mtu_size`, `excluded_routes`) — was dropped, leaving the tunnel with no
/// routes and silently breaking a working connection on the next reconnect (it "connects" but
/// passes no traffic). We instead start from the existing document (toml_edit keeps comments, key
/// order and every field) and merge only the keys present in the payload.
fn apply_config_edit(existing: &str, config: &serde_json::Value) -> Result<String, String> {
    let mut doc: toml_edit::DocumentMut = existing
        .parse()
        .map_err(|e: toml_edit::TomlError| format!("Failed to parse existing config: {e}"))?;

    // Routing-managed keys belong to RoutingPanel (resolve_and_apply); a Settings/EditView save
    // must never clobber them, so they are skipped here and keep their on-disk value.
    let routing_managed = [
        "exclusions",
        "exclusions_file",
        "blocked_file",
        "process_direct_file",
        "process_proxy_file",
        "process_block_file",
        "vpn_mode",
    ];
    if let Some(obj) = config.as_object() {
        merge_json_into_table(doc.as_table_mut(), obj, &routing_managed);
    }

    // Mode switch: if the editor declares exactly one listener type, drop the other known type so
    // a stale [listener.tun]/[listener.socks] block doesn't linger (the sidecar crashes with both
    // present). Fields WITHIN the kept type are preserved by the merge above.
    if let Some(incoming) = config.get("listener").and_then(|l| l.as_object()) {
        let has_tun = incoming.contains_key("tun");
        let has_socks = incoming.contains_key("socks");
        if let Some(listener) = doc.get_mut("listener").and_then(|l| l.as_table_mut()) {
            if has_socks && !has_tun {
                listener.remove("tun");
            } else if has_tun && !has_socks {
                listener.remove("socks");
            }
        }
    }
    // Final safety: never leave both listener types present.
    if let Some(listener) = doc.get_mut("listener").and_then(|l| l.as_table_mut()) {
        if listener.contains_key("socks") && listener.contains_key("tun") {
            listener.remove("tun"); // socks takes priority
        }
    }

    // DHCP ports (67, 68) must stay in killswitch_allow_ports so the Kill Switch never blocks a
    // DHCP lease renewal. ENSURE rather than replace — keep any other configured ports (the old
    // code hard-reset this to exactly [67, 68], silently dropping a user's extra allow-ports).
    {
        let mut ports_list: Vec<i64> = doc
            .get("killswitch_allow_ports")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|e| e.as_integer()).collect())
            .unwrap_or_default();
        for p in [67_i64, 68_i64] {
            if !ports_list.contains(&p) {
                ports_list.push(p);
            }
        }
        let mut ports = toml_edit::Array::new();
        for p in &ports_list {
            ports.push(*p);
        }
        doc["killswitch_allow_ports"] = toml_edit::value(ports);
    }

    // Remove empty custom_sni — the sidecar may interpret "" as "empty SNI".
    if let Some(endpoint) = doc.get_mut("endpoint").and_then(|e| e.as_table_mut()) {
        if endpoint
            .get("custom_sni")
            .and_then(|v| v.as_str())
            .is_some_and(|s| s.is_empty())
        {
            endpoint.remove("custom_sni");
        }
    }

    // IN-58: an explicitly-emptied endpoint.name (the user cleared the «Имя конфига» field) means
    // "clear the title" → the card falls back to the username. The frontend now sends name = ""
    // (not undefined) so the merge wrote it; strip the empty key so the .toml carries no `name =
    // ""` and the file-derived name is truly empty. (Previously the field sent `undefined`, the
    // key was omitted, and the non-destructive merge KEPT the old on-disk name — the «снэкбар
    // сохранено, а имя не менялось» bug.)
    if let Some(endpoint) = doc.get_mut("endpoint").and_then(|e| e.as_table_mut()) {
        if endpoint
            .get("name")
            .and_then(|v| v.as_str())
            .is_some_and(|s| s.is_empty())
        {
            endpoint.remove("name");
        }
    }

    Ok(doc.to_string())
}

#[tauri::command]
pub fn save_client_config(config_path: String, config: serde_json::Value) -> Result<(), String> {
    validate_app_path(&config_path)?;
    // Safety: refuse to save config that's missing [endpoint] — would break the sidecar
    if config.get("endpoint").and_then(|e| e.as_object()).is_none_or(|e| e.is_empty()) {
        return Err("Refusing to save: endpoint section is missing or empty".into());
    }

    // WR-01: defense-in-depth on the display name, same as rename_config/WR-02. The inline
    // rename path validates `endpoint.name` twice (ConfigCard client-side AND rename_config
    // server-side via validate_config_name). The ConfigEditView «Имя конфига» edit persists
    // through THIS command instead, so without the SAME server-side check a direct
    // `invoke("save_client_config", { config: { endpoint: { name: "<65+ chars / control
    // chars>" } } })` bypasses the client validation and writes a garbage/over-long name that
    // list_configs then renders as the card title. Validate it here with the exact same
    // validator rename_config uses. An empty/absent name is allowed (the card falls back to the
    // username) — only a PRESENT non-empty name is checked.
    if let Some(name) = config
        .get("endpoint")
        .and_then(|e| e.as_object())
        .and_then(|e| e.get("name"))
        .and_then(|n| n.as_str())
    {
        if !name.is_empty() {
            crate::ssh::sanitize::validate_config_name(name)?;
        }
    }

    // Non-destructive save: merge the editor's payload onto the existing on-disk document so
    // nothing the payload omits is lost (comments, key order, and crucially the [listener.tun]
    // routing block — included_routes / mtu_size / excluded_routes). See apply_config_edit.
    let existing = std::fs::read_to_string(&config_path).unwrap_or_default();
    let content = apply_config_edit(&existing, &config)?;
    std::fs::write(&config_path, &content)
        .map_err(|e| format!("Failed to write config: {e}"))?;

    // IN-26 follow-up: keep the manifest display name in sync with the freshly-saved
    // endpoint.name. ConfigEditView's «Имя конфига» edit goes through THIS save (it rewrites the
    // .toml), NOT rename_config, so without this the manifest label drifted stale and an old name
    // resurfaced (e.g. as the import copy name «<old> (копия)»). Best-effort: a sync failure must
    // not fail the save — the file (the source of truth for the card) is already written.
    let _ = crate::commands::manifest::sync_entry_name_from_file(&config_path);

    Ok(())
}

// ═══════════════════════════════════════════════════════════════
//   Tests
// ═══════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_minimal_config() {
        let toml = r#"
loglevel = "debug"
vpn_mode = "proxy"
killswitch_enabled = false
"#;
        let config = ClientConfig::validate(toml).unwrap();
        assert_eq!(config.loglevel, "debug");
        assert_eq!(config.vpn_mode, "proxy");
        assert!(!config.killswitch_enabled);
    }

    #[test]
    fn test_validate_invalid_toml() {
        let result = ClientConfig::validate("this is not TOML {{{");
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_defaults() {
        // Empty string parses as empty TOML table — all fields get defaults
        let config = ClientConfig::validate("").unwrap();
        assert_eq!(config.loglevel, "info");
        assert_eq!(config.vpn_mode, "general");
        assert!(config.killswitch_enabled);
        assert!(config.post_quantum_group_enabled);
    }

    #[test]
    fn test_validate_preserves_unknown_keys() {
        let toml = r#"
loglevel = "info"
vpn_mode = "general"
killswitch_enabled = true
some_future_key = "value"
"#;
        let config = ClientConfig::validate(toml).unwrap();
        assert!(config.extra.contains_key("some_future_key"));
        assert_eq!(
            config.extra["some_future_key"],
            toml::Value::String("value".to_string())
        );
    }

    #[test]
    fn test_default_has_dhcp_ports() {
        let config = ClientConfig::default();
        assert!(config.killswitch_allow_ports.contains(&67));
        assert!(config.killswitch_allow_ports.contains(&68));
    }

    #[test]
    fn test_ensure_dhcp_ports_adds_missing() {
        let mut config = ClientConfig::default();
        config.killswitch_allow_ports.clear();
        assert!(!config.killswitch_allow_ports.contains(&67));
        config.ensure_dhcp_ports();
        assert!(config.killswitch_allow_ports.contains(&67));
        assert!(config.killswitch_allow_ports.contains(&68));
    }

    #[test]
    fn test_ensure_dhcp_ports_idempotent() {
        let mut config = ClientConfig::default();
        config.ensure_dhcp_ports();
        let len = config.killswitch_allow_ports.len();
        config.ensure_dhcp_ports(); // call again
        assert_eq!(config.killswitch_allow_ports.len(), len); // no duplicates
    }

    #[tokio::test]
    async fn write_string_to_path_creates_file() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("tt_test_write_{}.txt", std::process::id()));
        let content = "hello from write_string_to_path\nline2";
        write_string_to_path(content.to_string(), path.to_string_lossy().to_string())
            .await
            .expect("write should succeed");
        assert!(path.exists(), "file should exist after write");
        let read_back = std::fs::read_to_string(&path).unwrap();
        assert_eq!(read_back, content);
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn write_string_to_path_overwrites_existing() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("tt_test_overwrite_{}.txt", std::process::id()));
        std::fs::write(&path, "old content").unwrap();
        write_string_to_path("new content".to_string(), path.to_string_lossy().to_string())
            .await
            .expect("overwrite should succeed");
        let read_back = std::fs::read_to_string(&path).unwrap();
        assert_eq!(read_back, "new content");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn test_round_trip() {
        let toml_input = r#"
loglevel = "warn"
vpn_mode = "proxy"
killswitch_enabled = false
killswitch_allow_ports = [80, 443, 67, 68]
post_quantum_group_enabled = false
custom_field = 42
"#;
        let config1 = ClientConfig::validate(toml_input).unwrap();
        let serialized = toml::to_string_pretty(&config1).unwrap();
        let config2 = ClientConfig::validate(&serialized).unwrap();

        assert_eq!(config1.loglevel, config2.loglevel);
        assert_eq!(config1.vpn_mode, config2.vpn_mode);
        assert_eq!(config1.killswitch_enabled, config2.killswitch_enabled);
        assert_eq!(config1.killswitch_allow_ports, config2.killswitch_allow_ports);
        assert_eq!(config1.post_quantum_group_enabled, config2.post_quantum_group_enabled);
        assert!(config2.extra.contains_key("custom_field"));
    }

    // ── apply_config_edit: non-destructive save (config-mangling fix) ──────────

    /// IN-58: clearing «Имя конфига» sends endpoint.name = "" — apply_config_edit must STRIP the
    /// empty key (not write `name = ""`) so the file-derived name is empty and the card falls back
    /// to the username. The rest of the config is preserved.
    #[test]
    fn apply_edit_empty_name_clears_endpoint_name() {
        let existing = r#"loglevel = "info"
vpn_mode = "general"
killswitch_enabled = true
killswitch_allow_ports = [67, 68]

[endpoint]
hostname = "h.win"
addresses = ["h.win:443"]
username = "gold-fish"
password = "secret"
name = "OldName"
"#;
        let config = serde_json::json!({
            "endpoint": {
                "hostname": "h.win",
                "addresses": ["h.win:443"],
                "username": "gold-fish",
                "password": "secret",
                "name": ""
            }
        });
        let out = apply_config_edit(existing, &config).unwrap();
        let parsed: toml::Value = toml::from_str(&out).unwrap();
        let ep = parsed.get("endpoint").and_then(|e| e.as_table()).unwrap();
        assert!(ep.get("name").is_none(), "endpoint.name must be cleared:\n{out}");
        assert_eq!(
            ep.get("username").and_then(|v| v.as_str()),
            Some("gold-fish"),
            "other endpoint fields preserved:\n{out}"
        );
    }

    /// The headline bug: editing a field (e.g. the display name) must NOT drop the
    /// [listener.tun] routing block the editor doesn't echo back. Losing included_routes left
    /// the tunnel with no routes → "connects but no traffic".
    #[test]
    fn apply_edit_preserves_listener_tun_routes_and_comments() {
        let existing = r#"# top comment kept
loglevel = "info"
vpn_mode = "general"
killswitch_enabled = true
killswitch_allow_ports = [67, 68]

[endpoint]
hostname = "h.win"
addresses = ["h.win:443"]
username = "gold-fish"
password = "secret"
name = "OldName"

[listener.tun]
mtu_size = 1280
change_system_dns = true
included_routes = ["0.0.0.0/0"]
excluded_routes = []
"#;
        // Editor echoes back only what it knows — note listener.tun has ONLY change_system_dns.
        let config = serde_json::json!({
            "loglevel": "info",
            "vpn_mode": "general",
            "killswitch_enabled": true,
            "killswitch_allow_ports": [67, 68],
            "endpoint": {
                "hostname": "h.win",
                "addresses": ["h.win:443"],
                "username": "gold-fish",
                "password": "secret",
                "name": "NewName"
            },
            "listener": { "tun": { "change_system_dns": true } }
        });
        let out = apply_config_edit(existing, &config).unwrap();
        // Routes / mtu survive even though the payload omitted them.
        assert!(out.contains("included_routes"), "included_routes lost:\n{out}");
        assert!(out.contains("mtu_size = 1280"), "mtu_size lost:\n{out}");
        assert!(out.contains("excluded_routes"), "excluded_routes lost:\n{out}");
        // The edit is applied and the comment is preserved.
        assert!(out.contains("name = \"NewName\""), "name not applied:\n{out}");
        assert!(out.contains("# top comment kept"), "comment lost:\n{out}");
        // The password round-trips.
        assert!(out.contains("password = \"secret\""), "password lost:\n{out}");
    }

    /// Switching tun → socks must drop the stale [listener.tun] block (sidecar crashes with both)
    /// while round-tripping the SOCKS credentials.
    #[test]
    fn apply_edit_mode_switch_tun_to_socks_drops_tun() {
        let existing = r#"
[endpoint]
hostname = "h.win"
name = "S"

[listener.tun]
mtu_size = 1280
included_routes = ["0.0.0.0/0"]
"#;
        let config = serde_json::json!({
            "endpoint": { "hostname": "h.win", "name": "S" },
            "listener": { "socks": { "address": "127.0.0.1:1080", "username": "u", "password": "p" } }
        });
        let out = apply_config_edit(existing, &config).unwrap();
        assert!(!out.contains("[listener.tun]"), "stale tun left:\n{out}");
        assert!(out.contains("username = \"u\""), "socks user lost:\n{out}");
        assert!(out.contains("password = \"p\""), "socks pass lost:\n{out}");
    }

    /// DHCP ports are ensured, not reset — a user's extra allow-ports survive a save.
    #[test]
    fn apply_edit_ensures_dhcp_ports_without_dropping_others() {
        let existing = r#"
killswitch_allow_ports = [80, 443, 67, 68]
[endpoint]
hostname = "h.win"
"#;
        // Payload does not send killswitch_allow_ports at all.
        let config = serde_json::json!({ "endpoint": { "hostname": "h.win" } });
        let out = apply_config_edit(existing, &config).unwrap();
        for needle in ["80", "443", "67", "68"] {
            assert!(out.contains(needle), "port {needle} lost:\n{out}");
        }
    }

    /// RoutingPanel-managed keys are never clobbered by a Settings/EditView save.
    #[test]
    fn apply_edit_keeps_routing_managed_keys() {
        let existing = r#"
vpn_mode = "general"
exclusions = ["example.com"]
exclusions_file = "C:/data/exclusions.txt"
[endpoint]
hostname = "h.win"
"#;
        // A hostile/stale payload tries to wipe the routing keys.
        let config = serde_json::json!({
            "vpn_mode": "proxy",
            "exclusions": [],
            "exclusions_file": "",
            "endpoint": { "hostname": "h.win" }
        });
        let out = apply_config_edit(existing, &config).unwrap();
        assert!(out.contains("vpn_mode = \"general\""), "vpn_mode clobbered:\n{out}");
        assert!(out.contains("example.com"), "exclusions clobbered:\n{out}");
        assert!(out.contains("exclusions.txt"), "exclusions_file clobbered:\n{out}");
    }
}

/// Result of importing a dropped file — either a VPN config or routing rules.
#[derive(Serialize)]
pub struct ImportDropResult {
    pub file_type: String, // "config" | "routing"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub routing_rules: Option<RoutingRules>,
}

/// Import a file dropped via HTML5 drag-drop (receives content, not path).
/// Used when dragDropEnabled is false and we get file content from FileReader.
#[tauri::command]
pub async fn import_dropped_content(content: String, file_name: String) -> Result<ImportDropResult, String> {
    // IN-05: classify the extension via the shared helper so the drag-drop door and the
    // file-picker door (read_config_file_for_import) parse extensions identically.
    let ext = crate::commands::paths::lowercase_extension(&file_name);

    match ext.as_str() {
        "toml" => {
            if !content.contains("[endpoint]") && !content.contains("[listener") {
                return Err("TOML file does not appear to be a VPN config (missing [endpoint] section)".into());
            }
            // Drag-drop import goes through the same ADD-not-overwrite path: import_config_from_string
            // auto-adds a host+user duplicate as a copy «(копия N)» (IN-36) and never overwrites.
            // The unique filename + manifest append happen Rust-side; useFileDrop refreshes the list.
            let config_path = super::deeplink::import_config_from_string(
                content,
                "drag-drop".into(),
                // Preserve the dropped file's original branded filename (the frontend sends
                // file.name) instead of re-deriving from content — keeps the «[<CC>_]…» prefix.
                Some(file_name.clone()),
            )
            .await?;
            Ok(ImportDropResult {
                file_type: "config".into(),
                config_path: Some(config_path),
                routing_rules: None,
            })
        }
        "json" => {
            // WR-06 + IN-57: the dropped content arrives from the frontend `file.text()` — the
            // SAME untrusted/abuse model as the hardened read paths (CR-01 / WR-04). BOTH routing
            // import doors (this drag-drop branch + the «Импорт» button `import_routing_rules`) go
            // through the SHARED `parse_routing_rules_capped` so the 64 KiB cap + i18n error codes
            // are identical — WR-06 had hardened only this door, leaving the button uncapped.
            let rules = crate::routing_rules::parse_routing_rules_capped(&content)?;
            crate::routing_rules::save_routing_rules(rules.clone())?;
            Ok(ImportDropResult {
                file_type: "routing".into(),
                config_path: None,
                routing_rules: Some(rules),
            })
        }
        _ => Err(format!("Unsupported file format: .{ext}")),
    }
}
