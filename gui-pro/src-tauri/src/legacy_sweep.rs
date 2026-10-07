//! What the installer could not remove, found at startup and deleted from the data folder — the
//! six listed names only.
//!
//! # Why the application looks at all, when the installer already tried
//!
//! Three binaries of the previous installation survived a real install
//! (UAT gap G-32-2): `trusttunnel.exe`, `trusttunnel_client.exe` and `wintun.dll`, about 25 MB
//! sitting in the data folder beside the saved configs and passwords. They survived for a
//! reason no ordering inside the installer can reach — they were mapped into memory by the very
//! processes the installer was replacing, and `Delete` on a mapped image fails silently. 32-FIX-07
//! closes the application first, 32-FIX-09 stops the VPN core by process id, and 32-FIX-10 hands
//! whatever still survives to the session manager for the next restart and writes the surviving
//! paths into a marker beside the new binaries. Between them the ordinary case is covered.
//!
//! What none of them covers is a machine that is ALREADY in the failed state — including one
//! that carries no marker at all because its failure predates the marker. One launch
//! later those files are ordinary files: the processes that held them are gone. So this is the one
//! place from which the leftovers are visible at all.
//!
//! # THIS MODULE DELETES THE SIX LISTED NAMES, AND THAT REVERSES A PRODUCT DECISION ON RECORD
//!
//! 2026-09-06, task 0 of plan 32-FIX-11, option `report-only` («Только сообщать в журнал»): the
//! removal was offered — the same closed six-name allow-list, the same parent-folder check and the
//! same compiled disjointness proof this module still uses — and the report was chosen instead.
//! That answer stood until 2026-09-23, when the owner reversed it for `WIN-25` (milestone 3.1.0):
//! on a machine where the 3.0.0 installer could not remove the previous version, ~25 MB of the old
//! program — including its old VPN core — was staying in the data folder forever, next to the
//! saved configs and passwords, until somebody deleted it by hand. Nobody was going to. The
//! allow-list, the parent-folder check and the disjointness proof that made the report-only answer
//! safe to ship are exactly what makes the removal safe to ship now: nothing about WHAT may be
//! touched changed, only whether touching it is allowed.
//! `tests::this_module_removes_only_the_listed_names` is what stands guard over that line now — it
//! reads this file's own source and goes red the moment a removal call appears anywhere outside the
//! two functions the closed list and the marker basename are allowed to reach. Widening what may be
//! removed needs a new product decision, not an edit.
//!
//! # Why an allow-list of binaries and not a deny-list of data
//!
//! The same argument the installer's enumeration makes, and it is not weakened by the module now
//! removing files. The most numerous files in the data folder are the per-server `.toml` configs,
//! and the USER chooses their names — they cannot be enumerated at all. A rule shaped as «leave
//! the data alone» could therefore never be complete, while a rule shaped as «these six binaries
//! and nothing else» is complete by construction. The list is closed, it is the same six the
//! installer enumerates (`tests::the_sweep_and_the_installer_name_the_same_six_binaries`), and it
//! is provably disjoint from every name the application persists
//! (`tests::no_name_in_the_projects_user_data_list_can_ever_be_reported_as_a_leftover`).
//!
//! That shape is also what keeps the log channel safe. This pass walks the folder that holds
//! `ssh_credentials.json`. It never enumerates the directory, never opens a file it is removing,
//! and only ever prints filenames drawn from its own static list — so no value from the credential
//! store can reach `app.log` by any input, which is D-29 holding by construction rather than by
//! care (T-32-11-04).
//!
//! # What it costs on the ordinary machine
//!
//! It runs on every launch, so the clean path has to be cheap: one `exists()` on the marker, six
//! `metadata()` calls in the data folder, and exactly one line in `app.log` saying it looked and
//! found nothing. No directory is enumerated and no file is opened. On a machine with leftovers it
//! costs the same plus one read of a marker file of at most eight short lines, up to six file
//! removals and, once none of the six remains, one removal of the marker itself.
//!
//! The marker is removed LAST, and only once none of the six listed names remains in the data
//! folder (D-24): it is the installer's own record of what survived, and it has not finished its
//! job while one of those six is still sitting there. A name that is busy — held open by something
//! else — is left for the next launch with one log line and no interruption to startup; the marker
//! then waits with it, and both are retried together next time.

use std::path::Path;

/// Basename of the marker `NSIS_HOOK_PREINSTALL` writes when an artifact survives its removal.
///
/// **Pinned from both ends since this plan.** The installer composes it in
/// `!define TT_LEGACY_SURVIVOR_MARKER_BASENAME`, and until now nothing in Rust named it — 32-FIX-10
/// recorded that as a residual in `.planning/WINDOWS.md` rather than leaving it implicit, because
/// the sidecar pid path acquired exactly this defect once (D-07): the two ends drifted, the kill
/// became a no-op, and nothing was watching for months.
/// `tests::the_marker_basename_is_the_one_the_installer_writes` closes it — change either end and
/// the test goes red.
pub(crate) const LEGACY_SURVIVOR_MARKER_BASENAME: &str = ".legacy-survivors.txt";

/// The installed filename of the main binary.
///
/// Composed from the package name rather than typed out, because that is what the installer does
/// too: Tauri's `${MAINBINARYNAME}` is the Cargo bin target's name, which is the package name, and
/// the enumeration spells `$R9\${MAINBINARYNAME}.exe`. A literal here would be a second spelling
/// that a package rename could leave behind — and the product is called «TrustTunnel Client Pro»
/// while the binary is called `trusttunnel`, so a wrong literal would look entirely plausible.
pub(crate) const MAIN_BINARY_NAME: &str = concat!(env!("CARGO_PKG_NAME"), ".exe");

/// The five legacy binaries that have no Rust constant of their own to be sourced from.
///
/// The sixth is the VPN core, which does: `commands::vpn::SIDECAR_IMAGE_NAME`. Use
/// [`legacy_binary_names`] rather than this constant — it is the whole six, in one place, and the
/// contract in `tests` asserts that whole against the installer's enumeration. A second typed copy
/// of any of these names is the drift this file's neighbours record having happened before.
///
/// The two shortcuts and the uninstall registry key the installer also removes are deliberately
/// NOT here: neither is a file in the data folder, so neither can be a leftover of the kind this
/// pass reports.
pub(crate) const LEGACY_BINARY_BASENAMES: &[&str] = &[
    MAIN_BINARY_NAME,
    "vcruntime140.dll",
    "vcruntime140_1.dll",
    "wintun.dll",
    "uninstall.exe",
];

/// The closed six-name allow-list: the five above plus the VPN core from its own constant.
pub(crate) fn legacy_binary_names() -> Vec<&'static str> {
    LEGACY_BINARY_BASENAMES
        .iter()
        .copied()
        .chain(std::iter::once(crate::commands::vpn::SIDECAR_IMAGE_NAME))
        .collect()
}

