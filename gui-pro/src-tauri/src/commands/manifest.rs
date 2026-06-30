//! Multi-config manifest model — Phase 11 foundation slice.
//!
//! This module owns the `configs.json` manifest that ties the individual per-config
//! `.toml` files (already coexisting on disk, branded `TrustTunnel_<user>.toml`) into
//! an ordered, named, last-used-marked list. It is the SINGLE mutation funnel: every
//! import / delete / duplicate / rename / set-last-used / migration goes through one
//! atomic write (temp + fsync + rename — WCA-03 / RESEARCH Pattern 1).
//!
//! Wave 1 (Plan 11-02, this file) implements the production functions and turns the
//! Wave-0 ignored stubs into real RED→GREEN assertions.
//!
//! Security invariants this module holds:
//!   * D-29 — the manifest stores NO password; never log `.toml` content / secrets.
//!     `summarize()` reads name/host/user only, never `endpoint.password`.
//!   * V12 — every path-taking op validates against `portable_data_dir()`
//!     (reuse `config.rs::validate_app_path`); delete only manifest-tracked files
//!     inside the data dir.

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;

use crate::ssh::portable_data_dir;

/// WR-01: process-wide serialization for the manifest read-modify-write funnel.
///
/// Every mutator (`add_config`, `delete_config`, `duplicate_config`, `rename_config`,
/// `set_last_used`, `migrate_configs`, and the deeplink import append/replace) does an
/// independent `read_manifest → mutate → write_manifest_atomic`. The individual file
/// write is atomic (temp + fsync + rename), but the read→write WINDOW is not: two
/// near-simultaneous Tauri invokes could interleave so command B reads the manifest
/// before command A's write lands, then B overwrites with a stale copy and A's mutation
/// is silently lost (last-writer-wins). A single std `Mutex<()>` taken at the top of the
/// funnel closes that window — the mutators are short and synchronous, so a blocking
/// std mutex is sufficient (the only async path, the per-config ping, never mutates the
/// manifest). The guard is poison-tolerant: a panic while held must not wedge every
/// later config operation, so we recover the inner `()` rather than propagate the poison.
static MANIFEST_LOCK: Mutex<()> = Mutex::new(());

/// Acquire the manifest funnel lock, recovering from a poisoned mutex. The guarded value
/// is `()` (no shared state lives behind the lock — it serializes the read-modify-write
/// SECTION, not a datum), so a prior panic cannot have left inconsistent in-memory state;
/// recovering the poison is always safe here and keeps a single panicking command from
/// permanently breaking the config list.
fn lock_manifest() -> std::sync::MutexGuard<'static, ()> {
    MANIFEST_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Current manifest schema version. Bumped only on a breaking layout change.
/// Migration is idempotent and guards on the presence of a manifest at this version.
pub const MANIFEST_SCHEMA_VERSION: u32 = 1;

/// The manifest file name in the portable data dir.
const MANIFEST_FILENAME: &str = "configs.json";
/// The temp file used by the atomic writer (written, fsync'd, then renamed over the real one).
const MANIFEST_TMP_FILENAME: &str = "configs.json.tmp";

/// One config entry in the manifest. Holds ONLY non-secret metadata — the
/// credentials (username/password) live inside the per-config `.toml` and are read
/// on demand. The manifest must never duplicate the password (D-29 / V8).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConfigEntry {
    /// Stable id for this config (derived from its path; stable across renames).
    pub id: String,
    /// Display name. TOML `name` → else `username` (D-14). Editable via inline rename.
    pub name: String,
    /// Absolute path to the per-config `.toml` inside the portable data dir.
    pub path: String,
    /// Sort order in the list (lower = higher). Last-used is rendered on top.
    pub order: u32,
    /// Whether this is the last-used config (D-05 — no "favourite"/star concept).
    pub last_used: bool,
}

/// The on-disk `configs.json` manifest. The single source of truth for the config
/// list; written atomically by Rust (the frontend cannot guarantee atomic fs writes).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Manifest {
    /// Schema version — see `MANIFEST_SCHEMA_VERSION`. Drives idempotent migration.
    pub schema_version: u32,
    /// The ordered list of configs.
    pub configs: Vec<ConfigEntry>,
}

impl Default for Manifest {
    fn default() -> Self {
        Self {
            schema_version: MANIFEST_SCHEMA_VERSION,
            configs: Vec::new(),
        }
    }
}

/// Non-secret summary of one config, read from its `.toml` for the card + dup key.
/// NEVER carries `endpoint.password` (D-29).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConfigSummary {
    pub id: String,
    pub name: String,
    pub host: String,
    pub user: String,
    pub path: String,
    pub order: u32,
    pub last_used: bool,
}

// ─── Stable id derivation ────────────────────────────────────────────────────

/// Derive a stable id for a config from its on-disk path. The id is stable across
/// renames (the name changes, the path/file does not) and is a filesystem-safe
/// slug of the file stem plus a short hash of the full path so two files with the
/// same stem in different states never collide.
fn id_from_path(path: &Path) -> String {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("config");
    // A small deterministic hash of the canonical-ish path string keeps the id stable
    // for the same file while disambiguating same-stem files. std's DefaultHasher is
    // deterministic within a build for our purposes (we only need stability across the
    // app's own runs, not across std versions).
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.to_string_lossy().hash(&mut hasher);
    let h = hasher.finish();
    // Keep the stem readable; suffix a short hex so the id is unique per path.
    format!("{}-{:08x}", slugify(stem), (h & 0xffff_ffff) as u32)
}

/// IN-51: a strictly-unique id for a config created at runtime (add/import/duplicate). `id_from_path`
/// is a PURE function of the path, so deleting a copy frees its filename and re-adding reclaims the
/// SAME filename → the SAME id. The frontend uses the id as the React `key` (and the per-card
/// view-transition-name), so a recycled id let a freshly-added copy inherit a just-deleted copy's
/// slot («появляются на той же самой позиции»). Appending a creation salt — wall-clock nanos (unique
/// across app restarts) + an atomic per-process counter (unique within the same clock tick) — makes
/// every newly-created config's id strictly unique, so it always renders as a brand-new card. The id
/// is STORED in the manifest at creation and returned verbatim by list_configs (never re-derived), so
/// it stays stable across reloads and renames. Migration keeps `id_from_path` (one-time, no recycle).
fn creation_id(path: &Path) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static CREATION_SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = CREATION_SEQ.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    format!("{}-{:011x}{:04x}", id_from_path(path), nanos & 0xffff_ffff_ffff, seq & 0xffff)
}

/// Lower-case, keep ascii alphanumerics + dash/underscore, collapse the rest to `-`.
fn slugify(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_dash = false;
    for ch in s.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            out.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "config".to_string()
    } else {
        trimmed
    }
}

// ─── Atomic write + read ─────────────────────────────────────────────────────

/// Atomically write the manifest: write to `configs.json.tmp`, fsync, then rename
/// over `configs.json` (atomic swap on the same NTFS volume). The ONLY writer path.
pub fn write_manifest_atomic(dir: &Path, manifest: &Manifest) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("Failed to create data dir: {e}"))?;
    let tmp = dir.join(MANIFEST_TMP_FILENAME);
    let final_path = dir.join(MANIFEST_FILENAME);
    let json = serde_json::to_vec_pretty(manifest)
        .map_err(|e| format!("Failed to serialize manifest: {e}"))?;
    {
        let mut f =
            std::fs::File::create(&tmp).map_err(|e| format!("Failed to create temp manifest: {e}"))?;
        std::io::Write::write_all(&mut f, &json)
            .map_err(|e| format!("Failed to write temp manifest: {e}"))?;
        // fsync the data to disk before the rename so a crash can never leave a
        // half-written configs.json (the temp may be partial, the real file is not).
        f.sync_all()
            .map_err(|e| format!("Failed to fsync temp manifest: {e}"))?;
    }
    std::fs::rename(&tmp, &final_path)
        .map_err(|e| format!("Failed to swap manifest into place: {e}"))?;
    Ok(())
}

/// Read and deserialize the manifest from `configs.json` in the given dir.
/// Returns the default (empty) manifest if none exists.
pub fn read_manifest(dir: &Path) -> Result<Manifest, String> {
    let path = dir.join(MANIFEST_FILENAME);
    if !path.exists() {
        return Ok(Manifest::default());
    }
    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("Failed to read manifest: {e}"))?;
    serde_json::from_str::<Manifest>(&content)
        .map_err(|e| format!("Failed to parse manifest: {e}"))
}

// ─── Config-file predicate + summary (D-14 / D-29) ───────────────────────────

/// Is this `.toml` a TrustTunnel client config? Mirrors `config.rs::auto_detect_config`
/// (and the `deeplink.rs` shape guard): it must contain `[endpoint]` or `[listener`.
fn looks_like_config(content: &str) -> bool {
    content.contains("[endpoint]") || content.contains("[listener")
}

/// Read name/host/user out of a config `.toml`. Name = TOML `name` → else `username`
/// (D-14). NEVER reads or logs `endpoint.password` (D-29). Validates the path first (V12).
///
/// Exposed as a Tauri command so later waves (e.g. ConfigEditView's read-only header)
/// can fetch a single config's non-secret summary by path without going through the
/// whole list. The password is never part of the returned `ConfigSummary`.
#[tauri::command]
pub fn summarize_config(path: String) -> Result<ConfigSummary, String> {
    validate_app_path(&path)?;
    summarize_unchecked(&path)
}

/// The path-validation-free summary reader. Callers that have ALREADY validated the path
/// (or that read only files they themselves discovered inside the data dir, e.g. the
/// migration scan and the in-process `list_configs`) use this. Tests use it directly with
/// tempdir fixtures (which legitimately live outside `portable_data_dir()`).
fn summarize_unchecked(path: &str) -> Result<ConfigSummary, String> {
    let content =
        std::fs::read_to_string(path).map_err(|e| format!("Failed to read config: {e}"))?;
    let v: toml::Value =
        toml::from_str(&content).map_err(|e| format!("Failed to parse config: {e}"))?;
    let ep = v.get("endpoint").and_then(|e| e.as_table());
    let host = ep
        .and_then(|e| e.get("hostname"))
        .and_then(|h| h.as_str())
        .unwrap_or_default()
        .to_string();
    let user = ep
        .and_then(|e| e.get("username"))
        .and_then(|u| u.as_str())
        .unwrap_or_default()
        .to_string();
    // The config NAME lives in [endpoint] in real server configs (endpoint.name); accept a
    // top-level `name` too (older hand-made files), then fall back to the username (D-14).
    let name = ep
        .and_then(|e| e.get("name"))
        .and_then(|n| n.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from)
        .or_else(|| {
            v.get("name")
                .and_then(|n| n.as_str())
                .filter(|s| !s.is_empty())
                .map(String::from)
        })
        .unwrap_or_else(|| user.clone());
    // NOTE: endpoint.password is intentionally NEVER read here — D-29.
    let p = Path::new(path);
    Ok(ConfigSummary {
        id: id_from_path(p),
        name,
        host,
        user,
        path: path.to_string(),
        order: 0,
        last_used: false,
    })
}

// ─── Path validation ─────────────────────────────────────────────────────────
//
// WR-03: the validator now lives in one shared place (commands::paths) instead of a copy
// per module. Re-export both names so manifest's call sites + the delete-orphan test (which
// passes a tempdir to `validate_path_in_dir`) read unchanged.
use crate::commands::paths::{validate_app_path, validate_path_in_dir};

// ─── Migration (HEADLINE P11-02) ─────────────────────────────────────────────

