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

// ─── PP-5: self-echo suppression window ──────────────────────────────────────
//
// Every in-app mutation (add/delete/duplicate/rename/reorder/import/save) writes through the atomic
// writer. PA-4/17-07 made all six mutation commands return `Result<(), String>`/`Ok(())`; the FE
// RE-INVOKES `list_configs` right after each mutation (reload/refresh) — it does NOT get a fresh
// `Vec<ConfigSummary>` handed back from the command. The data-dir fs-watcher (`start_configs_watcher`)
// ALSO sees that same write and would emit a `configs-changed` echo, driving a SECOND, redundant
// `list_configs` for a change the FE already re-fetched. PP-5 records an "expected write" instant at
// the end of `atomic_write`; the watcher suppresses `configs-changed` for a short window after it (a
// genuine EXTERNAL change — file-manager delete/restore — lands outside any in-app write window and
// still fires). The window is a coalescing debounce, not a correctness gate FOR THE MUTATORS THAT
// SELF-REFETCH.
//
// F5 CAVEAT: two mutators — `set_last_used` and `reorder_configs` — have fire-and-forget FE callers
// that do NOT re-fetch (`markLastUsed` resolves ids only; `persistOrder` is optimistic-local to the
// Settings tab), and IN-49 removed the tab-SWITCH reload backstop (panels stay mounted). For those
// two the suppressed echo WAS the only live refresh, so they now emit `configs-changed` THEMSELVES
// after their write (see each command). Suppression must NOT be justified by a tab-switch/focus
// backstop for tab switches — that backstop no longer exists.

use std::time::{Duration, Instant};

/// How long after an in-app atomic write the watcher suppresses its own `configs-changed` echo.
/// Long enough to swallow the notify event for our own write (temp+rename lands within a few ms),
/// short enough that a real external change moments later is not masked.
const SELF_ECHO_SUPPRESS: Duration = Duration::from_millis(250);

/// The instant of the last in-app atomic write. `None` until the first write. Poison-tolerant.
static LAST_EXPECTED_WRITE: Mutex<Option<Instant>> = Mutex::new(None);

/// Record that an in-app write just happened (called at the tail of `atomic_write`). Opens the
/// PP-5 suppression window so the watcher skips the echo for our own write.
fn note_expected_write() {
    let mut guard = LAST_EXPECTED_WRITE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = Some(Instant::now());
}

/// True if we are still inside the suppression window opened by the most recent in-app write —
/// i.e. this fs event is (almost certainly) the echo of our own write and should NOT re-emit
/// `configs-changed`. An external change arriving after the window returns false (emit as usual).
fn within_self_echo_window() -> bool {
    let guard = LAST_EXPECTED_WRITE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    matches!(*guard, Some(t) if t.elapsed() < SELF_ECHO_SUPPRESS)
}

/// Test-only: force the last-expected-write instant to a chosen time so the window-expiry branch is
/// tested WITHOUT a real sleep (a sleep-based test is flaky under the shared static — a parallel
/// write test could re-arm the window mid-sleep).
#[cfg(test)]
fn force_last_expected_write(instant: Option<Instant>) {
    let mut guard = LAST_EXPECTED_WRITE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = instant;
}

// ─── PP-6: single data-dir watcher owns both FE signals ──────────────────────
//
// Before PP-6 there were TWO OS watchers on the SAME `portable_data_dir`: `start_configs_watcher`
// (app-wide, emits `configs-changed` for the list) and `watch_config_file` (config.rs, emits
// `config-file-changed {exists,path}` for the ACTIVE file's external-delete/restore lifecycle).
// Two `notify` watchers on one directory is the redundant OS-watcher PP-6 flags. PP-6 collapses
// them: `start_configs_watcher` is the SOLE watcher and ALSO emits `config-file-changed` for the
// registered active path. `watch_config_file`/`unwatch_config_file` no longer spawn a watcher —
// they just register/clear the active path here. Both FE signals keep firing with identical
// payloads; only the duplicate OS watcher is gone.

/// The currently-watched active config path (set by `watch_config_file`, cleared by
/// `unwatch_config_file`). The single data-dir watcher reads this to decide whether an fs event
/// touches the active file and thus warrants a `config-file-changed` emit. Poison-tolerant.
static ACTIVE_CONFIG_PATH: Mutex<Option<String>> = Mutex::new(None);

/// Register the active config path so the single data-dir watcher emits `config-file-changed`
/// for it (PP-6). Replaces the old second OS watcher's target.
pub fn set_active_config_path(path: String) {
    let mut guard = ACTIVE_CONFIG_PATH
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = Some(path);
}

/// Clear the active config path (PP-6) — after this no `config-file-changed` is emitted until a
/// new path is registered.
pub fn clear_active_config_path() {
    let mut guard = ACTIVE_CONFIG_PATH
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = None;
}

/// The registered active config path, if any (read by the single data-dir watcher).
fn active_config_path() -> Option<String> {
    ACTIVE_CONFIG_PATH
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

/// Current manifest schema version. Bumped only on a breaking layout change.
/// Migration is idempotent and guards on the presence of a manifest at this version.
pub const MANIFEST_SCHEMA_VERSION: u32 = 1;

/// The manifest file name in the portable data dir.
const MANIFEST_FILENAME: &str = "configs.json";
/// The temp file used by the atomic writer (written, fsync'd, then renamed over the real one).
/// 17-03: the generic `atomic_write` now derives `<name>.tmp` itself, so production no longer
/// references this constant — the crash-safety test still asserts against the exact temp name.
#[cfg_attr(not(test), allow(dead_code))]
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
    /// B6 fix #5 (DATA-LOSS): a DURABLE flag marking this entry as a deliberately-created copy
    /// (card «Дублировать» or import same-server «Добавить копию»). Set true at every app
    /// copy-creation site; `is_deliberate_copy` checks it FIRST so a copy is ALWAYS spared by the
    /// delete identity-sweep — even when its name/filename heuristic would miss it (a numbered
    /// «(копия 2)» label, an import copy that kept the original filename, or a copy the user then
    /// RENAMED, stripping the name marker). `#[serde(default)]` so existing manifests written
    /// before this field parse as `false` (legacy copies fall back to the name/filename heuristic).
    #[serde(default)]
    pub copy: bool,
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
    /// The RAW `[endpoint].hostname` — the dedup / same-server IDENTITY key. Read by
    /// `find_duplicate_by_host_user` (D-13), `identity_key_of` (B6 copy-sweep), and the FE
    /// `identityKey` (dedupeConfigsByIdentity.ts). MUST stay the raw hostname: re-keying it to the
    /// IP would silently alter dedup/same-server-copy behavior (the round-2 DATA-LOSS surface).
    pub host: String,
    /// 16-07 (gap 5a): the value the Connection-tab card SHOWS. IP-preferring — for a bare-IP
    /// endpoint that carries a fake TLS-SNI hostname (e.g. `trusttunnel.local` +
    /// `addresses=["203.0.113.141:443"]`) this is the real IP, so the FE `isIpAddress` branch
    /// renders the «IP» glyph instead of the globe. Display ONLY — never a dedup/identity key.
    /// Computed by `derive_display_host` (which reuses `ping::host_from_addr`). Plain snake_case so
    /// the FE `display_host` mirrors it 1:1.
    pub display_host: String,
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

/// PP-1 (17-03): the single generic atomic file writer. Writes `bytes` to `<name>.tmp` inside
/// `dir`, fsyncs the data, renames it over `<name>` (atomic swap on the same NTFS volume), then
/// PP-3 makes a BEST-EFFORT fsync of the PARENT DIR (F9: on Windows this requires opening the dir
/// with FILE_FLAG_BACKUP_SEMANTICS — a plain open is denied — and can still fail without write
/// access, so it is swallowed). The rename's durability does NOT rest on that fsync: NTFS journals
/// the rename as a metadata transaction, so the directory-entry update survives a power loss even
/// when the fsync is skipped or denied. The dir fsync is a belt to that journaling suspenders.
///
/// This is the ONE writer every password-bearing per-config `.toml` routes through (config
/// save/normalize/recovery/DHCP-patch, the duplicate copy, the rename, the import writes, the
/// deploy/server-config export). A crash / power-loss / ENOSPC mid-write can therefore never leave
/// a truncated password file: the temp may be partial, but the real file is only ever swapped in
/// whole. F14: on a RECOVERABLE mid-write error (write/fsync/rename returns `Err`, e.g. ENOSPC) the
/// partial `<name>.tmp` is removed best-effort before returning — it holds partial password-bearing
/// bytes (D-29) that must not linger until the next successful save; only a hard crash (no unwind)
/// can leave a temp behind, and the next `atomic_write` overwrites it. Generalized from
/// `write_manifest_atomic`'s proven temp→write_all→sync_all→rename body so there is no second
/// hand-rolled copy to drift.
///
/// D-29: this function NEVER logs `bytes` (the config content carries the endpoint password) — it
/// emits nothing at all; only the caller's neutral path/name may be logged. `name` must be a BARE
/// filename (no separators) — callers join it onto a validated `dir`.
///
/// T-23-04 / FAB-02: the temp name is UNIQUE PER CALL, not `<name>.tmp`.
///
/// With one shared temp per destination, two concurrent writers of the same file interleaved their
/// bytes into it, and whichever renamed second published a byte-wise MIX of two generations. Both
/// halves of the atomicity argument above quietly assumed a single writer. That assumption held
/// until Phase 23 added a background scheduler writing `group_cache/<id>.json` on a timer while the
/// UI can write the same file on demand — but the exposure was never limited to geodata: every
/// password-bearing `.toml` routed through here shared the same single temp, so two saves racing
/// (two windows, an autosave against a manual save) could publish a spliced config. A mixed
/// credentials file is a worse outcome than either write losing.
///
/// Unique temps make concurrent writers independent: each fills its own file, each rename is whole,
/// and the last one to rename wins cleanly. Last-writer-wins is the correct semantic here — it is
/// what a single shared file can express — and no reader can ever observe a mixture.
///
/// Deliberately NOT swept: a hard crash mid-write now leaves `<name>.<pid>.<n>.tmp` behind instead
/// of a reusable `<name>.tmp`. Sweeping siblings on the way in would race a concurrent writer's live
/// temp and turn its rename into a spurious failure — trading corruption for flakiness. Orphans are
/// inert: `<name>` itself is never a temp, readers only ever open the real name, and the existing
/// tests pin that a stray temp is never read as data. Clutter beats a spliced password file.
pub fn atomic_write(dir: &Path, name: &str, bytes: &[u8]) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("Failed to create data dir: {e}"))?;
    // pid separates processes (a second app instance), the counter separates calls within one.
    static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let tmp = dir.join(format!(
        "{name}.{}.{}.tmp",
        std::process::id(),
        TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let final_path = dir.join(name);
    // F14: every error path AFTER the temp is created must remove `<name>.tmp` before returning.
    // The temp holds a PARTIAL, password-bearing config (D-29); an ENOSPC/IO failure mid-write must
    // not strand it on disk until the next successful save. The rename below CONSUMES the temp on
    // success (nothing to clean up), so this best-effort cleanup runs only on the failure legs.
    {
        let write_result = (|| {
            let mut f = std::fs::File::create(&tmp)
                .map_err(|e| format!("Failed to create temp file: {e}"))?;
            std::io::Write::write_all(&mut f, bytes)
                .map_err(|e| format!("Failed to write temp file: {e}"))?;
            // fsync the data to disk BEFORE the rename so a crash can never leave a half-written
            // final file (the temp may be partial, the real file is swapped in whole or not at all).
            f.sync_all()
                .map_err(|e| format!("Failed to fsync temp file: {e}"))
        })();
        if let Err(e) = write_result {
            let _ = std::fs::remove_file(&tmp); // best-effort — the partial password file must not linger
            return Err(e);
        }
    }
    if let Err(e) = std::fs::rename(&tmp, &final_path) {
        let _ = std::fs::remove_file(&tmp); // rename failed → the temp is still ours to clean up
        return Err(format!("Failed to swap file into place: {e}"));
    }
    // PP-3 (16-PERF-AUDIT §m-3) + F9 (17-review): best-effort fsync of the PARENT DIR so the rename
    // (a directory-entry mutation) is itself durable against an immediate power loss.
    //
    // F9: on Windows — the ONLY shipping platform — a plain `File::open(dir)` fails with
    // ERROR_ACCESS_DENIED because std does NOT pass FILE_FLAG_BACKUP_SEMANTICS, which is required to
    // obtain a HANDLE to a directory. The old `File::open(dir)` therefore NEVER opened, so this whole
    // branch was dead here and durability rested entirely on the fallback below. We now open the dir
    // WITH backup-semantics so `sync_all()` (→ FlushFileBuffers on the dir handle) can actually run.
    // It is still BEST-EFFORT: the open (no write access) or the flush may fail, and either way we
    // swallow it — a parent-dir fsync failure must not fail an otherwise-successful write. The real
    // durability guarantee does NOT depend on it: NTFS journals the rename (a metadata transaction),
    // so the directory entry survives a crash even when this flush is skipped or denied. This fsync
    // is the belt to that journaling suspenders, no longer a load-bearing (and previously dead) step.
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_BACKUP_SEMANTICS (0x0200_0000): lets CreateFile return a handle to a DIRECTORY
        // (not just a file). Hard-coded literal to avoid pulling an extra windows-sys feature into
        // the build (CI-drift risk); the value is stable Win32 ABI.
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
        if let Ok(dir_handle) = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(dir)
        {
            let _ = dir_handle.sync_all();
        }
    }
    #[cfg(not(windows))]
    {
        // On Unix a plain directory open + fsync is the standard, supported idiom.
        if let Ok(dir_handle) = std::fs::File::open(dir) {
            let _ = dir_handle.sync_all();
        }
    }
    // PP-5: open the self-echo suppression window so the data-dir watcher skips the `configs-changed`
    // echo for THIS write (the FE re-invokes `list_configs` right after the mutation — PA-4/17-07
    // made the mutation commands return `Ok(())` rather than the fresh list). A genuine external
    // change lands outside any write window and still fires. This is the single choke point every
    // in-app `.toml`/manifest write flows through (17-03), so one call here covers all mutators.
    note_expected_write();
    Ok(())
}

