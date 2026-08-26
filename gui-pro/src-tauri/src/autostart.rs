//! Autostart («Запуск вместе с системой») — the Rust-side write path and the startup reconcile.
//!
//! ## Why this module exists (owner bug 2026-08-26: «autostart does not work»)
//!
//! Until this module, the switch wrote through the JS side of `tauri-plugin-autostart` via a
//! dynamic `import("@tauri-apps/plugin-autostart")`, and the ONLY record of the user's choice was
//! the `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` value itself. That design has two
//! failure modes, both observed on a real Windows install:
//!
//! 1. **The choice evaporates.** Tauri's NSIS uninstaller deletes exactly that Run value whenever
//!    it runs outside update mode — a version-upgrade install, a full uninstall→reinstall cycle,
//!    or the «Удалить перед установкой» radio on a same-version reinstall. Registry forensics
//!    showed the wipe signature precisely: the `StartupApproved\Run` companion values written by
//!    `auto-launch::enable()` were still present and «enabled» (for BOTH historical product names),
//!    while the Run values were gone. Nothing re-asserted the choice, so the app silently stopped
//!    starting with Windows and the switch read OFF again. The fix: persist the choice in
//!    `app_settings.json` (which survives reinstalls) and re-assert the registry entry at startup
//!    when it has been wiped — see [`reconcile_autostart_on_startup`].
//!
//! 2. **The row was untestable.** The dynamic plugin import collided with the vitest harness
//!    (`restoreMocks: true` strips a module mock's resolved values — the 28-06 trap), so no test
//!    could drive a write through the autostart switch. Moving the write behind plain Tauri
//!    commands makes the row exactly like «Запускать в свёрнутом режиме»: mockable through
//!    `invoke`, testable like every other row.
//!
//! The `tauri-plugin-autostart` RUST side stays: its `AutoLaunchManager` (via `ManagerExt`) is
//! still the single writer of the Run + `StartupApproved\Run` pair. Only the JS entry point moved.

use tauri_plugin_autostart::ManagerExt;

use crate::app_settings;
use crate::logging::log_app;

#[cfg(windows)]
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

/// What the startup reconcile should do, decided from the persisted choice and the registry state.
///
/// Pure so the decision table is unit-testable without a registry. The inputs are deliberately
/// only these two:
///
/// - `stored` — the user's persisted choice (`None` = never touched the switch).
/// - `run_entry_present` — does the `Run` VALUE exist, regardless of the
///   `StartupApproved\Run` enable/disable flag next to it.
///
/// The `StartupApproved` flag is deliberately NOT an input: when the user disables the app in
/// Task Manager → «Автозагрузка», Windows keeps the Run value and flips only that flag. The Run
/// value being present therefore means «the OS-level state is whatever the user last set at the
/// OS level» — and an app that force-re-enables itself against a Task Manager disable on every
/// launch is malware behaviour. We only re-assert when the value itself has been WIPED (the
/// installer signature), never when it merely stands disabled.
#[derive(Debug, PartialEq, Eq)]
enum ReconcileAction {
    /// The user asked for autostart and the Run value is gone → re-create it.
    ReassertEnable,
    /// Every other combination: no stored opinion, an explicit OFF, or an intact entry.
    LeaveAlone,
}

fn reconcile_action(stored: Option<bool>, run_entry_present: bool) -> ReconcileAction {
    match (stored, run_entry_present) {
        (Some(true), false) => ReconcileAction::ReassertEnable,
        _ => ReconcileAction::LeaveAlone,
    }
}

/// Does the HKCU `Run` value for this app exist at all (enabled OR Task-Manager-disabled)?
///
/// Distinct from `AutoLaunchManager::is_enabled()`, which ANDs the value's presence with the
/// `StartupApproved` flag — the reconcile needs the raw presence, see [`ReconcileAction`].
#[cfg(windows)]
fn run_entry_present(app_name: &str) -> bool {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(RUN_KEY, KEY_READ)
        .and_then(|key| key.get_raw_value(app_name))
        .is_ok()
}

/// Rewrite the Run value as a QUOTED command line, best-effort.
///
/// `auto-launch` 0.5.0 writes `{path} {args}` unquoted — for this app that is an install path
/// with spaces plus a trailing space. Windows' CreateProcess fallback does resolve unquoted
/// spaced paths today (several other apps on a test machine autostart exactly like that), so this
/// is hardening, not the bug fix: an unquoted spaced path is the classic binary-planting shape
/// (`C:\Users\x\AppData\Local\TrustTunnel.exe` would win over the real exe), and quoting removes
/// the ambiguity. Best-effort by design — if this rewrite fails the unquoted value still works,
/// so a failure here must not fail the user's toggle.
///
/// NOTE: this app registers no autostart args (`init(…, None)` in `lib.rs`). If args are ever
/// added there, this rewrite must learn to append them after the quoted path.
#[cfg(windows)]
fn quote_run_value(app_name: &str) {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};
    use winreg::RegKey;
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let quoted = format!("\"{}\"", exe.display());
    if let Ok(key) =
        RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(RUN_KEY, KEY_SET_VALUE)
    {
        if let Err(e) = key.set_value(app_name, &quoted) {
            log_app(
                "warn",
                &format!("[autostart] could not quote the Run value (entry still works unquoted): {e}"),
            );
        }
    }
}