/// Idempotent startup migration: legacy `tt_config_path` → config #1 + last-used;
/// scan all `*.toml` with the `[endpoint]`/`[listener]` predicate, dedup by path,
/// append the rest; never delete a file; guard on an existing manifest so a re-run is
/// a no-op. The headline P11-02 invariant: the user's working config is NEVER lost.
pub fn migrate_to_manifest(
    dir: &Path,
    legacy_active_path: Option<&str>,
) -> Result<Manifest, String> {
    // Idempotency guard: if a manifest already exists at this dir, return it unchanged.
    // A second run (StrictMode double-fire, a second launch) must not rebuild or reorder.
    let existing_path = dir.join(MANIFEST_FILENAME);
    if existing_path.exists() {
        return read_manifest(dir);
    }

    let mut entries: Vec<ConfigEntry> = Vec::new();
    let mut seen_paths: Vec<std::path::PathBuf> = Vec::new();

    // (a) The legacy active config is config #1 + last_used, IF it exists on disk and is
    //     a real config. This is the file the user is connected through — it must never
    //     be lost or demoted (P11-02).
    if let Some(active) = legacy_active_path {
        let active_path = Path::new(active);
        if active_path.is_file() {
            if let Ok(content) = std::fs::read_to_string(active_path) {
                if looks_like_config(&content) {
                    let canon = canonical_or_self(active_path);
                    let name = derive_name(&content, active_path);
                    entries.push(ConfigEntry {
                        id: id_from_path(active_path),
                        name,
                        path: active_path.to_string_lossy().to_string(),
                        order: 0,
                        last_used: true,
                    });
                    seen_paths.push(canon);
                }
            }
        }
    }

    // (b) Scan ALL *.toml in the data dir with the config predicate; dedup by canonical
    //     path against the active one + each other; append the rest in a stable order.
    //     NEVER delete a file. A sorted scan keeps the manifest deterministic (idempotent
    //     byte-output even though we only write once, this guards re-creation parity).
    // IN-03: carry the content read here straight through to derive_name instead of reading
    // each candidate `.toml` a SECOND time below — one read per file, not two.
    let mut found: Vec<(std::path::PathBuf, String)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) == Some("toml")
                && p.file_name().and_then(|s| s.to_str()) != Some("Cargo.toml")
            {
                if let Ok(content) = std::fs::read_to_string(&p) {
                    if looks_like_config(&content) {
                        found.push((p, content));
                    }
                }
            }
        }
    }
    // Sort by path so the manifest order is deterministic (the content tuple element is not
    // part of the ordering key).
    found.sort_by(|a, b| a.0.cmp(&b.0));

    let mut next_order: u32 = entries.len() as u32;
    for (p, content) in found {
        let canon = canonical_or_self(&p);
        if seen_paths.iter().any(|s| s == &canon) {
            continue; // dedup — already the active config (or a duplicate path)
        }
        let name = derive_name(&content, &p);
        entries.push(ConfigEntry {
            id: id_from_path(&p),
            name,
            path: p.to_string_lossy().to_string(),
            order: next_order,
            last_used: false,
        });
        seen_paths.push(canon);
        next_order += 1;
    }

    let manifest = Manifest {
        schema_version: MANIFEST_SCHEMA_VERSION,
        configs: entries,
    };
    write_manifest_atomic(dir, &manifest)?;
    Ok(manifest)
}

/// Canonicalize a path, falling back to the path itself if canonicalize fails (e.g. the
/// file vanished between scan and read). Used only for dedup comparison.
fn canonical_or_self(p: &Path) -> std::path::PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// Derive the display name from config content: TOML `name` → else `username` → else the
/// file stem (D-14, with a final stem fallback so a nameless+userless config still shows
/// something sensible). NEVER reads the password.
fn derive_name(content: &str, path: &Path) -> String {
    if let Ok(v) = toml::from_str::<toml::Value>(content) {
        let ep = v.get("endpoint").and_then(|e| e.as_table());
        // Name lives in [endpoint] in real server configs (endpoint.name); accept a top-level
        // `name` too (older hand-made files), then the username, then the file stem.
        if let Some(name) = ep.and_then(|e| e.get("name")).and_then(|n| n.as_str()) {
            if !name.is_empty() {
                return name.to_string();
            }
        }
        if let Some(name) = v.get("name").and_then(|n| n.as_str()) {
            if !name.is_empty() {
                return name.to_string();
            }
        }
        if let Some(user) = ep.and_then(|e| e.get("username")).and_then(|u| u.as_str()) {
            if !user.is_empty() {
                return user.to_string();
            }
        }
    }
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("config")
        .to_string()
}

/// IN-58: remove `name` from the `[endpoint]` table — used when the user CLEARS the title (an
/// empty name is valid and falls back to the username). `toml_edit` preserves comments, key order
/// and the other tables (incl. the `[listener.tun]` routing block). An unparseable file is
/// returned unchanged (the manifest label is still cleared by the caller, so the card falls back
/// to the username regardless).
fn remove_endpoint_name(content: &str) -> String {
    match content.parse::<toml_edit::DocumentMut>() {
        Ok(mut doc) => {
            if let Some(ep) = doc.get_mut("endpoint").and_then(|e| e.as_table_mut()) {
                ep.remove("name");
            }
            doc.to_string()
        }
        Err(_) => content.to_string(),
    }
}

/// Upsert the `name = "…"` key INSIDE the `[endpoint]` table of a config `.toml` WITHOUT
/// disturbing the rest of the file (comments, key order, the other tables the sidecar reads).
///
/// Real server configs carry the display name as `endpoint.name` (NOT top-level), so the rename
/// must write it there for `summarize_unchecked` (and the server) to read it back. Line-based on
/// purpose: re-serializing through the `toml` crate would drop the config's comments and reorder
/// keys. If a `name = …` line already exists inside `[endpoint]` it is REPLACED in place;
/// otherwise the key is INSERTED at the end of the `[endpoint]` section (just before the next
/// table header, or at EOF). When there is no `[endpoint]` table at all (never, for a valid
/// config), the content is returned unchanged. The value is escaped for a TOML basic string.
fn upsert_endpoint_name(content: &str, name: &str) -> String {
    let escaped = name.replace('\\', "\\\\").replace('"', "\\\"");
    let name_line = format!("name = \"{escaped}\"");
    let mut out: Vec<String> = Vec::new();
    let mut in_endpoint = false;
    let mut done = false;
    // WR-02: a `name`/`addresses`/`dns_upstreams`/`included_routes` value can be a multi-line
    // array (an array-of-arrays, or a pretty-printed array broken across lines), whose
    // CONTINUATION lines legitimately begin with `[`. The old code treated ANY line whose
    // trimmed start is `[` as a table header, so such a continuation line flipped `in_endpoint`
    // false (or the name got inserted mid-array) → malformed TOML. We now track unterminated
    // `[...]`/`{...}` bracket depth across lines: a line is only a table header when we are at
    // bracket depth 0 (not inside an open multi-line value). `[` at depth 0 that is a table
    // header reads as `[name]` / `[a.b]`, never as the start of a value array, so depth-0 is the
    // correct discriminator.
    let mut bracket_depth: i32 = 0;
    for raw in content.lines() {
        let trimmed = raw.trim_start();
        // Only consider a line a table header when we are NOT inside an open multi-line
        // array/inline-table value carried over from a previous line.
        if bracket_depth == 0 && is_table_header(trimmed) {
            // A new table header. If we were inside [endpoint] and have not written the name
            // yet, append it at the END of the endpoint section (before this header).
            if in_endpoint && !done {
                out.push(name_line.clone());
                done = true;
            }
            in_endpoint = trimmed.starts_with("[endpoint]");
            out.push(raw.to_string());
            // A table header line carries no unterminated value, so depth stays 0.
            continue;
        }
        if in_endpoint && !done && bracket_depth == 0 && is_name_assignment(trimmed) {
            // Replace the existing endpoint.name in place. Only at depth 0 so a `name` key that
            // is itself a multi-line array opener still updates the depth below for its
            // continuation lines (it is not a plain replaceable scalar). For our purposes
            // endpoint.name is always a single-line string, so the common path replaces it here.
            out.push(name_line.clone());
            done = true;
            // The replaced line's own brackets are irrelevant now (we wrote a scalar), so do
            // NOT fold its depth in — continue to the next line at the same depth.
            continue;
        }
        // Track bracket depth across this line so the NEXT line knows whether it is a value
        // continuation (depth > 0) rather than a table header. Quote-/comment-aware so a `[`
        // inside a string or a `# comment` does not skew the count.
        bracket_depth = (bracket_depth + net_bracket_delta(raw)).max(0);
        out.push(raw.to_string());
    }
    // EOF while still inside [endpoint] (it was the last table) and no name written → append.
    if in_endpoint && !done {
        out.push(name_line.clone());
    }
    // If [endpoint] never appeared, leave the file untouched (caller validated it is a config).
    let mut joined = out.join("\n");
    if content.ends_with('\n') {
        joined.push('\n');
    }
    joined
}

/// True for a `name = …` assignment line — not a comment, not a different key like
/// `name_servers`. Used by `upsert_endpoint_name` to find a replaceable existing name line.
fn is_name_assignment(trimmed: &str) -> bool {
    match trimmed.strip_prefix("name") {
        Some(rest) => rest.trim_start().starts_with('='),
        None => false,
    }
}

/// WR-02: a TOML table header is `[table]` or `[[array-of-tables]]` — a `[` at the very start
/// of the (trimmed) line that is NOT immediately followed by content making it an array VALUE.
/// Because we only call this at bracket-depth 0 (outside any open multi-line value), a leading
/// `[` here is unambiguously a header. We additionally require a matching `]` ON THE SAME LINE
/// so a multi-line array assigned at depth 0 like `key = [` (which does not start with `[`) and
/// a bare continuation line are never misread; a real header always closes its bracket inline.
fn is_table_header(trimmed: &str) -> bool {
    if !trimmed.starts_with('[') {
        return false;
    }
    // The header's closing `]` is on the same line for both `[t]` and `[[a]]`. A multi-line
    // array whose FIRST line happened to start with `[` (an array-of-arrays opener) would NOT
    // close on the same line, so it is correctly excluded.
    trimmed.contains(']')
}

/// WR-02: net change in unterminated bracket depth contributed by a single line, counting `[`
/// `]` `{` `}` while IGNORING anything inside a TOML string (basic `"…"`, literal `'…'`) or
/// after an unquoted `#` comment. This lets `upsert_endpoint_name` know whether the NEXT line
/// is a value continuation (depth > 0) instead of a table header. Conservative: it does not
/// model multi-line basic strings (`"""`), which configs we write never use around `[endpoint]`.
fn net_bracket_delta(line: &str) -> i32 {
    let mut depth: i32 = 0;
    let mut in_basic = false; // inside "…"
    let mut in_literal = false; // inside '…'
    let mut escaped = false; // previous char was a backslash inside a basic string
    for c in line.chars() {
        if in_basic {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_basic = false;
            }
            continue;
        }
        if in_literal {
            // Literal strings have no escapes — a `'` always closes.
            if c == '\'' {
                in_literal = false;
            }
            continue;
        }
        match c {
            '"' => in_basic = true,
            '\'' => in_literal = true,
            '#' => break, // rest of the line is a comment
            '[' | '{' => depth += 1,
            ']' | '}' => depth -= 1,
            _ => {}
        }
    }
    depth
}

// ─── Manifest mutation funnel (Tauri commands) ───────────────────────────────
//
// Each command reads the manifest → mutates in memory → write_manifest_atomic. Every
// path-taking op validates against portable_data_dir() first (V12). These are registered
// in lib.rs in THIS plan so no later wave edits lib.rs for manifest ops.

/// Run the startup migration. The frontend reads the legacy `tt_config_path` from
/// localStorage and passes it; idempotent (a second call is a no-op). Returns the list.
#[tauri::command]
pub fn migrate_configs(legacy_active_path: Option<String>) -> Result<Vec<ConfigSummary>, String> {
    // WR-01: serialize the read-modify-write window so a startup migration cannot race a
    // concurrent user mutation (e.g. a fast delete/rename) and lose an update.
    let _guard = lock_manifest();
    let dir = portable_data_dir();
    migrate_to_manifest(&dir, legacy_active_path.as_deref())?;
    list_configs()
}

/// Return the manifest entries as non-secret summaries (id/name/host/user/path +
/// order/last_used). Reads each entry's `.toml` for the fresh name/host/user (D-14);
/// the manifest stores NO password. The last-used entry is surfaced first.
#[tauri::command]
pub fn list_configs() -> Result<Vec<ConfigSummary>, String> {
    list_configs_in_dir(&portable_data_dir())
}

