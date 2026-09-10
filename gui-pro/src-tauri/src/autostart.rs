//! Autostart («Запуск вместе с системой») — the Rust-side write path and the startup reconcile.
//!
//! ## The mechanism: a logon Scheduled Task, not a `Run` value (owner forensics 2026-08-28)
//!
//! This application's manifest requests `requireAdministrator` (embedded by `build.rs`), and
//! Windows runs `HKCU\...\CurrentVersion\Run` entries at logon under the user's **filtered**
//! token, raising no consent prompt during that pass. An entry demanding elevation is therefore
//! skipped **silently, at every logon, forever** — which is what this module used to write.
//!
//! **Four independent layers agreed autostart worked and all four were wrong:** the `Run` value
//! present and correct, its `StartupApproved\Run` companion reading enabled, `app_settings.json`
//! carrying `autostart_enabled: true`, and Task Manager showing «Включено» — while the interactive
//! logon at 00:47:26 (Winlogon 7001) produced no application start at all; the running process
//! began at 00:49:22, a manual launch. A logon task registered «with highest privileges» is the
//! only mechanism compatible with that manifest, and it lives in [`crate::task_scheduler`].
//!
//! **[`reconcile_autostart_on_startup`] was never at fault** for that defect and is not rewritten
//! here beyond its presence source. It re-asserts only a *wiped* entry, and the entry was intact.
//!
//! ## What survived the mechanism change, and why
//!
//! The shape, the ordering and the semantics below were paid for by an earlier bug and are all
//! still correct; only the machinery underneath them was wrong.
//!
//! 1. **The choice is persisted in `app_settings.json`, not inferred from the OS.** Tauri's NSIS
//!    uninstaller deletes OS-level autostart state whenever it runs outside update mode — a
//!    version upgrade, an uninstall→reinstall cycle, or the «Удалить перед установкой» radio on a
//!    same-version reinstall. Registry forensics showed that wipe signature precisely. The choice
//!    file survives reinstalls, so the startup reconcile can put the entry back.
//! 2. **The row is driven by plain Tauri commands.** The write used to go through a dynamic
//!    `import("@tauri-apps/plugin-autostart")`, which collided with the vitest harness
//!    (`restoreMocks: true` strips a module mock's resolved values — the 28-06 trap), so no test
//!    could drive the switch. Behind `invoke` it is testable like every other Settings row.
//!
//! ## The one leftover, named on purpose
//!
//! `tauri-plugin-autostart` is still registered in `lib.rs` and still granted by
//! `capabilities/default.json`, but **nothing in this crate calls it any more**. Removing it means
//! touching a Rust dependency, an npm dependency and its lock file, and the capability list — an
//! architectural change wider than this plan, so it is written down in the phase's
//! `deferred-items.md` rather than done quietly here. It is inert (no frontend code invokes the
//! plugin), but it is a second writer of the very `Run` value [`clear_dead_autostart_registry`]
//! deletes, and that is exactly why it is named here instead of left to be rediscovered.

use crate::app_settings;
use crate::logging::log_app;
#[cfg(windows)]
use crate::task_scheduler::{
    autostart_task_name, delete_task, explain_scheduler_failure, register_logon_task,
    remove_legacy_root_task, task_exists, task_is_enabled,
};

/// The two registry keys the abandoned mechanism wrote into.
///
/// The second one is the reason this cleanup exists as its own step: the startup-approval entries
/// are **not** in the uninstaller's existing five-value list, and the forensics found the
/// older product name still carrying an approval entry with **no `Run` value beside it**. Removing
/// only the `Run` values would leave that asymmetry in place on exactly the machines that have it.
#[cfg(windows)]
const DEAD_AUTOSTART_KEYS: [&str; 2] = [
    r"Software\Microsoft\Windows\CurrentVersion\Run",
    r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run",
];

