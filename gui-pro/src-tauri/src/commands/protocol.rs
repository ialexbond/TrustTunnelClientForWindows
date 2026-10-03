//! Register trusttunnel:// and tt:// URL protocol handlers in the Windows registry.
//! Uses HKEY_CURRENT_USER (no admin rights needed).
//!
//! Strategy: register the app EXE DIRECTLY as the handler (`"<exe>" "%1"`). A clicked
//! `tt://` link then makes the browser/OS prompt show the app name («Открыть TrustTunnel
//! Client Pro?») — NOT powershell.exe. (The previous design registered a hidden
//! powershell.exe one-liner that wrote the URL to a file; for a VPN app, a browser prompt
//! to "open Windows PowerShell" reads as malware and scared users off — 06-uat.) The URL
//! reaches the running app via the single-instance handler (warm start) or via argv on a
//! cold start (`capture_cold_start_deeplink` writes `.pending_deeplink`, drained by the
//! frontend's startup poll once its listener is attached).

#[cfg(windows)]
use winreg::enums::HKEY_CURRENT_USER;
#[cfg(windows)]
use winreg::RegKey;

/// Path where an incoming deep-link URL is staged for the frontend's startup poll
/// (`poll_pending_deeplink`). Lives in the per-user data root.
///
/// D-03 C: this doc comment used to read "lives next to the exe (per-user install dir,
/// writable)". That premise DIED when the install moved to Program Files — the install
/// directory is no longer a per-user writable location — and a comment that outlives its premise
/// is precisely how the next reader puts the file back where it cannot be written. The staging
/// file is user-written runtime state, so it moves with the rest of the data.
fn deeplink_pending_path() -> std::path::PathBuf {
    crate::ssh::user_data_dir().join(".pending_deeplink")
}

/// Cold-start capture: if THIS process was launched by the protocol handler
/// (`"<exe>" "%1"`), the URL is in our own argv. Stage it in `.pending_deeplink` so the
/// frontend's startup poll (`useDeepLinkImport` channel 2) drains it AFTER its listener
/// is attached — avoiding the emit-before-listener race. Warm start (an already-running
/// instance) is handled by the single-instance handler instead, so this only fires on a
/// genuine cold launch. Best-effort; returns the captured URL if any.
pub fn capture_cold_start_deeplink() -> Option<String> {
    let url = std::env::args()
        .find(|a| a.starts_with("trusttunnel://") || a.starts_with("tt://"))?;
    let _ = std::fs::write(deeplink_pending_path(), &url);
    Some(url)
}

/// Register a URL protocol scheme pointing DIRECTLY at the app exe (`"<exe>" "%1"`), so
/// the OS handler-prompt shows the app — not powershell.exe. HKCU = no UAC.
#[cfg(windows)]
fn register_protocol(scheme: &str, exe_path: &str) -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let class_path = format!("Software\\Classes\\{scheme}");

    let (key, _) = hkcu
        .create_subkey(&class_path)
        .map_err(|e| format!("Failed to create registry key: {e}"))?;

    key.set_value("", &format!("URL:{scheme} Protocol"))
        .map_err(|e| format!("Failed to set default value: {e}"))?;
    key.set_value("URL Protocol", &"")
        .map_err(|e| format!("Failed to set URL Protocol: {e}"))?;

    let (cmd_key, _) = hkcu
        .create_subkey(format!("{class_path}\\shell\\open\\command"))
        .map_err(|e| format!("Failed to create command key: {e}"))?;

    // Launch the app directly with the URL as %1. The running app receives it via the
    // single-instance handler (warm) or argv at startup (cold). Quoted so a path with
    // spaces is one argument.
    cmd_key
        .set_value("", &build_protocol_command(exe_path))
        .map_err(|e| format!("Failed to set command: {e}"))?;

    Ok(())
}