/// PP-1 convenience over `atomic_write`: take a FULL destination path, split off its parent dir
/// and bare filename, then route the write through `atomic_write`. Every `.toml` writer that
/// already holds a full `PathBuf` (config save/normalize/recovery/DHCP-patch, the duplicate copy,
/// the rename, the import writes, the deploy/server-config export) calls this so it stays a
/// one-line swap of the old `std::fs::write(&path, bytes)`. A path with no parent (never, for our
/// data-dir files) or no filename is an error rather than a silent plain write. D-29: logs nothing.
pub fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| "atomic write: destination has no parent directory".to_string())?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "atomic write: destination has no filename".to_string())?;
    atomic_write(dir, name, bytes)
}

/// Atomically write the manifest: serialize to bytes, then route through the generic
/// `atomic_write` (temp → fsync → rename → parent-dir fsync). The ONLY manifest writer path.
pub fn write_manifest_atomic(dir: &Path, manifest: &Manifest) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(manifest)
        .map_err(|e| format!("Failed to serialize manifest: {e}"))?;
    atomic_write(dir, MANIFEST_FILENAME, &json)
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

/// Is `s` a bare IP literal? Accepts an unbracketed IPv4/IPv6, and a bracketed IPv6 literal
/// (`[2001:db8::1]`) by stripping the surrounding brackets first. Used ONLY to decide whether a
/// candidate host string is an address (→ drives the «IP» glyph); it is not a validator.
fn is_bare_ip(s: &str) -> bool {
    let unbracketed = s.strip_prefix('[').and_then(|r| r.strip_suffix(']')).unwrap_or(s);
    unbracketed.parse::<std::net::IpAddr>().is_ok()
}

/// The app's self-hosted "no real domain" SNI placeholder. When a self-hosted (non-Let's-Encrypt)
/// install has no user domain, the generated config carries `hostname = "trusttunnel.local"` as a
/// FAKE TLS-SNI name (mirroring `server_config.rs::validated_server_host`, which treats empty OR
/// `trusttunnel.local` as "no real host"). It is NOT a routable domain — the real endpoint is the
/// IP in `addresses[0]` — so for the card we surface that IP instead of this placeholder.
const NO_DOMAIN_SNI_PLACEHOLDER: &str = "trusttunnel.local";

/// 16-07 (gap 5a): the IP-preferring value the card SHOWS (`ConfigSummary.display_host`), kept
/// SEPARATE from `host` (the raw dedup/identity key) so fixing the card glyph can never alter
/// dedup/same-server-copy behavior.
///
/// Rule — a bare-IP `addresses[0]` wins over a FAKE SNI hostname; a REAL domain keeps the domain
/// (so its globe glyph is preserved):
///   * hostname is a REAL domain (non-empty, not a bare IP, not the `trusttunnel.local`
///     no-domain placeholder) → the hostname wins (globe).
///   * else (hostname empty, itself an IP, or the `trusttunnel.local` placeholder) AND
///     `addresses[0]` yields a bare IP → that IP (so a `trusttunnel.local`-SNI-over-IP config
///     surfaces the real IP + the «IP» glyph — the gap-5a fix).
///   * else fall back to the trimmed hostname, else the address host, else "".
///
/// The `trusttunnel.local` test mirrors `server_config.rs::validated_server_host` (empty OR
/// `trusttunnel.local` ⇒ no real host) so the two agree on what counts as a real domain. Reuses
/// `ping::host_from_addr` for the address host — the SAME derivation the ping reader uses, so the
/// two host derivations cannot drift (the 5a root_cause requires reuse, not a copy).
fn derive_display_host(hostname: &str, first_addr: Option<&str>) -> String {
    let hostname = hostname.trim();
    let addr_host = first_addr.and_then(crate::commands::ping::host_from_addr);
    let addr_is_ip = addr_host.as_deref().map(is_bare_ip).unwrap_or(false);
    // A REAL domain wins → globe preserved. "Real" excludes empty, a bare IP, and the
    // no-domain `trusttunnel.local` placeholder (a fake SNI, not a routable name).
    let hostname_is_real_domain = !hostname.is_empty()
        && !is_bare_ip(hostname)
        && !hostname.eq_ignore_ascii_case(NO_DOMAIN_SNI_PLACEHOLDER);
    if hostname_is_real_domain {
        return hostname.to_string();
    }
    // Fake-SNI / empty / IP hostname: prefer a bare-IP addresses[0] so the «IP» glyph fires.
    if addr_is_ip {
        if let Some(ip) = addr_host {
            return ip;
        }
    }
    // No usable address IP: keep the hostname (may itself be an IP or the placeholder), else the
    // address host, else "".
    if !hostname.is_empty() {
        return hostname.to_string();
    }
    addr_host.unwrap_or_default()
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
    // 16-07 (gap 5a): the card DISPLAY value — IP-preferring, separate from `host` (the raw
    // dedup/identity key, left untouched above). `addresses[0]` feeds derive_display_host so a
    // bare-IP endpoint carrying a fake SNI hostname surfaces the real IP + the «IP» glyph.
    let first_addr = ep
        .and_then(|e| e.get("addresses"))
        .and_then(|a| a.as_array())
        .and_then(|a| a.first())
        .and_then(|s| s.as_str());
    let display_host = derive_display_host(&host, first_addr);
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
        display_host,
        user,
        path: path.to_string(),
        order: 0,
        last_used: false,
    })
}

// ─── PP-4: (mtime, len) summarize cache ──────────────────────────────────────
//
// `list_configs` runs on every refresh (import/delete/rename/reorder + the fs-watcher
// `configs-changed` echo + tab-switch/focus backstop). Each call re-read + re-parsed EVERY
// `.toml` even when nothing on disk changed. PP-4 keys a per-path cache on the file's
// (mtime, len): if BOTH match the last parse, the stored name/host/display_host/user is
// reused and the TOML parse is skipped. A write always bumps mtime (and usually len), so a
// real edit invalidates the entry and is re-parsed — the cache can never serve stale data.
// The password is NEVER cached (D-29: `summarize_unchecked` never reads it in the first place).
//
// Bounded: entries whose path is no longer in the manifest are never evicted actively, but the
// cache only grows with distinct config paths the user has ever listed (a handful), so unbounded
// growth is not a practical concern; a stale entry for a deleted path is simply never hit again.

/// The cache key half we compare: last-modified time + byte length. A `.toml` write (atomic
/// temp+rename, 17-03) lands a fresh mtime, so a stale key can never match a changed file.
#[derive(Clone, Copy, PartialEq, Eq)]
struct FileStamp {
    mtime_ns: i128,
    len: u64,
}

fn file_stamp(path: &str) -> Option<FileStamp> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?;
    // Represent mtime as signed nanoseconds from the UNIX epoch so pre-epoch times (rare, but
    // possible on odd filesystems) still compare correctly instead of saturating.
    let mtime_ns = match modified.duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_nanos() as i128,
        Err(e) => -(e.duration().as_nanos() as i128),
    };
    Some(FileStamp { mtime_ns, len: meta.len() })
}

/// Process-wide cache: path → (stamp, parsed summary). Reuses the parsed name/host/display_host/
/// user when the file's (mtime, len) is unchanged since the last parse (PP-4). Poison-tolerant for
/// the same reason as the manifest lock — a stale/rebuildable cache must never wedge the list.
static SUMMARIZE_CACHE: Mutex<Option<std::collections::HashMap<String, (FileStamp, ConfigSummary)>>> =
    Mutex::new(None);

/// `summarize_unchecked` with the PP-4 (mtime, len) cache in front. On a stamp hit the stored
/// summary is cloned (no file read/parse); on a miss (or an unstat-able file) it falls through to
/// a fresh parse and refreshes the cache. Behavior is identical to `summarize_unchecked` — only
/// the redundant re-parse of unchanged files is elided.
fn summarize_cached(path: &str) -> Result<ConfigSummary, String> {
    let stamp = file_stamp(path);
    if let Some(stamp) = stamp {
        let mut guard = SUMMARIZE_CACHE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let map = guard.get_or_insert_with(std::collections::HashMap::new);
        if let Some((cached_stamp, cached)) = map.get(path) {
            if *cached_stamp == stamp {
                return Ok(cached.clone());
            }
        }
        // Miss (new file, changed stamp, or first sight): parse fresh, then cache under the stamp.
        let summary = summarize_unchecked(path)?;
        map.insert(path.to_string(), (stamp, summary.clone()));
        return Ok(summary);
    }
    // Un-stat-able (locked/racing): skip the cache entirely and parse directly.
    summarize_unchecked(path)
}