/// Testable core of `list_configs` against an explicit dir. NOTE: this does NOT take
/// `lock_manifest()` — `list_configs` is called from inside other commands that already hold
/// the lock (add/delete/duplicate/rename), so re-locking would deadlock. It is a pure read +
/// summarize; the IN-25 prune below only FILTERS the returned list (it never rewrites
/// configs.json), so it is safe to run lock-free.
fn list_configs_in_dir(dir: &Path) -> Result<Vec<ConfigSummary>, String> {
    let manifest = read_manifest(dir)?;
    let mut out: Vec<ConfigSummary> = Vec::with_capacity(manifest.configs.len());
    for entry in &manifest.configs {
        // IN-25: drop entries whose `.toml` was deleted OUTSIDE the app (removed in the file
        // manager) so the card disappears on the next reload. Use try_exists() — NOT summarize
        // success — so a present-but-locked / present-but-unparseable file is KEPT (it still
        // falls back to the manifest name below); only a genuinely-absent file (Ok(false)) is
        // skipped. A try_exists Err (permission/IO) is treated as "present" (keep, don't drop on
        // an inconclusive check). The manifest is not rewritten here (would need the lock and
        // would deadlock); the absent entry is simply filtered out each list call.
        if matches!(Path::new(&entry.path).try_exists(), Ok(false)) {
            continue;
        }
        // Re-summarize from the .toml so renames/edits to the file reflect; fall back to
        // the manifest name if the file is unreadable (do not drop the entry). The paths
        // here are manifest-tracked (added through the validated add/migrate funnel), so
        // the unchecked reader is correct — no second path-validation needed.
        let summary = summarize_unchecked(&entry.path).unwrap_or_else(|_| ConfigSummary {
            id: entry.id.clone(),
            name: entry.name.clone(),
            host: String::new(),
            user: String::new(),
            path: entry.path.clone(),
            order: entry.order,
            last_used: entry.last_used,
        });
        out.push(ConfigSummary {
            id: entry.id.clone(),
            name: if summary.name.is_empty() {
                entry.name.clone()
            } else {
                summary.name
            },
            host: summary.host,
            user: summary.user,
            path: entry.path.clone(),
            order: entry.order,
            last_used: entry.last_used,
        });
    }
    // last-used first, then by order — the lead card renders on top (D-05 / D-18).
    out.sort_by(|a, b| {
        b.last_used
            .cmp(&a.last_used)
            .then(a.order.cmp(&b.order))
    });
    Ok(out)
}

/// Append an already-on-disk config (inside the data dir) to the manifest. Deduped by
/// canonical path — adding the same path twice is a no-op. Returns the updated list.
#[tauri::command]
pub fn add_config(path: String) -> Result<Vec<ConfigSummary>, String> {
    validate_app_path(&path)?;
    // WR-01: hold the funnel lock across read→mutate→write so a concurrent mutation
    // cannot overwrite this add with a stale manifest copy (lost update).
    let _guard = lock_manifest();
    let dir = portable_data_dir();
    let mut manifest = read_manifest(&dir)?;
    prune_missing(&mut manifest); // IN-55: drop ghosts so order/dedup are truthful
    add_entry(&mut manifest, &path)?;
    write_manifest_atomic(&dir, &manifest)?;
    list_configs()
}

/// Internal: append a config entry (deduped by canonical path). Shared by add_config +
/// duplicate_config so the dedup rule lives in one place. Name derived from content (D-14).
fn add_entry(manifest: &mut Manifest, path: &str) -> Result<(), String> {
    add_entry_named(manifest, path, None)
}

/// Like `add_entry` but with an OPTIONAL explicit display name. The import/duplicate COPY paths
/// pass `Some("<base> (копия N)")` (IN-26) so the copy is labelled distinctly; a plain
/// add/import passes `None` and derives the name from content (D-14).
fn add_entry_named(
    manifest: &mut Manifest,
    path: &str,
    name_override: Option<&str>,
) -> Result<(), String> {
    let p = Path::new(path);
    let canon = canonical_or_self(p);
    let already = manifest
        .configs
        .iter()
        .any(|c| canonical_or_self(Path::new(&c.path)) == canon);
    if already {
        return Ok(()); // dedup — no-op
    }
    let content = std::fs::read_to_string(p).map_err(|e| format!("Failed to read config: {e}"))?;
    if !looks_like_config(&content) {
        return Err("File is not a TrustTunnel config (missing [endpoint])".into());
    }
    let next_order = manifest.configs.iter().map(|c| c.order).max().map_or(0, |m| m + 1);
    let name = match name_override {
        Some(n) => n.to_string(),
        None => derive_name(&content, p),
    };
    manifest.configs.push(ConfigEntry {
        id: creation_id(p), // IN-51: unique per creation, never recycled from a deleted copy
        name,
        path: path.to_string(),
        order: next_order,
        last_used: false,
    });
    Ok(())
}

// ─── Ghost pruning (IN-55) ───────────────────────────────────────────────────
//
// list_configs HIDES entries whose `.toml` was deleted outside the app (try_exists == Ok(false))
// but never rewrites configs.json (IN-25 — it runs lock-free inside locked callers, so it cannot
// re-lock to write). Those lingering "ghost" entries are read RAW by next_copy_name / the order
// allocator / find_duplicate_by_host_user, which is why the owner saw «(копия 4)» with no copy 2,
// a re-added config snap back to a deleted slot, and a fresh «Россия» become «Россия (копия)».
// Pruning the ghosts before any add/copy/import (and persisting it) makes those reads truthful.

/// Drop manifest entries whose `.toml` is CONFIRMED gone from disk, then compact `order` to a
/// contiguous 0..N (by prior order) so the freed slots don't pin a re-added config. Only a
/// genuinely-absent file (`try_exists() == Ok(false)`) is removed — a present-but-locked or
/// inconclusive (Err) entry is KEPT, same rule list_configs uses to hide. Returns whether
/// anything was removed. Operates on an in-memory manifest; the caller persists the write.
fn prune_missing(manifest: &mut Manifest) -> bool {
    let before = manifest.configs.len();
    manifest
        .configs
        .retain(|e| !matches!(Path::new(&e.path).try_exists(), Ok(false)));
    if manifest.configs.len() == before {
        return false;
    }
    let mut idxs: Vec<usize> = (0..manifest.configs.len()).collect();
    idxs.sort_by_key(|&i| manifest.configs[i].order);
    for (new_order, &i) in idxs.iter().enumerate() {
        manifest.configs[i].order = new_order as u32;
    }
    true
}

/// Lock + read + prune + write-if-changed. For callers that do NOT already hold the funnel lock
/// (the import flow, which then runs find_duplicate / next_copy_name as separate locked reads, and
/// the fs-watcher). Callers already holding the lock with a manifest in hand (add/duplicate) use
/// `prune_missing` directly instead — re-locking here would deadlock.
pub fn prune_manifest_in_dir(dir: &Path) -> Result<bool, String> {
    let _guard = lock_manifest();
    let mut manifest = read_manifest(dir)?;
    let changed = prune_missing(&mut manifest);
    if changed {
        write_manifest_atomic(dir, &manifest)?;
    }
    Ok(changed)
}

// ─── Copy naming (IN-26) ─────────────────────────────────────────────────────
//
// A deliberately-created copy (card «Дублировать» or import «Добавить копию») is labelled
// «<base> (копия)», then «<base> (копия 2)», «(копия 3)», … The name is baked INTO the copy's
// `.toml` as `endpoint.name` so `list_configs` (which re-derives the name from the file) surfaces
// it and ConfigEditView shows the same title — the same model rename uses.

/// Strip a trailing « (копия)» / « (копия N)» from a display name to get its true base, so a
/// copy-of-a-copy does not nest («X (копия) (копия)»).
fn copy_base_name(name: &str) -> String {
    let s = name.trim_end();
    if let Some(base) = s.strip_suffix(" (копия)") {
        return base.trim_end().to_string();
    }
    // « (копия N)» — strip the trailing ')', then a run of digits, then « (копия ».
    if let Some(inner) = s.strip_suffix(')') {
        if let Some(idx) = inner.rfind(" (копия ") {
            let num = &inner[idx + " (копия ".len()..];
            if !num.is_empty() && num.chars().all(|c| c.is_ascii_digit()) {
                return inner[..idx].trim_end().to_string();
            }
        }
    }
    s.to_string()
}

/// The next free copy display name for `base` given the existing display names: «<base>
/// (копия)» if free, else «<base> (копия 2)», «(копия 3)», … (the first unused N≥2).
fn next_copy_name(existing: &[String], base: &str) -> String {
    let first = format!("{base} (копия)");
    if !existing.iter().any(|n| n == &first) {
        return first;
    }
    let mut n = 2u32;
    loop {
        let cand = format!("{base} (копия {n})");
        if !existing.iter().any(|x| x == &cand) {
            return cand;
        }
        n += 1;
    }
}

/// The display names of all current manifest entries (file-derived name → else manifest label),
/// the same derivation `list_configs` uses — for allocating a non-colliding copy name.
fn existing_display_names(manifest: &Manifest) -> Vec<String> {
    manifest
        .configs
        .iter()
        .map(|e| {
            summarize_unchecked(&e.path)
                .map(|s| if s.name.is_empty() { e.name.clone() } else { s.name })
                .unwrap_or_else(|_| e.name.clone())
        })
        .collect()
}

/// Public: the next free copy name for `base_display_name` against `dir`'s manifest. Used by the
/// import AddCopy path (deeplink.rs) to label an imported duplicate «<base> (копия [N])».
pub fn next_copy_name_for(dir: &Path, base_display_name: &str) -> String {
    let base = copy_base_name(base_display_name);
    let existing = read_manifest(dir)
        .map(|m| existing_display_names(&m))
        .unwrap_or_default();
    next_copy_name(&existing, &base)
}

/// Public wrapper so the import path can bake a display name into config content as
/// `endpoint.name` (the title `list_configs` reads). Pure string transform.
pub fn with_endpoint_name(content: &str, name: &str) -> String {
    upsert_endpoint_name(content, name)
}

/// IN-31: watch the config data dir and emit `configs-changed` so the «Подключение» list
/// refreshes the INSTANT a config `.toml` (or `configs.json`) is created/removed/changed on disk
/// — e.g. a config deleted in the file manager disappears immediately instead of lingering until
/// a tab-switch/focus. Mirrors `geodata_v2ray::start_geodata_watcher`: a dedicated thread owns
/// the `notify` watcher (which is dropped if the thread exits), filters to our files, and lives
/// for the app's whole run. Best-effort: a watcher failure just means the focus/tab reload
/// backstop (IN-25) still applies.
pub fn start_configs_watcher(app: tauri::AppHandle) {
    use notify::{Event, EventKind, RecursiveMode, Watcher};
    use tauri::Emitter;

    let dir = portable_data_dir();
    if std::fs::create_dir_all(&dir).is_err() {
        eprintln!("[configs] data dir unavailable; watcher not started");
        return;
    }
    eprintln!("[configs] Starting file watcher on {}", dir.display());

    std::thread::spawn(move || {
        let app_handle = app.clone();
        let mut watcher = match notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            let Ok(event) = res else { return };
            if !matches!(
                event.kind,
                EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(_)
            ) {
                return;
            }
            // Only our files (the per-config .toml + the manifest) — ignore unrelated writes so we
            // don't spam refreshes. NEVER read or log file CONTENT (D-29): we react to path events
            // only and the frontend re-reads via list_configs (which carries no password).
            let relevant = event.paths.iter().any(|p| {
                p.extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|e| e.eq_ignore_ascii_case("toml"))
                    || p.file_name().and_then(|n| n.to_str()) == Some(MANIFEST_FILENAME)
            });
            if relevant {
                app_handle.emit("configs-changed", ()).ok();
            }
        }) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("[configs] Failed to create watcher: {e}");
                return;
            }
        };

        if let Err(e) = watcher.watch(&dir, RecursiveMode::NonRecursive) {
            eprintln!("[configs] Failed to watch directory: {e}");
            return;
        }
        eprintln!("[configs] File watcher active");

        // Keep the thread (and thus the watcher) alive for the app's lifetime.
        loop {
            std::thread::sleep(std::time::Duration::from_secs(60));
        }
    });
}

/// The CURRENT display name of a config read from its `.toml` (the same derivation
/// `list_configs` uses) — so callers never depend on a possibly-stale manifest label. `None`
/// when the file can't be read or yields an empty name.
pub fn current_display_name(path: &str) -> Option<String> {
    summarize_unchecked(path)
        .ok()
        .map(|s| s.name)
        .filter(|n| !n.is_empty())
}