/// What one launch's look found. Counts and static names only — never a path read out of a file,
/// and never a filename this module did not already know (T-32-11-01).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct LeftoverReport {
    /// The data folder and the running program's folder are one place, so nothing was examined.
    /// That equality is the machine shape this project had BEFORE phase 32, so it is the ordinary
    /// case on an old install and not an exotic one.
    pub refused_same_folder: bool,
    /// Names from the closed list that are really sitting in the data folder right now, with the
    /// bytes each one occupies.
    pub stale: Vec<(&'static str, u64)>,
    /// The installer left a record of a failed removal.
    pub marker_present: bool,
    /// Entries of that record whose basename is on the closed list AND whose folder is the data
    /// folder. Reported by name, from the static list — never as the bytes the file carried.
    pub marker_named: Vec<&'static str>,
    /// Entries on the closed list that point somewhere else. Counted, not named: the record is
    /// written by an elevated installer into a world-readable folder, so it is input and not
    /// instruction, and a path that is not in the data folder is not this pass's business.
    pub marker_elsewhere: usize,
    /// Entries whose basename is on no list of ours — the two shortcuts land here legitimately.
    /// Counted and never named, which is what stops an arbitrary string in that file from reaching
    /// `app.log`.
    pub marker_unrecognised: usize,
    /// The record was present and could not be read. Path-free, like every other reason this
    /// project puts in front of a person (D-29).
    pub marker_error: Option<String>,
    /// Names from the closed list that were removed this launch, with the bytes each one held.
    ///
    /// 03-04 (WIN-25, D-21): the report-only answer of 2026-09-06 was reversed on 2026-09-23. This
    /// is the removal counterpart of `stale`, which stays "what was found" regardless of whether it
    /// could be taken away.
    pub removed: Vec<(&'static str, u64)>,
    /// Names from the closed list that were found but could not be removed right now — held open by
    /// something else. Retried at the next launch (D-24); never a reason to stop startup.
    pub busy: Vec<&'static str>,
    /// The installer's marker was removed this launch, because none of the six listed names
    /// remained in the data folder afterward (D-24).
    pub marker_removed: bool,
    /// The marker could not be removed this launch even though the folder was clean — held open by
    /// something else. Retried at the next launch, like a busy binary; never a panic.
    pub marker_remove_error: Option<String>,
}

/// Look for leftovers of a previous installation and remove exactly what the closed six-name list
/// (D-21, D-22) finds in the data folder — everything else there, including every name a user
/// chose, is left untouched by construction.
///
/// Three roots are PARAMETERS rather than resolved in here, for the reason `sidecar_pid_dir` states
/// at its own site: under `cargo test --lib` the executable is a test binary somewhere in the build
/// tree, so a pass that resolved its own inputs could only be asserted about wherever that binary
/// happened to live. `exe_dir` is `None` when the executable's directory cannot be resolved at all;
/// that is «I do not know where the program is», and the pass then declines the folder comparison,
/// the marker and the sidecar-core protection, all of which need it. `current_exe` is likewise
/// `None` when the running executable's own path cannot be resolved, in which case that one
/// protection is simply absent rather than guessed at.
pub(crate) fn sweep_legacy_leftovers(
    data_root: &Path,
    exe_dir: Option<&Path>,
    current_exe: Option<&Path>,
    emit: &mut dyn FnMut(&str),
) -> LeftoverReport {
    let mut report = LeftoverReport::default();

    // ── 1. The refusal, and it is unconditional and comes first ────────────────────────────
    //
    // Before phase 32 the install directory and the data root were ONE folder, so this equality
    // is the shape of every machine that has not been through the relocation — the ordinary case,
    // not the exotic one. In that folder every one of the six names belongs to the program that is
    // running at this instant, so «leftovers» there are not leftovers at all. Reporting them would
    // be advising the user to delete the application he just started; had the owner authorised the
    // removal, doing it would have deleted the running program outright (T-32-11-03).
    if let Some(exe) = exe_dir {
        if crate::data_adoption::same_dir(data_root, exe) {
            report.refused_same_folder = true;
            emit(
                "[legacy] the data folder and the program's own folder are the same place - \
                 nothing is examined there, because every binary in it belongs to the program \
                 that is running",
            );
            return report;
        }
    }

    // ── 2. The installer's record. INPUT, never instruction ────────────────────────────────
    //
    // Read from the folder the executable is in, because that is where the installer composed it
    // (`${TT_INSTALL_DIR}`) and it is the one root the installer resolves correctly whichever
    // administrator UAC elevated it to. It is a plain text file in a folder every account on the
    // machine can read and an elevated process wrote, so nothing in it is obeyed: a line is
    // matched against the closed list by BASENAME, and only a match whose folder is the data
    // folder is ever printed — and printed as the name from our own list, never as the bytes the
    // file carried (T-32-11-01).
    if let Some(exe) = exe_dir {
        let marker = exe.join(LEGACY_SURVIVOR_MARKER_BASENAME);
        if marker.exists() {
            report.marker_present = true;
            match std::fs::read_to_string(&marker) {
                Ok(body) => scan_marker(&body, data_root, &mut report),
                Err(e) => report.marker_error = Some(reason_without_path(&e.to_string())),
            }
        }
    }

    if let Some(reason) = &report.marker_error {
        emit(&format!(
            "[legacy] the last install left a record of what it could not remove, and that record \
             could not be read - {reason}"
        ));
    }
    if !report.marker_named.is_empty() {
        emit(&format!(
            "[legacy] the last install could not remove {} file(s) of the previous version and \
             wrote them down: {}",
            report.marker_named.len(),
            report.marker_named.join(", ")
        ));
    }
    if report.marker_elsewhere > 0 {
        emit(&format!(
            "[legacy] that record also points at {} file(s) outside the data folder; they are \
             counted and left alone",
            report.marker_elsewhere
        ));
    }
    if report.marker_unrecognised > 0 {
        emit(&format!(
            "[legacy] and {} entry/entries this version does not look for - the previous \
             version's two shortcuts land here; they are counted, never named",
            report.marker_unrecognised
        ));
    }

    // ── 3. The data folder as it is right now ──────────────────────────────────────────────
    //
    // Six `metadata()` calls and NOT a directory listing, which is the difference between a pass
    // that can only ever name six known binaries and one that could put any filename it happened
    // to see — including a per-server config the user named himself — into a log file (D-29).
    report.stale = stale_binaries_in(data_root);

    // A path is protected if it coincides with the running executable itself, or with the sidecar
    // core beside it (D-22) — checked even though the same-folder refusal above already covers the
    // ordinary case, because the two roots can legitimately differ once the data folder has moved.
    let mut protected: Vec<&Path> = Vec::new();
    if let Some(ce) = current_exe {
        protected.push(ce);
    }
    let sidecar_path = exe_dir.map(|d| d.join(crate::commands::vpn::SIDECAR_IMAGE_NAME));
    if let Some(p) = &sidecar_path {
        protected.push(p.as_path());
    }
    // With the program's folder unknown none of the protections above exists — not the
    // same-folder refusal, not the sidecar core beside the executable — and on a machine that has
    // not been through the phase-32 relocation the data folder IS the program's folder, where
    // removing `wintun.dll` takes the VPN adapter away from the running program. Unknown means
    // «report, do not touch»: the stale names stay in the report and nothing is removed.
    let stale_names: Vec<&'static str> = if exe_dir.is_some() {
        report.stale.iter().map(|(n, _)| *n).collect()
    } else {
        emit(
            "[legacy] the program's own folder could not be determined - leftovers are reported, \
             nothing is removed",
        );
        Vec::new()
    };
    for name in stale_names {
        match remove_listed_leftover(data_root, name, &protected) {
            RemovalOutcome::Removed(bytes) => report.removed.push((name, bytes)),
            RemovalOutcome::Busy(_reason) => report.busy.push(name),
            RemovalOutcome::Absent | RemovalOutcome::Refused => {}
        }
    }

    if !report.removed.is_empty() {
        let names: Vec<&str> = report.removed.iter().map(|(n, _)| *n).collect();
        let bytes: u64 = report.removed.iter().map(|(_, b)| *b).sum();
        emit(&format!(
            "[legacy] removed leftovers of a previous installation from the data folder ({}): {} \
             - {} in total",
            folder_for_report(data_root),
            names.join(", "),
            megabytes(bytes)
        ));
    }
    if !report.busy.is_empty() {
        emit(&format!(
            "[legacy] could not remove now, in use: {} - retried at the next launch",
            report.busy.join(", ")
        ));
    }

    // ── 4. The marker's own turn, then the one remaining silent-by-default branch ─────────
    //
    // D-24: the marker is removed only once none of the six listed names remains in the data
    // folder — recomputed fresh here rather than trusted from `report.stale`, because a busy or
    // protected name from the loop above means the folder is NOT clean even though it was attempted.
    // A name that stayed for either reason keeps the marker alive right alongside it.
    if report.marker_present {
        if let Some(exe) = exe_dir {
            if stale_binaries_in(data_root).is_empty() {
                match remove_survivor_marker(exe) {
                    Ok(()) => report.marker_removed = true,
                    Err(reason) => {
                        emit(&format!(
                            "[legacy] the installer's leftover record could not be removed yet - \
                             {reason}"
                        ));
                        report.marker_remove_error = Some(reason);
                    }
                }
            }
        }
    }

    let anything_found = report.marker_present || !report.stale.is_empty();
    if !anything_found {
        // The clean path, which is almost every launch on almost every machine: ONE line. It is
        // not silence, and that is deliberate — a later absence of these lines only means
        // something if looking normally leaves a trace.
        emit("[legacy] looked for leftovers of a previous installation - none found");
    }

    report
}