/// Read the effective autostart state for the Settings switch.
///
/// Same semantics the switch always had (`isEnabled()` from the JS plugin): the Run value exists
/// AND Windows has not disabled it via Task Manager. A Task-Manager-disabled entry honestly reads
/// OFF here — the switch must not claim a startup that will not happen.
#[tauri::command]
pub fn get_autostart(app: tauri::AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

/// Flip autostart from the Settings switch: registry first, then the persisted choice.
///
/// Order matters. The choice is recorded only AFTER the registry write succeeded — persisting a
/// choice the OS refused would make the startup reconcile re-assert a state the user never
/// actually reached. A failure is logged to app.log before it surfaces, so a machine where the
/// write is blocked (AV registry protection, policy) leaves evidence instead of only a snackbar.
#[tauri::command]
pub fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|e| {
            let msg = e.to_string();
            log_app("warn", &format!("[autostart] enable failed: {msg}"));
            msg
        })?;
        #[cfg(windows)]
        quote_run_value(&app.package_info().name);
        log_app("info", "[autostart] enabled (Run entry written)");
    } else {
        if let Err(e) = manager.disable() {
            // `auto-launch::disable()` is delete_value(), which errors when the value is already
            // absent — e.g. an installer wiped it while the switch still showed ON. Absent IS the
            // requested state, so only a value that is verifiably still present is a failure.
            match manager.is_enabled() {
                Ok(false) => {}
                _ => {
                    let msg = e.to_string();
                    log_app("warn", &format!("[autostart] disable failed: {msg}"));
                    return Err(msg);
                }
            }
        }
        log_app("info", "[autostart] disabled (Run entry removed)");
    }
    // Losing the choice file is logged but does not fail the toggle: the registry — what actually
    // governs the next boot — is already in the requested state.
    if let Err(e) = app_settings::set_autostart_choice(enabled) {
        log_app("warn", &format!("[autostart] choice not persisted: {e}"));
    }
    Ok(())
}

/// Startup reconcile: put the Run entry back if an installer wiped it (the bug).
///
/// Runs on every launch from `.setup()`. Decision table in [`reconcile_action`]; the only case
/// that acts is «the user asked for autostart AND the Run value is gone». Failures are logged and
/// swallowed — startup must never be blocked by a registry refusal, and the switch will honestly
/// show OFF on the next Settings visit.
pub fn reconcile_autostart_on_startup(app: &tauri::AppHandle) {
    let stored = app_settings::load_app_settings().autostart_enabled;

    #[cfg(windows)]
    let present = run_entry_present(&app.package_info().name);
    #[cfg(not(windows))]
    let present = true; // non-Windows builds have no Run key to reconcile

    match reconcile_action(stored, present) {
        ReconcileAction::ReassertEnable => match app.autolaunch().enable() {
            Ok(()) => {
                #[cfg(windows)]
                quote_run_value(&app.package_info().name);
                log_app(
                    "info",
                    "[autostart] Run entry was missing while the stored choice is ON — re-asserted (installer wipe recovery)",
                );
            }
            Err(e) => log_app(
                "warn",
                &format!("[autostart] failed to re-assert the wiped Run entry: {e}"),
            ),
        },
        ReconcileAction::LeaveAlone => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The one case that acts: the user asked for autostart and the installer wiped the entry.
    /// This is the bug as a unit test — on the pre-fix tree nothing re-asserted anything.
    #[test]
    fn a_stored_on_with_a_wiped_run_entry_is_reasserted() {
        assert_eq!(
            reconcile_action(Some(true), false),
            ReconcileAction::ReassertEnable
        );
    }

    /// An INTACT entry is never touched, even with a stored ON. This is the Task-Manager case:
    /// Windows disables startup by flipping `StartupApproved` and KEEPING the Run value, so
    /// «value present» may mean «user disabled it at the OS level» — re-enabling over that on
    /// every launch would be malware behaviour.
    #[test]
    fn a_present_run_entry_is_left_alone_even_when_the_stored_choice_is_on() {
        assert_eq!(
            reconcile_action(Some(true), true),
            ReconcileAction::LeaveAlone
        );
    }

    /// «Never touched» must stay never-touched: no stored opinion → no registry writes, in either
    /// registry state. Inventing an ON here would enrol every fresh install into autostart.
    #[test]
    fn no_stored_choice_never_acts() {
        assert_eq!(reconcile_action(None, false), ReconcileAction::LeaveAlone);
        assert_eq!(reconcile_action(None, true), ReconcileAction::LeaveAlone);
    }

    /// An explicit OFF never acts either — including when an entry is present (the user may have
    /// re-added it by hand at the OS level; their most recent word wins over our stored one).
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
}
