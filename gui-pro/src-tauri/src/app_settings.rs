//! App-level settings persisted on the Rust side (D-12).
//!
//! Why a new module instead of reusing something existing: before Phase 23 every backend-known
//! setting used one of two ad-hoc mechanisms — a marker FILE next to the exe (`.start_minimized`
//! in `lib.rs`, `.enable_logs` in `logging.rs`) or a runtime mirror pushed from the frontend's
//! `localStorage` (the notifications gate in `lib.rs`). Neither works for the geodata auto-update
//! toggle:
//!
//! - The marker-file mechanism means "file absent = OFF". The toggle must default to **ON**
//!   (D-13), and every existing install lacks the file — so that mechanism would ship the feature
//!   switched off for everybody. An inverted marker (`.geodata_autoupdate_off`) would work but
//!   reads as a trap and does not extend to a second setting.
//! - The localStorage mirror is unreachable from a background task: the scheduler runs with no
//!   window open, possibly before any webview has ever mounted this session.
//!
//! So: one small JSON in `portable_data_dir()`, modelled on `active_groups.json`
//! (`geodata.rs`), holding a struct rather than a single boolean — the next Rust-side setting
//! extends `AppSettings` instead of adding a fourth persistence mechanism.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Settings the Rust side owns and can read with no window open.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    /// D-13 — governs the whole automatic geodata path (check + download + deferred apply).
    /// Default **ON**: a missing file, a missing key, and a corrupt file all resolve to `true`,
    /// so the feature is live on every existing install with no migration step.
    #[serde(default = "default_true")]
    pub geodata_auto_update: bool,
}

fn default_true() -> bool {
    true
}

// Hand-written, NOT `#[derive(Default)]`: the derived impl would give `false` for a bool field and
// silently invert the required default-ON semantics (D-13). This impl is what `load_app_settings`
// falls back to on every read error, so getting it wrong would ship the feature switched off.
impl Default for AppSettings {
    fn default() -> Self {
        Self {
            geodata_auto_update: true,
        }
    }
}

fn app_settings_path() -> PathBuf {
    crate::ssh::portable_data_dir().join("app_settings.json")
}

/// Path-parameterised read leg, so the tests below can exercise the real decode + fallback
/// behaviour against a temp file instead of the live data dir.
fn load_app_settings_from(path: &Path) -> AppSettings {
    match std::fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => AppSettings::default(),
    }
}

/// Read the persisted settings. **Never fails.**
///
/// This deliberately diverges from its structural analog `geodata::load_active_groups`, which
/// surfaces a parse error as `Err`. A default-ON setting must never fail closed: if the file is
/// truncated by a power loss or hand-edited into invalid JSON, the correct answer is "the feature
/// is on", not an error the scheduler would have to interpret.
pub fn load_app_settings() -> AppSettings {
    load_app_settings_from(&app_settings_path())
}

fn save_app_settings_to(path: &Path, settings: &AppSettings) -> Result<(), String> {
    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("Failed to serialize app settings: {e}"))?;
    // D-15: the ONE writer (temp → fsync → rename → parent-dir fsync). A truncate-then-write cut
    // short mid-flight would leave invalid JSON, which `load_app_settings` reads as the default —
    // i.e. it would silently discard the user's choice rather than keeping the previous file.
    crate::commands::manifest::write_bytes_atomic(path, json.as_bytes())
}

/// Read the geodata auto-update toggle (D-12/D-13). Bound by the Settings screen.
#[tauri::command]
pub fn get_geodata_auto_update() -> bool {
    load_app_settings().geodata_auto_update
}