/// **Pro's two historical names, and nothing else.**
///
/// The other edition may still be installed on the same machine, and a cleanup reaching into its
/// values would break its autostart from inside our process. The uninstaller hook three files over
/// does exactly that across a five-value list; that is a recorded defect (T-24), and this list
/// copies its unconditional SHAPE without copying its reach. Pinned by the test below, because a
/// name added here later is the whole failure.
#[cfg(windows)]
const DEAD_AUTOSTART_VALUES: [&str; 2] = ["TrustTunnel", "TrustTunnel Client Pro"];

/// Remove the state the abandoned `Run`-value mechanism left behind, on startup, once.
///
/// **Unconditional by design — there is deliberately no «does it exist?» gate.** A cheap existence
/// check is precisely why legacy installs never received earlier fixes: the check passes on a clean
/// machine, the fix never runs on a dirty one, and nothing distinguishes the two afterwards.
/// Removing something already absent is a success here, by the same rule the disable arm uses.
///
/// Opening the key can fail on a machine that never had either entry; that is not an existence
/// gate on the removals but the handle the removals need, and a value that is simply not there
/// comes back as `NotFound` and is counted as nothing rather than as a refusal.
///
/// Counts go to app.log so a machine where the cleanup is blocked — policy, security software —
/// leaves evidence rather than silence.
pub fn clear_dead_autostart_registry() {
    #[cfg(windows)]
    {
        use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};
        use winreg::RegKey;

        let mut removed = 0usize;
        let mut refused = 0usize;

        for key_path in DEAD_AUTOSTART_KEYS {
            let Ok(key) =
                RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(key_path, KEY_SET_VALUE)
            else {
                continue;
            };
            for value in DEAD_AUTOSTART_VALUES {
                match key.delete_value(value) {
                    Ok(()) => removed += 1,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => {
                        refused += 1;
                        log_app(
                            "warn",
                            &format!(
                                "[autostart] could not remove the dead «{value}» entry under {key_path}: {e}"
                            ),
                        );
                    }
                }
            }
        }

        log_app(
            "info",
            &format!(
                "[autostart] dead Run / startup-approval cleanup: {removed} removed, {refused} refused"
            ),
        );
    }
}

/// Remove the ONE machine-wide logon task the builds before the per-user split registered.
///
/// **Why this is not housekeeping.** That task is registered with highest privileges, it lives
/// in the scheduler's ROOT — outside the per-user folder — and after the split nothing in this
/// application governs it any more: the Settings switch reads and writes a per-user name and
/// cannot see it, so a user who turns autostart OFF would still be started at every logon by a
/// registration no surface mentions. Same shape, same reasoning and same unconditional form as
/// [`clear_dead_autostart_registry`] directly above: a machine that has one is exactly the
/// machine an existence gate would skip.
///
/// Failures are logged, never fatal — startup must not be blocked by a scheduler refusal.
pub fn clear_legacy_global_logon_task() {
    #[cfg(windows)]
    {
        match remove_legacy_root_task() {
            Ok(true) => log_app(
                "info",
                "[autostart] the legacy machine-wide logon task was removed; autostart is \
                 per-user from here on",
            ),
            Ok(false) => {}
            Err(e) => log_app(
                "warn",
                &format!("[autostart] the legacy machine-wide logon task could not be removed: {e}"),
            ),
        }
    }
}

/// What the startup reconcile should do, decided from the persisted choice and the OS state.
///
/// Pure so the decision table is unit-testable without touching the scheduler. The inputs are
/// deliberately only these two:
///
/// - `stored` — the user's persisted choice (`None` = never touched the switch).
/// - `task_present` — does the logon TASK exist, regardless of whether its enabled bit is set.
///
/// The enabled bit is deliberately NOT an input: when the user switches the app off in Task
/// Manager → «Автозагрузка», Windows keeps the task and flips only that bit. The task existing
/// therefore means «the OS-level state is whatever the user last set at the OS level» — and an app
/// that force-re-enables itself against a Task Manager disable on every launch is malware
/// behaviour. We only re-register when the task itself has been REMOVED (the installer signature),
/// never when it merely stands disabled.
///
/// This is the identical rule the registry mechanism lived by, re-sourced: value present → task
/// present, `StartupApproved` flag → the task's enabled bit.
#[derive(Debug, PartialEq, Eq)]
enum ReconcileAction {
    /// The user asked for autostart and the task is gone → register it again.
    ReassertEnable,
    /// Every other combination: no stored opinion, an explicit OFF, or an intact task.
    LeaveAlone,
}

