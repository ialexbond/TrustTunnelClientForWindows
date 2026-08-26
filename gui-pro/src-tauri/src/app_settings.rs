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

    /// 27 D-06 — the «Авто-режим» master toggle, as the Rust connectivity monitor sees it.
    ///
    /// Lives here rather than in `localStorage` because the failover monitor runs with no window
    /// open, possibly before any webview has mounted this session — the exact unreachability this
    /// module's header names. `localStorage` stays the UI-facing store and mirrors into this file
    /// on every write (`useAppSettings`), so the two never disagree for longer than one IPC hop.
    ///
    /// Default **OFF**, the opposite polarity from `geodata_auto_update` above — see the `Default`
    /// impl for why.
    #[serde(default)]
    pub failover_enabled: bool,

    /// 27 D-08 — config ids the user has opted OUT of the failover queue (`ConfigEntry.id`, which
    /// is stable across renames; never a path and never a display name).
    ///
    /// An exclusion set rather than an inclusion set so a newly added server participates by
    /// default: the alternative silently leaves every new config out of the queue until the user
    /// finds the switch. Ids carry no secret — they already cross the IPC boundary via the config
    /// commands (D-29).
    ///
    /// Never validated against the manifest on read (T-28-04). The set is only ever *matched
    /// against* the config list when the queue is built, so an id naming a config that no longer
    /// exists simply matches nothing. Validating here would mean deleting a config could silently
    /// re-enrol a server the user had opted out of, if that config ever came back.
    #[serde(default)]
    pub failover_excluded_ids: Vec<String>,

    /// The user's autostart CHOICE — did they ask the app to start with Windows?
    ///
    /// Owner bug (2026-08-26, «Запуск вместе с системой не работает»): until this field existed,
    /// the ONLY record of the choice was the `HKCU\...\CurrentVersion\Run` registry value itself —
    /// and Tauri's NSIS uninstaller deletes exactly that value whenever it runs outside update
    /// mode (a version-upgrade install, a full uninstall→reinstall, or the «Удалить перед
    /// установкой» radio on a same-version reinstall). Registry forensics on a real Windows install
    /// showed the wipe signature precisely: the `StartupApproved\Run` companion values the plugin
    /// writes were still present and «enabled», while the `Run` values were gone. The user's
    /// choice silently evaporated with them; nothing ever re-asserted it, so the app just stopped
    /// starting with Windows and the switch read OFF again.
    ///
    /// `Option`, not `bool`: `None` means «the user never touched the switch», and the startup
    /// reconcile (`autostart::reconcile_autostart_on_startup`) must do NOTHING in that case —
    /// inventing either polarity would flip a setting the user never expressed an opinion on.
    /// Fails to `None` on absent/corrupt files for the same reason (a third failure direction
    /// next to geodata's fail-open and failover's fail-closed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub autostart_enabled: Option<bool>,
}

fn default_true() -> bool {
    true
}

// Hand-written, NOT `#[derive(Default)]`: the derived impl would give `false` for a bool field and
// silently invert the required default-ON semantics (D-13). This impl is what `load_app_settings`
// falls back to on every read error, so getting it wrong would ship the feature switched off.
//
// The two families deliberately fail in OPPOSITE directions, which is the thing to be careful about
// when extending this impl:
//   - `geodata_auto_update` fails OPEN (absent/corrupt → ON). A missed background download is
//     harmless, and defaulting OFF would have shipped the feature dead for every existing install.
//   - `failover_*` fails CLOSED (absent/corrupt → OFF, nothing excluded). The frontend default has
//     always been OFF (`APP_SETTINGS_DEFAULTS.masterOn`), and a fresh or hand-corrupted install that
//     started switching servers on its own — changing the user's exit country without being asked —
//     is a behaviour nobody asked for. A truncated file must never resolve to an accidental ON.
impl Default for AppSettings {
    fn default() -> Self {
        Self {
            geodata_auto_update: true,
            failover_enabled: false,
            failover_excluded_ids: Vec::new(),
            // No opinion until the user flips the switch — see the field doc for why this must
            // not be a bool (the startup reconcile keys off «never touched» vs «asked for ON»).
            autostart_enabled: None,
        }
    }
}