/// Serializes the whole read-modify-write below.
///
/// WR-05: the load-mutate-save shape only delivers its promise ("a future second setting written by
/// another caller is not clobbered") if the read and the write are atomic WITH RESPECT TO EACH
/// OTHER. Without this lock two concurrent callers both read the old struct, each mutates its own
/// field, and the later write drops the earlier one's change — and Tauri commands run on the async
/// runtime, so they genuinely interleave. Today `AppSettings` has one field and one writer, so
/// nothing is lost yet; the doc comment was describing a guarantee the code did not provide, which
/// is exactly the kind of note that stops the next author from adding the lock.
///
/// `std::sync::Mutex` is the right kind here: the critical section is entirely synchronous (a file
/// read, a struct mutation, an atomic file write) and contains no `.await`, so no guard can ever
/// span a suspension point.
static SETTINGS_WRITE: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Write the geodata auto-update toggle (D-12/D-13).
///
/// Load-mutate-save rather than write-whole-struct so a future second setting written by another
/// caller is not clobbered by this one — see `SETTINGS_WRITE` for what makes that actually hold.
#[tauri::command]
pub fn set_geodata_auto_update(enabled: bool) -> Result<(), String> {
    let switched_on = set_geodata_auto_update_at(&app_settings_path(), enabled)?;
    // IN-03: the scheduler is parked in `sleep(24h)`. Switching the toggle OFF already took effect
    // immediately (the loop re-reads it from disk each iteration), but switching it ON did nothing
    // until that sleep expired or the app restarted — a default-ON feature the user just re-enabled
    // sitting idle for a day reads as broken. Wake the loop so it checks now. Only on a genuine
    // OFF→ON transition, so re-saving the same value cannot drive it.
    if switched_on {
        crate::geodata_scheduler::auto_update_wake().notify_waiters();
    }
    Ok(())
}