/// Match each line of the installer's record against the closed list, and place it.
///
/// Three outcomes and no fourth: a name on the list whose folder is the data folder (named), a
/// name on the list somewhere else (counted), anything else at all (counted). The two shortcuts
/// the installer also records land in the third bucket legitimately — they are not files in the
/// data folder, so this pass has nothing to say about them beyond that they were there.
fn scan_marker(body: &str, data_root: &Path, report: &mut LeftoverReport) {
    let allow = legacy_binary_names();
    for line in body.lines() {
        let entry = line.trim();
        if entry.is_empty() {
            continue;
        }
        let path = Path::new(entry);
        let base = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
        let Some(known) = allow.iter().copied().find(|a| a.eq_ignore_ascii_case(base)) else {
            report.marker_unrecognised += 1;
            continue;
        };
        match path.parent() {
            Some(parent) if crate::data_adoption::same_dir(parent, data_root) => {
                report.marker_named.push(known);
            }
            _ => report.marker_elsewhere += 1,
        }
    }
}

/// Which of the six are really sitting in the data folder, and how much space each takes.
///
/// `metadata` rather than `exists` for one reason worth the syscall being identical: the size is
/// what makes the report land with a person. «25.4 MB of a program you no longer run» is a fact
/// somebody acts on; «3 files» is not.
fn stale_binaries_in(data_root: &Path) -> Vec<(&'static str, u64)> {
    let mut found = Vec::new();
    for name in legacy_binary_names() {
        if let Ok(md) = std::fs::metadata(data_root.join(name)) {
            if md.is_file() {
                found.push((name, md.len()));
            }
        }
    }
    found
}

/// What happened, or did not, to one listed name.
#[derive(Debug, Clone, PartialEq, Eq)]
enum RemovalOutcome {
    /// Removed, and how many bytes it held.
    Removed(u64),
    /// A regular file on the list, in the right folder, that could not be removed right now — held
    /// open by something else. Retried at the next launch (D-24).
    Busy(String),
    /// Nothing of that name was there, or what was there was not a regular file.
    Absent,
    /// The name is not on the closed list, or the resolved path coincides with a protected path.
    Refused,
}

/// The single site that may ever delete one of the six listed binaries.
///
/// Every refusal happens before the filesystem is touched: a name outside [`legacy_binary_names`]
/// is refused by construction (T-03-04-01), and a path that coincides with `protected` — the
/// running process's own executable, or the sidecar core beside it — is refused even though its
/// name is on the list (T-03-04-02). Only a REGULAR file under the resulting path is ever removed:
/// `symlink_metadata` rather than `metadata` so a symlink, junction or directory planted under one
/// of these six names is left alone rather than followed or recursed into.
fn remove_listed_leftover(
    data_root: &Path,
    name: &'static str,
    protected: &[&Path],
) -> RemovalOutcome {
    if !legacy_binary_names().contains(&name) {
        return RemovalOutcome::Refused;
    }
    let path = data_root.join(name);
    if protected.iter().any(|p| crate::data_adoption::same_dir(&path, p)) {
        return RemovalOutcome::Refused;
    }
    match std::fs::symlink_metadata(&path) {
        Ok(md) if md.is_file() => {
            let bytes = md.len();
            match std::fs::remove_file(&path) {
                Ok(()) => RemovalOutcome::Removed(bytes),
                Err(e) => RemovalOutcome::Busy(reason_without_path(&e.to_string())),
            }
        }
        _ => RemovalOutcome::Absent,
    }
}

/// A size a person reads, not a byte count.
fn megabytes(bytes: u64) -> String {
    format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
}

/// An error text with anything path-shaped taken out.
///
/// The same predicate `data_adoption::path_free` applies and for the same reason (D-29): today
/// `read_to_string` formats its errors from the operation and never from the destination, but
/// «never today» is not a guard, and this string reaches `app.log`. Not shared with that function
/// because its replacement text names the operation — a write — and this one is a read; sharing
/// the predicate but not the sentence would be a worse trade than three lines.
fn reason_without_path(reason: &str) -> String {
    if reason.contains('\\') || reason.contains('/') {
        return "the record could not be read".to_string();
    }
    reason.to_string()
}

/// A folder named in a way a person can act on, with the account name taken out.
///
/// The useful half of the report is WHICH folder — «the program lives in two places» is the
/// observation that opened this gap, and a line that will not say where helps nobody. The unsafe
/// half is that the data folder is under the user's profile, so its literal spelling carries the
/// Windows account name into a log file. Both are satisfied by naming the folder the way the
/// system names it: the `%LOCALAPPDATA%` prefix is restored as the variable it came from, and a
/// folder that is not under it is reduced to its own last component.
fn folder_for_report(dir: &Path) -> String {
    let text = dir.to_string_lossy().replace('/', "\\");
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let local = local.to_string_lossy().replace('/', "\\");
        let local = local.trim_end_matches('\\');
        // `is_char_boundary` because a profile path may hold non-ASCII (a Cyrillic account name is
        // ordinary on this project's machines) and slicing a byte length that lands mid-character
        // panics.
        if !local.is_empty()
            && text.len() >= local.len()
            && text.is_char_boundary(local.len())
            && text[..local.len()].eq_ignore_ascii_case(local)
        {
            return format!("%LOCALAPPDATA%{}", &text[local.len()..]);
        }
    }
    // Not under the one root we can name as a variable. Then the only safe thing left to say is
    // the folder's own name — every parent of it is profile, and that is the part carrying the
    // account.
    dir.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "the application's data folder".to_string())
}