/// The registry `shell\open\command` value for a scheme: the app exe launched directly
/// with the URL as `%1`. Pure (testable) — locks the "direct exe, never powershell"
/// contract so the malware-looking «Открыть Windows PowerShell?» prompt cannot regress.
#[cfg(windows)]
fn build_protocol_command(exe_path: &str) -> String {
    format!("\"{exe_path}\" \"%1\"")
}

/// Check if a URL protocol is registered.
#[cfg(windows)]
fn is_protocol_registered(scheme: &str) -> bool {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let class_path = format!("Software\\Classes\\{scheme}\\shell\\open\\command");
    hkcu.open_subkey(&class_path).is_ok()
}

/// Register both trusttunnel:// and tt:// protocols.
#[tauri::command]
pub fn register_url_protocols() -> Result<String, String> {
    #[cfg(windows)]
    {
        let exe = std::env::current_exe()
            .map_err(|e| format!("Failed to get exe path: {e}"))?;
        let exe_path = exe.to_string_lossy().to_string();

        // Always (re)write the command — this MIGRATES installs whose registry still holds
        // the old powershell.exe handler to the direct-exe command. create_subkey +
        // set_value overwrites; it is idempotent and cheap, so no is_protocol_registered
        // short-circuit (that guard is exactly why legacy installs never got the fix).
        for scheme in &["trusttunnel", "tt"] {
            register_protocol(scheme, &exe_path)?;
        }

        Ok("Registered: trusttunnel, tt".into())
    }

    #[cfg(not(windows))]
    {
        Ok("URL protocol registration not supported on this platform".into())
    }
}

/// Check if protocols are registered.
#[tauri::command]
pub fn check_url_protocols() -> bool {
    #[cfg(windows)]
    {
        is_protocol_registered("trusttunnel") && is_protocol_registered("tt")
    }

    #[cfg(not(windows))]
    {
        false
    }
}