/// The failover half of `AppSettings`, as it crosses the IPC boundary.
///
/// A separate struct rather than handing the whole `AppSettings` to the frontend: the geodata
/// toggle already has its own command pair, and widening this one to carry it would give the
/// Settings screen two ways to write the same field.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FailoverSettings {
    pub enabled: bool,
    pub excluded_ids: Vec<String>,
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

/// Read the failover master toggle and the per-server opt-out set (27 D-06/D-08).
///
/// Bound by the «Авто-режим» settings section, and — the reason this file is the transport — read
/// by the connectivity monitor from a background task with no window open.
#[tauri::command]
pub fn get_failover_settings() -> FailoverSettings {
    let settings = load_app_settings();
    FailoverSettings {
        enabled: settings.failover_enabled,
        excluded_ids: settings.failover_excluded_ids,
    }
}

/// Write the failover master toggle and the opt-out set (27 D-06/D-08).
///
/// Both fields move together because the frontend owns them as one unit: `useAppSettings` mirrors
/// its whole failover view on every write, so a split pair would just be two chances to half-apply
/// a change. `excluded_ids` REPLACES the stored set rather than merging into it — un-ticking the
/// last opted-out server has to actually empty it.
#[tauri::command]
pub fn set_failover_settings(enabled: bool, excluded_ids: Vec<String>) -> Result<(), String> {
    set_failover_settings_at(&app_settings_path(), enabled, excluded_ids)
}

/// Drop every failover exclusion whose config no longer exists, given the ids that DO.
///
/// The exclusion set is keyed by config id and lives in `app_settings.json`, i.e. OUTSIDE the
/// manifest — so deleting a config leaves its id behind. `failover_queue` already treats an unknown
/// id as inert, which is why this never produced a visible queue bug, but the stale entry is not
/// harmless: config ids are derived from the file path (`id_from_path`), so re-importing the same
/// config to the same path resurrects the SAME id — and it would come back silently excluded, with a
/// «Порядок переключения» row switched off that the user never switched off. This makes deletion
/// mean deletion.
///
/// Takes the live ids rather than reading the manifest itself: the caller already holds the manifest
/// funnel lock, so a read from in here would be both redundant and a lock-ordering hazard.
///
/// Best-effort by design. Failing to prune costs a stale entry in a set that ignores it — never a
/// reason to fail a delete that already succeeded on disk.
pub fn prune_failover_exclusions(live_ids: &[String]) -> Result<(), String> {
    prune_failover_exclusions_at(&app_settings_path(), live_ids)
}

/// Path-parameterised leg of `prune_failover_exclusions`, so the test drives the real
/// read-modify-write against a temp file instead of the live data dir.
fn prune_failover_exclusions_at(path: &Path, live_ids: &[String]) -> Result<(), String> {
    let settings = load_app_settings_from(path);
    let kept: Vec<String> = settings
        .failover_excluded_ids
        .iter()
        .filter(|id| live_ids.contains(id))
        .cloned()
        .collect();
    // Nothing stale — and, more importantly, NO WRITE. This runs after every delete, and rewriting
    // an unchanged file would arm the PP-5 self-echo window for no reason at all.
    if kept.len() == settings.failover_excluded_ids.len() {
        return Ok(());
    }
    set_failover_settings_at(path, settings.failover_enabled, kept)
}

/// Path-parameterised write leg, so the serialization can be exercised against a temp file.
///
/// Load-mutate-save under `SETTINGS_WRITE`, exactly like `set_geodata_auto_update_at`. This is the
/// point at which WR-05's guarantee stops being hypothetical: `AppSettings` now genuinely has two
/// settings families with two independent writers, so a write-whole-struct writer here would drop
/// the geodata toggle on every failover change (and vice versa).
fn set_failover_settings_at(
    path: &Path,
    enabled: bool,
    excluded_ids: Vec<String>,
) -> Result<(), String> {
    // Poisoned-lock handling matches the geodata writer: the mutex guards `()`, not an invariant of
    // its own, so a previous panic inside the section says nothing about the file. Failing here
    // instead would permanently break the toggle for the rest of the session.
    let _write_guard = SETTINGS_WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let mut settings = load_app_settings_from(path);
    settings.failover_enabled = enabled;
    settings.failover_excluded_ids = excluded_ids;
    save_app_settings_to(path, &settings)
}