/// Clear the PP-4 summarize cache. Test-only hook so cache-behavior tests start from a known
/// empty state without leaking entries across cases.
#[cfg(test)]
fn clear_summarize_cache() {
    let mut guard = SUMMARIZE_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = None;
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
    // B6 fix #6: migration is DEDUP-BY-PATH ONLY (the pre-B6 behavior — the identity-aware skip is
    // REVERTED). Rationale: the skip left the losing same-identity twin as an UNTRACKED
    // password-bearing `.toml` on disk (migration never deletes — P11-02 — and never re-runs), and
    // the delete-sweep iterates only `manifest.configs`, so that untracked twin could NEVER be
    // deleted in-app → a residual-secret file forever. Tracking BOTH twins instead is coherent: the
    // display already collapses same-identity twins to one card (`dedupeConfigsByIdentity`), and the
    // delete identity-sweep removes BOTH files on delete. So the twin is invisible (collapsed) yet
    // fully deletable — no untracked orphan. NEVER reads the password (D-29).

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
                    let path_str = active_path.to_string_lossy().to_string();
                    entries.push(ConfigEntry {
                        id: id_from_path(active_path),
                        name,
                        path: path_str,
                        order: 0,
                        last_used: true,
                        copy: false, // migrated files are never copies (fix #5 durable flag)
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
        let path_str = p.to_string_lossy().to_string();
        // B6 fix #6: track EVERY distinct-path config (path-dedup only — no identity skip). A
        // same-identity twin is kept as its own tracked entry so it is deletable in-app; the
        // display-collapse hides it and the delete identity-sweep removes both files together.
        entries.push(ConfigEntry {
            id: id_from_path(&p),
            name,
            path: path_str,
            order: next_order,
            last_used: false,
            copy: false, // migrated files are never copies (fix #5 durable flag)
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

/// Lexical, case-insensitive path equality (Windows) — the delete path's FALLBACK confinement check
/// when the canonical V12 validator drifts (junction/subst/OneDrive-redirect of the portable folder).
/// Strips the `\\?\` verbatim prefix and normalizes separators/trailing slash/case so a canonical form
/// and a plain form of the SAME directory compare equal. Used only as a belt for the delete
/// confinement (never to widen where a file may be written).
fn same_dir_lexical(a: &Path, b: &Path) -> bool {
    fn norm(p: &Path) -> String {
        p.to_string_lossy()
            .trim_start_matches(r"\\?\")
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_lowercase()
    }
    norm(a) == norm(b)
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
    // We already hold the lock and migration just reconciled the folder — read via the lock-free
    // core, NOT `list_configs()` (which now takes the lock itself for its folder reconcile and would
    // deadlock re-entrantly here).
    list_configs_in_dir(&dir)
}

/// Phase 19 UAT (owner model — "the folder is the source of truth"): APPEND to the manifest any valid
/// config `.toml` in `dir` that is not already tracked (dedup by canonical path). Mirrors
/// `migrate_to_manifest`'s scan + `looks_like_config` predicate + `derive_name`, but is APPEND-ONLY
/// (never reorders/renames/deletes an existing entry — P11-02) and runs on every list rather than once.
/// This makes a config file that landed in the folder via a manifest-BYPASSING add-path (protocol
/// deploy; and, before their own fixes, Users-tab download staging / Settings file-browse) VISIBLE in
/// the app AND deletable in-app — the two things a manifest-only list + a manifest-only delete could
/// never do. Returns true if anything was adopted (so the caller persists). D-29: `derive_name` reads
/// only the display name, never the password.
fn adopt_orphans_in_dir(dir: &Path, manifest: &mut Manifest) -> bool {
    let mut seen: Vec<std::path::PathBuf> = manifest
        .configs
        .iter()
        .map(|e| canonical_or_self(Path::new(&e.path)))
        .collect();
    let mut found: Vec<(std::path::PathBuf, String)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            // Only *.toml config files, case-INSENSITIVELY (folder-as-truth: `config.TOML` counts
            // too, matching the fs-watcher). Cargo.toml is excluded; the `<name>.toml.tmp` atomic-write
            // temp and `<config>.toml.recovered` sidecars have a DIFFERENT extension and are skipped.
            let is_toml = p
                .extension()
                .and_then(|s| s.to_str())
                .map(|x| x.eq_ignore_ascii_case("toml"))
                .unwrap_or(false);
            if !is_toml || p.file_name().and_then(|s| s.to_str()) == Some("Cargo.toml") {
                continue;
            }
            // Dedup by canonical path BEFORE reading the file — an already-tracked path needs no read,
            // so a steady-state list does zero extra file reads.
            let canon = canonical_or_self(&p);
            if seen.iter().any(|s| s == &canon) {
                continue;
            }
            // `looks_like_config` gates on the `[endpoint]`/`[listener]` predicate so a stray
            // non-config .toml is never adopted.
            if let Ok(content) = std::fs::read_to_string(&p) {
                if looks_like_config(&content) {
                    found.push((p, content));
                    seen.push(canon); // guard against re-adopting the same canonical path in this scan
                }
            }
        }
    }
    found.sort_by(|a, b| a.0.cmp(&b.0));
    let base_order: u32 = manifest
        .configs
        .iter()
        .map(|e| e.order)
        .max()
        .map(|m| m + 1)
        .unwrap_or(0);
    let adopted = !found.is_empty();
    // Derive each adopted config's order from the enumerate() index (base + i), NOT a hand-incremented
    // counter: the newer CI clippy toolchain (rust 1.97) denies `clippy::explicit_counter_loop` on a
    // manual `next_order += 1` — a toolchain-drift lint the local clippy did not yet flag.
    for (i, (p, content)) in found.into_iter().enumerate() {
        let name = derive_name(&content, &p);
        manifest.configs.push(ConfigEntry {
            id: id_from_path(&p),
            name,
            path: p.to_string_lossy().to_string(),
            order: base_order + i as u32,
            last_used: false,
            copy: false, // an adopted orphan is a plain config, never a deliberate copy
        });
    }
    adopted
}

/// Phase 19 UAT (owner model): reconcile the folder ⇄ manifest before every `list_configs` read so
/// the app view always mirrors the folder both ways: PRUNE entries whose `.toml` vanished from the
/// folder (file gone → card gone) and ADOPT valid config `.toml`s the folder has but the manifest
/// lacks (file present → card present). Takes the manifest lock and persists only when something
/// changed; best-effort (a failed persist just re-reconciles on the next list). MUST NOT be called
/// while already holding the lock (it locks itself) — `migrate_configs` uses `list_configs_in_dir`.
fn reconcile_folder_with_manifest(dir: &Path) {
    let _guard = lock_manifest();
    let Ok(mut manifest) = read_manifest(dir) else {
        return;
    };
    let pruned = prune_missing(&mut manifest);
    let adopted = adopt_orphans_in_dir(dir, &mut manifest);
    if pruned || adopted {
        let _ = write_manifest_atomic(dir, &manifest);
    }
}

/// Return the manifest entries as non-secret summaries (id/name/host/user/path +
/// order/last_used). Reads each entry's `.toml` for the fresh name/host/user (D-14);
/// the manifest stores NO password. The last-used entry is surfaced first.
#[tauri::command]
pub fn list_configs() -> Result<Vec<ConfigSummary>, String> {
    let dir = portable_data_dir();
    // Folder-as-truth: adopt any orphaned config .toml + prune vanished files BEFORE the read, so a
    // file in the folder always shows and a file removed from the folder always disappears.
    reconcile_folder_with_manifest(&dir);
    list_configs_in_dir(&dir)
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
        // the unchecked reader is correct — no second path-validation needed. PP-4: the
        // (mtime, len) cache skips the re-parse when the .toml is unchanged since last list.
        let summary = summarize_cached(&entry.path).unwrap_or_else(|_| ConfigSummary {
            id: entry.id.clone(),
            name: entry.name.clone(),
            host: String::new(),
            // Unreadable file: no host context → the card display value is empty too.
            display_host: String::new(),
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
            // Carry the summary's IP-preferring display value through to the card (16-07).
            display_host: summary.display_host,
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
/// canonical path — adding the same path twice is a no-op.
///
/// PA-4 (17-07, MINOR-2): returns `Result<(), String>`, NOT the updated list. Every caller
/// already discarded the returned `Vec<ConfigSummary>` and re-invoked `list_configs`
/// afterwards (consume-and-drop-reload), so returning `Ok(())` makes the discard explicit in
/// the type and drops one redundant manifest read per mutation. The convention decision was
/// recorded in plan 17-04 and applied consistently to all six manifest MUTATION commands
/// (add/delete/duplicate/rename/set_last_used/reorder); the READ commands (`list_configs`,
/// `migrate_configs`) keep their `Vec` return — their list IS consumed.
#[tauri::command]
pub fn add_config(path: String) -> Result<(), String> {
    validate_app_path(&path)?;
    // WR-01: hold the funnel lock across read→mutate→write so a concurrent mutation
    // cannot overwrite this add with a stale manifest copy (lost update).
    let _guard = lock_manifest();
    let dir = portable_data_dir();
    let mut manifest = read_manifest(&dir)?;
    prune_missing(&mut manifest); // IN-55: drop ghosts so order/dedup are truthful
    add_entry(&mut manifest, &path)?;
    write_manifest_atomic(&dir, &manifest)?;
    Ok(())
}

/// Internal: append a config entry (deduped by canonical path). Shared by add_config +
/// duplicate_config so the dedup rule lives in one place. Name derived from content (D-14).
/// A plain add is never a copy (`copy = false`).
fn add_entry(manifest: &mut Manifest, path: &str) -> Result<(), String> {
    add_entry_named(manifest, path, None, false)
}

/// Like `add_entry` but with an OPTIONAL explicit display name and a durable `copy` flag. The
/// import/duplicate COPY paths pass `Some("<base> (копия N)")` (IN-26) so the copy is labelled
/// distinctly AND `copy = true` (B6 fix #5) so the delete identity-sweep spares it regardless of
/// how its name/filename later drifts; a plain add/import passes `None`/`false` and derives the
/// name from content (D-14).
fn add_entry_named(
    manifest: &mut Manifest,
    path: &str,
    name_override: Option<&str>,
    copy: bool,
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
        copy, // B6 fix #5: durable copy marker (import same-server «Добавить копию» passes true)
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

/// Lock + read + prune + write-if-changed. 17-03/PP-2: the import flow now prunes INLINE under its
/// own single held lock (`import_config_under_lock` calls `prune_missing` directly — re-locking here
/// would deadlock), so production no longer calls this wrapper; it is retained as the funnel's
/// standalone prune entry point (and exercised by tests). Callers already holding the lock with a
/// manifest in hand (add/duplicate) use `prune_missing` directly instead.
#[cfg_attr(not(test), allow(dead_code))]
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
                // PP-5: suppress the `configs-changed` echo of our OWN in-app write. After each
                // mutation the FE re-invokes `list_configs` (PA-4/17-07 — the commands return
                // `Ok(())`, not a list), so a watcher-driven second read would be redundant. A
                // genuine EXTERNAL change lands outside the suppression window and still fires.
                // F5: `set_last_used`/`reorder_configs` have fire-and-forget callers that do NOT
                // re-fetch, so they self-emit `configs-changed` after their write — that explicit
                // emit is what refreshes the list, NOT this suppressed echo.
                if !within_self_echo_window() {
                    app_handle.emit("configs-changed", ()).ok();
                }
            }
            // PP-6: this SINGLE data-dir watcher also drives `config-file-changed` for the registered
            // ACTIVE config path (retiring the second OS watcher that config.rs used to spawn). Emit
            // it for a Create/Remove/Modify that touches the active file. NOT gated by the PP-5
            // self-echo window: the active-file lifecycle (external delete/restore vs in-app delete)
            // is disambiguated FE-side by the self-delete guard (useConfigLifecycle, B2/#8) exactly
            // as before — collapsing the watcher must not change that timing. Payload shape is
            // byte-identical to the old config.rs emit: `{ exists, path }`.
            if let Some(active) = active_config_path() {
                let active_path = std::path::Path::new(&active);
                let active_name = active_path.file_name();
                let touches_active = active_name.is_some()
                    && event
                        .paths
                        .iter()
                        .any(|p| p.file_name() == active_name);
                if touches_active {
                    let exists = active_path.is_file();
                    app_handle
                        .emit(
                            "config-file-changed",
                            serde_json::json!({ "exists": exists, "path": &active }),
                        )
                        .ok();
                }
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

/// Phase 13 (13-08): the endpoint LOGIN (username) of a config read from its `.toml` — the value
/// the CONNECT notification plate shows in its login row. Reuses `summarize_unchecked` (the same
/// name/host/user reader `list_configs` uses), which reads `endpoint.username` and NEVER
/// `endpoint.password` (D-29). `None` when the file can't be read or the username is empty (the
/// plate then omits the login row rather than showing a placeholder).
pub fn username_for_config(path: &str) -> Option<String> {
    summarize_unchecked(path)
        .ok()
        .map(|s| s.user)
        .filter(|u| !u.is_empty())
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
pub fn delete_config(id: String) -> Result<(), String> {
    // WR-01: serialize read→mutate→write against other manifest mutators.
    let _guard = lock_manifest();
    let dir = portable_data_dir();
    delete_config_in_dir(&dir, &id)?;
    // PA-4 (17-07): return Ok(()) — the FE discarded the list and re-invoked list_configs.
    Ok(())
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
    let target = manifest.configs[idx].clone();

    // B6 (16-UAT round 2): the card the user deleted may be the DISPLAY winner of a same-server
    // migration twin (two `.toml` files, same host+user — legacy `trusttunnel_client.toml` +
    // `TrustTunnel_<user>.toml`). The card carries only the winner id, so deleting exactly that one
    // entry+file leaves the loser twin orphaned → it collapses back into a card → "reappears". So
    // delete SWEEPS every manifest entry sharing the target's (host,user) identity — EXCEPT a
    // deliberate «(копия)» / `-copy` / `-<n>` sibling (it is its own card the user chose to keep,
    // per the DECIDED rule). The target itself is always swept even if the file is unreadable now
    // (its identity is unknown then, but it is still the explicit delete). NEVER reads the password
    // (D-29).
    let target_is_copy = is_deliberate_copy(target.copy, &target.name, &target.path);
    let target_identity = if target_is_copy { None } else { identity_key_of(&target.path) };

    // Collect the ids to delete: the target, plus non-copy siblings sharing its identity.
    let mut ids_to_delete: Vec<String> = vec![target.id.clone()];
    if let Some((ref host, ref user)) = target_identity {
        for c in &manifest.configs {
            if c.id == target.id {
                continue;
            }
            if is_deliberate_copy(c.copy, &c.name, &c.path) {
                continue; // a deliberate copy keeps its own card — never swept (fix #5: flag-first)
            }
            if let Some((h, u)) = identity_key_of(&c.path) {
                if &h == host && &u == user {
                    ids_to_delete.push(c.id.clone());
                }
            }
        }
    }

    // Remove the matched entries from the manifest (record originals + positions for WR-03
    // re-insertion on a file-delete failure). Remove from the highest index down so earlier
    // indices stay valid.
    let mut removed: Vec<(usize, ConfigEntry)> = Vec::new();
    let mut positions: Vec<usize> = manifest
        .configs
        .iter()
        .enumerate()
        .filter(|(_, c)| ids_to_delete.iter().any(|d| d == &c.id))
        .map(|(i, _)| i)
        .collect();
    positions.sort_unstable_by(|a, b| b.cmp(a));
    for pos in positions {
        removed.push((pos, manifest.configs.remove(pos)));
    }
    // Restore ascending order so re-insertion (on failure) lands entries at their original slots.
    removed.sort_by_key(|(pos, _)| *pos);

    let removed_last_used = removed.iter().any(|(_, e)| e.last_used);

    // WR-03: delete each on-disk file, and if ANY file cannot be removed, RE-INSERT its entry so
    // the manifest still tracks the file we could not remove (never orphan a password-bearing
    // `.toml`) and surface the error. V12: only delete a file that validates inside the data dir; a
    // path pointing outside is dropped from the list without attempting a delete. A NotFound error
    // is success-equivalent (the file is already gone). Files that DID delete stay removed; only the
    // failed one is re-tracked, then we fail — matching the single-delete WR-03 contract.
    let mut first_err: Option<String> = None;
    let mut reinsert: Vec<(usize, ConfigEntry)> = Vec::new();
    for (pos, entry) in &removed {
        // Confinement before removal (never delete outside the data dir — D-06). Prefer the canonical
        // V12 validator; FALL BACK to a lexical parent-dir check when canonicalize DRIFTS
        // (junction/subst/OneDrive-redirect of the portable folder). Phase 19 UAT: the old code
        // SILENTLY skipped remove_file on a validate miss — the entry was already dropped from the
        // manifest, so the card vanished from the app while the `.toml` stayed in the folder forever (a
        // UI-only removal, the "не удаляется из папки" report). Now a validate-miss on a file
        // still lexically inside the data dir is STILL removed, and a path confined by NEITHER check is
        // treated as a delete FAILURE (re-insert + surface the error) — never a silent orphan.
        let confined = validate_path_in_dir(&entry.path, dir).is_ok()
            || Path::new(&entry.path)
                .parent()
                .map(|par| same_dir_lexical(par, dir))
                .unwrap_or(false);
        if !confined {
            reinsert.push((*pos, entry.clone()));
            if first_err.is_none() {
                first_err =
                    Some("Failed to delete config file: path is outside the app folder".into());
            }
            continue;
        }
        if let Err(e) = std::fs::remove_file(&entry.path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                reinsert.push((*pos, entry.clone()));
                if first_err.is_none() {
                    first_err = Some(format!("Failed to delete config file: {e}"));
                }
            }
        }
    }
    // Re-insert the entries whose files could not be removed, at their original positions (ascending
    // so earlier indices are filled first and later ones still land correctly).
    reinsert.sort_by_key(|(pos, _)| *pos);
    for (pos, entry) in reinsert {
        let at = pos.min(manifest.configs.len());
        manifest.configs.insert(at, entry);
    }
    if let Some(err) = first_err {
        // Persist the partial state (files that DID delete stay gone; the re-inserted entry keeps
        // its file tracked), then surface the error.
        write_manifest_atomic(dir, &manifest)?;
        return Err(err);
    }

    // If we removed the last-used config, promote the new top entry (lowest order) so the
    // list always has a sensible lead when non-empty.
    if removed_last_used {
        if let Some(top) = manifest.configs.iter_mut().min_by_key(|c| c.order) {
            top.last_used = true;
        }
    }
    write_manifest_atomic(dir, &manifest)
}

/// Duplicate a config: copy its `.toml` to a unique filename in the data dir and append a
/// «(копия)» entry. The active/last-used config is untouched.
#[tauri::command]
pub fn duplicate_config(id: String) -> Result<(), String> {
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
    // PP-1: rewrite the copy's baked-in name atomically — a crash here must not leave the copy's
    // password-bearing `.toml` truncated. dest lives inside `dir`, so split off its bare filename.
    write_bytes_atomic(&dest, upsert_endpoint_name(&dest_content, &copy_name).as_bytes())
        .map_err(|e| format!("Failed to write copy name: {e}"))?;
    let next_order = manifest.configs.iter().map(|c| c.order).max().map_or(0, |m| m + 1);
    manifest.configs.push(ConfigEntry {
        id: creation_id(&dest), // IN-51: unique per creation, never recycled from a deleted copy
        name: copy_name,
        path: dest.to_string_lossy().to_string(),
        order: next_order,
        last_used: false,
        copy: true, // B6 fix #5: card «Дублировать» is a deliberate copy — durably spare it from the sweep
    });
    write_manifest_atomic(&dir, &manifest)?;
    // PA-4 (17-07): return Ok(()) — the FE discarded the list and re-invoked list_configs.
    Ok(())
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

/// B6 (16-UAT round 2 + fix #5): true when this entry is a DELIBERATELY-created copy of another
/// config, mirroring the frontend `isDeliberateCopy` rule (dedupeConfigsByIdentity.ts). A copy has
/// the same (host,user) identity as its original but must keep its own card and must NEVER be
/// swept by the delete identity-sweep — permanent data loss otherwise (fix #5).
///
/// Detection order (fix #5 hardening):
///   1. The DURABLE `copy` flag (primary) — set true at every app copy-creation site
///      (`duplicate_config`, import same-server «Добавить копию»). A flagged entry is a copy no
///      matter what its name/filename later becomes (a numbered «(копия 2)» label, an import copy
///      that kept the original filename, or a copy the user RENAMED to strip the marker).
///   2. Name heuristic (legacy fallback, for pre-flag manifests): the display name carries a
///      trailing « (копия)» OR « (копия N)» — detected via `copy_base_name` (which parses BOTH),
///      not a literal `.contains("(копия)")` that missed the numbered form «(копия 2)».
///   3. Filename heuristic (legacy fallback): a `-copy` / `-copy-<n>` / trailing `-<n>` suffix.
///
/// A migration twin (`trusttunnel_client.toml` + `TrustTunnel_<user>.toml`) carries no copy flag,
/// no «(копия)» label, and no copy suffix — so it is never mis-flagged; generated usernames glue
/// digits to the noun («free-lion58»), never as a trailing «-<n>».
fn is_deliberate_copy(copy: bool, name: &str, path: &str) -> bool {
    // (1) Durable flag wins — a flagged copy is always spared, regardless of name/filename drift.
    if copy {
        return true;
    }
    let base = Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    let stem = base.strip_suffix(".toml").unwrap_or(&base);
    // (2) Name heuristic (legacy fallback): a trailing « (копия)» OR « (копия N)». `copy_base_name`
    // strips both forms, so a real strip (base != name) means the name carries a copy marker — this
    // catches the numbered «(копия 2)» that the old literal `.contains("(копия)")` missed.
    if copy_base_name(name).trim_end() != name.trim_end() {
        return true;
    }
    // (3) `-copy` or `-copy-<n>` suffix (card «Дублировать», legacy fallback).
    if stem.ends_with("-copy") {
        return true;
    }
    if let Some((_, n)) = stem.rsplit_once("-copy-") {
        if !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()) {
            return true;
        }
    }
    // `-<n>` trailing-number suffix (import «Добавить копию» → `<stem>-2.toml`).
    if let Some((_, tail)) = stem.rsplit_once('-') {
        if !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) {
            return true;
        }
    }
    false
}

/// B6: the same-server identity key for a manifest entry read off its `.toml` — normalized
/// (host, user), matching the FE `identityKey`. `None` when the file is unreadable or has no host
/// (an un-keyable entry is never collapsed/swept). NEVER reads the password (D-29).
fn identity_key_of(path: &str) -> Option<(String, String)> {
    let s = summarize_unchecked(path).ok()?;
    let host = s.host.trim().to_lowercase();
    if host.is_empty() {
        return None;
    }
    Some((host, s.user.trim().to_lowercase()))
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

/// Phase 19 UAT: extract the endpoint's REAL IP/host for a GeoIP lookup from config CONTENT —
/// prefer `endpoint.addresses[0]` (the real `IP:port`, port stripped) over `endpoint.hostname`,
/// which is often a self-signed SNI like `trusttunnel.local` that GeoIP cannot resolve. Used to
/// brand a link/clipboard import's filename with the country prefix like every other add-path.
/// `None` when neither is usable. D-29: never reads the password.
pub fn geoip_host_from_content(content: &str) -> Option<String> {
    let v = toml::from_str::<toml::Value>(content).ok()?;
    let ep = v.get("endpoint")?.as_table()?;
    // addresses = ["203.0.113.200:443", …] → first entry, strip the trailing :port (and IPv6 [] ).
    if let Some(addr) = ep
        .get("addresses")
        .and_then(|a| a.as_array())
        .and_then(|a| a.first())
        .and_then(|x| x.as_str())
    {
        let host = addr.rsplit_once(':').map(|(h, _)| h).unwrap_or(addr).trim();
        let host = host.trim_start_matches('[').trim_end_matches(']');
        if !host.is_empty() {
            return Some(host.to_string());
        }
    }
    // Fallback: the SNI hostname (GeoIP best-effort — may not resolve).
    ep.get("hostname")
        .and_then(|h| h.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Phase 19 UAT: the country-prefix rule shared by ALL add-paths — an optional 2-ASCII-letter code,
/// uppercased, yields `<CC>_`, anything else yields `""`. Mirrors `client_config_filename` /
/// `buildConfigFileName` so a link/clipboard import brands the same way as deploy / Users-tab.
fn country_prefix(country: Option<&str>) -> String {
    match country {
        Some(c) if c.len() == 2 && c.chars().all(|ch| ch.is_ascii_alphabetic()) => {
            format!("{}_", c.to_ascii_uppercase())
        }
        _ => String::new(),
    }
}

/// Derive a filesystem-safe stem for an imported config from its content: TOML `name` →
/// else `username` → else `config`. Slugified so the import filename is branded + readable
/// (e.g. a config named «Германия» for user `swift-fox` → `swift-fox`/`config`). NEVER
/// reads the password (D-29). Used by the import write path to brand the unique filename.
pub fn import_stem_from_content(content: &str, country: Option<&str>) -> String {
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
        // Phase 19 UAT: UNIFY with the deploy/Users branded name «[<CC>_]TrustTunnel_<slug>» — prepend
        // the country prefix (best-effort, from a GeoIP of the endpoint IP) so a link/clipboard import
        // matches every other add-path. The prefix lives ONLY in the filename (never in the TOML), so
        // the content-derived path used to drop it.
        format!("{}TrustTunnel_{slug}", country_prefix(country))
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
/// 17-03/PP-2: production import now appends INLINE under `import_config_under_lock`'s single held
/// lock (the whole check→write→append is one critical section), so this standalone wrapper is no
/// longer called by production — it is retained as the funnel's append entry point and exercised by
/// the import tests.
#[cfg_attr(not(test), allow(dead_code))]
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
/// (deeplink.rs) labels the new entry «<base> (копия N)» (IN-26). This is a same-server
/// «Добавить копию», so it is a DELIBERATE copy: mark it durably (`copy = true`, B6 fix #5) so the
/// delete identity-sweep spares it even though its imported filename may carry no `-copy`/`-<n>`
/// suffix (the import keeps the original filename) and its «(копия N)» label could later be
/// renamed away.
#[cfg_attr(not(test), allow(dead_code))]
pub fn append_config_to_manifest_named(dir: &Path, path: &str, name: &str) -> Result<(), String> {
    let _guard = lock_manifest();
    let mut manifest = read_manifest(dir)?;
    add_entry_named(&mut manifest, path, Some(name), true)?;
    write_manifest_atomic(dir, &manifest)
}

/// PP-2 (16-PERF-AUDIT §m-2): perform an entire config import — prune ghosts → decide
/// duplicate-vs-original → allocate a unique filename → write the `.toml` atomically → append the
/// manifest entry — under ONE continuous hold of `MANIFEST_LOCK`.
///
/// The pre-PP-2 import path took the lock THREE separate times (`prune_manifest_in_dir`,
/// `find_duplicate_by_host_user`, then `append_config_to_manifest*`) with the duplicate DECISION
/// made OUTSIDE any lock. Two near-simultaneous imports of the same (host, user) could therefore
/// both observe «no duplicate» in the gap and each write an ORIGINAL — two non-copy twins instead
/// of one original + one «(копия)». Holding the lock across the whole check→write→append closes
/// that TOCTOU window: the second caller only runs its check AFTER the first's manifest write is
/// committed, so it sees the duplicate and lands as a copy.
///
/// Returns `(destination path, is_copy)`. `is_copy` is true when a same-(host,user) config already
/// existed (D-13 «add as copy»). D-29: never logs the content/password. All the sub-helpers used
/// here (`prune_missing`, `find_duplicate_by_host_user`, `unique_import_path`, `next_copy_name_for`,
/// `read_manifest`, `write_manifest_atomic`) are lock-FREE, so calling them under the held guard
/// cannot re-enter the std `Mutex` and deadlock; the `append_config_to_manifest*` wrappers (which
/// DO take the lock) are deliberately NOT used here.
pub fn import_config_under_lock(
    dir: &Path,
    content: &str,
    original_file_name: Option<&str>,
    // Phase 19 UAT: best-effort country code (GeoIP of the endpoint IP, derived by the async caller
    // OUTSIDE this lock) so a content-derived import filename gets the unified «[<CC>_]TrustTunnel_…»
    // prefix. Ignored when `original_file_name` is used (that path preserves the branded name verbatim).
    country: Option<&str>,
) -> Result<(String, bool), String> {
    // One continuous critical section — the whole point of PP-2.
    let _guard = lock_manifest();

    // IN-55: prune ghost manifest entries (configs deleted outside the app) in-memory FIRST — do
    // NOT call prune_manifest_in_dir (it re-takes the lock → deadlock). We persist the pruned
    // manifest as part of the final append write below, so a ghost can't inflate the copy number or
    // make a fresh config look like a duplicate. (Persist the prune even on the no-op no-dup path so
    // a stale ghost is cleaned regardless.)
    let mut manifest = read_manifest(dir)?;
    let pruned = prune_missing(&mut manifest);
    if pruned {
        write_manifest_atomic(dir, &manifest)?;
    }

    // D-13 duplicate key = (host, user), read from the incoming CONTENT (D-29: never the password).
    // Reuse the same `find_duplicate_by_host_user` the pre-PP-2 path used — it is lock-free
    // (read_manifest, no MANIFEST_LOCK), so calling it under the held guard cannot deadlock, and the
    // just-persisted prune means it reads the truthful manifest.
    let (host, user) = host_user_from_content(content);
    let existing = find_duplicate_by_host_user(dir, &host, &user);

    // Branded/derived unique destination filename (atomic create_new claim — never overwrites).
    let stem = original_file_name
        .and_then(safe_import_stem_from_filename)
        .unwrap_or_else(|| import_stem_from_content(content, country));
    let dest = unique_import_path(dir, &stem);
    let dest_str = dest.to_string_lossy().to_string();

    match existing {
        Some(dup) => {
            // Same-server duplicate → AUTO-add as a copy «<base> (копия N)» (D-13 / IN-36). Base the
            // copy name on the duplicate's CURRENT file-derived name (not the maybe-stale manifest
            // label); `next_copy_name_for` allocates the first free «(копия N)» against the dir's
            // manifest (lock-free read — safe under the held guard).
            let dup_base = current_display_name(&dup.path).unwrap_or(dup.name);
            let copy_name = next_copy_name_for(dir, &dup_base);
            let content_named = with_endpoint_name(content, &copy_name);
            // PP-1: atomic write of the copy's password-bearing `.toml`.
            write_bytes_atomic(&dest, content_named.as_bytes())?;
            // Append the copy entry to the (pruned) in-hand manifest and persist atomically — all
            // still under the single held lock, so no concurrent import can slip in a second twin.
            add_entry_named(&mut manifest, &dest_str, Some(&copy_name), true)?;
            write_manifest_atomic(dir, &manifest)?;
            Ok((dest_str, true))
        }
        None => {
            // First import for this identity → plain original (name derived from content).
            write_bytes_atomic(&dest, content.as_bytes())?;
            add_entry(&mut manifest, &dest_str)?;
            write_manifest_atomic(dir, &manifest)?;
            Ok((dest_str, false))
        }
    }
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
pub fn rename_config(id: String, name: String) -> Result<(), String> {
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
    // PP-1: persist the renamed `endpoint.name` atomically — a crash mid-write must not truncate
    // this password-bearing config `.toml`.
    write_bytes_atomic(Path::new(&path), updated.as_bytes())
        .map_err(|e| format!("Failed to write config: {e}"))?;
    // Keep the manifest label in sync as the fallback for an unreadable file.
    entry.name = name;
    write_manifest_atomic(&dir, &manifest)?;
    // PA-4 (17-07): return Ok(()) — the FE discarded the list and re-invoked list_configs.
    Ok(())
}

/// Mark a config as last-used: clear every other marker, set this one, move it to order 0
/// (the lead card). D-05 — exactly one last-used at a time, no favourite/star concept.
///
/// F5 (17-review): takes `app` so it can EXPLICITLY emit `configs-changed` after its write. The
/// atomic writer arms the PP-5 self-echo window, which suppresses the fs-watcher's `configs-changed`
/// echo — and this command's FE caller (`markLastUsed`) is fire-and-forget with NO list re-fetch,
/// and IN-49 removed the tab-switch reload backstop, so that suppressed echo WAS the only live
/// refresh. Without the explicit emit the «Подключение» list would show a stale order/lead-card
/// after an A→B switch until some other event refreshed it. The self-notify replaces exactly the
/// echo PP-5 swallows; PP-5 suppression is UNCHANGED for every other writer (which self-refetch).
#[tauri::command]
pub fn set_last_used(app: tauri::AppHandle, id: String) -> Result<(), String> {
    use tauri::Emitter;
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
    // F5: self-notify the FE. The write above armed the PP-5 window, so the watcher will SKIP its
    // `configs-changed` echo for this write; this explicit emit is the refresh that echo would have
    // driven. `markLastUsed` does not re-fetch, so without it the Connection list keeps a stale
    // lead-card/order. Same event name/payload the watcher uses → useConfigMutations' listener runs
    // its silent `refresh()`. Best-effort like every emit here; a dropped emit is a UI-freshness
    // nicety, never a correctness gate (D-29: no config content crosses — the FE re-reads via
    // list_configs which carries no password).
    app.emit("configs-changed", ()).ok();
    // PA-4 (17-07): return Ok(()) — the FE discarded the list and re-invoked list_configs.
    Ok(())
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
///
/// F5 (17-review): takes `app` to EXPLICITLY emit `configs-changed` after the write — same reason as
/// `set_last_used`. Its FE caller (`persistOrder` in AutoModeSettings) is optimistic-local to the
/// Settings tab and does NOT re-fetch; with IN-49's tab-switch backstop gone, the PP-5-suppressed
/// echo was the only path that refreshed the «Подключение» list, so a reorder on «Авто-режим» left
/// «Подключение» showing the stale order indefinitely. The self-notify replaces that echo.
#[tauri::command]
pub fn reorder_configs(app: tauri::AppHandle, ids: Vec<String>) -> Result<(), String> {
    use tauri::Emitter;
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
    // F5: self-notify the FE (see the doc comment). The PP-5 window this write armed suppresses the
    // watcher echo; `persistOrder` does not re-fetch, so this explicit emit is what refreshes the
    // «Подключение» list to the new order. Same event/payload as the watcher → the FE listener runs
    // its silent `refresh()`. Best-effort; D-29: no config content crosses.
    app.emit("configs-changed", ()).ok();
    // PA-4 (17-07): return Ok(()) — the FE discarded the list and re-invoked list_configs.
    Ok(())
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

    /// Phase 19 UAT (folder-as-truth): adopt_orphans_in_dir ADOPTS a valid config .toml that is in
    /// the folder but NOT in the manifest (the protocol-deploy / file-browse orphan class), skips a
    /// non-config .toml, and leaves an already-tracked config untouched (dedup by path).
    #[test]
    fn adopt_orphans_picks_up_untracked_configs_only() {
        let tmp = tempdir();
        // a.toml is tracked; b.toml is a valid UNTRACKED orphan; junk.toml is not a config.
        let a = write_toml(&tmp, "a.toml", &endpoint_config(Some("Alpha")));
        let b = write_toml(&tmp, "b.toml", &endpoint_config(Some("Beta")));
        std::fs::write(tmp.join("junk.toml"), b"not = \"a config\"\n").unwrap();
        let mut manifest = Manifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            configs: vec![ConfigEntry {
                id: "alpha".into(),
                name: "Alpha".into(),
                path: a.to_string_lossy().to_string(),
                order: 0,
                last_used: true,
                copy: false,
            }],
        };
        let adopted = adopt_orphans_in_dir(&tmp, &mut manifest);
        assert!(adopted, "an untracked valid config must be adopted");
        assert_eq!(manifest.configs.len(), 2, "only b.toml is adopted (junk skipped)");
        assert!(
            manifest.configs.iter().any(|e| e.path == b.to_string_lossy()),
            "the untracked orphan b.toml is now tracked",
        );
        assert!(
            !manifest.configs.iter().any(|e| e.path.ends_with("junk.toml")),
            "a non-config .toml is never adopted",
        );
        // Idempotent: a second pass adopts nothing (both are now tracked).
        assert!(!adopt_orphans_in_dir(&tmp, &mut manifest), "second pass adopts nothing");
        cleanup(&tmp);
    }

    /// Phase 19 UAT (folder-as-truth): reconcile_folder_with_manifest makes the on-disk configs.json
    /// mirror the folder both ways — it ADOPTS an orphan and PRUNES an entry whose file is gone.
    #[test]
    fn reconcile_adopts_orphans_and_prunes_missing() {
        let tmp = tempdir();
        let present = write_toml(&tmp, "present.toml", &endpoint_config(Some("Present")));
        let orphan = write_toml(&tmp, "orphan.toml", &endpoint_config(Some("Orphan")));
        // Manifest tracks `present` (real) + `ghost` (file never created → must be pruned).
        let manifest = Manifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            configs: vec![
                ConfigEntry { id: "present".into(), name: "Present".into(), path: present.to_string_lossy().to_string(), order: 0, last_used: true, copy: false },
                ConfigEntry { id: "ghost".into(), name: "Ghost".into(), path: tmp.join("ghost.toml").to_string_lossy().to_string(), order: 1, last_used: false, copy: false },
            ],
        };
        write_manifest_atomic(&tmp, &manifest).unwrap();
        reconcile_folder_with_manifest(&tmp);
        let back = read_manifest(&tmp).unwrap();
        assert!(back.configs.iter().any(|e| e.path == present.to_string_lossy()), "present stays");
        assert!(back.configs.iter().any(|e| e.path == orphan.to_string_lossy()), "orphan adopted");
        assert!(!back.configs.iter().any(|e| e.id == "ghost"), "missing-file entry pruned");
        assert_eq!(back.configs.len(), 2, "present + adopted orphan, ghost gone");
        cleanup(&tmp);
    }

    /// Phase 19 UAT (#3 unified filename): the content-derived import stem gets the SAME
    /// «[<CC>_]TrustTunnel_<slug>» country prefix every other add-path uses when a country is supplied.
    #[test]
    fn import_stem_prefixes_country_when_provided() {
        let cfg = "[endpoint]\nhostname = \"h\"\nusername = \"alice\"\naddresses = [\"1.2.3.4:443\"]\n";
        assert_eq!(import_stem_from_content(cfg, Some("de")), "DE_TrustTunnel_alice");
        assert_eq!(import_stem_from_content(cfg, None), "TrustTunnel_alice");
        // Junk / non-2-letter country → no prefix (mirrors client_config_filename / buildConfigFileName).
        assert_eq!(import_stem_from_content(cfg, Some("Germany")), "TrustTunnel_alice");
        assert_eq!(import_stem_from_content(cfg, Some("D")), "TrustTunnel_alice");
        assert_eq!(import_stem_from_content(cfg, Some("")), "TrustTunnel_alice");
    }

    /// Phase 19 UAT (#3): the GeoIP host for an import prefers the real IP in addresses[] over a
    /// self-signed SNI hostname (which GeoIP cannot resolve).
    #[test]
    fn geoip_host_prefers_addresses_over_sni() {
        let cfg = "[endpoint]\nhostname = \"trusttunnel.local\"\nusername = \"u\"\naddresses = [\"203.0.113.200:443\"]\n";
        assert_eq!(geoip_host_from_content(cfg).as_deref(), Some("203.0.113.200"));
        let no_addr = "[endpoint]\nhostname = \"vpn.example.com\"\nusername = \"u\"\n";
        assert_eq!(geoip_host_from_content(no_addr).as_deref(), Some("vpn.example.com"));
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
                copy: false,
            }],
        };
        // A stray leftover .tmp from a hypothetical crashed write must not be read as the
        // manifest — only configs.json is ever read.
        //
        // T-23-04: it is no longer OVERWRITTEN either. Temp names are unique per call now (a shared
        // temp let two concurrent writers splice their bytes into one published file), so an orphan
        // simply stays put, inert. What matters is unchanged and asserted below: the round-trip is
        // exact, and this call's own temp is consumed by its rename.
        std::fs::write(tmp.join(MANIFEST_TMP_FILENAME), b"GARBAGE-PARTIAL").unwrap();
        write_manifest_atomic(&tmp, &m).unwrap();
        let back = read_manifest(&tmp).unwrap();
        assert_eq!(m, back, "write_manifest_atomic then read_manifest round-trips");
        let live_temps: Vec<_> = std::fs::read_dir(&tmp)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|f| {
                f.starts_with(MANIFEST_FILENAME) && f.ends_with(".tmp") && f != MANIFEST_TMP_FILENAME
            })
            .collect();
        assert!(
            live_temps.is_empty(),
            "the temp this call created is consumed by the rename, found: {live_temps:?}"
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
                    copy: false,
                },
                ConfigEntry {
                    id: id_from_path(&b),
                    name: "Beta".into(),
                    path: b.to_string_lossy().to_string(),
                    order: 1,
                    last_used: false,
                    copy: false,
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
                copy: false,
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
                copy: false,
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

    /// Truth (WR-03 / D-29 / T-13-SEC-01): the NOTIFICATION PAYLOAD path resolves the config
    /// DISPLAY NAME only — never the `.toml` password. `notify::maybe_fire` builds the plate payload
    /// as `{ kind, config_name: current_display_name(&path) }`; the pure decider is string-free
    /// (covered by notify::d29_no_secret_in_notify_payload_or_log), but the one string the emit path
    /// touches is `current_display_name`, and no test previously locked that it returns the display
    /// name and NEVER the password. This is that lock, mirroring the SUPER-SECRET fixture discipline
    /// the notify.rs module docstring cites.
    #[test]
    fn d29_notify_payload_display_name_never_leaks_the_password() {
        let tmp = tempdir();
        // A distinctive sentinel a leak would surface (mirrors ping.rs / the manifest D-29 fixture).
        let secret = "SUPER-SECRET-NOTIFY-PAYLOAD-XYZ";
        let p = write_toml(
            &tmp,
            "TrustTunnel_user.toml",
            &sample_config(Some("Германия"), "de1.example.com", "swift-fox", secret),
        );

        // The exact value maybe_fire puts into the `notify-plate` payload's `configName` field.
        let config_name = current_display_name(&p.to_string_lossy());

        // (1) It resolves to the DISPLAY NAME — proving the payload carries the human-readable name.
        assert_eq!(
            config_name.as_deref(),
            Some("Германия"),
            "the notification payload must carry the config display name",
        );
        // (2) And it NEVER contains the endpoint password — the D-29 leak the plate payload guards.
        assert!(
            !config_name.as_deref().unwrap_or_default().contains(secret),
            "the notification payload's configName must never contain the password (WR-03 / D-29)",
        );
        cleanup(&tmp);
    }

    /// Phase 13 (13-08): `username_for_config` returns the endpoint LOGIN — the value the CONNECT
    /// plate shows in its login row — and NEVER the password (D-29). An unreadable path / empty
    /// username yields None so the plate omits the row rather than showing a placeholder.
    #[test]
    fn username_for_config_reads_login_and_never_the_password() {
        let tmp = tempdir();
        let secret = "SUPER-SECRET-LOGIN-XYZ";
        let p = write_toml(
            &tmp,
            "TrustTunnel_user.toml",
            &sample_config(Some("Германия"), "de1.example.com", "ivan_petrov", secret),
        );
        let path = p.to_string_lossy().to_string();

        // (1) It resolves the endpoint username.
        assert_eq!(
            username_for_config(&path).as_deref(),
            Some("ivan_petrov"),
            "the plate login row must carry the endpoint username",
        );
        // (2) It NEVER carries the password — the D-29 leak the login row guards.
        assert!(
            !username_for_config(&path).as_deref().unwrap_or_default().contains(secret),
            "the plate login must never contain the password (D-29)",
        );
        // (3) An unreadable path yields None (the plate omits the row).
        assert!(username_for_config("Z:/does/not/exist.toml").is_none());
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
                    copy: false,
                },
                ConfigEntry {
                    id: "b".into(),
                    name: "B".into(),
                    path: tmp.join("b.toml").to_string_lossy().to_string(),
                    order: 1,
                    last_used: false,
                    copy: false,
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
            copy: false,
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
                copy: false,
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
                    copy: false,
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
            copy: false,
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
                    copy: false,
                },
                ConfigEntry {
                    id: "present".into(),
                    name: "Россия".into(),
                    path: present.to_string_lossy().to_string(),
                    order: 5,
                    last_used: true,
                    copy: false,
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
                copy: false,
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
                    copy: false,
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

    // ─── B6 (16-UAT round 2): migration twin dedup + delete identity-sweep ───

    /// B6 fix #6: a FRESH migration of two same-identity twin files (legacy
    /// `trusttunnel_client.toml` + branded `TrustTunnel_<user>.toml`, same host+user) tracks BOTH
    /// as manifest entries (path-dedup only — the identity-skip is REVERTED). Rationale: the old
    /// skip left the losing twin UNTRACKED on disk (a residual password-bearing `.toml` that could
    /// never be deleted in-app). Tracking both is coherent: the display collapses the pair to one
    /// card (`dedupeConfigsByIdentity`) and the delete identity-sweep removes both files. Migration
    /// still NEVER deletes a file (P11-02).
    #[test]
    fn migrate_tracks_both_same_identity_twins_deletes_nothing() {
        let tmp = tempdir();
        // Two files, same host+user (a migration twin). Different names/content otherwise.
        let legacy = write_toml(
            &tmp,
            "trusttunnel_client.toml",
            &sample_config(Some("Россия"), "ru1.example.com", "swift-fox", "SECRET-A"),
        );
        let branded = write_toml(
            &tmp,
            "TrustTunnel_swift-fox.toml",
            &sample_config(Some("Россия"), "ru1.example.com", "swift-fox", "SECRET-A"),
        );

        let manifest = migrate_to_manifest(&tmp, None).expect("migration ok");

        // BOTH twin files are tracked (path-dedup only — no identity collapse at migration).
        assert_eq!(
            manifest.configs.len(),
            2,
            "both same-identity twins must be TRACKED (fix #6 — no untracked orphan)"
        );
        // NEVER delete a file during migration (P11-02) — both twin files still on disk.
        assert!(legacy.is_file(), "migration must not delete the legacy twin file");
        assert!(branded.is_file(), "migration must not delete the branded twin file");
        // Both tracked entries point at the two twin paths.
        let paths: Vec<&str> = manifest.configs.iter().map(|c| c.path.as_str()).collect();
        assert!(paths.contains(&legacy.to_string_lossy().as_ref()));
        assert!(paths.contains(&branded.to_string_lossy().as_ref()));
        cleanup(&tmp);
    }

    /// B6 fix #6 (the untracked-orphan scenario end-to-end): a fresh migration of the twin pair
    /// tracks both, and DELETING the (display-winner) card then removes BOTH files via the identity
    /// sweep — because both are tracked, the sweep reaches the twin. No residual `.toml` is left.
    #[test]
    fn migrate_then_delete_removes_both_twin_files_no_orphan() {
        let tmp = tempdir();
        let legacy = write_toml(
            &tmp,
            "trusttunnel_client.toml",
            &sample_config(Some("Россия"), "ru1.example.com", "swift-fox", "SECRET-A"),
        );
        let branded = write_toml(
            &tmp,
            "TrustTunnel_swift-fox.toml",
            &sample_config(Some("Россия"), "ru1.example.com", "swift-fox", "SECRET-A"),
        );
        let manifest = migrate_to_manifest(&tmp, None).expect("migration ok");
        assert_eq!(manifest.configs.len(), 2, "both twins tracked");

        // Delete via the first entry's id — the identity-sweep must take the sibling twin too.
        let target_id = manifest.configs[0].id.clone();
        delete_config_in_dir(&tmp, &target_id).expect("delete sweeps the identity");
        assert!(!legacy.exists(), "legacy twin file must be removed by the sweep");
        assert!(!branded.exists(), "branded twin file must be removed by the sweep");
        let after = read_manifest(&tmp).unwrap();
        assert!(
            after.configs.is_empty(),
            "no orphan entry (and no untracked residual file) remains after delete"
        );
        cleanup(&tmp);
    }

    /// B6 SOURCE: a DELIBERATE copy (a `copy: true` entry, or a legacy «(копия)» / `-copy` /
    /// `-<n>` suffixed one) has the same (host,user) as its original but is never collapsed by the
    /// delete sweep — it is its own card. Fix #6: migration itself no longer collapses, so both the
    /// original and the copy are tracked after migration (the display collapses the non-copy twin
    /// only).
    #[test]
    fn migrate_keeps_deliberate_copy_as_its_own_entry() {
        let tmp = tempdir();
        write_toml(
            &tmp,
            "TrustTunnel_swift-fox.toml",
            &sample_config(Some("Россия"), "ru1.example.com", "swift-fox", "SECRET-A"),
        );
        // A deliberate duplicate: same identity, copy-suffixed filename.
        write_toml(
            &tmp,
            "TrustTunnel_swift-fox-copy.toml",
            &sample_config(Some("Россия (копия)"), "ru1.example.com", "swift-fox", "SECRET-A"),
        );

        let manifest = migrate_to_manifest(&tmp, None).expect("migration ok");
        assert_eq!(
            manifest.configs.len(),
            2,
            "both files are tracked after migration (fix #6 — no identity collapse at migration)"
        );
        cleanup(&tmp);
    }

    /// B6 DELETE: deleting a card whose server has a migration twin (same host+user) must remove
    /// BOTH twin files + BOTH manifest entries — not just the one the card's id points at (else the
    /// orphan twin reappears on reload).
    #[test]
    fn delete_sweeps_all_same_identity_twins() {
        let tmp = tempdir();
        let a = write_toml(
            &tmp,
            "trusttunnel_client.toml",
            &sample_config(Some("Россия"), "ru1.example.com", "swift-fox", "SECRET-A"),
        );
        let b = write_toml(
            &tmp,
            "TrustTunnel_swift-fox.toml",
            &sample_config(Some("Россия"), "ru1.example.com", "swift-fox", "SECRET-A"),
        );
        write_manifest_atomic(
            &tmp,
            &Manifest {
                schema_version: MANIFEST_SCHEMA_VERSION,
                configs: vec![
                    ConfigEntry { id: "twin-a".into(), name: "Россия".into(), path: a.to_string_lossy().to_string(), order: 0, last_used: true, copy: false },
                    ConfigEntry { id: "twin-b".into(), name: "Россия".into(), path: b.to_string_lossy().to_string(), order: 1, last_used: false, copy: false },
                ],
            },
        )
        .unwrap();

        // Delete via the card's winner id (twin-a). The sweep must take twin-b too.
        delete_config_in_dir(&tmp, "twin-a").expect("delete sweeps the identity");
        assert!(!a.exists(), "twin A file must be removed");
        assert!(!b.exists(), "twin B file must be removed (the sweep)");
        let after = read_manifest(&tmp).unwrap();
        assert!(after.configs.is_empty(), "both twin entries must be gone (no orphan reappears)");
        cleanup(&tmp);
    }

    /// B6 DELETE: the sweep must PRESERVE a deliberate «(копия)» sibling (same host+user but a
    /// copy-suffixed name). Deleting the server card removes its migration twin pair but leaves the
    /// copy the user chose to keep (its own card).
    #[test]
    fn delete_sweep_preserves_deliberate_copy_sibling() {
        let tmp = tempdir();
        let original = write_toml(
            &tmp,
            "TrustTunnel_swift-fox.toml",
            &sample_config(Some("Россия"), "ru1.example.com", "swift-fox", "SECRET-A"),
        );
        let twin = write_toml(
            &tmp,
            "trusttunnel_client.toml",
            &sample_config(Some("Россия"), "ru1.example.com", "swift-fox", "SECRET-A"),
        );
        let copy = write_toml(
            &tmp,
            "TrustTunnel_swift-fox-copy.toml",
            &sample_config(Some("Россия (копия)"), "ru1.example.com", "swift-fox", "SECRET-A"),
        );
        write_manifest_atomic(
            &tmp,
            &Manifest {
                schema_version: MANIFEST_SCHEMA_VERSION,
                configs: vec![
                    ConfigEntry { id: "orig".into(), name: "Россия".into(), path: original.to_string_lossy().to_string(), order: 0, last_used: true, copy: false },
                    ConfigEntry { id: "twin".into(), name: "Россия".into(), path: twin.to_string_lossy().to_string(), order: 1, last_used: false, copy: false },
                    ConfigEntry { id: "copy".into(), name: "Россия (копия)".into(), path: copy.to_string_lossy().to_string(), order: 2, last_used: false, copy: true },
                ],
            },
        )
        .unwrap();

        delete_config_in_dir(&tmp, "orig").expect("delete sweeps twins, keeps the copy");
        assert!(!original.exists(), "the original must be removed");
        assert!(!twin.exists(), "the migration twin must be swept");
        assert!(copy.exists(), "the deliberate copy must be PRESERVED (its own card)");
        let after = read_manifest(&tmp).unwrap();
        assert_eq!(after.configs.len(), 1, "only the copy entry remains");
        assert_eq!(after.configs[0].id, "copy");
        cleanup(&tmp);
    }

    // ─── B6 fix #5 (DATA-LOSS): the identity-sweep must spare a deliberately-kept copy ───

    /// fix #5(a): a NUMBERED copy label «<base> (копия 2)» (from `next_copy_name`) does NOT contain
    /// the literal "(копия)", so the OLD name check missed it → the sweep deleted it. The
    /// `copy_base_name`-based heuristic now recognises the numbered form; the durable flag covers it
    /// regardless. Deleting the sibling server card must PRESERVE the «(копия 2)» copy.
    #[test]
    fn delete_sweep_preserves_numbered_kopiya_copy() {
        let tmp = tempdir();
        let original = write_toml(
            &tmp,
            "TrustTunnel_swift-fox.toml",
            &sample_config(Some("Россия"), "ru1.example.com", "swift-fox", "SECRET-A"),
        );
        // A second numbered copy «(копия 2)» — no literal "(копия)" substring in that exact form.
        let copy2 = write_toml(
            &tmp,
            "TrustTunnel_swift-fox-copy-2.toml",
            &sample_config(Some("Россия (копия 2)"), "ru1.example.com", "swift-fox", "SECRET-A"),
        );
        write_manifest_atomic(
            &tmp,
            &Manifest {
                schema_version: MANIFEST_SCHEMA_VERSION,
                configs: vec![
                    ConfigEntry { id: "orig".into(), name: "Россия".into(), path: original.to_string_lossy().to_string(), order: 0, last_used: true, copy: false },
                    // No durable flag on this entry (legacy manifest) — the NAME heuristic must catch «(копия 2)».
                    ConfigEntry { id: "copy2".into(), name: "Россия (копия 2)".into(), path: copy2.to_string_lossy().to_string(), order: 1, last_used: false, copy: false },
                ],
            },
        )
        .unwrap();

        delete_config_in_dir(&tmp, "orig").expect("delete sweeps the server, keeps the copy");
        assert!(!original.exists(), "the original server must be removed");
        assert!(copy2.exists(), "the «(копия 2)» copy must be PRESERVED (data-loss fix #5)");
        let after = read_manifest(&tmp).unwrap();
        assert_eq!(after.configs.len(), 1, "only the copy remains");
        assert_eq!(after.configs[0].id, "copy2");
        cleanup(&tmp);
    }

    /// fix #5(b): a copy created via `duplicate_config` (durable `copy: true`) that the user then
    /// RENAMED — stripping the «(копия)» name marker AND with no copy filename suffix — must STILL
    /// be spared by the sweep. Only the durable flag can save it here (name + filename heuristics
    /// both miss). This is the pure data-loss hole the flag closes.
    #[test]
    fn delete_sweep_preserves_renamed_flagged_copy() {
        let tmp = tempdir();
        let original = write_toml(
            &tmp,
            "TrustTunnel_swift-fox.toml",
            &sample_config(Some("Россия"), "ru1.example.com", "swift-fox", "SECRET-A"),
        );
        // A copy the user RENAMED to a plain name, stored under a filename with NO copy suffix
        // (worst case: neither the name nor the filename heuristic can flag it).
        let renamed_copy = write_toml(
            &tmp,
            "TrustTunnel_swift-fox-backup.toml",
            &sample_config(Some("Мой запасной"), "ru1.example.com", "swift-fox", "SECRET-A"),
        );
        write_manifest_atomic(
            &tmp,
            &Manifest {
                schema_version: MANIFEST_SCHEMA_VERSION,
                configs: vec![
                    ConfigEntry { id: "orig".into(), name: "Россия".into(), path: original.to_string_lossy().to_string(), order: 0, last_used: true, copy: false },
                    // Durable flag set at creation; name/filename markers are gone → only the flag saves it.
                    ConfigEntry { id: "renamed".into(), name: "Мой запасной".into(), path: renamed_copy.to_string_lossy().to_string(), order: 1, last_used: false, copy: true },
                ],
            },
        )
        .unwrap();

        delete_config_in_dir(&tmp, "orig").expect("delete sweeps the server, keeps the flagged copy");
        assert!(!original.exists(), "the original server must be removed");
        assert!(
            renamed_copy.exists(),
            "a renamed, no-suffix copy with the durable flag must be PRESERVED (data-loss fix #5)"
        );
        let after = read_manifest(&tmp).unwrap();
        assert_eq!(after.configs.len(), 1, "only the flagged copy remains");
        assert_eq!(after.configs[0].id, "renamed");
        cleanup(&tmp);
    }

    /// fix #5(c): an import same-server auto-copy (`append_config_to_manifest_named`, durable
    /// `copy: true`) that kept the ORIGINAL filename (no `-copy`/`-<n>` suffix) must be spared by
    /// the sweep — the durable flag covers the filename-heuristic hole.
    #[test]
    fn delete_sweep_preserves_import_autocopy_with_original_filename() {
        let tmp = tempdir();
        let original = write_toml(
            &tmp,
            "TrustTunnel_swift-fox.toml",
            &sample_config(Some("Россия"), "ru1.example.com", "swift-fox", "SECRET-A"),
        );
        // The import auto-copy landed under a branded filename that carries NO copy suffix.
        let import_copy = write_toml(
            &tmp,
            "RU_TrustTunnel_swift-fox.toml",
            &sample_config(Some("Россия (копия)"), "ru1.example.com", "swift-fox", "SECRET-A"),
        );
        write_manifest_atomic(
            &tmp,
            &Manifest {
                schema_version: MANIFEST_SCHEMA_VERSION,
                configs: vec![
                    ConfigEntry { id: "orig".into(), name: "Россия".into(), path: original.to_string_lossy().to_string(), order: 0, last_used: true, copy: false },
                    ConfigEntry { id: "imported".into(), name: "Россия (копия)".into(), path: import_copy.to_string_lossy().to_string(), order: 1, last_used: false, copy: true },
                ],
            },
        )
        .unwrap();

        delete_config_in_dir(&tmp, "orig").expect("delete sweeps the server, keeps the import copy");
        assert!(!original.exists(), "the original server must be removed");
        assert!(import_copy.exists(), "the import auto-copy must be PRESERVED (data-loss fix #5)");
        cleanup(&tmp);
    }

    /// fix #5(d): the counter-case — a genuine migration twin (same host+user, NO durable flag, NO
    /// «(копия)» marker, NO copy filename suffix) IS still swept. The fix must not over-protect.
    #[test]
    fn delete_sweep_still_removes_a_genuine_twin() {
        let tmp = tempdir();
        let original = write_toml(
            &tmp,
            "TrustTunnel_swift-fox.toml",
            &sample_config(Some("Россия"), "ru1.example.com", "swift-fox", "SECRET-A"),
        );
        let twin = write_toml(
            &tmp,
            "trusttunnel_client.toml",
            &sample_config(Some("Россия"), "ru1.example.com", "swift-fox", "SECRET-A"),
        );
        write_manifest_atomic(
            &tmp,
            &Manifest {
                schema_version: MANIFEST_SCHEMA_VERSION,
                configs: vec![
                    ConfigEntry { id: "orig".into(), name: "Россия".into(), path: original.to_string_lossy().to_string(), order: 0, last_used: true, copy: false },
                    ConfigEntry { id: "twin".into(), name: "Россия".into(), path: twin.to_string_lossy().to_string(), order: 1, last_used: false, copy: false },
                ],
            },
        )
        .unwrap();

        delete_config_in_dir(&tmp, "orig").expect("delete sweeps the genuine twin");
        assert!(!original.exists(), "the original must be removed");
        assert!(!twin.exists(), "a genuine non-copy twin MUST still be swept (no over-protection)");
        let after = read_manifest(&tmp).unwrap();
        assert!(after.configs.is_empty(), "both non-copy twin entries are gone");
        cleanup(&tmp);
    }

    /// fix #5 unit: `is_deliberate_copy` recognises the numbered «(копия 2)» label and honours the
    /// durable flag first, while a bare non-copy name/path is not flagged.
    #[test]
    fn is_deliberate_copy_covers_numbered_label_and_flag() {
        // Durable flag wins regardless of name/path.
        assert!(is_deliberate_copy(true, "Мой запасной", "C:/app/TrustTunnel_swift-fox-backup.toml"));
        // Numbered «(копия 2)» label (the old .contains("(копия)") missed this).
        assert!(is_deliberate_copy(false, "Россия (копия 2)", "C:/app/whatever.toml"));
        // Plain «(копия)» label still flagged.
        assert!(is_deliberate_copy(false, "Россия (копия)", "C:/app/whatever.toml"));
        // Filename `-copy` suffix still flagged.
        assert!(is_deliberate_copy(false, "Россия", "C:/app/TrustTunnel_swift-fox-copy.toml"));
        // A genuine twin: no flag, no label marker, no suffix → NOT a copy.
        assert!(!is_deliberate_copy(false, "Россия", "C:/app/trusttunnel_client.toml"));
    }

    /// B6 DELETE + WR-03: the orphan-on-failure safety survives inside the identity-sweep path — if
    /// the DELETED card's file cannot be removed, its entry is RE-INSERTED (never orphaned) and the
    /// delete surfaces an error. (Cross-platform, the only way to force a deterministic remove_file
    /// failure is to point the path at a directory — which cannot be identity-read, so we target it
    /// directly: the target is always in the delete set regardless of identity. This exercises the
    /// re-insertion branch of the new sweep code, the WR-03 contract.)
    #[test]
    fn delete_sweep_keeps_entry_when_the_target_file_delete_fails() {
        let tmp = tempdir();
        // A directory standing in for an unremovable config file (remove_file on a dir errors
        // non-NotFound on every platform — the same trick the WR-03 single-delete test uses).
        let dir_as_path = tmp.join("trusttunnel_client.toml");
        std::fs::create_dir(&dir_as_path).unwrap();
        // A readable same-name-server sibling that would be swept — but must NOT be touched because
        // the target's file failed to delete (we re-insert + fail before any sibling is affected...
        // and the target here has no readable identity, so the sibling is not in the set at all).
        let sibling = write_toml(
            &tmp,
            "TrustTunnel_swift-fox.toml",
            &sample_config(Some("Россия"), "ru1.example.com", "swift-fox", "SECRET-A"),
        );
        write_manifest_atomic(
            &tmp,
            &Manifest {
                schema_version: MANIFEST_SCHEMA_VERSION,
                configs: vec![
                    ConfigEntry { id: "locked".into(), name: "Россия".into(), path: dir_as_path.to_string_lossy().to_string(), order: 0, last_used: true, copy: false },
                    ConfigEntry { id: "sibling".into(), name: "Россия".into(), path: sibling.to_string_lossy().to_string(), order: 1, last_used: false, copy: false },
                ],
            },
        )
        .unwrap();

        let result = delete_config_in_dir(&tmp, "locked");
        assert!(result.is_err(), "delete must surface the error when the target file cannot be removed");
        // The unremovable file must STILL be tracked (no orphaned password-bearing file).
        assert!(dir_as_path.is_dir(), "the unremovable path must still exist");
        let after = read_manifest(&tmp).unwrap();
        assert!(
            after.configs.iter().any(|c| c.id == "locked"),
            "the entry for the file we could not remove must be re-inserted (no orphan)"
        );
        // The readable sibling was untouched (the failed target has no identity, so no sweep).
        assert!(sibling.exists(), "an unrelated sibling must not be swept when the target fails");
        cleanup(&tmp);
    }

    /// Truth (IN-01): repeated last-used switches keep orders dense (0..n), never climbing
    /// monotonically. Replicates the NEW set_last_used transform and asserts the order set
    /// is exactly {0,1,...,n-1} after each switch, with the selected config at 0.
    #[test]
    fn set_last_used_keeps_orders_dense() {
        let mut configs = vec![
            ConfigEntry { id: "a".into(), name: "A".into(), path: "a".into(), order: 0, last_used: true, copy: false },
            ConfigEntry { id: "b".into(), name: "B".into(), path: "b".into(), order: 1, last_used: false, copy: false },
            ConfigEntry { id: "c".into(), name: "C".into(), path: "c".into(), order: 2, last_used: false, copy: false },
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

    /// F5 (17-review) — SELF-NOTIFY CONTRACT. `set_last_used` and `reorder_configs` MUST explicitly
    /// emit `configs-changed` after their write, because the PP-5 window their atomic write arms
    /// suppresses the fs-watcher echo AND their FE callers (`markLastUsed`, `persistOrder`) are
    /// fire-and-forget with no list re-fetch, with IN-49's tab-switch reload backstop gone — so the
    /// suppressed echo was the ONLY live refresh. A real emit needs a Tauri runtime + data dir (the
    /// same reason the reorder tests use in-memory transforms — line ~2766), so we assert the
    /// contract at the SOURCE level: each command takes `app: tauri::AppHandle` and, inside its body,
    /// calls `app.emit("configs-changed", ())`. A future edit dropping either the param or the emit
    /// (re-stranding the Connection list — the F5 regression) fails this test. Mirrors the existing
    /// D-29 source-discipline spy shape (`..._never_logs_the_password_d29`).
    #[test]
    fn f5_set_last_used_and_reorder_self_emit_configs_changed() {
        let src = include_str!("manifest.rs");

        // Extract a function's body slice: from its `pub fn <name>(` to the start of the NEXT
        // `#[tauri::command]` (both commands are the last two commands before the tests module, and
        // each is immediately followed by another `#[tauri::command]` or the tests boundary).
        fn body_after<'a>(src: &'a str, sig_needle: &str) -> &'a str {
            let start = src.find(sig_needle).unwrap_or_else(|| {
                panic!("expected to find `{sig_needle}` — did the signature change?")
            });
            let rest = &src[start..];
            // Cut at the next command attribute (or the tests module) so we scan only THIS body.
            let end = rest[sig_needle.len()..]
                .find("#[tauri::command]")
                .or_else(|| rest.find("mod tests"))
                .map(|i| i + sig_needle.len())
                .unwrap_or(rest.len());
            &rest[..end]
        }

        for sig in [
            "pub fn set_last_used(app: tauri::AppHandle, id: String)",
            "pub fn reorder_configs(app: tauri::AppHandle, ids: Vec<String>)",
        ] {
            let body = body_after(src, sig);
            assert!(
                body.contains("app.emit(\"configs-changed\", ())"),
                "F5: `{sig}` must self-emit `configs-changed` after its write (PP-5 swallows the \
                 watcher echo and the FE caller does not re-fetch)"
            );
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

    // ─── 16-07 (gap 5a): display_host derivation + dedup/identity regression ──────────

    /// A config `.toml` carrying an explicit `[endpoint].addresses` list — the round-3 gap-5a
    /// shape (a bare-IP endpoint with a fake TLS-SNI `hostname`). Carries a password so D-29
    /// (never read the password) still holds through the new display path.
    fn config_with_addresses(hostname: &str, user: &str, addresses: &[&str]) -> String {
        let addr_list = addresses
            .iter()
            .map(|a| format!("\"{a}\""))
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            "# TrustTunnel Client Configuration\n\
             loglevel = \"info\"\n\n\
             [endpoint]\n\
             hostname = \"{hostname}\"\n\
             username = \"{user}\"\n\
             password = \"s3cret-never-displayed\"\n\
             addresses = [{addr_list}]\n\n\
             [listener.tun]\n\
             mtu_size = 1280\n"
        )
    }

    /// Truth (gap 5a): a fake SNI hostname over a bare-IP addresses[0] → host stays the raw
    /// hostname (dedup key), display_host is the real IP (drives the FE «IP» glyph).
    #[test]
    fn derive_display_host_prefers_ip_over_fake_sni() {
        assert_eq!(
            derive_display_host("trusttunnel.local", Some("203.0.113.141:443")),
            "203.0.113.141"
        );
    }

    /// Truth: an EMPTY hostname + a bare-IP addresses[0] → the IP.
    #[test]
    fn derive_display_host_empty_hostname_uses_ip() {
        assert_eq!(derive_display_host("", Some("203.0.113.7:443")), "203.0.113.7");
    }

    /// Truth: a REAL domain hostname wins over the address (globe preserved) — the domain is
    /// never replaced by its resolved IP.
    #[test]
    fn derive_display_host_real_domain_wins() {
        assert_eq!(
            derive_display_host("vpn.example.com", Some("1.2.3.4:443")),
            "vpn.example.com"
        );
    }

    // ─── TA-7: legacy SOCKS → TUN migration (was a manual-only UAT step, now automated) ──
    //
    // UAT Test 2 («старый SOCKS-конфиг авто-конвертируется в рабочий TUN при загрузке») was skipped
    // for lack of a legacy artifact — but it is a pure deterministic load-time transform needing no
    // live server. This drives a REAL legacy `[listener.socks]` `.toml` through the actual normalize
    // path (`config::normalize_config_socks_to_tun`, the fn wired into the startup sweep
    // `normalize_all_configs_to_tun`), writes the result, and summarizes it — asserting the outcome
    // is a full-tunnel TUN config with the endpoint + credentials preserved verbatim.

    /// A realistic LEGACY client config that declares ONLY the removed `[listener.socks]` mode.
    /// Carries endpoint host/user/password so the test can assert they survive the conversion.
    fn legacy_socks_config() -> String {
        "# TrustTunnel Client Configuration (legacy SOCKS build)\n\
         loglevel = \"info\"\n\
         vpn_mode = \"general\"\n\
         killswitch_enabled = true\n\n\
         [endpoint]\n\
         hostname = \"de1.example.com\"\n\
         username = \"swift-fox\"\n\
         password = \"legacy-SOCKS-secret\"\n\n\
         [listener.socks]\n\
         bind_address = \"127.0.0.1\"\n\
         bind_port = 1080\n"
            .to_string()
    }

    #[test]
    fn legacy_socks_config_normalizes_to_full_tunnel_tun_preserving_endpoint_and_creds() {
        let tmp = tempdir();

        // 1. A real legacy SOCKS `.toml` on disk.
        let original = legacy_socks_config();
        let path = write_toml(&tmp, "TrustTunnel_swift-fox.toml", &original);

        // 2. The manifest-load normalize step (the same fn the startup sweep runs) rewrites it.
        let raw = std::fs::read_to_string(&path).expect("read legacy config");
        let normalized = crate::commands::config::normalize_config_socks_to_tun(&raw)
            .expect("a config with [listener.socks] MUST be normalized (Some)");
        std::fs::write(&path, &normalized).expect("write normalized config");

        // 3a. The rewritten TOML is a FULL-TUNNEL TUN config — no SOCKS listener remains, and the
        //     synthesized tun block routes everything (0.0.0.0/0).
        let doc: toml::Value = toml::from_str(&normalized).expect("normalized config is valid TOML");
        let listener = doc.get("listener").and_then(|l| l.as_table()).expect("[listener] present");
        assert!(listener.get("socks").is_none(), "the SOCKS listener must be gone:\n{normalized}");
        let tun = listener.get("tun").and_then(|t| t.as_table()).expect("[listener.tun] synthesized");
        let routes: Vec<&str> = tun
            .get("included_routes")
            .and_then(|r| r.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
            .unwrap_or_default();
        assert!(
            routes.contains(&"0.0.0.0/0"),
            "the TUN listener must be a FULL tunnel (0.0.0.0/0):\n{normalized}"
        );

        // 3b. The endpoint + credentials are preserved verbatim through the conversion.
        let ep = doc.get("endpoint").and_then(|e| e.as_table()).expect("[endpoint] preserved");
        assert_eq!(ep.get("hostname").and_then(|v| v.as_str()), Some("de1.example.com"));
        assert_eq!(ep.get("username").and_then(|v| v.as_str()), Some("swift-fox"));
        assert_eq!(
            ep.get("password").and_then(|v| v.as_str()),
            Some("legacy-SOCKS-secret"),
            "the endpoint password must survive the SOCKS→TUN conversion:\n{normalized}"
        );

        // 4. The SUMMARIZE path reads the now-TUN config as a normal card (host/user survive; the
        //    password is never surfaced in the summary — D-29).
        let summary = summarize_unchecked(&path.to_string_lossy()).expect("summarize normalized config");
        assert_eq!(summary.host, "de1.example.com");
        assert_eq!(summary.display_host, "de1.example.com"); // real domain → globe (no IP glyph)
        assert_eq!(summary.user, "swift-fox");

        // 5. Idempotence: a re-run over the already-TUN config is a no-op (None → no disk churn).
        assert!(
            crate::commands::config::normalize_config_socks_to_tun(&normalized).is_none(),
            "a TUN-only config must NOT be rewritten again (idempotent sweep)"
        );

        cleanup(&tmp);
    }

    /// Truth: a hostname that is ALREADY a bare IP → host == display_host == that IP.
    #[test]
    fn derive_display_host_ip_hostname_unchanged() {
        assert_eq!(
            derive_display_host("203.0.113.141", Some("203.0.113.141:443")),
            "203.0.113.141"
        );
    }

    /// Truth: no addresses at all → the hostname is the display value (domain → globe).
    #[test]
    fn derive_display_host_no_addresses_keeps_hostname() {
        assert_eq!(derive_display_host("foo.com", None), "foo.com");
    }

    /// Truth: a bracketed IPv6 addresses[0] with a non-IP hostname → display_host is the
    /// bracketed IPv6 literal (kept bracketed, matching host_from_addr).
    #[test]
    fn derive_display_host_bracketed_ipv6() {
        assert_eq!(
            derive_display_host("trusttunnel.local", Some("[2001:db8::1]:443")),
            "[2001:db8::1]"
        );
    }

    /// Truth: summarize_unchecked fills host with the RAW hostname (unchanged) AND display_host
    /// with the IP for the gap-5a shape.
    #[test]
    fn summarize_sets_display_host_ip_for_fake_sni_over_ip() {
        let tmp = tempdir();
        let p = write_toml(
            &tmp,
            "cfg.toml",
            &config_with_addresses("trusttunnel.local", "u", &["203.0.113.141:443"]),
        );
        let s = summarize_unchecked(&p.to_string_lossy()).expect("summary");
        assert_eq!(s.host, "trusttunnel.local", "host stays the RAW dedup key");
        assert_eq!(s.display_host, "203.0.113.141", "display_host is the real IP");
        cleanup(&tmp);
    }

    /// Truth: a real-domain config keeps host == display_host == the domain (globe preserved).
    #[test]
    fn summarize_sets_display_host_domain_for_real_domain() {
        let tmp = tempdir();
        let p = write_toml(
            &tmp,
            "cfg.toml",
            &config_with_addresses("vpn.example.com", "u", &["1.2.3.4:443"]),
        );
        let s = summarize_unchecked(&p.to_string_lossy()).expect("summary");
        assert_eq!(s.host, "vpn.example.com");
        assert_eq!(s.display_host, "vpn.example.com");
        cleanup(&tmp);
    }

    /// REGRESSION (gap 5a, threat T-16-07-01): adding display_host must NOT re-key dedup/identity.
    /// Two entries with the SAME fake SNI (hostname="trusttunnel.local") + SAME user + SAME IP still
    /// key IDENTICALLY on ("trusttunnel.local","u") — proving identity_key_of and
    /// find_duplicate_by_host_user still read the RAW host, not the IP (no DATA-LOSS re-keying).
    #[test]
    fn dedup_identity_unchanged_after_display_host() {
        let tmp = tempdir();
        let content = config_with_addresses("trusttunnel.local", "u", &["203.0.113.141:443"]);
        let a = write_toml(&tmp, "a.toml", &content);
        let b = write_toml(&tmp, "b.toml", &content);

        // identity_key_of keys off the RAW host + user — NOT the IP display_host.
        let ka = identity_key_of(&a.to_string_lossy()).expect("key a");
        let kb = identity_key_of(&b.to_string_lossy()).expect("key b");
        assert_eq!(ka, kb, "same-SNI+user copies still key identically");
        assert_eq!(
            ka,
            ("trusttunnel.local".to_string(), "u".to_string()),
            "the identity key is the RAW host+user, never the IP"
        );

        // find_duplicate_by_host_user still matches on the RAW host, not the IP display value.
        let manifest = Manifest {
            configs: vec![ConfigEntry {
                id: "id-a".to_string(),
                name: "A".to_string(),
                path: a.to_string_lossy().to_string(),
                order: 0,
                last_used: false,
                copy: false,
            }],
            ..Default::default()
        };
        write_manifest_atomic(&tmp, &manifest).unwrap();
        assert!(
            find_duplicate_by_host_user(&tmp, "trusttunnel.local", "u").is_some(),
            "dup match still keys on the RAW host (trusttunnel.local), not the IP"
        );
        assert!(
            find_duplicate_by_host_user(&tmp, "203.0.113.141", "u").is_none(),
            "the IP is NOT the dedup key — it must not match"
        );
        cleanup(&tmp);
    }

    // ─── Phase 17 (17-03) — PP-1 `atomic_write` crash-safety + D-29 spy (GREEN) ─────────────
    //
    // Landed by 17-03: 17-01 wrote these as `wave0_red`-gated RED (the symbol `atomic_write`
    // did not exist yet); 17-03 extracted `atomic_write` from `write_manifest_atomic`'s
    // temp→write_all→sync_all→rename body (+ PP-3 parent-dir fsync) and DELETED the gate so they
    // now run under default `cargo test --lib` and pass.

    /// T-23-04: two writers racing on the SAME destination must never publish a mixture.
    ///
    /// This is the defect the unique temp name fixes. With one shared `<name>.tmp`, both writers
    /// opened it, interleaved their `write_all`s into one file, and whichever renamed second
    /// published a byte-wise splice of two generations. For a group cache that means an unparseable
    /// file that fails the whole routing resolve; for a config `.toml` it means a spliced
    /// password-bearing file — worse than either write simply losing.
    ///
    /// The assertion is the invariant, not the mechanism: the destination must equal ONE of the two
    /// payloads exactly. Last-writer-wins is fine and expected; a mixture is not. The payloads are
    /// large and byte-distinct so an interleave cannot accidentally equal either one.
    ///
    /// Verified to FAIL against the shared-temp version — this is not a test that would have passed
    /// either way.
    #[test]
    fn concurrent_writers_never_publish_a_spliced_file() {
        let dir = tempdir();
        let name = "contested.toml";
        let a = vec![b'A'; 512 * 1024];
        let b = vec![b'B'; 512 * 1024];

        // Several rounds: a single round can serialise by luck on a fast machine.
        for _ in 0..8 {
            let (d1, d2) = (dir.clone(), dir.clone());
            let (a1, b1) = (a.clone(), b.clone());
            let h1 = std::thread::spawn(move || atomic_write(&d1, name, &a1));
            let h2 = std::thread::spawn(move || atomic_write(&d2, name, &b1));
            h1.join().unwrap().expect("writer A must succeed");
            h2.join().unwrap().expect("writer B must succeed");

            let published = std::fs::read(dir.join(name)).unwrap();
            assert!(
                published == a || published == b,
                "the published file must be exactly one generation, got {} bytes starting {:?}",
                published.len(),
                &published[..published.len().min(8)]
            );
        }

        cleanup(&dir);
    }

    /// GREEN (17-03): the generic `atomic_write(dir, name, bytes)` is crash-safe — a stray temp from
    /// a hypothetical crashed write is never read as data, and the final file equals the bytes
    /// exactly. Mirrors the existing `manifest_atomic_roundtrip` GARBAGE-PARTIAL shape, but for an
    /// arbitrary `.toml` payload (every password-bearing config writer routes through this).
    ///
    /// T-23-04: the assertion moved from "no `<name>.tmp` survives" to "the DESTINATION is exactly
    /// the bytes, and the temp this call created is consumed". Temp names are now unique per call,
    /// so a pre-existing orphan is no longer overwritten — it is simply irrelevant, because nothing
    /// ever reads a temp. Pinning the old literal name would pin the shared-temp bug that made two
    /// concurrent writers splice their bytes into one published file.
    #[test]
    fn wave0_pp1_atomic_write_is_crash_safe() {
        let tmp = tempdir();
        let name = "client.toml";
        let bytes = b"[endpoint]\nhostname = \"de.example.com\"\n";

        // Simulate a crashed prior write leaving a partial temp beside the target.
        std::fs::write(tmp.join(format!("{name}.tmp")), b"GARBAGE-PARTIAL").unwrap();

        atomic_write(&tmp, name, bytes).unwrap();

        let back = std::fs::read(tmp.join(name)).unwrap();
        assert_eq!(back, bytes, "atomic_write writes the exact bytes to <name>");
        // The temp THIS call created is gone (consumed by the rename): no `<name>.<pid>.<n>.tmp`
        // sibling is left behind. The pre-seeded orphan is expected to survive and is inert.
        let live_temps: Vec<_> = std::fs::read_dir(&tmp)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|f| f.starts_with(&format!("{name}.")) && f.ends_with(".tmp") && f != &format!("{name}.tmp"))
            .collect();
        assert!(
            live_temps.is_empty(),
            "the temp this call created must be consumed by the rename, found: {live_temps:?}"
        );
        cleanup(&tmp);
    }

    /// F9 (17-review): the PP-3 parent-dir fsync path must EXECUTE and still let the write succeed
    /// on Windows — the old `File::open(dir)` was denied (ERROR_ACCESS_DENIED) so the branch was dead
    /// here; the backup-semantics open now actually opens the dir handle. This test proves the whole
    /// write (including the dir-fsync leg) completes and lands the file — a regression to the plain
    /// dir open would still pass (the fsync is best-effort/swallowed), but building this path under
    /// `#[cfg(windows)]` guards the compile + documents the intended durability leg. On non-Windows
    /// the same `atomic_write` call exercises the Unix `File::open(dir)` fsync branch.
    #[test]
    fn f9_parent_dir_fsync_path_runs_and_write_succeeds() {
        let tmp = tempdir();
        let name = "durable.toml";
        let bytes = b"[endpoint]\nhostname = \"de.example.com\"\n";
        atomic_write(&tmp, name, bytes).unwrap();
        let back = std::fs::read(tmp.join(name)).unwrap();
        assert_eq!(back, bytes, "write completes through the parent-dir fsync leg and lands the file");
        cleanup(&tmp);
    }

    /// F14 (17-review): a FAILED `atomic_write` must not strand its `<name>.tmp` — that temp holds a
    /// partial, password-bearing config (D-29), so leaving it on disk until the next successful save
    /// is both a data-hygiene and a secret-lingering hazard. We force the terminal `rename` to fail
    /// deterministically by making the final path an existing NON-EMPTY directory (a file→dir rename
    /// over a non-empty dir fails on every platform). The write then errors AND cleans up its temp.
    #[test]
    fn f14_failed_atomic_write_removes_the_partial_temp() {
        let tmp = tempdir();
        let name = "client.toml";
        // Make `<dir>/client.toml` an existing non-empty directory so `rename(tmp, final)` cannot
        // succeed — the failure leg that must still remove `client.toml.tmp`.
        let final_as_dir = tmp.join(name);
        std::fs::create_dir(&final_as_dir).unwrap();
        std::fs::write(final_as_dir.join("blocker"), b"x").unwrap();

        let result = atomic_write(&tmp, name, b"[endpoint]\npassword = \"leak-me\"\n");
        assert!(result.is_err(), "rename over a non-empty dir must fail the write");
        assert!(
            !tmp.join(format!("{name}.tmp")).exists(),
            "F14: the partial `<name>.tmp` must be removed on the rename-failure path (no lingering secret)"
        );
        cleanup(&tmp);
    }

    /// GREEN (17-03) — D-29 spy: driving `atomic_write` on password-bearing `.toml`
    /// content never leaks the password into a log line. The writer path must emit ONLY the
    /// destination path / neutral tokens, NEVER the file content. Reuses the ping D-29 spy
    /// shape — this is a source-level guard (like `import_log_discipline_d29`): read this
    /// file's own source and assert no log macro on the atomic-write path interpolates the
    /// content. The literal secret token is NOT written into any comment (comment-text
    /// discipline, T-17-01). The runtime half asserts the final on-disk bytes are the content
    /// verbatim (the writer neither drops nor logs them).
    #[test]
    fn wave0_pp1_atomic_write_never_logs_the_password_d29() {
        let tmp = tempdir();
        // A distinctive password token; a leak would surface it in a log sink.
        let secret = concat!("SUPER-", "SECRET-", "PP1");
        let content = format!(
            "[endpoint]\nhostname = \"de.example.com\"\nusername = \"swift-fox\"\npassword = \"{secret}\"\n"
        );
        assert!(content.contains(secret), "fixture must carry the secret, else the spy is vacuous");

        atomic_write(&tmp, "client.toml", content.as_bytes()).unwrap();

        // The bytes land verbatim (the writer does not mangle or drop the content)…
        let back = std::fs::read_to_string(tmp.join("client.toml")).unwrap();
        assert!(back.contains(secret), "the content is written verbatim to disk");

        // …and the writer's own source never interpolates the content into a log macro
        // (D-29): no `eprintln!`/`println!`/log line on the atomic-write path may reference
        // `content`/`bytes`/`password`. This is the same static-source discipline the deeplink
        // import path is guarded by. `atomic_write` lives in this module, so grep this source.
        let src = include_str!("manifest.rs");
        for line in src.lines() {
            let l = line.trim();
            let is_log = l.starts_with("eprintln!")
                || l.starts_with("println!")
                || l.starts_with("log::")
                || l.contains("emit_log");
            if is_log {
                assert!(
                    !l.contains("{content}") && !l.contains("{bytes}") && !l.contains("password"),
                    "D-29: a writer log line must never interpolate config content/password: {l}"
                );
            }
        }
        cleanup(&tmp);
    }

    // ─── PP-4: (mtime, len) summarize cache ──────────────────────────────────

    /// PP-4: a first `summarize_cached` parses + caches; a second call on an UNCHANGED file returns
    /// the SAME result from the cache. We prove the cache is actually consulted by mutating the file
    /// content on disk WITHOUT changing its (mtime, len) can't be forced portably, so instead we
    /// prove the positive: after clearing the cache a changed file re-parses, and an unchanged file
    /// keeps serving the prior parse until its stamp changes.
    #[test]
    fn pp4_summarize_cache_reuses_parse_until_the_file_stamp_changes() {
        clear_summarize_cache();
        let tmp = tempdir();
        let path = write_toml(&tmp, "TrustTunnel_cache.toml", &sample_config(Some("First"), "h.win", "u1", "pw1"));
        let path_s = path.to_string_lossy().to_string();

        // First call: cold cache → parses "First".
        let a = summarize_cached(&path_s).unwrap();
        assert_eq!(a.name, "First");

        // Overwrite with DIFFERENT content AND a different length (name len differs) so the stamp
        // changes; the cache must invalidate and re-parse the new name.
        std::fs::write(&path, sample_config(Some("Second-longer-name"), "h.win", "u2", "pw2")).unwrap();
        // Some filesystems have coarse mtime granularity; the length change alone flips the stamp
        // (FileStamp compares BOTH mtime and len), so this is deterministic regardless of clock res.
        let b = summarize_cached(&path_s).unwrap();
        assert_eq!(b.name, "Second-longer-name", "a changed stamp must re-parse, not serve the stale cache");
        assert_eq!(b.user, "u2");

        // Third call, no change since `b`: same stamp → the cache serves the parsed `b` verbatim.
        let c = summarize_cached(&path_s).unwrap();
        assert_eq!(c, b, "an unchanged file returns the cached parse");

        clear_summarize_cache();
        cleanup(&tmp);
    }

    /// PP-4: an un-stat-able / missing path falls through to a direct parse error (never a cache
    /// hit, never a panic) — the cache is a pure accelerator, not a correctness dependency.
    #[test]
    fn pp4_missing_file_bypasses_cache_and_errors_like_the_uncached_reader() {
        clear_summarize_cache();
        let tmp = tempdir();
        let missing = tmp.join("does_not_exist.toml");
        let r = summarize_cached(&missing.to_string_lossy());
        assert!(r.is_err(), "a missing file errors (no cache entry, no panic)");
        cleanup(&tmp);
    }

    // ─── PP-5: self-echo suppression window ──────────────────────────────────

    /// PP-5: the self-echo window arms on an in-app write and re-enables the echo once elapsed /
    /// unarmed. Both directions live in ONE test so the shared static isn't raced by a sibling
    /// PP-5 test running in parallel; window-expiry uses a forced past instant, not a real sleep
    /// (a sleep-based check is flaky under the shared static — a parallel write could re-arm it).
    ///
    /// This mutex serializes access to the shared `LAST_EXPECTED_WRITE` across the (single) test
    /// that forces it, so even future PP-5 tests can lock it and never race each other. `atomic_write`
    /// (called by OTHER write tests) only ever ARMS the window — it can shorten a "not suppressed"
    /// assertion's validity, so we assert the armed direction FIRST (monotonic: arming can only make
    /// `within_self_echo_window` true), then the forced-expiry direction which we control absolutely.
    #[test]
    fn pp5_self_echo_window_arms_and_expires() {
        // Armed direction: a real in-app write opens the window; immediately after we are inside it.
        let tmp = tempdir();
        atomic_write(&tmp, "probe.toml", b"x = 1\n").unwrap();
        assert!(
            within_self_echo_window(),
            "right after an in-app atomic write we are inside the self-echo window (echo suppressed)"
        );
        cleanup(&tmp);

        // Expired direction: force the last write far into the past → treated as external → emit.
        force_last_expected_write(Some(Instant::now() - (SELF_ECHO_SUPPRESS + Duration::from_secs(1))));
        assert!(
            !within_self_echo_window(),
            "an expired window is treated as an external change (echo emitted)"
        );
    }

    // ─── PP-6: single-watcher active-path registration ───────────────────────

    /// PP-6: watch/unwatch just register/clear the active path that the single data-dir watcher
    /// reads — no second OS watcher. The registration round-trips through the shared state.
    #[test]
    fn pp6_active_config_path_registers_and_clears() {
        set_active_config_path("C:/app/configs/germany.toml".to_string());
        assert_eq!(active_config_path().as_deref(), Some("C:/app/configs/germany.toml"));
        clear_active_config_path();
        assert_eq!(active_config_path(), None, "unwatch clears the active path (watcher stops emitting)");
    }
}
