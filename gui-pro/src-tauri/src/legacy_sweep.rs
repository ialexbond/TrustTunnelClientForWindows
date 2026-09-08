//! What the installer could not remove, found at startup and written into `app.log` — and never
//! removed.
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
//! What none of them covers is a machine that is ALREADY in the failed state — including the
//! one that carries no marker at all because its failure predates the marker. One launch
//! later those files are ordinary files: the processes that held them are gone. So this is the one
//! place from which the leftovers are visible at all.
//!
//! # THIS MODULE DELETES NOTHING, AND THAT IS A PRODUCT DECISION ON RECORD
//!
//! 2026-09-06, task 0 of plan 32-FIX-11, option `report-only` («Только сообщать в журнал»). The removal was
//! offered — a closed six-name allow-list, a parent-folder check and a compiled
//! disjointness proof — and the report was chosen instead. So this pass looks, says what it found in
//! words, and stops. Nothing here removes a file, not behind a flag, not behind a setting, and not
//! as dead code waiting to be switched on; `tests::nothing_in_this_module_removes_a_file` reads
//! this file's own source and goes red if any removal call appears in it. Adding one needs a new
//! product decision, not an edit.
//!
//! The accepted cost of that answer, stated so nobody repairs it by surprise: the leftovers stay
//! until somebody deletes them by hand, and the data folder goes on looking as though the program
//! lives in two places.
//!
//! # Why an allow-list of binaries and not a deny-list of data
//!
//! The same argument the installer's enumeration makes, and it is not weakened by nothing being
//! deleted here. The most numerous files in the data folder are the per-server `.toml` configs,
//! and the USER chooses their names — they cannot be enumerated at all. A rule shaped as «leave
//! the data alone» could therefore never be complete, while a rule shaped as «these six binaries
//! and nothing else» is complete by construction. The list is closed, it is the same six the
//! installer enumerates (`tests::the_sweep_and_the_installer_name_the_same_six_binaries`), and it
//! is provably disjoint from every name the application persists
//! (`tests::no_name_in_the_projects_user_data_list_can_ever_be_reported_as_a_leftover`).
//!
//! That shape is also what keeps the log channel safe. This pass walks the folder that holds
//! `ssh_credentials.json`. It never enumerates the directory, never opens a file it is reporting,
//! and only ever prints filenames drawn from its own static list — so no value from the credential
//! store can reach `app.log` by any input, which is D-29 holding by construction rather than by
//! care (T-32-11-04).
//!
//! # What it costs on the ordinary machine
//!
//! It runs on every launch, so the clean path has to be cheap: one `exists()` on the marker, six
//! `metadata()` calls in the data folder, and exactly one line in `app.log` saying it looked and
//! found nothing. No directory is enumerated and no file is opened. On a machine with leftovers it
//! costs the same plus one read of a marker file of at most eight short lines.
//!
//! The marker is NOT deleted after it is read, which is the one thing the plan asked for that this
//! build does not do: deleting it is a removal, and the answer forbids removals here. The
//! consequence is that the same report is written at every launch for as long as the condition
//! lasts — which is honest, because the condition does last: nothing is clearing those files.

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
}