/// Persist the user's autostart choice (owner bug 2026-08-26 — see the field doc).
///
/// NOT a `#[tauri::command]`: the frontend never writes the choice directly. It goes through
/// `autostart::set_autostart`, which changes the registry FIRST and records the choice only after
/// the registry write succeeded — persisting a choice the OS refused would make the startup
/// reconcile re-assert a state the user never actually reached.
pub fn set_autostart_choice(enabled: bool) -> Result<(), String> {
    set_autostart_choice_at(&app_settings_path(), enabled)
}

/// Path-parameterised write leg, so the serialization can be exercised against a temp file.
/// Load-mutate-save under `SETTINGS_WRITE`, exactly like the two writers above — this is the third
/// settings family in the file, so the WR-05 lock is what keeps it from clobbering the other two.
fn set_autostart_choice_at(path: &Path, enabled: bool) -> Result<(), String> {
    // Poisoned-lock handling matches the other writers: the mutex guards `()`, not an invariant of
    // its own, so a previous panic inside the section says nothing about the file.
    let _write_guard = SETTINGS_WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let mut settings = load_app_settings_from(path);
    settings.autostart_enabled = Some(enabled);
    save_app_settings_to(path, &settings)
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
                ..Default::default()
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

    // ─── Phase 28 (27 D-06): the failover transport ────────────────────────────────────────────
    //
    // These assert the OPPOSITE polarity from the geodata cases above, and the difference is the
    // whole point: geodata fails OPEN (absent/corrupt → ON) because a missed background download is
    // harmless, while failover fails CLOSED (absent/corrupt → OFF) because a fresh or hand-corrupted
    // install that started moving the user between servers on its own would be a behaviour nobody
    // asked for. Both defaults live in the same hand-written `Default`, so they are easy to get
    // backwards — hence one test per direction.

    /// T-28-01: an install that has never written the file must read failover OFF with nothing
    /// excluded. This is the fresh-install case AND the "upgraded from a build that predates the
    /// field" case — every install in the wild today.
    #[test]
    fn failover_reads_off_with_no_exclusions_when_the_file_is_absent() {
        let path = temp_settings_path("failover_absent");
        assert!(!path.exists(), "precondition: the temp file must not exist");
        let settings = load_app_settings_from(&path);
        assert!(
            !settings.failover_enabled,
            "a missing app_settings.json must read failover as OFF, never ON"
        );
        assert!(
            settings.failover_excluded_ids.is_empty(),
            "a missing app_settings.json must read an empty exclusion set"
        );
    }

    /// T-28-01: a truncated / hand-edited file must resolve to OFF, not to an error and never to an
    /// accidental ON. A power loss mid-write is the realistic producer of this state.
    #[test]
    fn failover_reads_off_when_the_file_is_corrupt() {
        let path = temp_settings_path("failover_corrupt");
        std::fs::write(&path, b"{\"failover_enabled\": tr").unwrap();
        let settings = load_app_settings_from(&path);
        let _ = std::fs::remove_file(&path);
        assert!(
            !settings.failover_enabled,
            "a corrupt app_settings.json must read failover as OFF (fail closed)"
        );
        assert!(
            settings.failover_excluded_ids.is_empty(),
            "a corrupt app_settings.json must read an empty exclusion set"
        );
    }

    /// Every install that exists today carries a file with `geodata_auto_update` and nothing else.
    /// It must still parse — `#[serde(default)]` on the new fields is what makes that true, and
    /// without it the whole file would fail to decode and silently revert the user's geodata choice.
    #[test]
    fn a_file_carrying_only_geodata_auto_update_parses_with_failover_defaults() {
        let path = temp_settings_path("failover_legacy");
        std::fs::write(&path, br#"{"geodata_auto_update": false}"#).unwrap();
        let settings = load_app_settings_from(&path);
        let _ = std::fs::remove_file(&path);
        assert!(
            !settings.geodata_auto_update,
            "the legacy field must still be honoured, not reset by the new ones"
        );
        assert!(!settings.failover_enabled, "the new field must take its default");
        assert!(
            settings.failover_excluded_ids.is_empty(),
            "the new list must take its default"
        );
    }

    /// T-28-02 / WR-05: this is the case the load-mutate-save shape and `SETTINGS_WRITE` exist for.
    /// Two settings families now have two writers; a write-whole-struct writer would drop the other
    /// family's value on every save.
    #[test]
    fn writing_either_settings_family_leaves_the_other_intact() {
        let path = temp_settings_path("failover_no_clobber");
        set_geodata_auto_update_at(&path, false).expect("the geodata write must succeed");

        set_failover_settings_at(&path, true, vec!["id-a".to_string()])
            .expect("the failover write must succeed");
        let after_failover = load_app_settings_from(&path);
        assert!(
            !after_failover.geodata_auto_update,
            "writing failover must not clobber geodata_auto_update"
        );
        assert!(after_failover.failover_enabled, "the failover write must persist");
        assert_eq!(after_failover.failover_excluded_ids, vec!["id-a".to_string()]);

        set_geodata_auto_update_at(&path, true).expect("the second geodata write must succeed");
        let after_geodata = load_app_settings_from(&path);
        let _ = std::fs::remove_file(&path);
        assert!(after_geodata.geodata_auto_update, "the geodata write must persist");
        assert!(
            after_geodata.failover_enabled,
            "writing geodata must not clobber failover_enabled"
        );
        assert_eq!(
            after_geodata.failover_excluded_ids,
            vec!["id-a".to_string()],
            "writing geodata must not clobber the exclusion set"
        );
    }

    /// Deleting a config must take its failover exclusion with it.
    ///
    /// The exclusion set lives outside the manifest, so nothing removed the id when the config went
    /// away. `failover_queue` ignores an unknown id, which is why no queue ever misbehaved — but ids
    /// are derived from the file path, so re-importing the same config to the same path brings back
    /// the SAME id, and it would return silently excluded: a row switched off that the user never
    /// switched off. That is the failure this guards.
    #[test]
    fn pruning_drops_exclusions_for_configs_that_no_longer_exist() {
        let dir = std::env::temp_dir().join(format!(
            "tt-prune-{}-{}",
            std::process::id(),
            line!()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("app_settings.json");

        set_failover_settings_at(
            &path,
            true,
            vec!["gone".to_string(), "kept".to_string()],
        )
        .unwrap();

        prune_failover_exclusions_at(&path, &["kept".to_string(), "other".to_string()]).unwrap();

        let after = load_app_settings_from(&path);
        assert_eq!(
            after.failover_excluded_ids,
            vec!["kept".to_string()],
            "an exclusion whose config is gone must not survive the delete"
        );
        // The unrelated setting rides along untouched — pruning rewrites the file, so this proves it
        // rewrites only the field it owns.
        assert!(after.failover_enabled, "pruning must not disturb the master toggle");

        // Idempotent, and a no-op run must not rewrite the file: this is called after EVERY delete,
        // and a pointless write would arm the PP-5 self-echo window for nothing.
        let before_mtime = std::fs::metadata(&path).unwrap().modified().unwrap();
        prune_failover_exclusions_at(&path, &["kept".to_string()]).unwrap();
        let after_mtime = std::fs::metadata(&path).unwrap().modified().unwrap();
        assert_eq!(
            before_mtime, after_mtime,
            "a prune with nothing stale must not write the file at all"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// T-28-04: an id naming a config that no longer exists is INERT, not an error. The set is only
    /// ever matched against the manifest when the failover queue is built (plan 28-02), so an
    /// unmatched id simply never matches. Rejecting it on read would mean deleting a config could
    /// silently re-enrol a server the user had opted out of.
    #[test]
    fn an_excluded_id_that_matches_no_config_round_trips_instead_of_erroring() {
        let path = temp_settings_path("failover_unknown_id");
        set_failover_settings_at(&path, true, vec!["ghost-config-id".to_string()])
            .expect("an unknown id must not make the write fail");
        let settings = load_app_settings_from(&path);
        let _ = std::fs::remove_file(&path);
        assert_eq!(
            settings.failover_excluded_ids,
            vec!["ghost-config-id".to_string()],
            "an id matching no config must be preserved verbatim"
        );
    }

    // ─── Owner bug 2026-08-26: the autostart CHOICE (see the `autostart_enabled` field doc) ─────

    /// The «never touched» state must survive every read path: absent file, corrupt file, and a
    /// legacy file written before the field existed. `Some(anything)` here would make the startup
    /// reconcile act on an opinion the user never expressed.
    #[test]
    fn the_autostart_choice_reads_none_for_absent_corrupt_and_legacy_files() {
        let absent = temp_settings_path("autostart_absent");
        assert!(!absent.exists(), "precondition: the temp file must not exist");
        assert_eq!(load_app_settings_from(&absent).autostart_enabled, None);

        let corrupt = temp_settings_path("autostart_corrupt");
        std::fs::write(&corrupt, b"{ nope").unwrap();
        let from_corrupt = load_app_settings_from(&corrupt).autostart_enabled;
        let _ = std::fs::remove_file(&corrupt);
        assert_eq!(from_corrupt, None);

        let legacy = temp_settings_path("autostart_legacy");
        std::fs::write(&legacy, br#"{"geodata_auto_update": false}"#).unwrap();
        let from_legacy = load_app_settings_from(&legacy).autostart_enabled;
        let _ = std::fs::remove_file(&legacy);
        assert_eq!(from_legacy, None, "a pre-field file must read as «never touched»");
    }

    /// The choice round-trips BOTH polarities — an explicit OFF is as much a choice as an ON, and
    /// the reconcile treats `Some(false)` («asked to not autostart») differently from `None`.
    #[test]
    fn the_autostart_choice_round_trips_both_polarities() {
        let path = temp_settings_path("autostart_roundtrip");
        set_autostart_choice_at(&path, true).expect("the ON write must succeed");
        assert_eq!(load_app_settings_from(&path).autostart_enabled, Some(true));
        set_autostart_choice_at(&path, false).expect("the OFF write must succeed");
        let stored = load_app_settings_from(&path).autostart_enabled;
        let _ = std::fs::remove_file(&path);
        assert_eq!(stored, Some(false), "an explicit OFF must persist, not collapse to None");
    }

    /// WR-05 holds for the third family too: recording the autostart choice must not clobber the
    /// values the other two writers own.
    #[test]
    fn recording_the_autostart_choice_leaves_the_other_families_intact() {
        let path = temp_settings_path("autostart_no_clobber");
        set_geodata_auto_update_at(&path, false).unwrap();
        set_failover_settings_at(&path, true, vec!["id-a".to_string()]).unwrap();

        set_autostart_choice_at(&path, true).expect("the choice write must succeed");
        let settings = load_app_settings_from(&path);
        let _ = std::fs::remove_file(&path);
        assert!(!settings.geodata_auto_update, "geodata must survive the autostart write");
        assert!(settings.failover_enabled, "failover must survive the autostart write");
        assert_eq!(settings.failover_excluded_ids, vec!["id-a".to_string()]);
        assert_eq!(settings.autostart_enabled, Some(true));
    }

    /// The exclusion set is a full replacement, not an append: the UI hands over the complete list
    /// of opted-out servers on every change, so un-ticking the last one must actually empty it.
    #[test]
    fn the_failover_writer_replaces_the_exclusion_set_rather_than_accumulating() {
        let path = temp_settings_path("failover_replace");
        set_failover_settings_at(&path, true, vec!["a".to_string(), "b".to_string()]).unwrap();
        assert_eq!(load_app_settings_from(&path).failover_excluded_ids.len(), 2);

        set_failover_settings_at(&path, false, Vec::new()).unwrap();
        let settings = load_app_settings_from(&path);
        let _ = std::fs::remove_file(&path);
        assert!(!settings.failover_enabled, "OFF must persist over the previous ON");
        assert!(
            settings.failover_excluded_ids.is_empty(),
            "an empty list must clear the set, not leave the previous ids behind"
        );
    }
}