/// Re-sync a manifest entry's display name from its `.toml` (the file is the source of truth for
/// the name). Best-effort: a no-op when the path isn't manifest-tracked or is unreadable. Called
/// after `save_client_config` so an «Имя конфига» edit in ConfigEditView (which rewrites the
/// `.toml` but NOT the manifest) keeps the manifest label in sync — otherwise the stale label
/// resurfaced (e.g. as the import copy name «<old> (копия)», IN-26).
pub fn sync_entry_name_from_file(path: &str) -> Result<(), String> {
    let _guard = lock_manifest();
    sync_entry_name_in_dir(&portable_data_dir(), path)
}

/// Testable core of `sync_entry_name_from_file` against an explicit dir (the command wraps this
/// with the funnel lock + `portable_data_dir()`).
fn sync_entry_name_in_dir(dir: &Path, path: &str) -> Result<(), String> {
    let new_name = match current_display_name(path) {
        Some(n) => n,
        None => return Ok(()), // unreadable → leave the manifest label as the fallback
    };
    let mut manifest = read_manifest(dir)?;
    let canon = canonical_or_self(Path::new(path));
    let mut changed = false;
    if let Some(entry) = manifest
        .configs
        .iter_mut()
        .find(|c| canonical_or_self(Path::new(&c.path)) == canon)
    {
        if entry.name != new_name {
            entry.name = new_name;
            changed = true;
        }
    }
    if changed {
        write_manifest_atomic(dir, &manifest)?;
    }
    Ok(())
}

/// Delete a config: remove its manifest entry AND its on-disk `.toml` — but ONLY when the
/// file is a manifest-tracked file inside the portable data dir (V12). Refuses to touch a
/// path outside the data dir.
#[tauri::command]
pub fn delete_config(id: String) -> Result<Vec<ConfigSummary>, String> {
    // WR-01: serialize read→mutate→write against other manifest mutators.
    let _guard = lock_manifest();
    let dir = portable_data_dir();
    delete_config_in_dir(&dir, &id)?;
    list_configs()
}

/// Testable core of `delete_config` against an explicit dir (the command wraps this with
/// the funnel lock + `portable_data_dir()` + `list_configs`). Splitting it out lets the
/// WR-03 regression test drive the orphan-on-failure path with a tempdir + a locked file
/// without touching the process-global data dir.
fn delete_config_in_dir(dir: &Path, id: &str) -> Result<(), String> {
    let mut manifest = read_manifest(dir)?;
    let idx = manifest
        .configs
        .iter()
        .position(|c| c.id == id)
        .ok_or("Config not found in manifest")?;
    let entry = manifest.configs.remove(idx);
    // WR-03: delete the on-disk file FIRST and only DROP the manifest entry if that
    // succeeds. The old code removed the entry unconditionally and best-effort-deleted the
    // file (`let _ = remove_file`). If the `.toml` was locked / in use / permission-denied
    // the delete silently failed yet the entry was gone — leaving an ORPHAN file on disk
    // that no manifest entry tracks and that startup migration (guarded by manifest-exists)
    // never re-discovers. Since each config file holds a password, an untracked orphan is
    // also a residual-secret concern. Now, on a delete failure, we re-insert the entry at
    // its original position so the manifest still tracks the file we could not remove, and
    // surface the error to the caller. V12: only delete a file that validates inside the
    // data dir; a path that somehow points outside is dropped from the list (the file is
    // not ours to remove) without attempting a delete. Scoped to `dir` (the manifest's own
    // dir) so the WR-03 test can drive this with a tempdir; in production `dir` IS
    // `portable_data_dir()`, so the behaviour is unchanged.
    if validate_path_in_dir(&entry.path, dir).is_ok() {
        if let Err(e) = std::fs::remove_file(&entry.path) {
            // The file may have been deleted out from under us already — NotFound is
            // success-equivalent (the file is gone, which is the goal). Any other error
            // means the file still exists, so keep tracking it: re-insert and fail.
            if e.kind() != std::io::ErrorKind::NotFound {
                manifest.configs.insert(idx, entry);
                return Err(format!("Failed to delete config file: {e}"));
            }
        }
    }
    // If we removed the last-used config, promote the new top entry (lowest order) so the
    // list always has a sensible lead when non-empty.
    if entry.last_used {
        if let Some(top) = manifest.configs.iter_mut().min_by_key(|c| c.order) {
            top.last_used = true;
        }
    }
    write_manifest_atomic(dir, &manifest)
}

/// Duplicate a config: copy its `.toml` to a unique filename in the data dir and append a
/// «(копия)» entry. The active/last-used config is untouched.
#[tauri::command]
pub fn duplicate_config(id: String) -> Result<Vec<ConfigSummary>, String> {
    // WR-01: serialize read→mutate→write against other manifest mutators.
    let _guard = lock_manifest();
    let dir = portable_data_dir();
    let mut manifest = read_manifest(&dir)?;
    prune_missing(&mut manifest); // IN-55: drop ghosts so the copy name/order are truthful
    let src = manifest
        .configs
        .iter()
        .find(|c| c.id == id)
        .ok_or("Config not found in manifest")?
        .clone();
    validate_app_path(&src.path)?;
    let src_path = Path::new(&src.path);
    let stem = src_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("config");
    // Allocate a unique destination filename so duplicate never overwrites (Pitfall 2).
    let dest = unique_path(&dir, stem);
    std::fs::copy(src_path, &dest).map_err(|e| format!("Failed to copy config: {e}"))?;
    // IN-26: label the copy «<base> (копия [N])» (incrementing), where <base> is the source's
    // DISPLAY name with any existing « (копия …)» stripped (so a copy-of-a-copy does not nest).
    // Bake the name INTO the copy's `.toml` as endpoint.name so list_configs surfaces it (the
    // file-derived name wins over the manifest label) and ConfigEditView shows the same title.
    let src_display = summarize_unchecked(&src.path)
        .map(|s| if s.name.is_empty() { src.name.clone() } else { s.name })
        .unwrap_or_else(|_| src.name.clone());
    let copy_name = next_copy_name(
        &existing_display_names(&manifest),
        &copy_base_name(&src_display),
    );
    let dest_content =
        std::fs::read_to_string(&dest).map_err(|e| format!("Failed to read copied config: {e}"))?;
    std::fs::write(&dest, upsert_endpoint_name(&dest_content, &copy_name))
        .map_err(|e| format!("Failed to write copy name: {e}"))?;
    let next_order = manifest.configs.iter().map(|c| c.order).max().map_or(0, |m| m + 1);
    manifest.configs.push(ConfigEntry {
        id: creation_id(&dest), // IN-51: unique per creation, never recycled from a deleted copy
        name: copy_name,
        path: dest.to_string_lossy().to_string(),
        order: next_order,
        last_used: false,
    });
    write_manifest_atomic(&dir, &manifest)?;
    list_configs()
}

/// Build a unique `<stem>-copy[-N].toml` path inside `dir`, atomically CLAIMING it.
///
/// IN-04: this used to loop on `candidate.exists()` (check) and return the path for the caller
/// to write (write) — a TOCTOU window where an external process could create the file between
/// the check and the caller's write. We now atomically claim the name with
/// `OpenOptions::create_new(true)` (fails with `AlreadyExists` if taken, advancing to the next
/// candidate). The caller then OVERWRITES the freshly-created empty file, so the name can never
/// be stolen between allocation and write. The `MANIFEST_LOCK` already serializes app-internal
/// callers; this also closes the cross-process race the helper itself made no guarantee about.
fn unique_path(dir: &Path, stem: &str) -> std::path::PathBuf {
    let mut candidate = dir.join(format!("{stem}-copy.toml"));
    let mut n = 2;
    loop {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(_) => break, // claimed: the empty file now exists; caller overwrites it
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                candidate = dir.join(format!("{stem}-copy-{n}.toml"));
                n += 1;
            }
            // A non-AlreadyExists error (e.g. permission) — fall back to returning the candidate
            // path unclaimed so the caller's own write surfaces the real IO error with context.
            Err(_) => break,
        }
    }
    candidate
}

// ─── Import-path helpers (shared with deeplink.rs) ───────────────────────────
//
// These let the import write path (deeplink.rs::import_config_from_string) allocate a
// UNIQUE destination filename and APPEND a manifest entry — killing the fixed-filename
// `trusttunnel_client.toml` overwrite bug (Pitfall 2 / T-11-08). The dup-detection helper
// surfaces a host+user collision (D-13) so the import modal can offer replace / add-copy
// WITHOUT the write silently clobbering the first config.

/// Allocate a unique `<stem>.toml` (or `<stem>-2.toml`, `<stem>-3.toml`, …) inside `dir`
/// that does not yet exist. Used by the import write path so a second import never
/// overwrites the first (Pitfall 2). The `stem` is a branded/derived base name; an empty
/// or all-dots stem falls back to `config` so the allocator can never produce `.toml`.
pub fn unique_import_path(dir: &Path, stem: &str) -> std::path::PathBuf {
    let trimmed = stem.trim();
    let safe_stem = if trimmed.is_empty() || trimmed.chars().all(|c| c == '.') {
        "config"
    } else {
        trimmed
    };
    // IN-04: atomically CLAIM the filename with `create_new(true)` instead of the prior
    // check-then-write `candidate.exists()` loop (a TOCTOU window). The import caller then
    // OVERWRITES the freshly-created empty file. Advance to the next candidate on
    // AlreadyExists; on any other IO error fall back to the unclaimed candidate so the caller's
    // own write surfaces the real error.
    let mut candidate = dir.join(format!("{safe_stem}.toml"));
    let mut n = 2;
    loop {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(_) => break,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                candidate = dir.join(format!("{safe_stem}-{n}.toml"));
                n += 1;
            }
            Err(_) => break,
        }
    }
    candidate
}

/// Find an existing manifest entry whose config `.toml` has the same (host, user) as the
/// incoming one — the D-13 duplicate key (server host + login = the connection identity,
/// NOT whole-file equality). Returns the FIRST matching entry. Empty host AND empty user
/// never match (an unparseable/credential-less config is not a "duplicate" of another).
/// Reads each entry's `.toml` via the unchecked summary reader (the manifest paths are
/// already manifest-tracked through the validated add/migrate funnel). NEVER reads the
/// password (D-29).
pub fn find_duplicate_by_host_user(dir: &Path, host: &str, user: &str) -> Option<ConfigEntry> {
    if host.is_empty() && user.is_empty() {
        return None;
    }
    let manifest = read_manifest(dir).ok()?;
    manifest.configs.into_iter().find(|entry| {
        summarize_unchecked(&entry.path)
            .map(|s| s.host == host && s.user == user)
            .unwrap_or(false)
    })
}

/// Read the (host, user) pair out of a config's TOML CONTENT (not a path) — the D-13 dup
/// key for an incoming import that has not been written to disk yet. NEVER reads the
/// password (D-29). Returns empty strings for missing fields.
pub fn host_user_from_content(content: &str) -> (String, String) {
    let Ok(v) = toml::from_str::<toml::Value>(content) else {
        return (String::new(), String::new());
    };
    let ep = v.get("endpoint").and_then(|e| e.as_table());
    let host = ep
        .and_then(|e| e.get("hostname"))
        .and_then(|h| h.as_str())
        .unwrap_or_default()
        .to_string();
    let user = ep
        .and_then(|e| e.get("username"))
        .and_then(|u| u.as_str())
        .unwrap_or_default()
        .to_string();
    (host, user)
}

/// Derive a filesystem-safe stem for an imported config from its content: TOML `name` →
/// else `username` → else `config`. Slugified so the import filename is branded + readable
/// (e.g. a config named «Германия» for user `swift-fox` → `swift-fox`/`config`). NEVER
/// reads the password (D-29). Used by the import write path to brand the unique filename.
pub fn import_stem_from_content(content: &str) -> String {
    // user is the fallback stem when there is no top-level `name` (host is the dup key, not
    // the filename — D-14 naming order: name → username).
    let (_host, user) = host_user_from_content(content);
    let raw = toml::from_str::<toml::Value>(content)
        .ok()
        .and_then(|v| {
            // endpoint.name (real configs) → top-level name (older files).
            let ep = v.get("endpoint").and_then(|e| e.as_table());
            ep.and_then(|e| e.get("name"))
                .and_then(|n| n.as_str())
                .filter(|s| !s.is_empty())
                .map(String::from)
                .or_else(|| {
                    v.get("name")
                        .and_then(|n| n.as_str())
                        .filter(|s| !s.is_empty())
                        .map(String::from)
                })
        })
        .unwrap_or(user);
    let slug = slugify(&raw);
    // slugify already falls back to "config" on an empty/degenerate input; brand it so the
    // import file is recognisable next to the wizard's TrustTunnel_<user>.toml files.
    if slug == "config" {
        "config".to_string()
    } else {
        format!("TrustTunnel_{slug}")
    }
}