/// Removes ONLY the installer's own marker, and only its fixed basename beside the executable.
///
/// D-24: called from [`sweep_legacy_leftovers`] after every listed name is gone from the data
/// folder — before that the marker is still doing its job of remembering what survived. A failure
/// here (the marker file itself busy) is reported and left for the next launch, exactly like a busy
/// binary; it is never a reason to stop startup.
fn remove_survivor_marker(exe_dir: &Path) -> Result<(), String> {
    let marker = exe_dir.join(LEGACY_SURVIVOR_MARKER_BASENAME);
    std::fs::remove_file(&marker).map_err(|e| reason_without_path(&e.to_string()))
}

/// The production entry point: resolve all three inputs through the accessors that already own
/// them, remove what the closed list finds, and report into the application log.
///
/// The data root comes from `ssh::user_data_dir()` — the single accessor every path-confinement
/// root in this crate derives from — and the program's folder from `sidecar_pid_dir`, which is the
/// function that already answers «the directory the executable is in» for the pid file the
/// installer reads. `current_exe` is `std::env::current_exe()` itself, read once and reused for
/// both: a second lookup is how the two ends of a path come to disagree, which this project has
/// already paid for once (D-07).
pub(crate) fn run_startup_report() -> LeftoverReport {
    let data_root = crate::ssh::user_data_dir();
    let current_exe = std::env::current_exe().ok();
    let exe_dir = crate::commands::vpn::sidecar_pid_dir(current_exe.clone());

    let mut emit = |line: &str| {
        // Two channels, copied from the adoption's report and for its reason: `log_app` is the
        // durable one and is a no-op when file logging is off, which is exactly why a summary that
        // only went there once proved nothing.
        crate::logging::log_app("info", line);
        eprintln!("{line}");
    };

    sweep_legacy_leftovers(&data_root, exe_dir.as_deref(), current_exe.as_deref(), &mut emit)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    static SANDBOX_SEQ: AtomicU32 = AtomicU32::new(0);

    /// A fresh, empty directory under the OS temp dir.
    ///
    /// Deliberately NOT reached through `user_data_dir()`. This module is about a folder that
    /// holds real server configs and a plaintext credential store, and a test that can see
    /// real data is a test that can eat it — the same reason `data_adoption`'s sandbox states.
    fn sandbox(tag: &str) -> PathBuf {
        let n = SANDBOX_SEQ.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "tt-legacy-{}-{}-{}-{}",
            std::process::id(),
            tag,
            n,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).expect("sandbox");
        p
    }

    fn touch(dir: &Path, name: &str, bytes: usize) {
        std::fs::write(dir.join(name), vec![b'x'; bytes]).expect("touch");
    }

    /// Run the pass over a sandbox and hand back both the report and everything it said.
    fn run(
        data_root: &Path,
        exe_dir: Option<&Path>,
        current_exe: Option<&Path>,
    ) -> (LeftoverReport, String) {
        let mut lines: Vec<String> = Vec::new();
        let report = {
            let mut emit = |l: &str| lines.push(l.to_string());
            sweep_legacy_leftovers(data_root, exe_dir, current_exe, &mut emit)
        };
        (report, lines.join("\n"))
    }

    /// **The six leftovers are named and nothing else in the folder is.**
    ///
    /// The positive half of the pass, asserted against a folder shaped like a real one: the six
    /// binaries beside a credential store, a manifest and two server configs whose names the user
    /// chose. What must come out is the six, by name, and not one word about the rest.
    #[test]
    fn all_six_stale_binaries_are_named_and_nothing_else_in_the_folder_is() {
        let root = sandbox("six");
        for name in legacy_binary_names() {
            touch(&root, name, 1024);
        }
        for name in ["ssh_credentials.json", "configs.json", "my home server.toml"] {
            touch(&root, name, 32);
        }
        let exe = sandbox("six-exe");

        let (report, log) = run(&root, Some(&exe), None);

        let mut found: Vec<&str> = report.stale.iter().map(|(n, _)| *n).collect();
        found.sort_unstable();
        let mut want = legacy_binary_names();
        want.sort_unstable();
        assert_eq!(found, want, "the pass must name exactly the six binaries it knows");

        for name in ["ssh_credentials.json", "configs.json", "my home server.toml"] {
            assert!(
                !log.contains(name),
                "the report names '{name}', which is the user's own file. The folder this walks \
                 also holds the plaintext credential store, so a report that can name a data file \
                 can put one in a log (D-29):\n{log}"
            );
        }
    }

    /// **When the program cannot tell where it lives, it deletes nothing.**
    ///
    /// Every protection the removal has — the same-folder refusal, the sidecar core beside the
    /// executable, the executable itself — is built from `exe_dir` / `current_exe`. With both
    /// unknown none of them exists, and on a machine that has not been through the phase-32
    /// relocation the data folder IS the program's folder: removing `wintun.dll` there takes the
    /// VPN adapter away from the program that is running. Unknown must mean «report, do not
    /// touch», never «touch without protection».
    #[test]
    fn an_unknown_program_folder_removes_nothing() {
        let root = sandbox("no-exe");
        for name in legacy_binary_names() {
            touch(&root, name, 64);
        }

        let (report, _log) = run(&root, None, None);

        assert!(
            report.removed.is_empty(),
            "the pass removed {:?} without knowing where the program lives — every protection \
             is missing in that state",
            report.removed
        );
        for name in legacy_binary_names() {
            assert!(root.join(name).exists(), "{name} must still be on disk");
        }
        assert_eq!(report.stale.len(), legacy_binary_names().len(), "still reported, just not touched");
    }

    /// **A clean machine gets one line saying it looked, and no names.**
    ///
    /// Silence and «nothing was found» must not be the same thing in the record. This pass runs at
    /// every launch, so the clean path is the one that runs on almost every machine almost always:
    /// it has to be one line, and it has to exist, because a later silence is only meaningful if
    /// looking normally leaves a trace.
    #[test]
    fn a_data_root_with_no_leftovers_reports_that_it_looked_and_names_nothing() {
        let root = sandbox("clean");
        touch(&root, "ssh_credentials.json", 16);
        let exe = sandbox("clean-exe");

        let (report, log) = run(&root, Some(&exe), None);

        assert!(report.stale.is_empty(), "nothing to find, so nothing may be reported found");
        assert!(!report.marker_present);
        assert!(!report.refused_same_folder);
        assert!(
            !log.trim().is_empty(),
            "the pass must record that it looked; an empty log makes a clean machine \
             indistinguishable from a pass that never ran"
        );
        assert_eq!(
            log.lines().count(),
            1,
            "the clean path runs at every launch on every machine, so it is one line and not a \
             paragraph:\n{log}"
        );
    }

    /// **The pass refuses outright when the data folder IS the program's own folder.**
    ///
    /// That equality is this project's shape before phase 32 — the install lived in
    /// `%LOCALAPPDATA%\TrustTunnel Client Pro` and the data lived beside it — so it is the
    /// ordinary case on an old machine, not the exotic one. Every «leftover» in such a folder is a
    /// file of the program that is running at that moment. Reporting them as leftovers would be
    /// telling the user to delete the application they just started.
    #[test]
    fn the_pass_refuses_outright_when_the_data_folder_is_the_running_programs_own_folder() {
        let root = sandbox("same");
        for name in legacy_binary_names() {
            touch(&root, name, 512);
        }

        let (report, log) = run(&root, Some(&root), None);

        assert!(report.refused_same_folder, "the equality must be refused, not merely survived");
        assert!(
            report.stale.is_empty(),
            "the refusal is unconditional: nothing may be examined once the two folders are one"
        );
        for name in legacy_binary_names() {
            assert!(
                !log.contains(name),
                "the refusal still named '{name}' — those are the files of the program that is \
                 running:\n{log}"
            );
        }
        assert!(!log.trim().is_empty(), "a refusal must be reported, not silent");
    }

    /// **One launch removes exactly the six listed binaries and leaves every other file
    /// byte-identical — the tracer for D-21/D-22/D-25.**
    ///
    /// The folder is shaped like a real one: the six leftovers beside per-server configs, the
    /// credential store, the rules files and a lookalike name that must NOT be mistaken for the
    /// real thing (`trusttunnel.exe.bak` is not `trusttunnel.exe`). What must be true afterward:
    /// the six are gone, everything else is untouched down to the byte, and the report and the log
    /// agree about what happened.
    #[test]
    fn one_launch_removes_the_six_listed_binaries_and_leaves_every_other_file_byte_identical() {
        let root = sandbox("sweep");
        for name in legacy_binary_names() {
            touch(&root, name, 777);
        }
        let user_files: &[(&str, &str)] = &[
            ("server-a.toml", "server-a config content"),
            ("ssh_credentials.json", "{\"user\":\"redacted\"}"),
            ("rules.toml", "rule = 1"),
            ("routing_rules.json", "[]"),
            ("trusttunnel.exe.bak", "a lookalike name, not the real binary"),
            ("notes.txt", "keep me"),
        ];
        let mut before: Vec<(&str, Vec<u8>)> = Vec::new();
        for (name, content) in user_files {
            std::fs::write(root.join(name), content.as_bytes()).expect("user file");
            before.push((*name, content.as_bytes().to_vec()));
        }
        let exe = sandbox("sweep-exe");

        let (report, log) = run(&root, Some(&exe), None);

        for name in legacy_binary_names() {
            assert!(!root.join(name).exists(), "'{name}' must be gone after one launch");
        }
        for (name, want) in &before {
            let got = std::fs::read(root.join(name))
                .unwrap_or_else(|e| panic!("'{name}' vanished, and it is the user's own data: {e}"));
            assert_eq!(got, *want, "'{name}' must be byte-identical after the sweep:\n{log}");
        }

        let mut removed: Vec<&str> = report.removed.iter().map(|(n, _)| *n).collect();
        removed.sort_unstable();
        let mut want_names = legacy_binary_names();
        want_names.sort_unstable();
        assert_eq!(removed, want_names, "exactly the six listed names must be reported removed");

        assert_eq!(log.lines().count(), 1, "one launch, one summary line:\n{log}");
        assert!(log.contains("removed leftovers"), "the line must say what happened:\n{log}");
        for name in legacy_binary_names() {
            assert!(log.contains(name), "the summary line must name '{name}':\n{log}");
        }
    }

    /// **`remove_listed_leftover` refuses any name outside the closed list, at runtime, before it
    /// ever touches the filesystem.**
    ///
    /// This is the direct unit test of the one function this module ever authorises to delete a
    /// file — not exercised indirectly through the sweep, which never offers this function an
    /// off-list name in the first place.
    #[test]
    fn an_off_list_name_is_refused_before_touching_the_filesystem() {
        let root = sandbox("offlist");
        touch(&root, "ssh_credentials.json", 32);

        let outcome = remove_listed_leftover(&root, "ssh_credentials.json", &[]);

        assert!(
            matches!(outcome, RemovalOutcome::Refused),
            "an off-list name must be refused, got {outcome:?}"
        );
        assert!(
            root.join("ssh_credentials.json").exists(),
            "a refused name must never be removed"
        );
    }

    /// **The running executable's own path is never removed, even when it coincides with a listed
    /// name (D-22, T-32-11-03's argument extended to the removal case).**
    ///
    /// Every other listed name still goes; only the one path that would be the running program
    /// deleting itself is refused.
    #[test]
    fn the_running_executables_own_path_is_never_removed_even_when_it_coincides() {
        let root = sandbox("protected");
        for name in legacy_binary_names() {
            touch(&root, name, 64);
        }
        let exe = sandbox("protected-exe");
        let current_exe = root.join(MAIN_BINARY_NAME);

        let (report, _log) = run(&root, Some(&exe), Some(&current_exe));

        assert!(
            root.join(MAIN_BINARY_NAME).exists(),
            "the running executable's own path must survive even though its name is listed"
        );
        let mut removed: Vec<&str> = report.removed.iter().map(|(n, _)| *n).collect();
        removed.sort_unstable();
        let mut want_names: Vec<&str> =
            legacy_binary_names().into_iter().filter(|n| *n != MAIN_BINARY_NAME).collect();
        want_names.sort_unstable();
        assert_eq!(removed, want_names, "every OTHER listed name must still be removed");
    }

    /// **A busy leftover waits for the next launch; the marker follows it (D-24).**
    ///
    /// Windows-only: `share_mode(0)` is the mechanism that makes `remove_file` fail deterministically
    /// for a file this same process holds open — the product is Windows-only, so this is the whole
    /// of the busy case. Run 1 removes everything except the held file and reports it busy with one
    /// log line; the marker survives because one listed name is still there. Run 2, after the handle
    /// is dropped, removes the last name and the marker goes with it. Run 3 is silent.
    #[cfg(windows)]
    #[test]
    fn a_busy_file_waits_for_the_next_launch_and_the_marker_follows_it() {
        use std::os::windows::fs::OpenOptionsExt;

        let root = sandbox("busy");
        let exe = sandbox("busy-exe");
        for name in legacy_binary_names() {
            touch(&root, name, 32);
        }
        let marker_body: String = legacy_binary_names()
            .into_iter()
            .map(|n| format!("{}\r\n", root.join(n).display()))
            .collect();
        std::fs::write(exe.join(LEGACY_SURVIVOR_MARKER_BASENAME), marker_body).expect("marker");

        let handle = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(root.join("wintun.dll"))
            .expect("open wintun.dll exclusively");

        let (report1, log1) = run(&root, Some(&exe), None);
        for name in legacy_binary_names() {
            if name == "wintun.dll" {
                assert!(root.join(name).exists(), "the busy file must survive run 1");
            } else {
                assert!(!root.join(name).exists(), "'{name}' must be gone after run 1");
            }
        }
        assert_eq!(report1.busy, vec!["wintun.dll"]);
        let busy_lines: Vec<&str> =
            log1.lines().filter(|l| l.contains("wintun.dll") && l.contains("in use")).collect();
        assert_eq!(
            busy_lines.len(),
            1,
            "exactly one line must name the busy file as in use:\n{log1}"
        );
        assert!(busy_lines[0].contains("retried"), "the busy line must promise a retry:\n{log1}");
        assert!(
            exe.join(LEGACY_SURVIVOR_MARKER_BASENAME).exists(),
            "the marker must survive while a listed name remains"
        );
        assert!(!report1.marker_removed);

        drop(handle);

        let (report2, _log2) = run(&root, Some(&exe), None);
        assert!(
            !root.join("wintun.dll").exists(),
            "the previously busy file must be gone after run 2"
        );
        assert_eq!(report2.removed, vec![("wintun.dll", 32u64)]);
        assert!(report2.marker_removed, "the marker must go once the folder is clean");
        assert!(!exe.join(LEGACY_SURVIVOR_MARKER_BASENAME).exists());

        let (report3, log3) = run(&root, Some(&exe), None);
        assert!(report3.stale.is_empty());
        assert!(!report3.marker_present);
        assert_eq!(log3.lines().count(), 1, "run 3 must be silent but for one line:\n{log3}");
        assert!(log3.contains("none found"));
    }

    /// **A marker naming files that are already gone is removed at once.**
    ///
    /// The marker's job is to remember what survived the installer; once nothing it names is stale
    /// any more, it has already done that job, whether this launch or an earlier one did the actual
    /// removing.
    #[test]
    fn a_marker_naming_files_already_gone_is_removed_in_that_run() {
        let root = sandbox("marker-clean");
        let exe = sandbox("marker-clean-exe");
        let body = format!("{}\r\n", root.join("wintun.dll").display());
        std::fs::write(exe.join(LEGACY_SURVIVOR_MARKER_BASENAME), body).expect("marker");

        let (report, _log) = run(&root, Some(&exe), None);

        assert!(report.stale.is_empty());
        assert!(report.marker_removed, "nothing is stale, so a present marker must be removed at once");
        assert!(!exe.join(LEGACY_SURVIVOR_MARKER_BASENAME).exists());
    }

    /// **The marker is kept while a listed name still remains, even when that name is merely
    /// protected rather than busy.**
    ///
    /// A cross-platform way to make a listed name "still remain" after an attempted removal, without
    /// the Windows-only busy mechanism: the protected-path refusal from task 1.
    #[test]
    fn a_marker_is_kept_while_a_protected_listed_name_still_remains() {
        let root = sandbox("marker-protected");
        let exe = sandbox("marker-protected-exe");
        touch(&root, MAIN_BINARY_NAME, 16);
        let body = format!("{}\r\n", root.join(MAIN_BINARY_NAME).display());
        std::fs::write(exe.join(LEGACY_SURVIVOR_MARKER_BASENAME), body).expect("marker");
        let current_exe = root.join(MAIN_BINARY_NAME);

        let (report, _log) = run(&root, Some(&exe), Some(&current_exe));

        assert!(root.join(MAIN_BINARY_NAME).exists(), "the protected binary must remain");
        assert!(
            !report.marker_removed,
            "a listed name is still in the data folder, so the marker must stay"
        );
        assert!(exe.join(LEGACY_SURVIVOR_MARKER_BASENAME).exists());
    }

    /// **A marker that cannot itself be removed is reported once and retried next launch — never a
    /// panic.**
    #[cfg(windows)]
    #[test]
    fn a_marker_that_cannot_be_removed_is_reported_and_retried_next_run() {
        use std::os::windows::fs::OpenOptionsExt;

        let root = sandbox("marker-busy");
        let exe = sandbox("marker-busy-exe");
        let marker_path = exe.join(LEGACY_SURVIVOR_MARKER_BASENAME);
        std::fs::write(&marker_path, "").expect("marker");
        // FILE_SHARE_READ (0x1): the sweep's own marker READ (step 2, unrelated to this test) must
        // still succeed, so only the later REMOVE attempt is the one that finds this file busy.
        let handle = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0x1)
            .open(&marker_path)
            .expect("open marker with read-only sharing");

        let (report, log) = run(&root, Some(&exe), None);

        assert!(report.marker_present);
        assert!(!report.marker_removed);
        assert!(
            report.marker_remove_error.is_some(),
            "a busy marker must record why it could not go"
        );
        assert_eq!(log.lines().count(), 1, "one line, and no panic:\n{log}");

        drop(handle);

        let (report2, _log2) = run(&root, Some(&exe), None);
        assert!(report2.marker_removed, "retried next run, the marker can finally go");
    }

    /// **Every entry of the installer's record is accounted for, and one pointing elsewhere is not
    /// called a leftover of this folder.**
    ///
    /// The marker is written by an elevated installer into a folder every account on the machine
    /// can read, so its contents are INPUT and not instruction (T-32-11-01). An entry naming one of
    /// the six but living somewhere else is counted and never presented as something in the data
    /// folder; an entry naming anything else at all is counted and never printed, which is what
    /// keeps an arbitrary string in that file out of `app.log`.
    #[test]
    fn every_marker_entry_is_accounted_for_and_one_outside_the_data_folder_is_not_called_a_leftover()
    {
        let root = sandbox("marker");
        let exe = sandbox("marker-exe");
        touch(&root, "wintun.dll", 64);

        let elsewhere = sandbox("marker-elsewhere");
        let body = format!(
            "{}\r\n{}\r\n{}\r\n\r\n",
            root.join("wintun.dll").display(),
            elsewhere.join("uninstall.exe").display(),
            "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\TrustTunnel Client Pro.lnk",
        );
        std::fs::write(exe.join(LEGACY_SURVIVOR_MARKER_BASENAME), body).expect("marker");

        let (report, log) = run(&root, Some(&exe), None);

        assert!(report.marker_present, "the record is on disk and must be reported as read");
        assert_eq!(
            report.marker_named,
            vec!["wintun.dll"],
            "only the entry that is both on the closed list and in the data folder may be named"
        );
        assert_eq!(report.marker_elsewhere, 1, "the entry pointing outside must be counted");
        assert_eq!(report.marker_unrecognised, 1, "the shortcut is counted, never named");
        assert!(
            !log.contains(".lnk"),
            "an entry this build does not look for reached the log by name; the record is \
             attacker-writable input, so only names from our own list may be printed:\n{log}"
        );
        assert!(report.marker_error.is_none());
    }

    /// **A record that cannot be read is reported with its reason and stops nothing.**
    ///
    /// Nothing this pass does is something the user asked for, so nothing it fails at may
    /// interrupt them — and it must still finish the half that does work. A directory standing
    /// where the file should be is the cheapest way to make the read fail on any filesystem.
    #[test]
    fn an_unreadable_marker_is_reported_with_its_reason_and_the_pass_still_finishes() {
        let root = sandbox("badmarker");
        let exe = sandbox("badmarker-exe");
        std::fs::create_dir_all(exe.join(LEGACY_SURVIVOR_MARKER_BASENAME)).expect("dir marker");
        touch(&root, "wintun.dll", 8);

        let (report, log) = run(&root, Some(&exe), None);

        assert!(report.marker_error.is_some(), "an unreadable record must be reported as such");
        assert_eq!(
            report.stale.iter().map(|(n, _)| *n).collect::<Vec<_>>(),
            vec!["wintun.dll"],
            "the disk half of the pass must still run after the record could not be read"
        );
        assert!(
            !log.contains(&exe.display().to_string()),
            "the failure reason carried a path into the log (D-29):\n{log}"
        );
    }

    /// **No name the application persists can ever be reported as a leftover — asserted over the
    /// WHOLE list, not over examples.**
    ///
    /// This is the guard that would have to be removed before a removal could ever aim at the
    /// wrong list, and it is kept although this build removes nothing precisely for that reason.
    /// The list it checks against is `lifecycle.rs`'s `USER_DATA` itself, not a copy of it: a
    /// second list beside that one is how the two drift, and one of them stops being enforced.
    #[test]
    fn no_name_in_the_projects_user_data_list_can_ever_be_reported_as_a_leftover() {
        let user_data = crate::lifecycle::tests::USER_DATA;
        assert!(!user_data.is_empty(), "CANNOT MEASURE: the user-data list is empty");

        let allow = legacy_binary_names();
        for name in user_data {
            assert!(
                !allow.iter().any(|a| a.eq_ignore_ascii_case(name)),
                "'{name}' is on BOTH the list of things the user owns and the list of leftovers \
                 this pass reports. The two lists must be disjoint by construction — that \
                 disjointness is what a removal, if one is ever authorised, would rest on"
            );
        }

        // And behaviourally, over a folder that holds every one of them.
        let root = sandbox("userdata");
        for name in user_data {
            touch(&root, name, 8);
        }
        let exe = sandbox("userdata-exe");
        let (report, log) = run(&root, Some(&exe), None);

        assert!(report.stale.is_empty(), "a folder of pure user data has no leftovers in it");
        for name in user_data {
            assert!(!log.contains(name), "the report named the user's '{name}':\n{log}");
        }
    }

    /// **A forged record naming the user's files produces no named file.**
    ///
    /// The marker is a plain text file in a world-readable folder. If its contents were treated as
    /// instruction, whoever could write it would choose what the application says — and, had the
    /// owner answered `sweep`, what the application deletes. The closed list is what makes that
    /// impossible rather than unlikely.
    #[test]
    fn a_marker_forged_with_user_data_names_produces_no_named_file() {
        let root = sandbox("forged");
        let exe = sandbox("forged-exe");
        let user_data = crate::lifecycle::tests::USER_DATA;
        for name in user_data {
            touch(&root, name, 8);
        }
        let body: String = user_data
            .iter()
            .map(|n| format!("{}\r\n", root.join(n).display()))
            .collect();
        std::fs::write(exe.join(LEGACY_SURVIVOR_MARKER_BASENAME), body).expect("marker");

        let (report, log) = run(&root, Some(&exe), None);

        assert!(
            report.marker_named.is_empty(),
            "a forged record got a user file onto the named list: {:?}",
            report.marker_named
        );
        assert_eq!(report.marker_unrecognised, user_data.len());
        for name in user_data {
            assert!(!log.contains(name), "the forged record put '{name}' into the log:\n{log}");
        }
    }

    /// **The report never carries the account name or the profile path.**
    ///
    /// The folder has to be named or the line is useless — «where do I look?» is the whole
    /// question. But the data folder sits under the user's profile, so its literal spelling is the
    /// Windows account name written into a log file that goes into bug reports. Naming it the way
    /// the system names it satisfies both.
    #[test]
    fn the_report_never_carries_the_account_name_or_the_profile_path() {
        let root = sandbox("privacy");
        touch(&root, "wintun.dll", 4096);
        let exe = sandbox("privacy-exe");

        let (_report, log) = run(&root, Some(&exe), None);
        assert!(log.contains("wintun.dll"), "the leftover must still be named:\n{log}");

        if let Some(profile) = std::env::var_os("USERPROFILE") {
            let profile = profile.to_string_lossy().into_owned();
            if !profile.is_empty() {
                assert!(
                    !log.contains(&profile),
                    "the report spelled out the user's profile directory:\n{log}"
                );
            }
        }
        if let Some(user) = std::env::var_os("USERNAME") {
            let user = user.to_string_lossy().into_owned();
            // Two characters is not a name, it is a substring that would match by accident.
            if user.len() > 2 {
                assert!(!log.contains(&user), "the report carried the account name:\n{log}");
            }
        }
    }

    /// **The basename this module reads is the one the installer writes.**
    ///
    /// The two-ended agreement 32-FIX-10 could not make, because nothing read the file yet, and
    /// recorded in `.planning/WINDOWS.md` so it could not be forgotten. `include_str!` binds the
    /// hook at COMPILE time, so editing the `.nsh` alone cannot leave this green — the same
    /// mechanism the pid path's contract uses, for the same reason: those two ends drifted once
    /// (D-07) and the kill was a no-op for months with nothing watching.
    #[test]
    fn the_marker_basename_is_the_one_the_installer_writes() {
        const HOOK_NSH: &str = include_str!("../nsis/installer-hooks.nsh");

        let want = format!(
            "!define TT_LEGACY_SURVIVOR_MARKER_BASENAME \"{LEGACY_SURVIVOR_MARKER_BASENAME}\""
        );
        assert!(
            HOOK_NSH.contains(&want),
            "the installer does not define the marker basename this module reads. Rust looks for \
             '{LEGACY_SURVIVOR_MARKER_BASENAME}'; the expected line is:\n  {want}\n\
             Two ends that can drift in silence is how the sidecar pid kill became a no-op (D-07)."
        );
        assert!(
            HOOK_NSH.contains(
                "!define TT_LEGACY_SURVIVOR_MARKER \"${TT_INSTALL_DIR}\\${TT_LEGACY_SURVIVOR_MARKER_BASENAME}\""
            ),
            "the marker is no longer composed on the INSTALL directory. This module looks for it \
             beside the executable, which is the one root the installer resolves correctly \
             whichever administrator UAC elevated it to"
        );
    }

    /// **The installer's enumeration and this module's allow-list are one set of six binaries.**
    ///
    /// WHAT BREAKS IF THE TWO ENDS DRIFT. The installer removes a binary this pass never looks
    /// for; that binary survives a failed removal on somebody's machine; and then nothing is
    /// looking for it, ever. It sits in the data folder for the life of the installation with no
    /// surface mentioning it — which is precisely the shape of the defect this whole remediation
    /// is closing, one layer removed. Drift the other way is quieter and no better: this pass
    /// reports a file the installer does not install, so a user is told to delete something that
    /// may not be a leftover at all.
    ///
    /// THREE DELIBERATE EXCLUSIONS, NAMED HERE RATHER THAN SILENTLY FILTERED. The installer also
    /// removes the Start-menu shortcut, the desktop shortcut (both `${PRODUCTNAME}.lnk`) and the
    /// uninstall registry key `HKCU\${UNINSTKEY}`. None of the three is a file in the data folder,
    /// so none can be a leftover of the kind this pass reports. They are dropped by rule — a
    /// registry root prefix and a `.lnk` extension — and the rule is written down here so a fourth
    /// exclusion cannot be added by widening a filter nobody reads.
    ///
    /// ONE TRANSLATION. The hook spells the main binary as the template's define,
    /// `${MAINBINARYNAME}.exe`, and that spelling is itself under contract in `lifecycle.rs` —
    /// requiring the define is what stops a product-name path being substituted for it. So the
    /// define is mapped to [`MAIN_BINARY_NAME`], which is composed from the same package name the
    /// template derives it from, and the mapping is the only one this test performs.
    ///
    /// `include_str!` binds the hook at COMPILE time; editing the `.nsh` alone cannot leave this
    /// green. Renaming `SIDECAR_IMAGE_NAME` does not un-aim it either — the sweep's list is built
    /// from that constant, so a rename moves one end and the comparison goes red rather than quiet.
    #[test]
    fn the_sweep_and_the_installer_name_the_same_six_binaries() {
        const HOOK_NSH: &str = include_str!("../nsis/installer-hooks.nsh");
        let body = crate::lifecycle::tests::hook_macro_statements(HOOK_NSH, "NSIS_HOOK_PREINSTALL");

        let announced: Vec<String> = body
            .iter()
            .filter(|l| l.starts_with("DetailPrint") && l.contains("$(legacyRemoving)"))
            .filter_map(|l| l.split('"').nth(1))
            .filter_map(|quoted| quoted.strip_prefix("$(legacyRemoving)"))
            .map(|target| target.trim().to_string())
            .collect();

        assert!(
            !announced.is_empty(),
            "CANNOT MEASURE: `NSIS_HOOK_PREINSTALL` announces no artifact at all. Either the macro \
             was emptied or the language key it prints was renamed, so this rule has lost its \
             subject — reporting PASS over an empty set is the vacuous shape this project refuses."
        );

        const REGISTRY_ROOTS: &[&str] = &["HKCU\\", "HKLM\\", "HKCR\\", "HKU\\", "SHCTX\\"];
        let mut installer: Vec<String> = Vec::new();
        for target in &announced {
            if REGISTRY_ROOTS.iter().any(|r| target.starts_with(r)) {
                continue; // the uninstall entry — not a file in the data folder
            }
            let base = target.rsplit('\\').next().unwrap_or(target.as_str());
            if base.to_ascii_lowercase().ends_with(".lnk") {
                continue; // the two shortcuts — not files in the data folder
            }
            let name = if base == "${MAINBINARYNAME}.exe" {
                MAIN_BINARY_NAME.to_string()
            } else {
                base.to_string()
            };
            installer.push(name.to_ascii_lowercase());
        }
        installer.sort();
        installer.dedup();

        let mut sweep: Vec<String> = legacy_binary_names()
            .into_iter()
            .map(|n| n.to_ascii_lowercase())
            .collect();
        sweep.sort();
        sweep.dedup();

        let only_installer: Vec<&String> = installer.iter().filter(|n| !sweep.contains(n)).collect();
        let only_sweep: Vec<&String> = sweep.iter().filter(|n| !installer.contains(n)).collect();

        assert!(
            only_installer.is_empty(),
            "the installer removes binaries this pass never looks for: {:?}\nOne of those \
             surviving a failed removal is a file that stays on a user's disk for the life of the \
             installation with nothing looking for it — the defect this whole remediation is \
             closing, one layer removed.\n  installer: {installer:?}\n  sweep:     {sweep:?}",
            only_installer
        );
        assert!(
            only_sweep.is_empty(),
            "this pass reports binaries the installer does not install: {:?}\nIt would tell a user \
             that a file is a leftover of a previous version when nothing here ever put it \
             there.\n  installer: {installer:?}\n  sweep:     {sweep:?}",
            only_sweep
        );
        assert_eq!(
            sweep.len(),
            6,
            "the allow-list is no longer the six binaries the enumeration names: {sweep:?}"
        );
    }

    /// **The compiled guard over D-21's reversal: this module may delete ONLY the six listed names,
    /// and ONLY through the two functions that are allowed to reach them.**
    ///
    /// Rewritten from `nothing_in_this_module_removes_a_file` (the `report-only` guard, 2026-09-06)
    /// when the owner reversed that answer for `WIN-25` (2026-09-23). A prohibition written only in
    /// a comment is a prohibition the next reader can undo without noticing they undid anything, so
    /// this rule reads its OWN compiled source rather than trust a comment — the same reason the
    /// guard it replaces did.
    ///
    /// The needles are assembled from fragments rather than written out, because this rule reads
    /// its OWN source: spelled in full they would appear in the file the assertion scans and the
    /// test would fail on its own wording forever, which is a rule that invalidates itself.
    ///
    /// Every occurrence of a removal call is attributed to its NEAREST PRECEDING `fn` declaration —
    /// the source of truth for "which function owns this", not a hand-kept list that could drift
    /// from the code it describes. An occurrence owned by anything other than the two permitted
    /// functions is the exact widening this test exists to catch, and it names the intruder.
    ///
    /// THE SCAN STOPS AT THE TEST MODULE, and that boundary is stated rather than implied. The
    /// prohibition is about the program: the harness in this module legitimately creates and clears
    /// its own sandbox directories, and a rule that could not tell those apart from a removal in the
    /// user's folder would be a rule about the wrong thing. Losing the boundary is a FAILURE, not a
    /// pass — a scan that cannot find where the shipped half ends can say nothing about it.
    #[test]
    fn this_module_removes_only_the_listed_names() {
        const THIS_FILE: &str = include_str!("legacy_sweep.rs");

        let boundary = concat!("#[cfg", "(test)]");
        let shipped = THIS_FILE.split(boundary).next().unwrap_or("");
        assert!(
            THIS_FILE.contains(boundary) && shipped.len() > 1000,
            "CANNOT MEASURE: the shipped half of this module could not be delimited from its test \
             harness, so this rule has no subject."
        );

        // Directory removal and directory enumeration have no legitimate site anywhere in the
        // shipped half — neither permitted function ever touches a directory.
        let dir_needles = [concat!("remove_", "dir"), concat!("read_", "dir")];
        let dir_offenders: Vec<&str> =
            dir_needles.iter().copied().filter(|n| shipped.contains(n)).collect();
        assert!(
            dir_offenders.is_empty(),
            "this module enumerates or removes a directory, which no permitted removal ever needs:\n  {}",
            dir_offenders.join("\n  ")
        );

        let win_needle = concat!("Delete", "File");
        assert!(
            !shipped.contains(win_needle),
            "a Windows API removal call appears outside the two permitted functions"
        );

        // Every file-removal call, wherever it sits, is attributed to its nearest preceding `fn`.
        let file_needle = concat!("remove_", "file");
        let allowed = ["remove_listed_leftover", "remove_survivor_marker"];
        let mut owners: Vec<&str> = Vec::new();
        let mut search_from = 0usize;
        while let Some(rel) = shipped[search_from..].find(file_needle) {
            let at = search_from + rel;
            let before = &shipped[..at];
            let fn_at =
                before.rfind("fn ").expect("CANNOT MEASURE: a removal call sits before any `fn`");
            let after_fn = &before[fn_at + 3..];
            let name_end = after_fn.find('(').unwrap_or(after_fn.len());
            owners.push(after_fn[..name_end].trim());
            search_from = at + file_needle.len();
        }

        let intruders: Vec<&str> = owners.iter().copied().filter(|o| !allowed.contains(o)).collect();
        assert!(
            intruders.is_empty(),
            "a removal call belongs to {intruders:?}, which is not one of the two functions this \
             module permits to remove a file ({allowed:?}). Adding a removal anywhere else is \
             exactly the widening D-23's guard exists to catch."
        );
        for name in allowed {
            assert_eq!(
                owners.iter().filter(|o| **o == name).count(),
                1,
                "{name} must contain exactly one removal call; owners found: {owners:?}"
            );
        }
        assert_eq!(owners.len(), 2, "exactly two removal calls total; owners found: {owners:?}");

        let fn_body = |name: &str| -> &str {
            let at = shipped.find(&format!("fn {name}")).unwrap_or_else(|| {
                panic!("CANNOT MEASURE: `fn {name}` was not found in the shipped half")
            });
            let after = &shipped[at..];
            let next_fn = after[3..].find("\nfn ").map(|i| i + 3).unwrap_or(after.len());
            &after[..next_fn]
        };

        let listed_body = fn_body("remove_listed_leftover");
        assert!(
            listed_body.contains("legacy_binary_names()"),
            "remove_listed_leftover must refuse by consulting legacy_binary_names(), the one \
             closed list this whole module rests on"
        );

        let marker_body = fn_body("remove_survivor_marker");
        assert!(
            marker_body.contains("LEGACY_SURVIVOR_MARKER_BASENAME"),
            "remove_survivor_marker must remove only the marker's own fixed basename"
        );
        assert_eq!(
            marker_body.matches(".join(").count(),
            1,
            "remove_survivor_marker must build exactly one path — the marker beside the \
             executable — and nothing else"
        );
    }
}