/// Look for leftovers of a previous installation, say what was found, and change nothing.
///
/// Both roots are PARAMETERS rather than resolved in here, for the reason `sidecar_pid_dir` states
/// at its own site: under `cargo test --lib` the executable is a test binary somewhere in the build
/// tree, so a pass that resolved its own inputs could only be asserted about wherever that binary
/// happened to live. `exe_dir` is `None` when the executable's directory cannot be resolved at all;
/// that is «I do not know where the program is», and the pass then declines the folder comparison
/// and the marker, which are the two things that need it.
pub(crate) fn report_legacy_leftovers(
    data_root: &Path,
    exe_dir: Option<&Path>,
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

    if !report.stale.is_empty() {
        let names: Vec<&str> = report.stale.iter().map(|(n, _)| *n).collect();
        let bytes: u64 = report.stale.iter().map(|(_, b)| *b).sum();
        emit(&format!(
            "[legacy] leftovers of a previous installation are still in the data folder ({}): {} \
             - {} in total",
            folder_for_report(data_root),
            names.join(", "),
            megabytes(bytes)
        ));
        emit(
            "[legacy] this version does not use those files; deleting exactly those by hand is \
             safe, and nothing else in that folder is a leftover - everything else there is your \
             own data",
        );
    }

    // ── 4. What will and will not happen about it ──────────────────────────────────────────
    let said_something = report.marker_present || !report.stale.is_empty();
    if said_something {
        emit(
            "[legacy] nothing here is removed automatically: by decision of 2026-09-06 this build \
             only reports what it found",
        );
    } else {
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

/// The production entry point: resolve both roots through the accessors that already own them and
/// report into the application log.
///
/// The data root comes from `ssh::user_data_dir()` — the single accessor every path-confinement
/// root in this crate derives from — and the program's folder from `sidecar_pid_dir`, which is the
/// function that already answers «the directory the executable is in» for the pid file the
/// installer reads. Neither is re-derived here; a second lookup is how the two ends of a path come
/// to disagree, which this project has already paid for once (D-07).
pub(crate) fn run_startup_report() -> LeftoverReport {
    let data_root = crate::ssh::user_data_dir();
    let exe_dir = crate::commands::vpn::sidecar_pid_dir(std::env::current_exe().ok());

    let mut emit = |line: &str| {
        // Two channels, copied from the adoption's report and for its reason: `log_app` is the
        // durable one and is a no-op when file logging is off, which is exactly why a summary that
        // only went there once proved nothing.
        crate::logging::log_app("info", line);
        eprintln!("{line}");
    };

    report_legacy_leftovers(&data_root, exe_dir.as_deref(), &mut emit)
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
    fn run(data_root: &Path, exe_dir: Option<&Path>) -> (LeftoverReport, String) {
        let mut lines: Vec<String> = Vec::new();
        let report = {
            let mut emit = |l: &str| lines.push(l.to_string());
            report_legacy_leftovers(data_root, exe_dir, &mut emit)
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

        let (report, log) = run(&root, Some(&exe));

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

        let (report, log) = run(&root, Some(&exe));

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

        let (report, log) = run(&root, Some(&root));

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

        let (report, log) = run(&root, Some(&exe));

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

        let (report, log) = run(&root, Some(&exe));

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
        let (report, log) = run(&root, Some(&exe));

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

        let (report, log) = run(&root, Some(&exe));

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

        let (_report, log) = run(&root, Some(&exe));
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

    /// **Nothing in this module removes a file.**
    ///
    /// The `report-only` answer (2026-09-06), compiled. A prohibition written only in a
    /// comment is a prohibition the next reader can undo without noticing they undid anything —
    /// and what would be undone here is a deletion inside the folder that holds the plaintext
    /// credential store, on machines with no rehearsal copy anywhere.
    ///
    /// The needles are assembled from fragments rather than written out, because this rule reads
    /// its OWN source: spelled in full they would appear in the file the assertion scans and the
    /// test would fail on its own wording forever, which is a rule that invalidates itself.
    ///
    /// THE SCAN STOPS AT THE TEST MODULE, and that boundary is stated rather than implied. The
    /// prohibition is about the program: the harness below legitimately creates and clears its own
    /// sandbox directories, and a rule that could not tell those apart from a deletion in the
    /// user's folder would be a rule about the wrong thing. Losing the boundary is a FAILURE, not
    /// a pass — a scan that cannot find where the shipped half ends can say nothing about it.
    #[test]
    fn nothing_in_this_module_removes_a_file() {
        const THIS_FILE: &str = include_str!("legacy_sweep.rs");

        let boundary = concat!("#[cfg", "(test)]");
        let shipped = THIS_FILE.split(boundary).next().unwrap_or("");
        assert!(
            THIS_FILE.contains(boundary) && shipped.len() > 1000,
            "CANNOT MEASURE: the shipped half of this module could not be delimited from its test \
             harness, so this rule has no subject."
        );

        let banned = [
            concat!("remove_", "file"),
            concat!("remove_", "dir"),
            concat!("Delete", "File"),
        ];
        let offenders: Vec<&str> = banned
            .iter()
            .copied()
            .filter(|needle| shipped.contains(needle))
            .collect();
        assert!(
            offenders.is_empty(),
            "this module removes files. That was offered on 2026-09-06 and \
             answered `report-only`: it reports and it does not delete. Adding a removal is a new \
             decision of his, not an edit — and the folder in question holds the saved configs and passwords, \
             saved passwords and the browser profile:\n  {}",
            offenders.join("\n  ")
        );
    }
}