/// Derive a filesystem-safe stem from an IMPORT SOURCE FILENAME, PRESERVING the original
/// branded name VERBATIM. The branded export format «[<CC>_]TrustTunnel_<login>.toml» carries
/// the country-code prefix ONLY in the filename (it is not stored in the config content), so
/// slugifying would lose it — we keep the name as-is. Returns `None` when the name cannot be
/// used safely, so the caller falls back to the content-derived stem (`import_stem_from_content`):
///   - takes the BASENAME only (split on BOTH separators) so a hostile path can never traverse,
///   - strips a trailing `.toml` (any case),
///   - rejects empty / all-dots / a remaining separator or NUL / a Windows reserved device name.
///
/// `unique_import_path` still suffixes `-2`/`-3` on collision, so a re-import never overwrites.
pub fn safe_import_stem_from_filename(file_name: &str) -> Option<String> {
    // Basename only: last segment after either separator — never let a path traverse the dir.
    let base = file_name.rsplit(['/', '\\']).next().unwrap_or(file_name).trim();
    // Strip a single trailing `.toml` (case-insensitive: `.toml` is 5 bytes ASCII).
    let stem = if base.len() >= 5 && base[base.len() - 5..].eq_ignore_ascii_case(".toml") {
        base[..base.len() - 5].trim()
    } else {
        base
    };
    if stem.is_empty() || stem.chars().all(|c| c == '.') {
        return None;
    }
    if stem.contains('/') || stem.contains('\\') || stem.contains('\0') {
        return None;
    }
    // Windows reserved device names (case-insensitive). Mirrors the guard in
    // deploy.rs::client_config_filename so an imported name can never be a reserved device.
    const RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if RESERVED.iter().any(|r| r.eq_ignore_ascii_case(stem)) {
        return None;
    }
    Some(stem.to_string())
}

/// Append an already-on-disk config (inside the data dir) to the manifest, reading the
/// manifest at `dir` and writing it back atomically. Used by the import write path
/// (deeplink.rs) so the imported file becomes a card. Deduped by canonical path. The path
/// MUST already be validated by the caller (it just wrote the file there).
pub fn append_config_to_manifest(dir: &Path, path: &str) -> Result<(), String> {
    // WR-01: the import write path (deeplink.rs) is part of the same mutation funnel —
    // serialize its read→mutate→write so an import cannot interleave with a card
    // mutation and lose an update.
    let _guard = lock_manifest();
    let mut manifest = read_manifest(dir)?;
    add_entry(&mut manifest, path)?;
    write_manifest_atomic(dir, &manifest)
}

/// Like `append_config_to_manifest` but with an explicit display name — the import AddCopy path
/// (deeplink.rs) labels the new entry «<base> (копия N)» (IN-26).
pub fn append_config_to_manifest_named(dir: &Path, path: &str, name: &str) -> Result<(), String> {
    let _guard = lock_manifest();
    let mut manifest = read_manifest(dir)?;
    add_entry_named(&mut manifest, path, Some(name))?;
    write_manifest_atomic(dir, &manifest)
}

/// Rename a config's display name. The name is the user-facing TITLE of the config (D-14):
/// it is written INTO the config `.toml` as `endpoint.name` (where real server configs carry
/// it), and mirrored into the manifest entry as a fallback. The file/path/id are unchanged.
///
/// Why write the file (not just the manifest): `list_configs` re-summarizes each entry from
/// its `.toml` (so file edits reflect), reading the manifest name ONLY when the file-derived
/// name is empty. The file-derived name is `endpoint.name` → else `username`, so for a config
/// with a real username it is never empty — a manifest-only rename was silently overridden by
/// the username on every reload (11-UAT: name edits did not stick). Persisting into the `.toml`
/// makes the rename the real config name, survive reload, and "reflect on the config".
#[tauri::command]
pub fn rename_config(id: String, name: String) -> Result<Vec<ConfigSummary>, String> {
    // WR-01: serialize read→mutate→write against other manifest mutators.
    let _guard = lock_manifest();
    let dir = portable_data_dir();
    let mut manifest = read_manifest(&dir)?;
    // WR-02: re-validate the frontend-supplied name at the trust boundary (V13 /
    // defence-in-depth). A direct `invoke("rename_config", {id, name})` bypasses the
    // ConfigCard client-side validation entirely, so an empty / oversized / control-char
    // name would otherwise be serialized verbatim into configs.json and poison the list.
    // The validator returns the trimmed canonical form we actually persist.
    // IN-58: an EMPTY name is VALID — it CLEARS the title so the card falls back to the username
    // (owner: "имя может быть пустым, тогда отображается username"). Only a PRESENT name is
    // validated (no oversized / control chars — WR-01/WR-02); the empty clear skips the validator,
    // which rejects empty by design.
    let name = if name.trim().is_empty() {
        String::new()
    } else {
        crate::ssh::sanitize::validate_config_name(&name)?
    };
    let entry = manifest
        .configs
        .iter_mut()
        .find(|c| c.id == id)
        .ok_or("Config not found in manifest")?;
    // Persist the name INTO the config .toml as `endpoint.name`. The path is manifest-tracked,
    // so re-validate it stays inside the data dir (V12) before rewriting; a read/write failure
    // aborts the rename (surfaced inline on the card) rather than leaving file and manifest out
    // of sync.
    let path = entry.path.clone();
    validate_app_path(&path)?;
    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("Failed to read config: {e}"))?;
    // Empty → REMOVE endpoint.name (file-derived name becomes empty → list_configs uses the
    // username). Non-empty → upsert it.
    let updated = if name.is_empty() {
        remove_endpoint_name(&content)
    } else {
        upsert_endpoint_name(&content, &name)
    };
    std::fs::write(&path, updated).map_err(|e| format!("Failed to write config: {e}"))?;
    // Keep the manifest label in sync as the fallback for an unreadable file.
    entry.name = name;
    write_manifest_atomic(&dir, &manifest)?;
    list_configs()
}

/// Mark a config as last-used: clear every other marker, set this one, move it to order 0
/// (the lead card). D-05 — exactly one last-used at a time, no favourite/star concept.
#[tauri::command]
pub fn set_last_used(id: String) -> Result<Vec<ConfigSummary>, String> {
    // WR-01: serialize read→mutate→write against other manifest mutators.
    let _guard = lock_manifest();
    let dir = portable_data_dir();
    let mut manifest = read_manifest(&dir)?;
    let exists = manifest.configs.iter().any(|c| c.id == id);
    if !exists {
        return Err("Config not found in manifest".into());
    }
    // Mark exactly the selected config last-used (D-05).
    for c in manifest.configs.iter_mut() {
        c.last_used = c.id == id;
    }
    // IN-01: re-normalize orders to a dense 0..n sequence instead of `saturating_add(1)`
    // on every non-selected config. The old approach made the order values climb
    // monotonically across switches (eventually saturating at u32::MAX) — only RELATIVE
    // order matters, so behaviour was correct but the on-disk JSON accumulated large,
    // non-intuitive numbers. Here we keep the selected config at 0 and reassign the rest
    // 1,2,3,… in their existing relative order (stable sort by current order), so the
    // values stay small and meaningful regardless of how many switches have happened.
    let selected_id = id.clone();
    manifest.configs.sort_by(|a, b| {
        // Selected config first (order 0), then preserve the existing relative order.
        let a_sel = a.id == selected_id;
        let b_sel = b.id == selected_id;
        b_sel.cmp(&a_sel).then(a.order.cmp(&b.order))
    });
    for (i, c) in manifest.configs.iter_mut().enumerate() {
        c.order = i as u32;
    }
    write_manifest_atomic(&dir, &manifest)?;
    list_configs()
}

/// Persist the user-set priority order (D-02 / D-05). The «Авто-режим» priority list
/// (drag / keyboard reorder) sends the manifest ids in the desired sequence; we assign
/// `order = 0,1,2,…` in that sequence and persist atomically so the auto-switch engine
/// reads the user's order on the next tick and across restarts.
///
/// Open Q1 split (per 12-RESEARCH): we do NOT special-case the last-used config here —
/// the priority `order` drives ONLY the engine's switch-target search. `list_configs`
/// already sorts `last_used DESC, order ASC`, so the last-used config still renders as
/// the lead card on the Connection tab regardless of the priority order.
///
/// Inputs are manifest ids, never filesystem paths (there is no path parameter), so no
/// path traversal is possible (V5/V12). The atomic writer guarantees no torn write.
/// D-29: this command never reads `endpoint.password` and logs nothing.
#[tauri::command]
pub fn reorder_configs(ids: Vec<String>) -> Result<Vec<ConfigSummary>, String> {
    // WR-01: serialize read→mutate→write against other manifest mutators.
    let _guard = lock_manifest();
    let dir = portable_data_dir();
    let mut manifest = read_manifest(&dir)?;

    // Rank each supplied id by its position in the sequence (0-based). Ids not present in
    // the manifest are simply absent from this map — no error, no panic (T-12-02).
    let rank: std::collections::HashMap<&str, u32> = ids
        .iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i as u32))
        .collect();
    let supplied_count = ids.len() as u32;

    // Sort: supplied ids first, in the given sequence; configs whose id is NOT in `ids`
    // keep their existing relative order at the tail (stable sort by current `order`).
    // Sorting by a (rank, existing-order) key gives a stable, deterministic result.
    manifest.configs.sort_by(|a, b| {
        let a_key = rank.get(a.id.as_str()).copied().unwrap_or(supplied_count);
        let b_key = rank.get(b.id.as_str()).copied().unwrap_or(supplied_count);
        a_key.cmp(&b_key).then(a.order.cmp(&b.order))
    });
    // Re-densify to a clean 0..n so the on-disk values stay small and meaningful.
    for (i, c) in manifest.configs.iter_mut().enumerate() {
        c.order = i as u32;
    }

    write_manifest_atomic(&dir, &manifest)?;
    list_configs()
}