/// Path-parameterised write leg, so the serialization can be exercised against a temp file.
///
/// Returns whether this write turned the setting ON from OFF. Computed INSIDE the lock, together
/// with the value it is reporting on — reading the previous value outside would be a second
/// unserialized read of the thing WR-05 just serialized.
fn set_geodata_auto_update_at(path: &Path, enabled: bool) -> Result<bool, String> {
    // A poisoned lock still hands back a usable guard: this mutex guards no invariant of its own
    // (it holds `()`), so a previous panic inside the section says nothing about the file. Failing
    // the write here instead would permanently break the toggle for the rest of the session.
    let _write_guard = SETTINGS_WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let mut settings = load_app_settings_from(path);
    let was_enabled = settings.geodata_auto_update;
    settings.geodata_auto_update = enabled;
    save_app_settings_to(path, &settings)?;
    Ok(enabled && !was_enabled)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A unique temp path per test — the settings file lives in the real data dir in production,
    /// which the test suite must never touch.
    fn temp_settings_path(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "tt_app_settings_{tag}_{}.json",
            uuid::Uuid::new_v4().simple()
        ))
    }

    /// D-13 truth: on an install that has never written the file, auto-update reads ON.
    /// This is the whole reason the module exists instead of reusing the marker-file mechanism —
    /// that one answers "absent = OFF" and would have shipped the feature dead for every user.
    #[test]
    fn geodata_auto_update_reads_on_when_the_file_is_absent() {
        let path = temp_settings_path("absent");
        assert!(!path.exists(), "precondition: the temp file must not exist");
        assert!(
            load_app_settings_from(&path).geodata_auto_update,
            "a missing app_settings.json must read as ON (D-13)"
        );
    }

    /// D-13 truth: a corrupt file must not fail closed. A power loss mid-write or a hand-edit can
    /// leave invalid JSON; answering "off" there would silently disable the feature forever with
    /// no user-visible cause.
    #[test]
    fn geodata_auto_update_reads_on_when_the_file_is_corrupt() {
        let path = temp_settings_path("corrupt");
        std::fs::write(&path, b"{ this is not json").unwrap();
        let settings = load_app_settings_from(&path);
        let _ = std::fs::remove_file(&path);
        assert!(
            settings.geodata_auto_update,
            "a corrupt app_settings.json must read as ON, not as an error or OFF (D-13)"
        );
    }

    /// The user's explicit OFF must survive the round trip — otherwise the default-ON fallback
    /// would swallow the one value it must never invent.
    #[test]
    fn an_explicit_off_survives_a_write_then_read_round_trip() {
        let path = temp_settings_path("roundtrip");
        save_app_settings_to(
            &path,
            &AppSettings {
                geodata_auto_update: false,
            },
        )
        .expect("atomic write must succeed in the temp dir");
        let settings = load_app_settings_from(&path);
        let _ = std::fs::remove_file(&path);
        assert!(
            !settings.geodata_auto_update,
            "a persisted OFF must read back as OFF"
        );
    }

    /// WR-05: the read-modify-write is serialized, so concurrent writers cannot interleave into a
    /// lost update.
    ///
    /// The assertion is deliberately about the FILE, not about timing: many threads hammer the same
    /// path, and afterwards it must parse cleanly and hold one of the two written values. An
    /// unserialized load-mutate-save is also an unserialized read-then-`write_bytes_atomic`, so
    /// this is the shape that goes wrong the moment `AppSettings` grows a second field with a
    /// second writer — which the doc comment already promised it would not.
    #[test]
    fn concurrent_writes_do_not_corrupt_or_lose_the_settings_file() {
        let path = temp_settings_path("concurrent");
        let threads: Vec<_> = (0..8)
            .map(|i| {
                let path = path.clone();
                std::thread::spawn(move || set_geodata_auto_update_at(&path, i % 2 == 0))
            })
            .collect();
        for t in threads {
            t.join().expect("no writer may panic").expect("every write must succeed");
        }

        let raw = std::fs::read_to_string(&path).expect("the file must exist after the writes");
        let _ = std::fs::remove_file(&path);
        serde_json::from_str::<AppSettings>(&raw)
            .expect("the file must be whole and parseable, never a half-written interleave");
    }

    /// The serialized writer must still round-trip a value through the real path-parameterised leg
    /// — the lock is not allowed to turn the write into a no-op.
    #[test]
    fn the_serialized_writer_persists_the_value_it_was_given() {
        let path = temp_settings_path("serialized");
        set_geodata_auto_update_at(&path, false).expect("the write must succeed");
        assert!(!load_app_settings_from(&path).geodata_auto_update, "OFF must persist");
        set_geodata_auto_update_at(&path, true).expect("the second write must succeed");
        let back_on = load_app_settings_from(&path).geodata_auto_update;
        let _ = std::fs::remove_file(&path);
        assert!(back_on, "ON must persist over the previous OFF");
    }

    /// IN-03: the writer reports an OFF→ON transition, and ONLY that.
    ///
    /// This flag is what wakes the scheduler out of its 24h sleep, so a false positive turns the
    /// loop into something a user can drive by clicking, and a false negative leaves a re-enabled
    /// default-ON feature idle for a day. The "already ON, saved again" case is the one that
    /// matters — the Settings screen writes on every flip, including redundant ones.
    #[test]
    fn only_an_off_to_on_transition_reports_a_wake() {
        let path = temp_settings_path("transition");

        // A fresh install reads ON (D-13), so writing ON again is not a transition.
        assert!(
            !set_geodata_auto_update_at(&path, true).unwrap(),
            "ON over the default ON is not a transition"
        );
        assert!(
            !set_geodata_auto_update_at(&path, false).unwrap(),
            "switching OFF must never wake the loop"
        );
        assert!(
            !set_geodata_auto_update_at(&path, false).unwrap(),
            "OFF over OFF is not a transition"
        );
        assert!(
            set_geodata_auto_update_at(&path, true).unwrap(),
            "OFF→ON is the one case that wakes the loop"
        );
        assert!(
            !set_geodata_auto_update_at(&path, true).unwrap(),
            "ON over ON must not wake it again"
        );

        let _ = std::fs::remove_file(&path);
    }
}