/// Poll for pending deep-link URL (written by the protocol handler).
/// Returns the URL and deletes the file, or None if no pending URL.
#[tauri::command]
pub fn poll_pending_deeplink() -> Option<String> {
    // D-03 C: reads through the SAME helper the writer uses. This site used to re-derive the
    // path from `current_exe()`, so writer and reader were two independent answers to "where is
    // the staging file" — a drift that would present as deep links silently never arriving.
    let pending = deeplink_pending_path();
    if pending.exists() {
        let url = std::fs::read_to_string(&pending).ok()?;
        let _ = std::fs::remove_file(&pending);
        let trimmed = url.trim().to_string();
        if trimmed.starts_with("trusttunnel://") || trimmed.starts_with("tt://") {
            Some(trimmed)
        } else {
            None
        }
    } else {
        None
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    // 06-uat regression: the protocol handler must launch the app DIRECTLY, never via
    // powershell.exe — a clicked tt:// link prompting «Открыть Windows PowerShell?» reads
    // as malware for a VPN app and scared users off.
    #[test]
    fn protocol_command_launches_exe_directly_not_powershell() {
        let cmd = build_protocol_command(r"C:\Users\me\AppData\Local\TrustTunnel\trusttunnel.exe");
        assert!(
            cmd.to_lowercase().contains("trusttunnel.exe"),
            "command must launch the app exe directly"
        );
        assert!(cmd.contains("\"%1\""), "command must pass the URL as %1");
        assert!(
            !cmd.to_lowercase().contains("powershell"),
            "command must NEVER route through powershell"
        );
    }

    #[test]
    fn protocol_command_quotes_a_path_with_spaces() {
        let cmd = build_protocol_command(r"C:\Program Files\TrustTunnel Client Pro\trusttunnel.exe");
        // The exe path is quoted as one argument, then a separate quoted %1.
        assert!(cmd.starts_with("\"C:\\Program Files\\TrustTunnel Client Pro\\trusttunnel.exe\""));
        assert!(cmd.ends_with("\"%1\""));
    }

    // ── D-03 item 4 / phase 32: the handler is WATCHED, not merely believed ──────
    //
    // D-03 item 4 asked to verify first and only then decide whether there was
    // anything to do. The verdict, re-checked against this file: the registration is
    // called unconditionally from the startup hook, `register_url_protocols` loops both
    // schemes and overwrites with no short-circuit, and `is_protocol_registered` is used
    // only by the read-only `check_url_protocols`. **The code is correct, and phase 32
    // changed none of it.** The finding is that there was nothing to fix.
    //
    // What was missing is anything watching that it STAYS correct now that the
    // executable's path changes underneath it (32-01 moved the install to Program
    // Files). If the write path ever short-circuits on an existing key, every handler
    // registered before the move stays frozen at a path that no longer exists — and it
    // would be a silent, permanent regression, because the guard that causes it looks
    // like an optimisation. That is not hypothetical: it is the exact mistake this
    // module's own comment records, and the reason legacy installs never received the
    // direct-exe fix.
    //
    // The three arms below are SOURCE-SHAPE assertions, bound at compile time by
    // `include_str!`, so changing the code without changing the rule cannot leave them
    // green. Each locates its subject first and fails as CANNOT MEASURE when it is
    // absent — a scan that has lost its subject must never report PASS.

    /// This module's own source, bound at compile time.
    const PROTOCOL_SRC: &str = include_str!("protocol.rs");
    /// The bootstrap that calls the registration on every launch.
    const BOOTSTRAP_SRC: &str = include_str!("../lib.rs");

    /// Blank out `//` comments so a rule cannot trip over the file's own PROSE about
    /// the very thing it forbids: this module explains at length why there is no
    /// `is_protocol_registered` short-circuit, and arm 1 scans for exactly that name.
    ///
    /// Line-based and deliberately conservative — it also truncates at a `//` that
    /// happens to sit inside a string literal. That can only ever hide code from a
    /// scan, never invent a match, so it cannot produce a false accusation; and the
    /// locate-or-fail check in each arm catches the case where it hid the subject.
    /// Line COUNT is preserved so indices still line up with the real file.
    fn without_comments(src: &str) -> String {
        src.lines()
            .map(|l| match l.find("//") {
                Some(i) => &l[..i],
                None => l,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The source of the top-level item introduced by `signature`, up to the first
    /// column-0 `}` — the shape rustfmt guarantees for a top-level item. `None` when
    /// the signature is absent; every caller must report that as an inability to
    /// measure rather than as an absence of violations.
    fn item_body<'a>(src: &'a str, signature: &str) -> Option<&'a str> {
        let start = src.find(signature)?;
        let rest = &src[start..];
        let end = rest.find("\n}")? + 2;
        Some(&rest[..end])
    }

    // Arm 1 — no exists-check may appear on the WRITE path. `check_url_protocols` may
    // and does call the probe; it is read-only. The scan is therefore scoped to the two
    // functions that write, not to the file.
    #[test]
    fn the_registration_write_path_has_no_existence_check() {
        let src = without_comments(PROTOCOL_SRC);
        for signature in ["pub fn register_url_protocols()", "fn register_protocol("] {
            let body = item_body(&src, signature).unwrap_or_else(|| {
                panic!(
                    "CANNOT MEASURE: `{signature}` was not found in commands/protocol.rs. \
                     The rule lost its subject — it was renamed or moved. That is not the \
                     same as having no violations, so this fails rather than passing."
                )
            });
            assert!(
                !body.contains("is_protocol_registered"),
                "`{signature}` must never short-circuit on an already-registered key. A \
                 cheap exists-check is exactly why legacy installs never received the \
                 direct-exe fix (see this module's own comment), and after the phase-32 \
                 relocation it would freeze every handler at an executable path that no \
                 longer exists. Offending body:\n{body}"
            );
        }
    }

    // Arm 2 — the command string must keep being derived from the RUNNING executable.
    // A stored, configured or hardcoded path would survive the relocation as a stale
    // value; `current_exe()` is what makes re-registration self-correcting (T-32-13).
    #[test]
    fn the_registered_command_is_built_from_the_running_executable() {
        let src = without_comments(PROTOCOL_SRC);

        let registrar = item_body(&src, "pub fn register_url_protocols()").unwrap_or_else(|| {
            panic!(
                "CANNOT MEASURE: `register_url_protocols` was not found in \
                 commands/protocol.rs — the rule lost its subject."
            )
        });
        assert!(
            registrar.contains("std::env::current_exe()"),
            "the exe path handed to the registration must come from the RUNNING \
             executable, so that a launch from the new install directory rewrites the \
             handler by itself. Offending body:\n{registrar}"
        );

        let writer = item_body(&src, "fn register_protocol(").unwrap_or_else(|| {
            panic!(
                "CANNOT MEASURE: `register_protocol` was not found in \
                 commands/protocol.rs — the rule lost its subject."
            )
        });
        assert!(
            writer.contains("build_protocol_command(exe_path)"),
            "the value written to shell\\open\\command must be the pure builder's \
             output applied to that path, not a literal assembled at the write site. \
             Offending body:\n{writer}"
        );
    }

    // Arm 3 — the startup call must stay UNCONDITIONAL. Re-registering on every launch
    // is what migrates an install across the relocation; behind any condition
    // («only if not registered», «only on first run») the migration stops happening.
    //
    // Measured structurally: the spawn that carries the call must sit at the same block
    // depth as a known unconditional sibling in the same closure, and must not be
    // preceded by a line that opens a condition. Wrapping it in `if` would indent it.
    #[test]
    fn the_startup_registration_call_is_unconditional() {
        let src = without_comments(BOOTSTRAP_SRC);
        let lines: Vec<&str> = src.lines().collect();
        let indent = |l: &str| l.len() - l.trim_start().len();

        let call = lines
            .iter()
            .position(|l| l.contains("commands::protocol::register_url_protocols()"))
            .unwrap_or_else(|| {
                panic!(
                    "CANNOT MEASURE: lib.rs never calls `register_url_protocols`. Either \
                     the startup registration was deleted — in which case no install ever \
                     migrates again — or it was renamed and this rule lost its subject."
                )
            });

        let spawn = lines[..call]
            .iter()
            .rposition(|l| l.contains("std::thread::spawn("))
            .unwrap_or_else(|| {
                panic!(
                    "CANNOT MEASURE: the call to `register_url_protocols` is no longer \
                     inside a `std::thread::spawn(` — the rule's structural assumption \
                     no longer holds, so it cannot judge conditionality."
                )
            });

        // A statement known to be unconditional in the same closure, used as the
        // reference depth. If IT moves, this rule reports that it cannot measure.
        let sibling = lines
            .iter()
            .position(|l| l.contains("commands::protocol::capture_cold_start_deeplink()"))
            .unwrap_or_else(|| {
                panic!(
                    "CANNOT MEASURE: the unconditional sibling call \
                     `capture_cold_start_deeplink` is gone from lib.rs, so there is no \
                     reference block depth left to compare against."
                )
            });

        assert_eq!(
            indent(lines[spawn]),
            indent(lines[sibling]),
            "the registration spawn is nested deeper than its unconditional sibling, so \
             something now guards it. Re-registration must run on EVERY launch — that is \
             the only thing that migrates an install whose handler still points at the \
             pre-relocation path.\n  spawn:   {}\n  sibling: {}",
            lines[spawn],
            lines[sibling]
        );

        let preceding = lines[..spawn]
            .iter()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or_else(|| {
                panic!("CANNOT MEASURE: nothing precedes the registration spawn in lib.rs.")
            });
        for opener in ["if ", "if let ", "match ", "while ", "else"] {
            assert!(
                !preceding.trim_start().starts_with(opener),
                "the registration spawn is preceded by `{opener}`, so it appears to be \
                 guarded. It must run on every launch.\n  preceding line: {preceding}"
            );
        }
    }
}