// ─── Tests (Wave-0 stubs turned GREEN) ───────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    /// IN-51: two configs created at the SAME path (e.g. a copy filename reclaimed after delete)
    /// must get DIFFERENT ids, so a re-added copy never inherits a deleted one's React key / slot.
    /// The salted id keeps the readable path-derived prefix.
    #[test]
    fn creation_id_is_unique_per_call_even_for_the_same_path() {
        let p = Path::new("C:/app/TrustTunnel_swift-fox-copy.toml");
        let a = creation_id(p);
        let b = creation_id(p);
        assert_ne!(a, b, "same path must yield distinct ids on two creations (no recycle)");
        let base = id_from_path(p);
        assert!(a.starts_with(&base), "salted id keeps the readable path-derived prefix");
        assert!(b.starts_with(&base));
    }

    /// A minimal but realistic TrustTunnel config `.toml`. Carries a password so the
    /// D-29 test can assert it never leaks into the manifest.
    fn sample_config(name: Option<&str>, host: &str, user: &str, password: &str) -> String {
        let name_line = name.map(|n| format!("name = \"{n}\"\n")).unwrap_or_default();
        format!(
            "# TrustTunnel Client Configuration\n\
             {name_line}loglevel = \"info\"\n\
             vpn_mode = \"general\"\n\
             killswitch_enabled = true\n\n\
             [endpoint]\n\
             hostname = \"{host}\"\n\
             username = \"{user}\"\n\
             password = \"{password}\"\n\n\
             [listener.tun]\n\
             mtu_size = 1280\n"
        )
    }

    fn write_toml(dir: &Path, file: &str, content: &str) -> std::path::PathBuf {
        let p = dir.join(file);
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(content.as_bytes()).unwrap();
        p
    }

    /// A realistic server config carrying the name INSIDE [endpoint] (where real configs put it),
    /// with comments + a following table — the layout `upsert_endpoint_name` must respect.
    fn endpoint_config(name: Option<&str>) -> String {
        let name_line = name.map(|n| format!("name = \"{n}\"\n")).unwrap_or_default();
        format!(
            "# TrustTunnel Client Configuration\n\
             loglevel = \"info\"\n\n\
             [endpoint]\n\
             hostname = \"getstarted.example.ru\"\n\
             username = \"free-lion58\"\n\
             anti_dpi = true\n\
             {name_line}dns_upstreams = [\"https://d.example/dns-query\"]\n\n\
             [listener.tun]\n\
             mtu_size = 1280\n"
        )
    }

    /// Truth: renaming a config that ALREADY has endpoint.name replaces it IN PLACE and leaves
    /// the rest of [endpoint] (the sidecar's data) untouched. The name stays inside [endpoint].
    #[test]
    fn remove_endpoint_name_clears_only_the_name() {
        let content = r#"[endpoint]
hostname = "h.win"
username = "alice"
name = "Custom"

[listener.tun]
included_routes = ["0.0.0.0/0"]
"#;
        let out = remove_endpoint_name(content);
        let parsed: toml::Value = toml::from_str(&out).unwrap();
        let ep = parsed.get("endpoint").and_then(|e| e.as_table()).unwrap();
        assert!(ep.get("name").is_none(), "endpoint.name must be removed:\n{out}");
        assert_eq!(ep.get("username").and_then(|v| v.as_str()), Some("alice"));
        assert!(out.contains("included_routes"), "[listener.tun] preserved:\n{out}");
    }

    #[test]
    fn upsert_endpoint_name_replaces_existing() {
        let c = endpoint_config(Some("Старое"));
        let out = upsert_endpoint_name(&c, "Новое");
        let v: toml::Value = toml::from_str(&out).expect("valid toml");
        let ep = v.get("endpoint").unwrap();
        assert_eq!(ep.get("name").unwrap().as_str().unwrap(), "Новое");
        assert!(v.get("name").is_none(), "name must stay inside [endpoint], not at root");
        // Exactly one name line total (no duplicate appended). Count by line-prefix so the
        // "name = " substring inside "hostname = "/"username = " does not inflate the count.
        let name_lines = out.lines().filter(|l| is_name_assignment(l.trim_start())).count();
        assert_eq!(name_lines, 1);
        // [endpoint] data + the following table preserved.
        assert_eq!(ep.get("hostname").unwrap().as_str().unwrap(), "getstarted.example.ru");
        assert_eq!(ep.get("username").unwrap().as_str().unwrap(), "free-lion58");
        assert!(v.get("listener").is_some());
    }

    /// Truth (11-UAT): a config with NO name gets it inserted INSIDE [endpoint] (so
    /// summarize_unchecked reads it), never at the document root.
    #[test]
    fn upsert_endpoint_name_inserts_into_endpoint_when_absent() {
        let c = endpoint_config(None);
        let out = upsert_endpoint_name(&c, "Тестирование");
        let v: toml::Value = toml::from_str(&out).expect("valid toml");
        assert_eq!(
            v.get("endpoint").unwrap().get("name").unwrap().as_str().unwrap(),
            "Тестирование"
        );
        assert!(v.get("name").is_none(), "name must be folded INTO [endpoint], not at root");
    }

    /// Truth: endpoint name as the LAST table (no following table) — inserted at EOF, still
    /// inside [endpoint].
    #[test]
    fn upsert_endpoint_name_appends_at_eof_when_endpoint_is_last() {
        let c = "[endpoint]\nhostname = \"h\"\nusername = \"u\"\n";
        let out = upsert_endpoint_name(c, "Конец");
        let v: toml::Value = toml::from_str(&out).expect("valid toml");
        assert_eq!(v.get("endpoint").unwrap().get("name").unwrap().as_str().unwrap(), "Конец");
    }

    /// Truth: a name with quotes/backslashes is escaped so the file stays valid TOML and the
    /// value round-trips exactly.
    #[test]
    fn upsert_endpoint_name_escapes_quotes_and_backslashes() {
        let c = endpoint_config(None);
        let tricky = r#"a"b\c"#;
        let out = upsert_endpoint_name(&c, tricky);
        let v: toml::Value = toml::from_str(&out).expect("valid toml");
        assert_eq!(v.get("endpoint").unwrap().get("name").unwrap().as_str().unwrap(), tricky);
    }

    /// WR-02: a multi-line array inside [endpoint] whose CONTINUATION lines start with `[`
    /// (an array-of-arrays / pretty-printed array) must NOT be misread as a table header. The
    /// old line-based detector flipped `in_endpoint` false on the `[` continuation line and
    /// produced malformed TOML / a misplaced name. After the bracket-depth fix the rename
    /// inserts/replaces endpoint.name correctly and the file stays valid TOML.
    #[test]
    fn upsert_endpoint_name_survives_multiline_array_continuation() {
        // `included_routes` is a pretty-printed array of arrays broken across lines; its
        // continuation lines begin with `[`. The name is absent → it must be inserted INTO
        // [endpoint] without corrupting the array.
        let c = "# cfg\n\
                 loglevel = \"info\"\n\n\
                 [endpoint]\n\
                 hostname = \"h.example\"\n\
                 username = \"u\"\n\
                 included_routes = [\n\
                 [\"10.0.0.0\", 8],\n\
                 [\"192.168.0.0\", 16],\n\
                 ]\n\n\
                 [listener.tun]\n\
                 mtu_size = 1280\n";
        let out = upsert_endpoint_name(c, "Имя");
        let v: toml::Value = toml::from_str(&out).expect("output must be valid TOML");
        let ep = v.get("endpoint").expect("endpoint table present");
        assert_eq!(ep.get("name").unwrap().as_str().unwrap(), "Имя");
        // The array survived intact (2 entries, each a 2-element array) and stayed in [endpoint].
        let routes = ep.get("included_routes").unwrap().as_array().unwrap();
        assert_eq!(routes.len(), 2);
        // The following table was NOT swallowed into the array / mis-parsed.
        assert!(v.get("listener").is_some(), "listener table preserved");
    }

    /// WR-02: replacing an EXISTING endpoint.name still works when a multi-line `[`-continuation
    /// array sits AFTER the name line — the depth tracking must not lose the in-place replace.
    #[test]
    fn upsert_endpoint_name_replaces_with_multiline_array_after() {
        let c = "[endpoint]\n\
                 name = \"Старое\"\n\
                 hostname = \"h\"\n\
                 included_routes = [\n\
                 [\"10.0.0.0\", 8],\n\
                 ]\n";
        let out = upsert_endpoint_name(c, "Новое");
        let v: toml::Value = toml::from_str(&out).expect("valid toml");
        assert_eq!(v.get("endpoint").unwrap().get("name").unwrap().as_str().unwrap(), "Новое");
        let name_lines = out.lines().filter(|l| is_name_assignment(l.trim_start())).count();
        assert_eq!(name_lines, 1, "exactly one name line (replaced in place)");
    }

    /// Truth: summarize reads the name from endpoint.name (real-config layout), NOT just root.
    #[test]
    fn summarize_reads_name_from_endpoint() {
        let tmp = tempdir();
        let p = write_toml(&tmp, "cfg.toml", &endpoint_config(Some("Тестирование")));
        let s = summarize_unchecked(&p.to_string_lossy()).expect("summary");
        assert_eq!(s.name, "Тестирование");
        assert_eq!(s.user, "free-lion58");
    }

    /// Truth (11-UAT IN-10): an imported config keeps its ORIGINAL branded filename verbatim —
    /// the country-code prefix lives only in the filename and must NOT be slugified away.
    #[test]
    fn safe_import_stem_preserves_branded_filename_verbatim() {
        assert_eq!(
            safe_import_stem_from_filename("de_TrustTunnel_swift-fox.toml").as_deref(),
            Some("de_TrustTunnel_swift-fox")
        );
        // Uppercase country prefix is preserved (not lowercased like slugify would).
        assert_eq!(
            safe_import_stem_from_filename("DE_TrustTunnel_swift-fox.TOML").as_deref(),
            Some("DE_TrustTunnel_swift-fox")
        );
        // An unbranded user file is kept as-is too (verbatim preserve, per the owner).
        assert_eq!(safe_import_stem_from_filename("my-vpn.toml").as_deref(), Some("my-vpn"));
    }

    /// Truth: a hostile path can never traverse — only the basename is used.
    #[test]
    fn safe_import_stem_takes_basename_only() {
        assert_eq!(
            safe_import_stem_from_filename("../../etc/evil.toml").as_deref(),
            Some("evil")
        );
        assert_eq!(
            safe_import_stem_from_filename(r"C:\Windows\system32\x.toml").as_deref(),
            Some("x")
        );
    }

    /// Truth: unusable names return None so the caller falls back to the content-derived stem.
    #[test]
    fn safe_import_stem_rejects_unusable_names() {
        assert_eq!(safe_import_stem_from_filename(""), None);
        assert_eq!(safe_import_stem_from_filename("   "), None);
        assert_eq!(safe_import_stem_from_filename(".."), None);
        assert_eq!(safe_import_stem_from_filename(".toml"), None); // stem empties out
        assert_eq!(safe_import_stem_from_filename("NUL.toml"), None); // Windows reserved
        assert_eq!(safe_import_stem_from_filename("con"), None); // reserved, case-insensitive
    }

    /// Truth: migration with a `tt_config_path` + N `.toml` files yields a manifest
    /// whose active config is #1 + last-used, with all files retained (HEADLINE P11-02).
    #[test]
    fn migrate_never_loses_existing_config() {
        let tmp = tempdir();
        let active = write_toml(
            &tmp,
            "TrustTunnel_swift-fox.toml",
            &sample_config(Some("Германия"), "de1.example.com", "swift-fox", "SECRET-A"),
        );
        let extra1 = write_toml(
            &tmp,
            "TrustTunnel_bold-eagle.toml",
            &sample_config(Some("Нидерланды"), "nl.example.com", "bold-eagle", "SECRET-B"),
        );
        let extra2 = write_toml(
            &tmp,
            "config-extra.toml",
            &sample_config(None, "sg.example.com", "calm-raven", "SECRET-C"),
        );

        let manifest =
            migrate_to_manifest(&tmp, Some(&active.to_string_lossy())).expect("migration ok");

        // All three files still on disk — NEVER lost.
        assert!(active.is_file(), "active config must survive migration");
        assert!(extra1.is_file(), "extra1 must survive migration");
        assert!(extra2.is_file(), "extra2 must survive migration");

        // The active config is config #1, order 0, last_used true.
        assert!(!manifest.configs.is_empty());
        let first = &manifest.configs[0];
        assert_eq!(
            std::fs::canonicalize(&first.path).unwrap(),
            std::fs::canonicalize(&active).unwrap(),
            "active config must be config #1"
        );
        assert_eq!(first.order, 0);
        assert!(first.last_used, "config #1 must be last_used");

        // All three configs present in the manifest (deduped, none dropped).
        assert_eq!(manifest.configs.len(), 3, "all three configs present");
        // Exactly one last_used.
        assert_eq!(manifest.configs.iter().filter(|c| c.last_used).count(), 1);

        cleanup(&tmp);
    }

    /// Truth: running migration twice produces the same manifest (idempotent;
    /// guards on manifest-exists).
    #[test]
    fn migrate_is_idempotent() {
        let tmp = tempdir();
        let active = write_toml(
            &tmp,
            "TrustTunnel_swift-fox.toml",
            &sample_config(Some("Германия"), "de1.example.com", "swift-fox", "SECRET-A"),
        );
        write_toml(
            &tmp,
            "TrustTunnel_bold-eagle.toml",
            &sample_config(Some("Нидерланды"), "nl.example.com", "bold-eagle", "SECRET-B"),
        );

        let first = migrate_to_manifest(&tmp, Some(&active.to_string_lossy())).unwrap();
        let first_bytes = std::fs::read(tmp.join(MANIFEST_FILENAME)).unwrap();
        let second = migrate_to_manifest(&tmp, Some(&active.to_string_lossy())).unwrap();
        let second_bytes = std::fs::read(tmp.join(MANIFEST_FILENAME)).unwrap();

        assert_eq!(first, second, "manifest after two runs must be identical");
        assert_eq!(
            first_bytes, second_bytes,
            "configs.json must be byte-identical after a re-run (idempotent)"
        );

        cleanup(&tmp);
    }

    /// Truth: empty dir + no tt_config_path → empty manifest, no crash.
    #[test]
    fn migrate_empty_dir_is_empty_manifest() {
        let tmp = tempdir();
        let manifest = migrate_to_manifest(&tmp, None).unwrap();
        assert_eq!(manifest.schema_version, MANIFEST_SCHEMA_VERSION);
        assert!(manifest.configs.is_empty(), "empty dir → empty manifest");
        cleanup(&tmp);
    }

    /// Truth: importing a second config APPENDS — two adds → two distinct files
    /// + two manifest entries (never the fixed-filename overwrite, Pitfall 2).
    #[test]
    fn import_appends_not_overwrites() {
        let tmp = tempdir();
        let a = write_toml(
            &tmp,
            "config-a.toml",
            &sample_config(Some("A"), "a.example.com", "user-a", "SECRET-A"),
        );
        let b = write_toml(
            &tmp,
            "config-b.toml",
            &sample_config(Some("B"), "b.example.com", "user-b", "SECRET-B"),
        );
        let mut manifest = Manifest::default();
        add_entry(&mut manifest, &a.to_string_lossy()).unwrap();
        add_entry(&mut manifest, &b.to_string_lossy()).unwrap();
        assert_eq!(manifest.configs.len(), 2, "two adds => two entries");
        assert!(a.is_file() && b.is_file(), "two distinct files on disk");
        // A third add of the SAME path is deduped (no-op).
        add_entry(&mut manifest, &a.to_string_lossy()).unwrap();
        assert_eq!(manifest.configs.len(), 2, "re-adding same path is a no-op");
        cleanup(&tmp);
    }

    /// Truth: a host+user collision is detectable from the summaries (D-13 duplicate key)
    /// so the UI can surface the in-modal replace/add-copy choice.
    #[test]
    fn dup_key_host_user() {
        let tmp = tempdir();
        let a = write_toml(
            &tmp,
            "config-a.toml",
            &sample_config(Some("A"), "dup.example.com", "same-user", "SECRET-A"),
        );
        let b = write_toml(
            &tmp,
            "config-b.toml",
            &sample_config(Some("B"), "dup.example.com", "same-user", "SECRET-B"),
        );
        let sa = summarize_unchecked(&a.to_string_lossy()).unwrap();
        let sb = summarize_unchecked(&b.to_string_lossy()).unwrap();
        // The duplicate key is (host, user) — A and B collide.
        assert_eq!((sa.host.as_str(), sa.user.as_str()), (sb.host.as_str(), sb.user.as_str()));
        cleanup(&tmp);
    }

    /// Truth: a write→read round-trip preserves the manifest exactly and a leftover
    /// `.tmp` does not corrupt `configs.json` (temp + rename atomicity).
    #[test]
    fn manifest_atomic_roundtrip() {
        let tmp = tempdir();
        let m = Manifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            configs: vec![ConfigEntry {
                id: "cfg-abc".into(),
                name: "Германия — Frankfurt".into(),
                path: tmp.join("c.toml").to_string_lossy().to_string(),
                order: 0,
                last_used: true,
            }],
        };
        // A stray leftover .tmp from a hypothetical crashed write must not be read as the
        // manifest (only configs.json is read), and the atomic write overwrites it.
        std::fs::write(tmp.join(MANIFEST_TMP_FILENAME), b"GARBAGE-PARTIAL").unwrap();
        write_manifest_atomic(&tmp, &m).unwrap();
        let back = read_manifest(&tmp).unwrap();
        assert_eq!(m, back, "write_manifest_atomic then read_manifest round-trips");
        // After the atomic rename the .tmp is gone (it was renamed over configs.json).
        assert!(
            !tmp.join(MANIFEST_TMP_FILENAME).exists(),
            "the temp file is consumed by the rename"
        );
        cleanup(&tmp);
    }

    /// Truth (IN-25): a config whose `.toml` was deleted OUTSIDE the app is filtered out of
    /// list_configs (the card disappears on reload); a present file stays.
    #[test]
    fn list_configs_skips_a_file_deleted_on_disk() {
        let tmp = tempdir();
        let a = write_toml(&tmp, "a.toml", &endpoint_config(Some("Alpha")));
        let b = write_toml(&tmp, "b.toml", &endpoint_config(Some("Beta")));
        let m = Manifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            configs: vec![
                ConfigEntry {
                    id: id_from_path(&a),
                    name: "Alpha".into(),
                    path: a.to_string_lossy().to_string(),
                    order: 0,
                    last_used: true,
                },
                ConfigEntry {
                    id: id_from_path(&b),
                    name: "Beta".into(),
                    path: b.to_string_lossy().to_string(),
                    order: 1,
                    last_used: false,
                },
            ],
        };
        write_manifest_atomic(&tmp, &m).unwrap();
        // Both files present → both listed.
        assert_eq!(list_configs_in_dir(&tmp).unwrap().len(), 2);
        // Delete one `.toml` on disk (as a file manager would).
        std::fs::remove_file(&b).unwrap();
        let list = list_configs_in_dir(&tmp).unwrap();
        assert_eq!(list.len(), 1, "the deleted-on-disk config is pruned from the returned list");
        assert_eq!(list[0].path, a.to_string_lossy());
        cleanup(&tmp);
    }

    /// Truth (IN-26): copy_base_name strips a trailing « (копия)» / « (копия N)» (and only that).
    #[test]
    fn copy_base_name_strips_copy_suffix() {
        assert_eq!(copy_base_name("Германия"), "Германия");
        assert_eq!(copy_base_name("Германия (копия)"), "Германия");
        assert_eq!(copy_base_name("Германия (копия 3)"), "Германия");
        // Unrelated trailing parens are NOT treated as a copy suffix.
        assert_eq!(copy_base_name("Сервер (test)"), "Сервер (test)");
        assert_eq!(copy_base_name("Сервер (копия x)"), "Сервер (копия x)");
    }

    /// Truth (IN-26): next_copy_name returns «(копия)» first, then «(копия 2)», «(копия 3)».
    #[test]
    fn next_copy_name_increments() {
        assert_eq!(next_copy_name(&[], "Германия"), "Германия (копия)");
        assert_eq!(
            next_copy_name(&["Германия (копия)".to_string()], "Германия"),
            "Германия (копия 2)"
        );
        assert_eq!(
            next_copy_name(
                &["Германия (копия)".to_string(), "Германия (копия 2)".to_string()],
                "Германия"
            ),
            "Германия (копия 3)"
        );
    }

    /// Truth (IN-26): next_copy_name_for reads the manifest's display names and allocates the
    /// next free copy name for the base.
    #[test]
    fn next_copy_name_for_uses_manifest_display_names() {
        let tmp = tempdir();
        let a = write_toml(&tmp, "a.toml", &endpoint_config(Some("Германия")));
        let m = Manifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            configs: vec![ConfigEntry {
                id: id_from_path(&a),
                name: "Германия".into(),
                path: a.to_string_lossy().to_string(),
                order: 0,
                last_used: true,
            }],
        };
        write_manifest_atomic(&tmp, &m).unwrap();
        assert_eq!(next_copy_name_for(&tmp, "Германия"), "Германия (копия)");
        // Stripping works: asking for a copy of «Германия (копия)» still yields the «(копия)»
        // family (and since «Германия (копия)» is not yet in the manifest, the first is free).
        assert_eq!(next_copy_name_for(&tmp, "Германия (копия)"), "Германия (копия)");
        cleanup(&tmp);
    }

    /// Truth (IN-26 follow-up): current_display_name reads the name from the FILE, not a manifest
    /// label.
    #[test]
    fn current_display_name_reads_file() {
        let tmp = tempdir();
        let p = write_toml(&tmp, "x.toml", &endpoint_config(Some("Настя")));
        assert_eq!(current_display_name(&p.to_string_lossy()).as_deref(), Some("Настя"));
        cleanup(&tmp);
    }

    /// Truth (IN-26 follow-up): syncing refreshes a STALE manifest label from the .toml — the bug
    /// where an old edited name resurfaced as the copy name «<old> (копия)».
    #[test]
    fn sync_entry_name_refreshes_stale_label() {
        let tmp = tempdir();
        let p = write_toml(&tmp, "x.toml", &endpoint_config(Some("Настя")));
        let m = Manifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            configs: vec![ConfigEntry {
                id: id_from_path(&p),
                name: "Настя222222546464654".into(), // stale label left by earlier name edits
                path: p.to_string_lossy().to_string(),
                order: 0,
                last_used: true,
            }],
        };
        write_manifest_atomic(&tmp, &m).unwrap();
        sync_entry_name_in_dir(&tmp, &p.to_string_lossy()).unwrap();
        let back = read_manifest(&tmp).unwrap();
        assert_eq!(back.configs[0].name, "Настя");
        cleanup(&tmp);
    }

    /// Truth (D-29): the manifest holds NO password and the serialized manifest carries no
    /// secret. The on-disk configs.json must never contain the password from any `.toml`.
    #[test]
    fn d29_no_secret_in_manifest_logs() {
        let tmp = tempdir();
        let secret = "SUPER-SECRET-PASSWORD-XYZ";
        let active = write_toml(
            &tmp,
            "TrustTunnel_user.toml",
            &sample_config(Some("Германия"), "de1.example.com", "swift-fox", secret),
        );
        let manifest = migrate_to_manifest(&tmp, Some(&active.to_string_lossy())).unwrap();

        // The serialized manifest must NOT contain the password.
        let serialized = serde_json::to_string(&manifest).unwrap();
        assert!(
            !serialized.contains(secret),
            "manifest serialization must not contain the password (D-29)"
        );

        // The on-disk configs.json must NOT contain the password.
        let on_disk = std::fs::read_to_string(tmp.join(MANIFEST_FILENAME)).unwrap();
        assert!(
            !on_disk.contains(secret),
            "configs.json on disk must not contain the password (D-29)"
        );

        // summarize() must read name/host/user but NEVER the password.
        let summary = summarize_unchecked(&active.to_string_lossy()).unwrap();
        let summary_json = serde_json::to_string(&summary).unwrap();
        assert!(
            !summary_json.contains(secret),
            "ConfigSummary must not contain the password (D-29)"
        );
        assert_eq!(summary.host, "de1.example.com");
        assert_eq!(summary.user, "swift-fox");

        cleanup(&tmp);
    }

    /// Truth: set_last_used marks exactly one config last-used and moves it to order 0.
    #[test]
    fn set_last_used_moves_to_top() {
        let tmp = tempdir();
        let mut manifest = Manifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            configs: vec![
                ConfigEntry {
                    id: "a".into(),
                    name: "A".into(),
                    path: tmp.join("a.toml").to_string_lossy().to_string(),
                    order: 0,
                    last_used: true,
                },
                ConfigEntry {
                    id: "b".into(),
                    name: "B".into(),
                    path: tmp.join("b.toml").to_string_lossy().to_string(),
                    order: 1,
                    last_used: false,
                },
            ],
        };
        // Apply the same in-memory transform set_last_used uses.
        for c in manifest.configs.iter_mut() {
            c.last_used = c.id == "b";
            if c.id == "b" {
                c.order = 0;
            } else {
                c.order = c.order.saturating_add(1);
            }
        }
        let b = manifest.configs.iter().find(|c| c.id == "b").unwrap();
        assert!(b.last_used && b.order == 0, "b is last_used at order 0");
        assert_eq!(
            manifest.configs.iter().filter(|c| c.last_used).count(),
            1,
            "exactly one last_used (the marker is exclusive)"
        );
        cleanup(&tmp);
    }

    /// The same in-memory order transform `reorder_configs` applies for a given id
    /// sequence: supplied ids first in sequence order, the rest at the tail by existing
    /// order, then re-densify to 0..n. Mirrors the production sort so the test asserts the
    /// real behaviour without invoking the #[tauri::command] (which needs the data dir).
    fn apply_reorder(configs: &mut [ConfigEntry], ids: &[&str]) {
        let rank: std::collections::HashMap<&str, u32> = ids
            .iter()
            .enumerate()
            .map(|(i, id)| (*id, i as u32))
            .collect();
        let supplied = ids.len() as u32;
        configs.sort_by(|a, b| {
            let a_key = rank.get(a.id.as_str()).copied().unwrap_or(supplied);
            let b_key = rank.get(b.id.as_str()).copied().unwrap_or(supplied);
            a_key.cmp(&b_key).then(a.order.cmp(&b.order))
        });
        for (i, c) in configs.iter_mut().enumerate() {
            c.order = i as u32;
        }
    }

    fn entry(id: &str, order: u32) -> ConfigEntry {
        ConfigEntry {
            id: id.into(),
            name: id.to_uppercase(),
            path: format!("C:/app/{id}.toml"),
            order,
            last_used: false,
        }
    }

    // Truth (D-02): reorder_configs assigns order by the given id sequence; atomic write.
    #[test]
    fn reorder_configs_applies_given_id_sequence() {
        let mut configs = vec![entry("a", 0), entry("b", 1), entry("c", 2)];
        apply_reorder(&mut configs, &["c", "a", "b"]);
        let order_of = |id: &str| configs.iter().find(|c| c.id == id).unwrap().order;
        assert_eq!(order_of("c"), 0, "c leads the sequence");
        assert_eq!(order_of("a"), 1);
        assert_eq!(order_of("b"), 2);
    }

    /// Truth (T-12-02): an unknown id in the sequence is ignored without panic; the known
    /// id still takes its position and the un-mentioned config keeps a tail slot.
    #[test]
    fn reorder_configs_ignores_unknown_id() {
        let mut configs = vec![entry("a", 0), entry("b", 1)];
        apply_reorder(&mut configs, &["zzz", "a"]); // "zzz" not in manifest
        let order_of = |id: &str| configs.iter().find(|c| c.id == id).unwrap().order;
        // "zzz" is dropped from ranking; "a" leads, "b" trails — dense 0..n, no panic.
        assert_eq!(order_of("a"), 0, "known id gets its position");
        assert_eq!(order_of("b"), 1, "un-mentioned config keeps a tail slot");
    }

    /// D-29: a reorder must never surface the password. Build a manifest backed by a real
    /// `.toml` carrying a secret, apply a reorder + atomic write, and assert the serialized
    /// manifest JSON never contains the password (the manifest holds only non-secret metadata).
    #[test]
    fn reorder_configs_never_leaks_password() {
        let tmp = tempdir();
        let secret = "s3cr3t-pw-never-in-manifest";
        let p = write_toml(&tmp, "x.toml", &sample_config(Some("X"), "h.win", "u", secret));
        let mut manifest = Manifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            configs: vec![ConfigEntry {
                id: "x".into(),
                name: "X".into(),
                path: p.to_string_lossy().to_string(),
                order: 0,
                last_used: true,
            }],
        };
        apply_reorder(&mut manifest.configs, &["x"]);
        write_manifest_atomic(&tmp, &manifest).unwrap();
        let json = serde_json::to_string(&manifest).unwrap();
        assert!(!json.contains(secret), "password must never appear in the manifest (D-29)");
        cleanup(&tmp);
    }

    /// Truth (WR-01): a serialized read-modify-write funnel never loses an update under
    /// concurrency. N threads each append a distinct entry through the SAME lock that the
    /// production mutators take (`lock_manifest`) around `read_manifest → mutate →
    /// write_manifest_atomic`. With the lock, every append survives (final count == N);
    /// without it the threads would interleave (read-stale → overwrite) and drop updates.
    #[test]
    fn manifest_funnel_lock_serializes_concurrent_writes() {
        let tmp = tempdir();
        // Seed an empty manifest so all threads share a starting point on disk.
        write_manifest_atomic(&tmp, &Manifest::default()).unwrap();

        const N: u32 = 12;
        let mut handles = Vec::new();
        for i in 0..N {
            let dir = tmp.clone();
            handles.push(std::thread::spawn(move || {
                // Exactly the funnel shape the production mutators use: take the global
                // lock, read, mutate in memory, write atomically, drop the guard.
                let _guard = lock_manifest();
                let mut manifest = read_manifest(&dir).unwrap();
                manifest.configs.push(ConfigEntry {
                    id: format!("cfg-{i}"),
                    name: format!("Config {i}"),
                    path: dir.join(format!("c{i}.toml")).to_string_lossy().to_string(),
                    order: i,
                    last_used: false,
                });
                write_manifest_atomic(&dir, &manifest).unwrap();
            }));
        }
        for h in handles {
            h.join().unwrap();
        }

        // All N appends must be present — no lost update (last-writer-wins) under the lock.
        let final_manifest = read_manifest(&tmp).unwrap();
        assert_eq!(
            final_manifest.configs.len(),
            N as usize,
            "every concurrent append must survive the serialized funnel (no lost update)"
        );
        // Each thread's distinct id is present exactly once.
        for i in 0..N {
            let id = format!("cfg-{i}");
            assert_eq!(
                final_manifest.configs.iter().filter(|c| c.id == id).count(),
                1,
                "entry {id} must appear exactly once"
            );
        }
        cleanup(&tmp);
    }

    /// Truth (WR-03): when the on-disk file delete FAILS, `delete_config` must KEEP the
    /// manifest entry (so the file stays tracked, never orphaned) and surface the error —
    /// instead of silently dropping the entry and leaking a password-bearing `.toml`.
    ///
    /// We force `remove_file` to fail deterministically (cross-platform) by pointing the
    /// entry path at a DIRECTORY: `std::fs::remove_file` refuses to remove a directory and
    /// returns a non-NotFound error, exactly like a locked / permission-denied `.toml`.
    /// The directory must still exist afterwards and the entry must remain in the manifest.
    #[test]
    fn delete_config_keeps_entry_when_file_delete_fails() {
        let tmp = tempdir();
        // A directory standing in for an unremovable config file (remove_file on a dir
        // errors with a non-NotFound kind on every platform).
        let dir_as_path = tmp.join("locked-config.toml");
        std::fs::create_dir(&dir_as_path).unwrap();

        let entry = ConfigEntry {
            id: "locked-1".into(),
            name: "Locked".into(),
            path: dir_as_path.to_string_lossy().to_string(),
            order: 0,
            last_used: true,
        };
        write_manifest_atomic(
            &tmp,
            &Manifest {
                schema_version: MANIFEST_SCHEMA_VERSION,
                configs: vec![entry.clone()],
            },
        )
        .unwrap();

        let result = delete_config_in_dir(&tmp, "locked-1");
        assert!(
            result.is_err(),
            "delete must fail (surface the error) when the file cannot be removed"
        );
        assert!(dir_as_path.is_dir(), "the unremovable path must still exist");

        // The manifest on disk must STILL track the entry — no orphan.
        let after = read_manifest(&tmp).unwrap();
        assert_eq!(
            after.configs.len(),
            1,
            "entry must be re-inserted so the file stays tracked (no orphan)"
        );
        assert_eq!(after.configs[0].id, "locked-1");

        cleanup(&tmp);
    }

    /// IN-55: prune_missing drops entries whose `.toml` is gone, compacts order, and resets the
    /// next copy name (the ghost «(копия N)» no longer inflates the count).
    #[test]
    fn prune_missing_drops_ghosts_compacts_order_resets_copy_name() {
        let tmp = tempdir();
        let present = tmp.join("present.toml");
        std::fs::write(&present, "x").unwrap();
        let ghost = tmp.join("ghost.toml"); // never created → try_exists == Ok(false)

        let mut manifest = Manifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            configs: vec![
                ConfigEntry {
                    id: "ghost".into(),
                    name: "Россия (копия)".into(),
                    path: ghost.to_string_lossy().to_string(),
                    order: 0,
                    last_used: false,
                },
                ConfigEntry {
                    id: "present".into(),
                    name: "Россия".into(),
                    path: present.to_string_lossy().to_string(),
                    order: 5,
                    last_used: true,
                },
            ],
        };

        assert!(prune_missing(&mut manifest), "a missing-file entry must be removed");
        assert_eq!(manifest.configs.len(), 1);
        assert_eq!(manifest.configs[0].id, "present");
        assert_eq!(manifest.configs[0].order, 0, "order compacted to 0..N");

        // With the ghost «Россия (копия)» gone, the next copy name resets to «(копия)».
        let existing = existing_display_names(&manifest);
        assert_eq!(next_copy_name(&existing, "Россия"), "Россия (копия)");
        cleanup(&tmp);
    }

    /// IN-55: when every file exists, prune is a no-op and order is untouched.
    #[test]
    fn prune_missing_noop_when_all_present() {
        let tmp = tempdir();
        let a = tmp.join("a.toml");
        std::fs::write(&a, "x").unwrap();
        let mut manifest = Manifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            configs: vec![ConfigEntry {
                id: "a".into(),
                name: "A".into(),
                path: a.to_string_lossy().to_string(),
                order: 3,
                last_used: false,
            }],
        };
        assert!(!prune_missing(&mut manifest), "no missing files → no change");
        assert_eq!(manifest.configs[0].order, 3, "order untouched when nothing pruned");
        cleanup(&tmp);
    }

    /// Truth (WR-03): the happy path still works — when the file delete succeeds the entry
    /// is dropped and the file is gone.
    #[test]
    fn delete_config_removes_entry_and_file_on_success() {
        let tmp = tempdir();
        let cfg = write_toml(
            &tmp,
            "TrustTunnel_gone.toml",
            &sample_config(Some("Gone"), "host.example.com", "user", "SECRET"),
        );
        write_manifest_atomic(
            &tmp,
            &Manifest {
                schema_version: MANIFEST_SCHEMA_VERSION,
                configs: vec![ConfigEntry {
                    id: "gone-1".into(),
                    name: "Gone".into(),
                    path: cfg.to_string_lossy().to_string(),
                    order: 0,
                    last_used: true,
                }],
            },
        )
        .unwrap();

        delete_config_in_dir(&tmp, "gone-1").expect("delete succeeds");
        assert!(!cfg.exists(), "the file must be gone");
        let after = read_manifest(&tmp).unwrap();
        assert!(after.configs.is_empty(), "the entry must be dropped");
        cleanup(&tmp);
    }

    /// Truth (IN-01): repeated last-used switches keep orders dense (0..n), never climbing
    /// monotonically. Replicates the NEW set_last_used transform and asserts the order set
    /// is exactly {0,1,...,n-1} after each switch, with the selected config at 0.
    #[test]
    fn set_last_used_keeps_orders_dense() {
        let mut configs = vec![
            ConfigEntry { id: "a".into(), name: "A".into(), path: "a".into(), order: 0, last_used: true },
            ConfigEntry { id: "b".into(), name: "B".into(), path: "b".into(), order: 1, last_used: false },
            ConfigEntry { id: "c".into(), name: "C".into(), path: "c".into(), order: 2, last_used: false },
        ];

        // The NEW dense re-normalize transform (mirrors set_last_used).
        let apply = |configs: &mut Vec<ConfigEntry>, id: &str| {
            for c in configs.iter_mut() {
                c.last_used = c.id == id;
            }
            let sel = id.to_string();
            configs.sort_by(|a, b| {
                let a_sel = a.id == sel;
                let b_sel = b.id == sel;
                b_sel.cmp(&a_sel).then(a.order.cmp(&b.order))
            });
            for (i, c) in configs.iter_mut().enumerate() {
                c.order = i as u32;
            }
        };

        // Switch many times — orders must stay {0,1,2}, never grow.
        for id in ["b", "c", "a", "b", "c", "a", "b"] {
            apply(&mut configs, id);
            let mut orders: Vec<u32> = configs.iter().map(|c| c.order).collect();
            orders.sort_unstable();
            assert_eq!(orders, vec![0, 1, 2], "orders must be dense after switching to {id}");
            // Exactly one last_used, and it is at order 0.
            assert_eq!(configs.iter().filter(|c| c.last_used).count(), 1);
            let lead = configs.iter().find(|c| c.last_used).unwrap();
            assert_eq!(lead.order, 0, "last-used config must be at order 0");
            assert_eq!(lead.id, id, "the switched-to config is last-used");
        }
    }

    // ── tempdir helpers (no external crate — std-only, unique per test) ──

    fn tempdir() -> std::path::PathBuf {
        let base = std::env::temp_dir();
        let unique = format!(
            "tt_manifest_test_{}_{}",
            std::process::id(),
            // a per-call counter keeps parallel tests from colliding
            COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        );
        let dir = base.join(unique);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    fn cleanup(dir: &Path) {
        let _ = std::fs::remove_dir_all(dir);
    }
}