fn reconcile_action(stored: Option<bool>, task_present: bool) -> ReconcileAction {
    match (stored, task_present) {
        (Some(true), false) => ReconcileAction::ReassertEnable,
        _ => ReconcileAction::LeaveAlone,
    }
}

/// Read the effective autostart state for the Settings switch.
///
/// Same semantics the switch always had, re-sourced onto the task: the logon task EXISTS **and**
/// Windows has not disabled it. A task disabled in Task Manager honestly reads OFF here — the
/// switch must not claim a startup that will not happen.
///
/// That conjunction is the whole reason the mechanism changed. Only the component-object interface
/// can answer the second half: a command-line scheduler tool cannot report ENABLED without parsing
/// console output, and console output is unparseable on this platform — Windows hands it back in
/// the OEM code page and localizes it, so any parse keyed on column position grabs the wrong token
/// and then fails safe into looking correct.
///
/// **AND «I COULD NOT FIND OUT» IS NOT «OFF».** The `Err` arm is not decoration and must not be
/// flattened by a caller: it means the scheduler could not be asked at all — the service stopped
/// by policy or by a third-party tuner, an apartment refused, this process's own identity
/// unreadable. Answering `Ok(false)` there would put the switch at OFF while the registered task
/// still starts the application at every logon, which is this feature's own defect class pointed
/// the other way. An absent or a disabled task is still a plain `Ok(false)`; the window renders
/// the error as «не удалось прочитать», never as a position of the switch.
#[tauri::command]
pub fn get_autostart() -> Result<bool, String> {
    #[cfg(windows)]
    {
        // The name is derived from THIS user's SID, so the answer is about this user's own
        // registration. Under the previous single machine-wide name, everyone on a per-machine
        // install read the same task — so the switch showed ON to people whose logon started
        // nothing, which is the exact lie this whole feature exists to end.
        task_is_enabled(&autostart_task_name()?)
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

/// Flip autostart from the Settings switch: the operating system first, then the persisted choice.
///
/// Order matters. The choice is recorded only AFTER the registration succeeded — persisting a
/// choice the OS refused would make the startup reconcile re-assert a state the user never
/// actually reached. A failure is logged to app.log before it surfaces, so a machine where the
/// registration is blocked (policy, security software) leaves evidence instead of only a snackbar.
#[tauri::command]
pub fn set_autostart(enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        if enabled {
            let exe = std::env::current_exe().map_err(|e| {
                let msg = format!("could not resolve this executable's path: {e}");
                log_app("warn", &format!("[autostart] enable failed: {msg}"));
                msg
            })?;
            let limit = register_logon_task(&autostart_task_name()?, &exe).map_err(|msg| {
                // G-32-15: before it is logged or shown, a raw scheduler failure is given its
                // stable code IF the Service Control Manager confirms the Task Scheduler service
                // is down. The owner met this exact path six times in 33 seconds and was told
                // «Попробуйте ещё раз» — the one remedy that could not work. The classification
                // happens here, on the failure, and never on the success path.
                let msg = explain_scheduler_failure(msg);
                log_app("warn", &format!("[autostart] enable failed: {msg}"));
                msg
            })?;
            log_app(
                "info",
                &format!("[autostart] enabled (logon task registered, ExecutionTimeLimit={limit})"),
            );
        } else {
            // `delete_task` already treats «already absent» as a success — absent IS the requested
            // state, the same rule the Run-value disable arm lived by when an installer had wiped
            // the value while the switch still showed ON. Only a task verifiably still present
            // after a failed delete reaches here as an error.
            delete_task(&autostart_task_name()?).map_err(|msg| {
                // The same classification as the enable arm. Switching autostart OFF against a
                // stopped scheduler fails for exactly the same reason and deserves exactly the
                // same sentence — the defect is the message, and it is symmetric.
                let msg = explain_scheduler_failure(msg);
                log_app("warn", &format!("[autostart] disable failed: {msg}"));
                msg
            })?;
            log_app("info", "[autostart] disabled (logon task removed)");
        }
    }
    // Losing the choice file is logged but does not fail the toggle: the scheduler — what actually
    // governs the next logon — is already in the requested state.
    if let Err(e) = app_settings::set_autostart_choice(enabled) {
        log_app("warn", &format!("[autostart] choice not persisted: {e}"));
    }
    Ok(())
}

/// Startup reconcile: put the logon task back if an installer removed it (the bug).
///
/// Runs on every launch from `.setup()`. Decision table in [`reconcile_action`]; the only case
/// that acts is «the user asked for autostart AND the task is gone». Failures are logged and
/// swallowed — startup must never be blocked by a scheduler refusal, and the switch will honestly
/// show OFF on the next Settings visit.
pub fn reconcile_autostart_on_startup() {
    let stored = app_settings::load_app_settings().autostart_enabled;

    #[cfg(windows)]
    let Ok(task_name) = autostart_task_name() else {
        // Without an identity there is no per-user task name to reconcile against, and
        // reconciling against a guess would be worse than not reconciling: it could register a
        // second, mis-attributed task. The switch reads honestly on the next Settings visit.
        log_app(
            "warn",
            "[autostart] the startup reconcile was skipped: this process's user could not be \
             determined, so there is no per-user task name to check",
        );
        return;
    };

    #[cfg(windows)]
    let present = task_exists(&task_name);
    #[cfg(not(windows))]
    let present = true; // non-Windows builds have no logon task to reconcile

    match reconcile_action(stored, present) {
        ReconcileAction::ReassertEnable => {
            #[cfg(windows)]
            {
                let outcome = std::env::current_exe()
                    .map_err(|e| format!("could not resolve this executable's path: {e}"))
                    .and_then(|exe| register_logon_task(&task_name, &exe));
                match outcome {
                    Ok(limit) => log_app(
                        "info",
                        &format!("[autostart] the logon task was missing while the stored choice is ON — re-registered (installer wipe recovery, ExecutionTimeLimit={limit})"),
                    ),
                    // Classified for the LOG, which is the only surface this path has — the
                    // reconcile runs at startup with nobody looking. The app.log carried
                    // this exact line at 17:08:54 with a bare `0x80070003`, and reading it took a
                    // person who already knew what that HRESULT meant on a machine whose scheduler
                    // was off. Now the line says so itself.
                    Err(e) => log_app(
                        "warn",
                        &format!(
                            "[autostart] failed to re-register the missing logon task: {}",
                            explain_scheduler_failure(e)
                        ),
                    ),
                }
            }
        }
        ReconcileAction::LeaveAlone => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The one case that acts: the user asked for autostart and the installer removed the task.
    /// This is the bug as a unit test — on the pre-fix tree nothing re-asserted anything.
    #[test]
    fn a_stored_on_with_a_wiped_run_entry_is_reasserted() {
        assert_eq!(
            reconcile_action(Some(true), false),
            ReconcileAction::ReassertEnable
        );
    }

    /// An INTACT task is never touched, even with a stored ON. This is the Task-Manager case:
    /// Windows disables startup by flipping the task's enabled bit and KEEPING the task, so
    /// «task present» may mean «user disabled it at the OS level» — re-registering over that on
    /// every launch would be malware behaviour.
    #[test]
    fn a_present_run_entry_is_left_alone_even_when_the_stored_choice_is_on() {
        assert_eq!(
            reconcile_action(Some(true), true),
            ReconcileAction::LeaveAlone
        );
    }

    /// «Never touched» must stay never-touched: no stored opinion → no OS writes, in either
    /// state. Inventing an ON here would enrol every fresh install into autostart.
    #[test]
    fn no_stored_choice_never_acts() {
        assert_eq!(reconcile_action(None, false), ReconcileAction::LeaveAlone);
        assert_eq!(reconcile_action(None, true), ReconcileAction::LeaveAlone);
    }

    /// An explicit OFF never acts either — including when a task is present (the user may have
    /// re-created it by hand at the OS level; their most recent word wins over our stored one).
    #[test]
    fn an_explicit_off_never_acts() {
        assert_eq!(
            reconcile_action(Some(false), false),
            ReconcileAction::LeaveAlone
        );
        assert_eq!(
            reconcile_action(Some(false), true),
            ReconcileAction::LeaveAlone
        );
    }

    /// The cleanup reaches Pro's two historical names and NOTHING else.
    ///
    /// Asserted as an exact list rather than as «does not contain X», because the failure being
    /// guarded is a name being ADDED later — and an exclusion test only ever catches the exclusions
    /// somebody already thought of. The other edition may be installed on the same machine, and a
    /// removal reaching into its values would break its autostart from inside our process. That is
    /// the T-24 defect the uninstaller hook still carries; this list copies its unconditional shape
    /// and not its reach.
    #[cfg(windows)]
    #[test]
    fn the_cleanup_names_only_pros_two_historical_names() {
        // The exact list, and nothing derived from it (WR-04). A follow-up
        // `.all(|v| v.starts_with("TrustTunnel") && !v.to_ascii_lowercase().contains("ligh"))`
        // used to sit here and could not fail: with the list pinned above, it walks two known
        // literals. It read as the exclusion this test is named for while asserting nothing —
        // the exclusion IS the pin, because any name that could belong to the other edition
        // reddens the exact list first. The textual half of this property, which a Rust
        // assertion genuinely cannot reach, is hygiene rule 22: it scans the module's production
        // body for the other edition's names spelled ANYWHERE, constant or not.
        assert_eq!(
            DEAD_AUTOSTART_VALUES,
            ["TrustTunnel", "TrustTunnel Client Pro"],
            "the cleanup must name exactly Pro's two historical names"
        );
    }

    /// Two key classes times two names is four removal sites, and the second key class is the one
    /// that is easy to forget: the startup-approval entries are not in the uninstaller's existing
    /// value list, and the forensics found the older name carrying an approval entry with
    /// no `Run` value beside it.
    #[cfg(windows)]
    #[test]
    fn the_cleanup_covers_both_key_classes_for_both_names() {
        // WR-04. This used to open with `DEAD_AUTOSTART_KEYS.len() * DEAD_AUTOSTART_VALUES.len()
        // == 4` over two `[&str; 2]` constants — the lengths are IN THE TYPES, so it could not
        // fail however wrong the contents became. It is deleted rather than reworded: «four» is a
        // type-level fact and the array types already carry it.
        //
        // What is asserted instead is the thing the count was standing in for and never checked:
        // that the two classes are two DIFFERENT entries. The pair of `any()` calls that used to
        // follow can both be satisfied by ONE entry — a key ending `CurrentVersion\Run` that also
        // contains `StartupApproved` — leaving the other entry completely unconstrained. That is
        // two removal sites wearing the shape of four, which is exactly the asymmetry this test
        // exists to refuse: the forensics found the older name carrying an approval entry
        // with no `Run` value beside it.
        let run_class = DEAD_AUTOSTART_KEYS
            .iter()
            .position(|k| k.ends_with(r"CurrentVersion\Run"));
        let approval_class = DEAD_AUTOSTART_KEYS
            .iter()
            .position(|k| k.contains("StartupApproved"));
        assert!(run_class.is_some(), "the dead Run values must be covered");
        assert!(
            approval_class.is_some(),
            "the startup-approval entries must be covered — they are not in the uninstaller's list"
        );
        assert_ne!(
            run_class, approval_class,
            "the two key classes must be two DIFFERENT entries: one entry satisfying both leaves \
             the other unconstrained, which is two removal sites, not four"
        );
    }
}
