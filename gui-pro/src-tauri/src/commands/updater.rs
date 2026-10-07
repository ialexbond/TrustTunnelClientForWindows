use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Emitter;
use tauri::Manager;
use url::Url;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

use super::vpn::{AppState, kill_sidecar_from_state};
use crate::ssh;

#[derive(Clone, Serialize)]
struct UpdateProgress {
    stage: String,
    percent: u32,
    message: String,
}

/// Validate download URL is from trusted domains only.
///
/// SEC-03: parse with the `url` crate (reqwest's own URL parser) and check the
/// parsed `.host_str()` instead of hand-rolling string splits. The old
/// `trim_start_matches("https://").split('/').next()` parser read everything
/// before the first `/` as the host, so `https://github.com@evil.com/x` was
/// accepted (it saw host `github.com@evil.com`, then matched the `github.com`
/// prefix logic) — a userinfo/@-bypass. `url::Url::host_str()` resolves the
/// authority correctly (it strips the `user@` userinfo and separates the port),
/// so the host of that URL is `evil.com` and the allow-list rejects it.
fn validate_download_url(url: &str) -> Result<(), String> {
    let allowed_hosts = ["github.com", "objects.githubusercontent.com"];
    let parsed = Url::parse(url).map_err(|_| "Invalid download URL".to_string())?;
    if parsed.scheme() != "https" {
        return Err("Download URL must use HTTPS".into());
    }
    let host = parsed
        .host_str()
        .ok_or("Download URL has no host")?
        .to_lowercase();
    if !allowed_hosts.iter().any(|d| host == *d || host.ends_with(&format!(".{d}"))) {
        return Err(format!("Downloads only allowed from: {}", allowed_hosts.join(", ")));
    }
    Ok(())
}

/// Pure integrity gate — fail-CLOSED (SEC-01 / G-2).
///
/// An empty/missing expected hash is a HARD reject. Previously `self_update`
/// SKIPPED verification when the checksum was empty (only a stderr warning),
/// which meant a missing checksum led to a silently-unverified, elevated `.exe`
/// install. This helper makes that impossible: it returns `Ok(())` ONLY on an
/// exact case-insensitive match of a well-formed 64-char hex SHA-256 digest.
///
/// Error codes (opaque strings consumed by the frontend update flow):
/// - `UPDATE_CHECKSUM_MISSING`   — empty / whitespace-only expected hash.
/// - `UPDATE_CHECKSUM_MALFORMED` — not exactly 64 ASCII hex chars.
/// - `UPDATE_CHECKSUM_MISMATCH`  — well-formed but does not match the bytes.
///
/// Pure (no I/O) so it is unit-testable under `cargo test --lib` without a real
/// network download or admin rights — mirrors the existing pure-helper test
/// pattern in this file (e.g. `validate_download_url`).
fn verify_checksum(file_bytes: &[u8], expected_sha256: &str) -> Result<(), String> {
    let expected = expected_sha256.trim();
    if expected.is_empty() {
        return Err("UPDATE_CHECKSUM_MISSING".into());
    }
    // A SHA-256 hex digest is exactly 64 hex chars — anything else is malformed.
    if expected.len() != 64 || !expected.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("UPDATE_CHECKSUM_MALFORMED".into());
    }
    let actual = format!("{:x}", Sha256::digest(file_bytes));
    if !actual.eq_ignore_ascii_case(expected) {
        return Err("UPDATE_CHECKSUM_MISMATCH".into());
    }
    Ok(())
}

/// Build an unguessable per-run updater temp dir NAME (SEC-05/06 TOCTOU).
///
/// The four updater artifacts (setup.exe / .bat / .vbs / .ps1) used to live in
/// `%TEMP%` under predictable fixed names, so a local attacker able to write the
/// world-writable temp dir could pre-stage / swap a file that then ran elevated
/// (classic time-of-check/time-of-use race). A fresh `tt_update_<uuid>` dir per
/// run has an unpredictable name, removing the pre-stage window for all four
/// artifacts at once. Extracted as a pure name-builder so the uniqueness
/// property is unit-testable without touching the filesystem.
fn make_run_dir_name() -> String {
    format!("tt_update_{}", uuid::Uuid::new_v4().simple())
}

/// Build the updater `.bat` body (pure — no I/O, so the cleanup contract is
/// unit-testable).
///
/// Review be-1 (resource leak): the previous tail ran a NON-recursive
/// `rmdir "{run_dir}"` while the still-executing `.bat` (and a possibly still-open
/// `loader.ps1`) physically lived inside `run_dir`. A non-empty dir makes
/// `rmdir` fail, so every successful update orphaned an empty `tt_update_<uuid>`
/// dir in `%TEMP%` (a slow temp-space leak introduced by the per-run-UUID TOCTOU
/// fix — before that, artifacts lived directly in `%TEMP%` with no dir to
/// orphan).
///
/// Fix: the `.bat` deletes the artifacts it safely can, then spawns a DETACHED
/// `cmd` that waits a few seconds and recursively (`rmdir /S /Q`) removes the
/// WHOLE run_dir — including the now-finished `.bat` and any released
/// `loader.ps1`. The detached process outlives the `.bat`'s own self-delete, so
/// the directory is reliably reclaimed. A best-effort start-time sweep
/// (`sweep_stale_update_dirs`) is the belt-and-suspenders for the rare case the
/// delayed cleanup loses a race with the 30s loader window.
///
/// D-10.3 (the relaunch across the relocation): the batch is written BEFORE the
/// installer runs, so `app_str` — composed from `current_exe()` in `self_update` — names
/// the directory the app is about to LEAVE. On the single update that crosses phase
/// 32-01's move out of `%LOCALAPPDATA%` and into Program Files, relaunching it starts an
/// executable that no longer exists: the update succeeds and the app appears to crash,
/// once per machine. The new destination cannot be interpolated into the batch (it is
/// not known yet), so the batch discovers it ITSELF after the install, from
/// `INSTALL_DIR_PRODUCT_KEY`, machine hive then user hive, and only adopts it when
/// `{exe_name}` is actually inside it. Anything else — no value, an unreadable hive, a
/// stale directory — falls back to `app_str`, i.e. to today's behaviour. A registry
/// failure must degrade to the status quo, never to nothing.
///
/// The registry key the NSIS installer writes the final install directory into, as the
/// key's unnamed (default) value: the Tauri template's `MANUPRODUCTKEY`, i.e.
/// `Software\${{MANUFACTURER}}\${{PRODUCTNAME}}` (`installer.nsi:32-33`, `:57-58`,
/// `:638-639`). Under `perMachine` the installer writes it to HKLM; every install made
/// before phase 32 wrote it to HKCU.
///
/// Deliberately NOT `ssh::PRODUCT_DATA_FOLDER`, although the two spell the same product
/// name today. Phase 32-01 split the install directory and the data root into two
/// different nouns and pinned that split with a compiled test; routing the batch's
/// install-directory lookup through the DATA folder's constant would quietly re-identify
/// them, and the next person to move one would move both.
///
/// Preferred over `UNINSTKEY\InstallLocation`, which the template writes WRAPPED IN
/// LITERAL QUOTE CHARACTERS (`installer.nsi:662`, confirmed on a real Windows install as
/// finding F7), so a naive read of that value yields a path that does not exist.
const INSTALL_DIR_PRODUCT_KEY: &str = r"Software\trusttunnel\TrustTunnel Client Pro";

/// Everything [`build_updater_bat`] splices into the batch.
///
/// A struct rather than positional parameters: WIN-16 adds an eighth input (the
/// Program Files root), and eight `&str`-shaped positionals in a row are both a
/// `clippy::too_many_arguments` finding and an easy place to swap two paths
/// unnoticed.
struct UpdaterBatPaths<'a> {
    pid: u32,
    /// The downloaded installer, run with `/S`.
    setup: &'a str,
    /// The executable path captured BEFORE the install (`TT_EXE`, the fallback target).
    app: &'a str,
    /// Basename of the executable, joined to the registry install dir when adopted.
    exe_name: &'a str,
    vbs: &'a str,
    loader: &'a str,
    run_dir: &'a str,
    /// Program Files root from HKLM (`resolve_program_files_dir`). `None` makes the
    /// batch ignore every registry install dir and relaunch through `TT_EXE`.
    program_files_dir: Option<&'a str>,
}

/// The updater batch text (see the notes above `INSTALL_DIR_PRODUCT_KEY` for the
/// cleanup and relocation contracts, and `registry_dir_narrowing` for WIN-16).
///
/// D-11 (T-02-06): the batch runs with administrator rights, so nothing it starts may
/// be resolved through PATH or the current directory, where an entry ahead of
/// System32 would win. Every external executable (`tasklist`, `find`, `timeout`,
/// `reg`, `cmd`) is written as `%SystemRoot%\System32\<name>.exe`. `%SystemRoot%`
/// expands when the line is parsed and holds no spaces on a stock install, so these
/// paths stay unquoted, which keeps the nested `""{run_dir}""` quoting of the cleanup
/// line intact. `ComSpec` is pinned first for the same reason: pipes and `for /f
/// ('...')` start their child shell through `%ComSpec%`, not through a path the batch
/// writes out.
///
/// `start`, `del`, `rmdir`, `goto`, `set`, `if`, `echo`, `title` and
/// `setlocal`/`endlocal` are cmd.exe built-ins with no file to name. For `start` the
/// D-11 rule is met by what it launches: only absolute targets, `"%TT_EXE%"` and
/// System32 `cmd.exe` (research assumption A2, rated reversible).
fn build_updater_bat(paths: &UpdaterBatPaths<'_>) -> String {
    let &UpdaterBatPaths {
        pid,
        setup: setup_str,
        app: app_str,
        exe_name,
        vbs: vbs_str,
        loader: loader_str,
        run_dir: run_dir_str,
        program_files_dir,
    } = paths;
    let product_key = INSTALL_DIR_PRODUCT_KEY;
    let narrowing = registry_dir_narrowing(program_files_dir);
    format!(
        r#"@echo off
title TrustTunnel Updater
set "ComSpec=%SystemRoot%\System32\cmd.exe"
echo Waiting for TrustTunnel to exit (PID {pid})...
:waitloop
%SystemRoot%\System32\tasklist.exe /FI "PID eq {pid}" 2>NUL | %SystemRoot%\System32\find.exe "{pid}" >NUL
if not errorlevel 1 (
    %SystemRoot%\System32\timeout.exe /t 1 /nobreak >nul
    goto waitloop
)
echo Installing update...
"{setup_str}" /S
echo Starting TrustTunnel...
%SystemRoot%\System32\timeout.exe /t 2 /nobreak >nul
set "TT_EXE={app_str}"
setlocal enabledelayedexpansion
set "TT_DIR="
for /f "delims=" %%L in ('%SystemRoot%\System32\reg.exe query "HKLM\{product_key}" /ve 2^>nul ^| %SystemRoot%\System32\find.exe "REG_SZ"') do set "TT_LINE=%%L" & set "TT_DIR=!TT_LINE:*REG_SZ    =!"
if not defined TT_DIR for /f "delims=" %%L in ('%SystemRoot%\System32\reg.exe query "HKCU\{product_key}" /ve 2^>nul ^| %SystemRoot%\System32\find.exe "REG_SZ"') do set "TT_LINE=%%L" & set "TT_DIR=!TT_LINE:*REG_SZ    =!"
{narrowing}endlocal & set "TT_DIR=%TT_DIR%"
if defined TT_DIR if exist "%TT_DIR%\{exe_name}" set "TT_EXE=%TT_DIR%\{exe_name}"
start "" "%TT_EXE%"
echo Cleaning up...
del "{vbs_str}" >nul 2>&1
del "{loader_str}" >nul 2>&1
del "{setup_str}" >nul 2>&1
start "" /b %SystemRoot%\System32\cmd.exe /c "%SystemRoot%\System32\timeout.exe /t 5 /nobreak >nul & rmdir /S /Q ""{run_dir_str}""" >nul 2>&1
(goto) 2>nul & del "%~f0"
"#
    )
}

/// Accept a Program Files root only in the one shape the narrowing can splice into
/// batch text safely: drive-letter absolute (`X:\...`), one trailing backslash
/// trimmed, and none of the characters batch or `!var:*str=!` substitution would
/// read as syntax.
///
/// The root comes from an admin-only HKLM value, so a hostile value is not the
/// expected case; the check exists because the value is interpolated VERBATIM into
/// an elevated batch. `=` in particular would end the search string of the prefix
/// substitution early, and `%`/`!`/`"` would be expanded or would close a quote.
/// Anything outside the accepted shape yields `None`, which makes the batch ignore
/// every registry install dir: the safe direction.
fn sanitize_program_files_dir(raw: &str) -> Option<String> {
    const FORBIDDEN: &[char] = &['"', '%', '!', '^', '&', '|', '<', '>', '=', '*', '?'];
    let root = raw.strip_suffix('\\').unwrap_or(raw);
    let b = root.as_bytes();
    let drive_form = b.len() > 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'\\';
    if !drive_form
        || root.ends_with('\\')
        || root.contains("..")
        || root[2..].contains(':')
        || root.chars().any(|c| c.is_control() || FORBIDDEN.contains(&c))
    {
        return None;
    }
    Some(root.to_string())
}

/// WIN-16 / REL-06: the batch lines that decide whether the install directory read
/// back from the registry may become the relaunch target.
///
/// Why the check exists. The batch runs with administrator rights and relaunches the
/// app from `%TT_DIR%\{exe_name}`. When HKLM has no value, `TT_DIR` comes from HKCU,
/// which any unprivileged process of the same user can write. Unchecked, that is a
/// way to have an elevated `start` launch a file of the attacker's choosing.
///
/// Why it is batch text and not a Rust `if`. The value does not exist yet when the
/// batch is written: the installer the batch itself runs is what writes it (RESEARCH
/// Pitfall 5). So the decision can only be made by cmd.exe, after the install.
///
/// What is accepted. `TT_DIR` survives only if it is
/// - in drive-letter form, `X:\...` (characters 2-3 are `:\`). UNC (`\\server\...`),
///   device paths (`\\?\...`) and relative paths fail here;
/// - free of `"`, so nothing in it can close a quoted argument on the lines after
///   `endlocal`, where `%TT_DIR%` is expanded at parse time (P-02-02-2);
/// - free of `..`, so it cannot climb out of the root after passing the prefix test
///   (a legitimate folder name with `..` in it merely falls back, see below);
/// - free of the wildcards `?` and `*`: `if exist` matches a pattern, `start` cannot
///   launch one, so a wildcard that got through would relaunch nothing at all
///   (`!TT_DIR:**=!` is the only way to find a `*`: it cuts through the first one);
/// - free of any `:` after the root, which would be an alternate data stream or a
///   second drive spec, never an install directory;
/// - strictly under the Program Files root: the text before the first `<root>\` is
///   empty (it compares equal, case-insensitively, to `<root>\` + the remainder) and
///   the remainder is not empty, so `Program FilesX`, `Program Files (x86)` and the
///   bare root itself are all refused.
///
/// «Local drive» is implemented as those two together: drive-letter form, plus the
/// prefix of a root that is itself a local system path. A mapped network drive
/// cannot be the Program Files root.
///
/// Where the root comes from. `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion`
/// `ProgramFilesDir`, read in Rust (`resolve_program_files_dir`) and sanitised
/// (`sanitize_program_files_dir`), never from `%ProgramFiles%`: the environment is
/// the user's to change, that key is writable only by administrators. When it cannot
/// be read or fails sanitising, the lines clear `TT_DIR` unconditionally.
///
/// Why rejection is safe (D-10). A cleared `TT_DIR` leaves `TT_EXE` at the path
/// captured before the install, and the installer writes over that same folder, so a
/// custom-folder install (`D:\TrustTunnel`, a drive root) still relaunches correctly.
/// The narrowing can therefore only ever remove a candidate, never add one.
///
/// Every comparison reads `!TT_DIR!` (delayed expansion, after the line is parsed),
/// never `%TT_DIR%`: whatever the value contains, it is data to cmd.exe here. The
/// lines run inside the builder's `setlocal enabledelayedexpansion` window, after
/// both registry probes and before `endlocal`, and they only ever clear `TT_DIR`
/// (plus their own scratch variables). The `registry_narrowing_tests` module runs
/// this exact text through cmd.exe.
fn registry_dir_narrowing(program_files_dir: Option<&str>) -> String {
    let Some(root) = program_files_dir.and_then(sanitize_program_files_dir) else {
        return "set \"TT_DIR=\"\n".to_string();
    };
    format!(
        r#"if defined TT_DIR if not "!TT_DIR:~1,2!"==":\" set "TT_DIR="
if defined TT_DIR set "TT_CHK=!TT_DIR:"=!"
if defined TT_DIR if not "!TT_CHK!"=="!TT_DIR!" set "TT_DIR="
if defined TT_DIR set "TT_CHK=!TT_DIR:..=!"
if defined TT_DIR if not "!TT_CHK!"=="!TT_DIR!" set "TT_DIR="
if defined TT_DIR set "TT_CHK=!TT_DIR:?=!"
if defined TT_DIR if not "!TT_CHK!"=="!TT_DIR!" set "TT_DIR="
if defined TT_DIR set "TT_CHK=!TT_DIR:**=!"
if defined TT_DIR if not "!TT_CHK!"=="!TT_DIR!" set "TT_DIR="
if defined TT_DIR set "TT_CHK=!TT_DIR:*{root}\=!"
if defined TT_DIR set "TT_REST=!TT_CHK::=!"
if defined TT_DIR if not "!TT_REST!"=="!TT_CHK!" set "TT_DIR="
if defined TT_DIR if not defined TT_CHK set "TT_DIR="
if defined TT_DIR if /I not "!TT_DIR!"=="{root}\!TT_CHK!" set "TT_DIR="
set "TT_CHK="
set "TT_REST="
"#
    )
}

/// The Program Files root the update batch accepts a registry install dir under.
///
/// Read from `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion` `ProgramFilesDir`
/// (writable only by administrators) instead of `%ProgramFiles%`, which a per-user
/// environment could redirect. The 64-bit view is requested explicitly: the
/// installer is per-machine x64, so its home is the 64-bit Program Files even if
/// this code were ever built for 32 bits. Any failure is `None`, which makes the
/// batch relaunch through `TT_EXE` only.
fn resolve_program_files_dir() -> Option<String> {
    #[cfg(windows)]
    {
        use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY};
        use winreg::RegKey;

        let key = RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey_with_flags(
                r"SOFTWARE\Microsoft\Windows\CurrentVersion",
                KEY_READ | KEY_WOW64_64KEY,
            )
            .ok()?;
        key.get_value::<String, _>("ProgramFilesDir").ok()
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// Absolute path to `wscript.exe` under `%SystemRoot%\System32`, resolved in Rust
/// rather than left to `Command::new`'s implicit search.
///
/// CR-02 (code review, phase 02): `self_update` runs elevated
/// (`trusttunnel.exe.manifest` sets `requireAdministrator`), and `Command::new` with a
/// bare name resolves through `CreateProcess`'s standard search order — the calling
/// process's own directory, then the current working directory, then `System32`, then
/// the Windows directory, then every `PATH` entry, including per-user `PATH` entries
/// that need no admin rights to add. A `wscript.exe` planted anywhere earlier in that
/// order would run with the admin token before the WIN-16-hardened `.bat` is even
/// launched. This is the same D-11 principle `build_updater_bat` already applies to
/// every external command the batch itself runs — applied here to the Rust-side spawn
/// that starts the VBS launcher.
///
/// Falls back to the bare name only if `SystemRoot` is unreadable, which does not
/// happen on a real Windows install (every `registry_narrowing_tests` case that reads
/// it uses `.expect(...)` for the same reason); this path never runs on `spawn()`
/// itself failing, only feeds into it.
fn wscript_exe_path() -> std::path::PathBuf {
    match std::env::var("SystemRoot") {
        Ok(root) => std::path::Path::new(&root).join("System32").join("wscript.exe"),
        Err(_) => std::path::PathBuf::from("wscript.exe"),
    }
}

/// Absolute path of Windows PowerShell for the cosmetic loader window `self_update`
/// spawns from the same elevated process. Same reason as `wscript_exe_path`: a bare
/// `powershell` name is a PATH/CWD lookup under the admin token (security audit of
/// phase 02, same class as CR-02). Falls back to the bare name only if `SystemRoot` is
/// unset, which does not happen on a real Windows install.
fn powershell_exe_path() -> std::path::PathBuf {
    match std::env::var("SystemRoot") {
        Ok(root) => std::path::Path::new(&root)
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe"),
        Err(_) => std::path::PathBuf::from("powershell"),
    }
}

/// The VBS launcher text `self_update` writes to hide the updater `.bat` window.
///
/// CR-01 (code review, phase 02; `deferred-items.md`, WIN-16 threat review): the
/// command string is `%SystemRoot%\System32\cmd.exe /d /c "<bat>"`, not the bare `.bat`
/// path. `WScript.Shell.Run` on a bare document path resolves it through the shell's
/// file-type association, which starts `cmd.exe /c <bat>` WITHOUT `/d` — and cmd.exe
/// started that way processes `HKCU\Software\Microsoft\Command Processor\AutoRun`
/// before a single line of the batch runs. `HKCU` is writable by any process running
/// as the same Windows user, no admin rights required, so an unprivileged same-user
/// process could plant an `AutoRun` value that then runs with this elevated updater's
/// admin token — before WIN-16's registry-dir narrowing (or any of D-11's hardening) is
/// ever reached. `/d` skips `AutoRun`; routing through `cmd.exe` explicitly also
/// removes the dependency on the `.bat` file-type association entirely.
/// `WScript.Shell.Run` expands environment variables in its command string, so
/// `%SystemRoot%` resolves at launch time, same as in `build_updater_bat`'s own text.
///
/// `bat_path` is escaped the same way it always was (backslashes doubled, quotes
/// doubled) before being wrapped in the extra `""..""` VBS-string-literal quoting that
/// `cmd.exe /d /c` needs around its own quoted argument. Proven by
/// `autorun_bypass_tests` below, which plants a foreign `HKCU` `AutoRun` value and runs
/// this exact command text through real `cmd.exe`.
fn build_vbs_launcher_content(bat_path: &str) -> String {
    format!(
        "CreateObject(\"Wscript.Shell\").Run \"%SystemRoot%\\System32\\cmd.exe /d /c \"\"{}\"\"\", 0, False",
        bat_path.replace('\\', "\\\\").replace('"', "\"\"")
    )
}

/// Best-effort sweep of orphaned `tt_update_*` dirs left in `%TEMP%` by earlier
/// runs (review be-1 belt-and-suspenders). Removes only dirs matching our own
/// `tt_update_` prefix, never touching unrelated temp content; all errors are
/// swallowed (a locked or in-progress dir is simply skipped and retried next
/// run). Runs at `self_update` start so accumulation can never grow unbounded
/// even if a previous run's delayed cleanup lost the loader race.
///
/// Takes the temp dir as a parameter (instead of reading `std::env::temp_dir()`
/// internally) so the prefix-filter contract is unit-testable without mutating
/// process-global env vars.
fn sweep_stale_update_dirs_in(temp: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(temp) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let is_ours = path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("tt_update_"));
        if is_ours {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

// ─── Phase 18: Sidecar + app version detection helpers ────────────────────
//
// Pure helpers (no I/O) для check_sidecar_version / check_app_update_info.
// Wrapped Tauri commands ниже. Все три функции testable изолированно через
// `#[cfg(test)] mod sidecar_version_tests`.

/// Strip "v" prefix + extract first `N.N.N` SemVer sequence from raw output.
///
/// Tolerates множество форматов которые может вернуть `trusttunnel_endpoint --version`:
/// - `"1.0.33"` → `"1.0.33"`
/// - `"v1.0.33\n"` → `"1.0.33"`
/// - `"trusttunnel 1.0.33\n"` → `"1.0.33"`
/// - `"trusttunnel-endpoint 1.0.33 (release)\n"` → `"1.0.33"`
/// - empty / "unknown" / "no-version-here" → `"unknown"`
///
/// Manual scan (no regex crate dep) — finds first `\d+\.\d+\.\d+` sequence
/// validated через `u32::parse` for each segment.
fn parse_version_from_output(raw: &str) -> String {
    let cleaned = raw.trim();
    if cleaned.is_empty() || cleaned == "unknown" {
        return "unknown".to_string();
    }
    let bytes = cleaned.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            let mut dots = 0;
            let mut j = i;
            while j < bytes.len() {
                let c = bytes[j];
                if c.is_ascii_digit() {
                    j += 1;
                } else if c == b'.' && dots < 2 {
                    dots += 1;
                    j += 1;
                } else {
                    break;
                }
            }
            if dots == 2 {
                let candidate = &cleaned[start..j];
                if candidate.split('.').all(|p| p.parse::<u32>().is_ok()) {
                    return candidate.to_string();
                }
            }
            i = j.max(i + 1);
        } else {
            i += 1;
        }
    }
    "unknown".to_string()
}

/// Compare semver-ish strings. Returns -1 if a < b, 0 if equal, 1 if a > b.
///
/// Strips "v" prefix + pre-release suffix (`-beta.1`). Numeric comparison
/// (`1.10.0 > 1.9.0`), not lexicographic. Missing segments treated as 0
/// (`"1.0" == "1.0.0"`). Non-numeric segments default to 0 для defence —
/// upstream callers must `validate_version` перед использованием.
fn compare_semver(a: &str, b: &str) -> i32 {
    let clean = |s: &str| -> Vec<u32> {
        s.trim_start_matches('v')
            .split('-').next().unwrap_or("") // strip "-beta.1"
            .split('.')
            .map(|p| p.parse::<u32>().unwrap_or(0))
            .collect()
    };
    let pa = clean(a);
    let pb = clean(b);
    for i in 0..pa.len().max(pb.len()) {
        let na = pa.get(i).copied().unwrap_or(0);
        let nb = pb.get(i).copied().unwrap_or(0);
        if na > nb { return 1; }
        if na < nb { return -1; }
    }
    0
}

/// Select sidecar tarball asset from release JSON `assets[]` array.
///
/// Pattern: `trusttunnel-v{TAG}-linux-{arch}.tar.gz`, EXCLUDES `-dbgsym.tar.gz`
/// (10× size — measured on the v1.0.33 assets: 107 MB vs 10.7 MB, 18-RESEARCH.md §Finding 1.
/// It is the RATIO this exclusion rests on, not those two numbers, so the measurement is left
/// dated rather than restated for every later release).
///
/// Returns `(download_url, size_bytes)` или `None` если asset не найден
/// (например unsupported arch).
fn select_sidecar_asset(assets: &[serde_json::Value], arch: &str) -> Option<(String, u64)> {
    let pattern_substring = format!("-linux-{arch}.tar.gz");
    for asset in assets {
        let name = asset.get("name").and_then(|v| v.as_str()).unwrap_or("");
        if name.ends_with(&pattern_substring)
            && !name.contains("-dbgsym")
            && name.starts_with("trusttunnel-v")
        {
            let url = asset.get("browser_download_url")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let size = asset.get("size")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            if !url.is_empty() {
                return Some((url, size));
            }
        }
    }
    None
}

// ─── Phase 18: Sidecar + app version Tauri commands ──────────────────────

/// REQ-18-UPDATE-DETECTION-02 — Sidecar version probe result.
///
/// Returned from `check_sidecar_version`. Frontend Plan 18-04 useUpdateChecker
/// hook aggregates это с `AppUpdateInfo` → `{ appUpdate, sidecarUpdate }`.
#[derive(Clone, Serialize, Deserialize)]
pub struct SidecarVersionInfo {
    pub current_version: String,      // "3.0.0" либо "unknown"
    pub latest_version: String,       // "1.0.33"
    pub latest_tag: String,           // "v1.0.33"
    pub available: bool,              // current < latest AND current != "unknown"
    pub asset_download_url: String,   // https://github.com/.../trusttunnel-v1.0.33-linux-x86_64.tar.gz
    pub asset_size_bytes: u64,
}

/// REQ-18-UPDATE-DETECTION-02 — Sidecar version probe (SSH + GitHub API).
///
/// 1. SSH connect → `{ENDPOINT_BINARY} --version` (REUSE pattern из `server_install.rs:23-26`)
/// 2. GitHub API `releases/latest` для `TrustTunnel/TrustTunnel` repo
/// 3. validate_version(tag) + validate_download_url(asset_url) — S-02 + V9 invariants
/// 4. Asset filter `trusttunnel-v{TAG}-linux-x86_64.tar.gz`, EXCLUDES `-dbgsym`
///
/// Errors: `UPDATE_CHECK_FAILED` (silent failure per D-2.x — GitHub API down /
/// rate-limit / parse failure → frontend swallows). SSH-level errors bubble через
/// existing SshParams::connect_with_app error contract.
///
/// PLAN-REVIEW Blocker #1 fix: individual fields (per Phase 17.1 `mtproto_install`
/// precedent в commands/ssh_commands.rs); Plan 18-04 frontend invokes
/// `invoke("check_sidecar_version", { host, port, user, password, keyPath, keyData })`
/// — Tauri auto-maps camelCase → snake_case на frontend boundary.
///
/// D-29 invariant: only host + version + error code logged (eprintln debug-only,
/// NOT activity_log / emit_log). Password parameter NEVER reaches log channel.
#[tauri::command]
pub async fn check_sidecar_version(
    app: tauri::AppHandle,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
    key_data: Option<String>,
) -> Result<SidecarVersionInfo, String> {
    use ssh::ENDPOINT_BINARY;

    // Reconstruct SshParams (matches Phase 17.1 mtproto_install pattern).
    let params = ssh::SshParams {
        host: host.clone(),
        port,
        ssh_user: user,
        ssh_password: password,
        key_path,
        key_data,
        // Internal (non-wizard) caller — None ⇒ legacy try-key-then-password (D-06).
        auth_method: None,
    };

    // 1. SSH probe for current version (REUSE pattern из server_install.rs:23-26)
    let handle = params.connect_with_app(app.clone()).await?;
    let (ver_out, _) = ssh::exec_command(
        &handle,
        &app,
        &format!("{bin} --version 2>/dev/null || echo unknown", bin = ENDPOINT_BINARY),
    )
    .await
    .unwrap_or_else(|e| {
        eprintln!("[check_sidecar_version] SSH probe failed: {e}");
        ("unknown".to_string(), 1)
    });
    handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();

    let current_version = parse_version_from_output(&ver_out);

    // 2. GitHub API — latest release (TrustTunnel/TrustTunnel repo, verified §Finding 1)
    // NOT `reqwest::Client::new()` (30.1 item 10). This probe shipped untimed: the same
    // unbounded wait phase 30 removed from `check_app_update_info`, left standing in the
    // two siblings beside it. It is one small JSON document from api.github.com, so there
    // is no slow-but-progressing case to protect and the check-budgets fit it exactly.
    let client = build_update_check_client(UPDATE_CHECK_CONNECT_TIMEOUT, UPDATE_CHECK_TIMEOUT)?;
    let res = client
        .get("https://api.github.com/repos/TrustTunnel/TrustTunnel/releases/latest")
        .header("User-Agent", "TrustTunnel-UpdateChecker")
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await
        .map_err(|e| {
            eprintln!("[check_sidecar_version] GitHub API request failed: {e}");
            "UPDATE_CHECK_FAILED".to_string()
        })?;

    if !res.status().is_success() {
        eprintln!("[check_sidecar_version] GitHub API status {}", res.status());
        return Err("UPDATE_CHECK_FAILED".into());
    }

    let data: serde_json::Value = res
        .json()
        .await
        .map_err(|_| "UPDATE_CHECK_FAILED".to_string())?;

    let latest_tag = data
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if latest_tag.is_empty() {
        return Err("UPDATE_CHECK_FAILED".into());
    }

    // S-02 — defence-in-depth: GitHub tag might in future embed в shell heredoc
    // (Plan 18-05 update_sidecar pipeline). Reject anything outside char-whitelist
    // (`[A-Za-z0-9.+-]`) до того как value покинет команду.
    ssh::sanitize::validate_version(&latest_tag)
        .map_err(|_| "UPDATE_CHECK_FAILED".to_string())?;

    let latest_version = latest_tag.trim_start_matches('v').to_string();

    // 3. Asset selection (default x86_64 — researcher §Pitfall 4: arch detect
    // adds complexity, ARM64 future enhancement за пределами Phase 18 first ship)
    let assets = data
        .get("assets")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let (asset_download_url, asset_size_bytes) = select_sidecar_asset(&assets, "x86_64")
        .ok_or_else(|| "UPDATE_CHECK_FAILED".to_string())?;

    // V9 — validate download URL whitelist (github.com / objects.githubusercontent.com)
    validate_download_url(&asset_download_url)
        .map_err(|_| "UPDATE_CHECK_FAILED".to_string())?;

    let available = current_version != "unknown"
        && compare_semver(&current_version, &latest_version) < 0;

    Ok(SidecarVersionInfo {
        current_version,
        latest_version,
        latest_tag,
        available,
        asset_download_url,
        asset_size_bytes,
    })
}

// ─── Phase 30: app-update failure classification (REQ ABOUT-01) ────────────
//
// PLACEMENT IS LOAD-BEARING. Everything below lives BEFORE the update command
// on purpose: the D-29 invariant test slices that command's body with
// `function_body`, which cuts at the next `\nfn ` / `\npub fn ` /
// `\npub async fn `. A helper written AFTER the command would silently shrink
// the window that test inspects and turn a real regression into a green run.

/// Stable, secret-free ASCII reason code — the app-update probe never reached
/// the network: name resolution failed, or the machine has no route out at all.
///
/// The frontend (`useUpdateChecker` → `UpdateCard`) is what localizes this; the
/// backend never ships user-facing prose. Spelling is deliberately identical to
/// `lifecycle::NO_INTERNET_REASON` — the same real-world condition should not
/// have two names across two subsystems.
///
/// D-09/D-29: a FIXED ASCII token. It carries no host, no URL, no path, no HTTP
/// status and no exception text, so nothing GitHub or the network stack prints
/// can leak into the UI or the log channel through this value.
pub const UPDATE_NO_INTERNET_REASON: &str = "no-internet";

/// Stable, secret-free ASCII reason code — the machine has network, but the
/// update server did not produce a usable answer: it did not respond in time,
/// answered with a non-success status, or answered with something we could not
/// parse or trust.
///
/// Localized by the frontend, same as the sibling above. This is also the
/// DEFAULT verdict for every ambiguous case: its user-facing copy («С
/// приложением всё в порядке — попробуйте позже») stays true no matter which of
/// the ambiguous causes actually happened, whereas telling a connected user
/// that they have no internet is a claim we would be getting wrong.
///
/// D-09/D-29: a FIXED ASCII token — no host, path, status code or exit code.
pub const UPDATE_SERVER_UNREACHABLE_REASON: &str = "server-unreachable";

/// Pure decision helper for the two update-check failure causes.
///
/// Takes OBSERVED FACTS rather than a `reqwest::Error`, because a
/// `reqwest::Error` cannot be constructed in a unit test — the same reason
/// `lifecycle.rs` keeps its decision helpers free of IO. `classify_reqwest_failure`
/// below is the thin adapter that reads those facts off a real error.
///
/// The model, in words:
/// - `is_timeout` DOMINATES. A timeout means packets went out and nothing came
///   back in time, which is exactly the "resolved address that did not answer"
///   case — the server's problem, not the network's. reqwest reports a connect
///   PHASE timeout as both `is_connect()` and `is_timeout()`, so this is also
///   what makes the connect+timeout combination land on server-unreachable.
/// - Absent a timeout, `no-internet` requires POSITIVE EVIDENCE that the machine
///   itself has no path out: the source chain naming a name-resolution failure or
///   an unreachable/down network. That evidence is what the user can act on.
/// - Everything else — decode failures, non-success statuses, protocol errors,
///   and a bare connect failure with nothing in the chain to explain it — is
///   server-unreachable.
///
/// Ambiguity therefore always resolves to `UPDATE_SERVER_UNREACHABLE_REASON`.
///
/// WHAT THIS USED TO BE, AND WHY IT CHANGED. The first implementation read
/// `!is_timeout && (is_connect || source_names_dns)`, treating a bare
/// `reqwest::Error::is_connect()` as sufficient evidence of "no internet". It is
/// not: `is_connect()` is true for EVERY error raised while establishing the
/// connection, which includes TCP `connection refused`, `connection reset`, TLS
/// handshake failure and proxy errors — all of which happen after the address
/// resolved and the packet left the machine. A user on working internet whose
/// network resets the TLS handshake to `api.github.com` was told «нет интернета»
/// and asked to check a connection that was fine. That is the app stating
/// something it did not verify, which is the exact class of defect this phase
/// exists to remove; `30-RESEARCH.md` §3 had already written the rule down
/// («ambiguity resolves to server-unreachable, never to no-internet»).
/// `is_connect` is therefore no longer an input at all: keeping a fact that
/// carries no decision weight in the signature is an invitation to wire it back
/// into the verdict.
pub fn classify_update_failure(is_timeout: bool, source_names_no_network: bool) -> &'static str {
    if !is_timeout && source_names_no_network {
        UPDATE_NO_INTERNET_REASON
    } else {
        UPDATE_SERVER_UNREACHABLE_REASON
    }
}

/// Does this error's source chain name a machine-has-no-network problem?
///
/// Walks `std::error::Error::source()` rather than matching on a type, because
/// the resolver error is buried several layers down (reqwest → hyper → hyper-util
/// → the resolver) and those layers are not part of reqwest's public API. Matching
/// the rendered text is blunt, but the alternative is depending on private types.
///
/// D-29: only the CLASSIFICATION escapes this function. The message it inspects
/// never leaves it, so a resolver that echoes the hostname cannot leak it.
fn error_chain_names_no_network(e: &dyn std::error::Error) -> bool {
    // Markers as printed by the Windows and POSIX resolvers and socket layers,
    // plus hyper's own wrapper text. Lowercased before matching so casing drift
    // does not matter.
    //
    // TWO GROUPS, BOTH POSITIVE EVIDENCE. Name resolution failing and having no
    // route out are the two ways the machine itself is the reason nothing left
    // it; `30-RESEARCH.md` §3 lists both under `no-internet`. The "no route" group
    // is what keeps the honest, actionable «нет интернета» verdict for the
    // Wi-Fi-off / cable-out case now that a bare `is_connect()` no longer counts.
    //
    // THE BARE THREE-LETTER TOKEN "dns" IS DELIBERATELY ABSENT. Matched with
    // `contains`, it fired on any rendered text that happened to hold that
    // sequence — a hostname like `cdns.example`, a proxy naming `dnsmasq`, a
    // Windows message mentioning a DNS *server* while failing for some other
    // reason — and flipped the verdict to `no-internet`. Every phrase below is
    // specific enough to mean what it says.
    const NO_NETWORK_MARKERS: [&str; 10] = [
        // — name resolution
        "name resolution",
        "failed to lookup address",
        "getaddrinfo",
        "no such host",
        "nodename nor servname",
        "os error 11001", // WSAHOST_NOT_FOUND
        // — no route out of the machine at all
        "network is unreachable",
        "network is down",
        "no route to host",
        "os error 10051", // WSAENETUNREACH
    ];

    let mut current: Option<&dyn std::error::Error> = Some(e);
    while let Some(err) = current {
        let rendered = err.to_string().to_lowercase();
        if NO_NETWORK_MARKERS.iter().any(|m| rendered.contains(m)) {
            return true;
        }
        current = err.source();
    }
    false
}

/// Adapter: read the observable facts off a real `reqwest::Error` and delegate.
///
/// Returns `String` because that is what a Tauri command's `Err` variant is; the
/// value is always one of the two consts above, never a rendered error.
fn classify_reqwest_failure(e: reqwest::Error) -> String {
    classify_update_failure(e.is_timeout(), error_chain_names_no_network(&e)).to_string()
}

/// How long the update check waits for the TCP+TLS connection to be established.
///
/// Separate from the total budget below because the two failures are different
/// events: a connect that never completes is a machine/route problem, a request
/// that connects and then stalls is the server's. reqwest reports a connect-PHASE
/// timeout as both `is_connect()` and `is_timeout()`, which `classify_update_failure`
/// already accounts for.
/// `pub(crate)` since 30.1: `ssh/server/server_version.rs` is the third member of this
/// class and takes the SAME two budgets through the SAME builder. Two constants that mean
/// «how long a GitHub version probe may wait» would drift the moment one of them is tuned.
pub(crate) const UPDATE_CHECK_CONNECT_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(10);

/// The total budget for one update-check request, connect included.
///
/// WHY THIS EXISTS (phase-30 security follow-up, finding S3). `check_app_update_info`
/// used a bare `reqwest::Client::new()`, which sets NO timeout of any kind — only the
/// OS connect timeout applies, and that one does not fire at all once the peer has
/// accepted the connection. A server that accepts and then never answers left the
/// `invoke` promise unresolved for the rest of the session, and the card sat on
/// «Проверяем обновления…» with no way out: exactly the stuck-card outcome the
/// panic fix in `extract_sha256_from_body` removed, reached by a different route.
/// Worse, `classify_update_failure` takes `is_timeout` as a first-class input, so
/// that whole branch — and the truth table testing it — described a path production
/// could not take. A configured timeout is what makes the branch real.
///
/// 30s is chosen against what the request IS: one small JSON document from
/// api.github.com on a 24h background timer. Nothing here streams, so there is no
/// legitimate slow-but-progressing case to protect. `self_update`'s DOWNLOAD client
/// is deliberately NOT given this budget — a multi-megabyte installer on a slow link
/// would be aborted mid-transfer, which is a regression, not a hardening.
pub(crate) const UPDATE_CHECK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// The HTTP client the app-update check and its digest fetch share.
///
/// Takes its two budgets as arguments rather than reading the consts directly, so a
/// test can drive the same builder with millisecond budgets and prove the timeout is
/// real against a socket that accepts and never answers. A test that only asserted
/// «the const is 30s» would prove that a number exists, not that it is wired in.
///
/// Returns the reason code rather than the builder error: `ClientBuilder::build`
/// fails on TLS-backend initialisation, which the user can do nothing about and
/// which must not put a rendered error on the wire (D-29).
///
/// `pub(crate)` since 30.1 so the server-version probe in `ssh/server/server_version.rs`
/// can reach it. Exporting the builder rather than copying four lines into that file is
/// what makes «every version probe carries a budget» a property one guard can check.
pub(crate) fn build_update_check_client(
    connect_timeout: std::time::Duration,
    total_timeout: std::time::Duration,
) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(connect_timeout)
        .timeout(total_timeout)
        .build()
        .map_err(|_| UPDATE_SERVER_UNREACHABLE_REASON.to_string())
}

/// The largest body `resolve_release_sha256` will read from a `.sha256` asset.
///
/// A `sha256sum` line is «<64 hex>  <filename>» — about eighty bytes. 4 KiB is
/// two orders of magnitude of headroom for a BOM, CRLFs and a long filename, and
/// still nowhere near a size worth pulling into memory.
const MAX_DIGEST_BYTES: u64 = 4 * 1024;

/// Is the ANNOUNCED digest body too large to be a digest?
///
/// The check runs on a 24h background timer and reads whatever URL the release
/// payload names. `validate_download_url` already pins the HOST, but nothing
/// pinned the SIZE: a release publishing a multi-gigabyte file named `*.sha256`
/// — or a compromised release account — turned a routine background check into an
/// out-of-memory kill of the whole app.
///
/// This is the CHEAP arm only: it refuses a body whose declared length is already
/// absurd, before a single byte is read. It is not the whole guard, and it never
/// was — a chunked response declares no length at all, so `None` reaches here and
/// this function correctly says «nothing to refuse yet». The bound that does not
/// depend on the server's honesty is `read_capped_digest_text`.
fn digest_body_too_large(content_length: Option<u64>) -> bool {
    content_length.is_some_and(|n| n > MAX_DIGEST_BYTES)
}

/// Read a response body, giving up the moment it exceeds `cap` bytes.
///
/// WHY THIS EXISTS (phase-30 security follow-up, finding S4). The size guard added
/// earlier only ever consulted `Content-Length`, and the code then called
/// `res.text()`, which reads to the end of the stream. Declaring a length is the
/// server's choice: a chunked response declares none, `digest_body_too_large`
/// returned false for it, and an unbounded read followed. So the cap protected
/// against a hostile release that announces its payload and not against one that
/// does not — which is the wrong way round, since announcing it is the honest
/// behaviour. A guard that a hostile party opts into is not a guard.
///
/// Streaming chunk by chunk with a running total is what makes the bound
/// independent of the declaration. `None` on overrun rather than a truncated
/// string: a partial read of a digest file is not a digest, and returning the
/// first 4 KiB would hand `is_hex_sha256` something that could coincidentally
/// pass. The caller treats `None` exactly as it treats a malformed body — fall
/// through to the release-body scan — so an oversized asset degrades to «this
/// release published no usable digest» instead of killing the app.
///
/// D-29: the body is inspected here and never rendered anywhere.
async fn read_capped_digest_text(mut res: reqwest::Response, cap: usize) -> Option<String> {
    let mut buf: Vec<u8> = Vec::new();
    loop {
        match res.chunk().await {
            Ok(Some(chunk)) => {
                // Checked BEFORE extending, so the high-water mark is one chunk
                // over the cap rather than the whole remaining body.
                if buf.len() + chunk.len() > cap {
                    return None;
                }
                buf.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            // A truncated or broken stream is not a digest either.
            Err(_) => return None,
        }
    }
    String::from_utf8(buf).ok()
}

/// Is this release asset THIS edition's Windows installer?
///
/// One definition for both readers — the installer lookup in `check_app_update_info` and the
/// digest fallback in `resolve_release_sha256`. They used to spell the rule separately, and the
/// copy in the fallback was simply missing, which is how a Light digest could be paired with a Pro
/// installer. The repository ships two editions from one release, so "any installer-shaped asset"
/// is never the right answer here.
fn is_pro_installer_asset_name(name: &str) -> bool {
    name.contains("Pro") && name.contains("setup") && name.ends_with(".exe")
}

/// Resolve the expected installer digest for a release, or "" when it has none.
///
/// Ported from `useUpdateChecker.ts` when the check moved into Rust. Every step is
/// best-effort by design: the previous behaviour was that a missing or unreachable
/// checksum left `expectedSha256` empty rather than failing the whole check, and a
/// stricter rule here would turn "release without a digest" into "no update check
/// at all". `self_update` is what decides whether an empty expectation is
/// acceptable — that decision is not this function's to make.
async fn resolve_release_sha256(
    client: &reqwest::Client,
    assets: &[serde_json::Value],
    installer_asset_name: Option<&str>,
    release_notes: &str,
) -> String {
    let digest_asset_url = installer_asset_name
        .and_then(|installer| {
            let expected = format!("{installer}.sha256");
            assets.iter().find_map(|a| {
                if a.get("name").and_then(|v| v.as_str()) == Some(expected.as_str()) {
                    a.get("browser_download_url").and_then(|v| v.as_str())
                } else {
                    None
                }
            })
        })
        .or_else(|| {
            assets.iter().find_map(|a| {
                let name = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
                // THE EDITION FILTER BELONGS HERE TOO. The front-end fallback this replaced kept
                // it (`…endsWith(".sha256") && ASSET_PATTERN.test(name.replace(".sha256",""))`);
                // the port dropped it and took the first `.sha256` asset in the release, whatever
                // it belonged to. This repository publishes Pro and Light from the same release,
                // so a Light digest listed first was handed to `self_update` as the expectation
                // for a Pro installer — and `verify_checksum` then reports
                // UPDATE_CHECKSUM_MISMATCH, i.e. a tamper-style failure for a perfectly good
                // download. A digest belonging to the OTHER edition is strictly worse than none.
                let base = name.strip_suffix(".sha256")?;
                if is_pro_installer_asset_name(base) {
                    a.get("browser_download_url").and_then(|v| v.as_str())
                } else {
                    None
                }
            })
        });

    if let Some(url) = digest_asset_url {
        // V9 whitelist applies to the digest asset too: it is fetched from the
        // same untrusted release payload as the installer URL.
        if validate_download_url(url).is_ok() {
            if let Ok(res) = client
                .get(url)
                .header("User-Agent", "TrustTunnel-UpdateChecker")
                .send()
                .await
            {
                // TWO ARMS, AND THE SECOND IS THE LOAD-BEARING ONE. The declared
                // length is refused first because it costs nothing; the streaming
                // cap is what holds when the server declares nothing at all.
                if res.status().is_success() && !digest_body_too_large(res.content_length()) {
                    if let Some(text) = read_capped_digest_text(res, MAX_DIGEST_BYTES as usize).await
                    {
                        // `sha256sum` output is "<digest>  <filename>" — take the digest.
                        let candidate = text.split_whitespace().next().unwrap_or("").to_string();
                        if is_hex_sha256(&candidate) {
                            return candidate;
                        }
                    }
                }
            }
        }
    }

    // Fallback: a "SHA256: <64 hex>" line in the release body.
    extract_sha256_from_body(release_notes)
}

/// Is this exactly 64 hex characters — the shape of a SHA-256 digest?
fn is_hex_sha256(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// Pull a `SHA256: <64 hex>` digest out of a release body, or "" when absent.
///
/// Scans EVERY `sha256` marker in the body and returns the first that is followed by a well-formed
/// 64-character run, so a prose mention of the word before the real digest line cannot hide it.
///
/// Hand-rolled rather than regex: `regex` is not a dependency of this crate and a
/// checksum-shaped scan is not worth adding one for.
fn extract_sha256_from_body(body: &str) -> String {
    // INDEX AND SLICE THE SAME STRING. This used to search `lower` and then slice `body` with the
    // offset it found. `str::to_lowercase` is not length-preserving in UTF-8 — 'İ' (U+0130) grows
    // 2 bytes to 3, 'ẞ' shrinks 3 to 2, the Kelvin sign (U+212A) shrinks 3 to 1 — so one such
    // character anywhere before the marker shifted every later index. Best case the hex run came
    // out truncated and the digest was silently lost (`self_update` then rejects the whole update
    // as UPDATE_CHECKSUM_MISSING); worst case the offset landed on a continuation byte and the
    // slice PANICKED inside the async command, leaving the `invoke` promise unresolved and the
    // card stuck on «Проверяем обновления…» for the rest of the session.
    // Scanning the lowercased copy is safe: a digest is ASCII hex, and `verify_checksum` compares
    // case-insensitively anyway.
    let lower = body.to_lowercase();

    // EVERY OCCURRENCE, NOT JUST THE FIRST. The code this replaced took `lower.find("sha256")`,
    // read the one hex run after it and gave up if that run was not 64 characters — a regression
    // against the front-end regex it was ported from, which scanned the whole body. A Russian
    // release body that says «Проверьте контрольную сумму SHA256 перед установкой» before the
    // real `SHA256: …` line stopped at the prose mention and returned "", which silently killed
    // the in-app update for that release. Walking on until a run is well formed restores the old
    // behaviour and cannot loop: `from` advances past the marker every iteration.
    let mut from = 0usize;
    while let Some(rel) = lower[from..].find("sha256") {
        let at = from + rel + "sha256".len();
        let digest: String = lower[at..]
            .chars()
            .skip_while(|c| !c.is_ascii_hexdigit())
            .take_while(|c| c.is_ascii_hexdigit())
            .collect();
        if is_hex_sha256(&digest) {
            return digest;
        }
        from = at;
    }
    String::new()
}

/// REQ-18-UPDATE-DETECTION-01 — App version check result (Windows installer).
///
/// Backend mirror existing frontend `useUpdateChecker.ts` GitHub API call —
/// optional convenience для consistent error handling + future caching.
#[derive(Clone, Serialize, Deserialize)]
pub struct AppUpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub latest_tag: String,
    pub available: bool,
    pub download_url: String,    // installer .exe URL либо html_url fallback
    pub release_notes: String,
    /// Expected SHA-256 of the installer, or "" when the release publishes none.
    ///
    /// Phase 30: this moved here from the webview. The frontend used to fetch the
    /// `.sha256` asset itself and hand the digest to `self_update` as
    /// `expectedSha256`. Once the CHECK moved into Rust, leaving the CHECKSUM on a
    /// webview request would have quietly emptied that argument — the tamper
    /// control would have disappeared as a side effect of a refactor rather than
    /// by anyone's decision. Empty is not an error: it means the release has no
    /// published digest, exactly as before.
    pub sha256: String,
}

/// REQ-18-UPDATE-DETECTION-01 — App version probe (GitHub API).
///
/// Reads current version из Tauri `package_info()` (synced from `tauri.conf.json`).
/// GitHub repo — `ialexbond/TrustTunnelClientForWindows` (verified существующий
/// `useUpdateChecker.ts:36` использует тот же endpoint per PLAN-REVIEW Blocker #2).
///
/// Asset filter: `Pro*setup*.exe$`. Если asset не найден — `download_url` fallback
/// на `html_url` (release page) per OQ-5 — пользователь всё равно может перейти.
///
/// Errors (Phase 30 — the two localizable causes, see the consts above):
/// `UPDATE_NO_INTERNET_REASON` when the probe never left the machine, and
/// `UPDATE_SERVER_UNREACHABLE_REASON` for every other failure. The single
/// collapsed token this used to return is gone: the frontend could not tell
/// «нет интернета» from «сервер не ответил» through it, so the card silently
/// claimed the installed version was current after a failed check. The sidecar
/// commands in this file still use the old collapsed token — that is the OTHER
/// update track, with its own surfaces, and it is out of this change's scope.
#[tauri::command]
pub async fn check_app_update_info(
    app: tauri::AppHandle,
) -> Result<AppUpdateInfo, String> {
    let current_version = app.package_info().version.to_string();

    // Built, never defaulted — see `UPDATE_CHECK_TIMEOUT` for why the default
    // constructor is banned here. The same client is handed to
    // `resolve_release_sha256`, so the digest fetch inherits both budgets.
    //
    // The banned constructor is NOT spelled out in this comment on purpose: the
    // guard below counts occurrences inside this function, and a comment naming
    // the thing it forbids would report a violation of the rule it documents.
    // Same shape as the hygiene gate's comment stripper (`about-hygiene.sh`).
    let client = build_update_check_client(UPDATE_CHECK_CONNECT_TIMEOUT, UPDATE_CHECK_TIMEOUT)?;
    let res = client
        .get("https://api.github.com/repos/ialexbond/TrustTunnelClientForWindows/releases/latest")
        .header("User-Agent", "TrustTunnel-UpdateChecker")
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await
        .map_err(classify_reqwest_failure)?;

    // Everything from here on has already proved the network works — the answer
    // itself is what is unusable, so every branch below is server-unreachable.
    if !res.status().is_success() {
        return Err(UPDATE_SERVER_UNREACHABLE_REASON.into());
    }

    let data: serde_json::Value = res
        .json()
        .await
        .map_err(|_| UPDATE_SERVER_UNREACHABLE_REASON.to_string())?;

    let latest_tag = data
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if latest_tag.is_empty() {
        return Err(UPDATE_SERVER_UNREACHABLE_REASON.into());
    }

    ssh::sanitize::validate_version(&latest_tag)
        .map_err(|_| UPDATE_SERVER_UNREACHABLE_REASON.to_string())?;

    let latest_version = latest_tag.trim_start_matches('v').to_string();
    let release_notes = data
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let html_url = data
        .get("html_url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // Asset selection — Pro installer pattern `Pro.*setup.*\.exe$`
    let assets = data
        .get("assets")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let installer_asset_name = assets
        .iter()
        .find_map(|a| {
            let name = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if is_pro_installer_asset_name(name) {
                Some(name.to_string())
            } else {
                None
            }
        });
    let download_url = installer_asset_name
        .as_ref()
        .and_then(|name| {
            assets.iter().find_map(|a| {
                if a.get("name").and_then(|v| v.as_str()) == Some(name.as_str()) {
                    a.get("browser_download_url")
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                } else {
                    None
                }
            })
        })
        .unwrap_or(html_url);

    if !download_url.is_empty() {
        validate_download_url(&download_url)
            .map_err(|_| UPDATE_SERVER_UNREACHABLE_REASON.to_string())?;
    }

    // Installer integrity expectation — see the doc comment on `AppUpdateInfo::sha256`.
    // Same three-step resolution the frontend used to perform: the digest asset
    // that belongs to THIS installer, else any published digest asset, else a
    // 64-hex string in the release body. A missing digest is not an error.
    let sha256 = resolve_release_sha256(&client, &assets, installer_asset_name.as_deref(), &release_notes).await;

    let available = compare_semver(&current_version, &latest_version) < 0;

    Ok(AppUpdateInfo {
        current_version,
        latest_version,
        latest_tag,
        available,
        download_url,
        release_notes,
        sha256,
    })
}

// ─── Phase 19: list_sidecar_versions (REQ-19-LIST-VERSIONS-CMD) ────────────
//
// Returns a list of the last N GitHub releases for the `TrustTunnel/TrustTunnel`
// repo. Used by Plan 19-03 ProtocolUpdateSection dropdown. Mirrors the
// `check_sidecar_version` pattern (Phase 18 Plan 18-03) and reuses
// `select_sidecar_asset` + `validate_download_url` + `ssh::sanitize::validate_version`.
//
// Pure helper `parse_releases_to_info` is extracted so unit tests can exercise
// the iteration / filter / validation logic without HTTP mocking (the wrapping
// Tauri command is just an HTTP fetch around it).
//
// D-29 invariant (REQ-19-D29-EXTENDED): function body MUST NOT call the activity
// log channel or any emit-log helper, MUST NOT send a vpn log Tauri event, and
// MUST NOT invoke the i18n log message helper. Asset URLs + tags NEVER reach
// the persisted log file. Static-grep test enforces this in CI (see test mod
// list_sidecar_versions_tests at the bottom of this file).

/// Phase 19 frozen contract — single release entry returned by
/// `list_sidecar_versions`. Plan 19-03 consumer expects camelCase fields:
/// `version`, `tag`, `assetDownloadUrl`, `assetSizeBytes`, `publishedAt`.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarReleaseInfo {
    /// Semver-only string with leading `v` stripped, e.g. `"1.0.33"`.
    pub version: String,
    /// Original GitHub `tag_name` with `v` prefix preserved, e.g. `"v1.0.33"`.
    pub tag: String,
    /// `browser_download_url` of the `trusttunnel-v{TAG}-linux-x86_64.tar.gz`
    /// asset (validated through `validate_download_url`).
    pub asset_download_url: String,
    /// Size in bytes of the selected asset (informational only).
    pub asset_size_bytes: u64,
    /// ISO timestamp from `release.published_at`; empty string if missing.
    pub published_at: String,
}

/// Pure helper — iterate GitHub releases JSON array, filter prereleases,
/// reject tags failing S-02 char-whitelist, select `x86_64` non-dbgsym asset,
/// validate download URL, build `SidecarReleaseInfo` for each survivor, and
/// stop once `result.len() >= cap`.
///
/// Extracted for testability — `list_sidecar_versions` Tauri command is a thin
/// HTTP wrapper around this helper. All filtering / validation decisions live
/// here. Tests in `list_sidecar_versions_tests` exercise this function with
/// hand-crafted `serde_json::Value` fixtures.
fn parse_releases_to_info(
    releases: &[serde_json::Value],
    cap: usize,
) -> Vec<SidecarReleaseInfo> {
    let mut result: Vec<SidecarReleaseInfo> = Vec::with_capacity(cap.min(releases.len()));

    for release in releases.iter() {
        // Filter prereleases (defensive — TrustTunnel/TrustTunnel currently has none,
        // but future-proof).
        if release.get("prerelease").and_then(|v| v.as_bool()).unwrap_or(false) {
            continue;
        }

        let tag = release
            .get("tag_name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if tag.is_empty() {
            continue;
        }

        // S-02 — char-whitelist defence against compromised/hostile API responses.
        if ssh::sanitize::validate_version(&tag).is_err() {
            continue;
        }

        let assets = release
            .get("assets")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let Some((url, size)) = select_sidecar_asset(&assets, "x86_64") else {
            continue;
        };

        // V9 — defence-in-depth on download URL allowlist.
        if validate_download_url(&url).is_err() {
            continue;
        }

        let version = tag.trim_start_matches('v').to_string();
        let published_at = release
            .get("published_at")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        result.push(SidecarReleaseInfo {
            version,
            tag,
            asset_download_url: url,
            asset_size_bytes: size,
            published_at,
        });

        if result.len() >= cap {
            break;
        }
    }

    result
}

/// REQ-19-LIST-VERSIONS-CMD — Phase 19 sidecar version listing.
///
/// Returns up to `max_count` (backend-capped at 10) most recent
/// `TrustTunnel/TrustTunnel` GitHub releases, sorted descending by GitHub's
/// default order (published_at desc). Prerelease entries filtered out; each
/// surviving release's `tag_name` validated through S-02 char-whitelist; only
/// `trusttunnel-v{TAG}-linux-x86_64.tar.gz` (non-dbgsym) assets accepted;
/// asset URLs validated through `validate_download_url` (github.com /
/// objects.githubusercontent.com whitelist, HTTPS only).
///
/// **D-29 invariant (REQ-19-D29-EXTENDED):** asset URLs and tag values NEVER
/// flow to the activity log channel or any emit-log helper. The function body
/// intentionally contains zero log emissions — only `eprintln!` for debug-stderr
/// diagnostics (not persisted). Static-grep test in
/// `list_sidecar_versions_tests` mod enforces this in CI.
///
/// **Error contract:** any failure (network / non-200 / parse / empty list)
/// returns `Err("UPDATE_CHECK_FAILED".into())` — opaque string with no URL
/// or tag leakage. Frontend `useSidecarVersions` (Plan 19-03) treats this as
/// silent failure (`console.warn` only, no toast) per D-4.4.
#[tauri::command]
pub async fn list_sidecar_versions(
    _app: tauri::AppHandle,
    max_count: u32,
) -> Result<Vec<SidecarReleaseInfo>, String> {
    // Backend cap defends against frontend passing oversized values
    // (DoS via memory / API quota burn).
    let cap = (max_count as usize).min(10);

    // `+5` buffer accommodates filtered-out prereleases / missing assets so the
    // result still has a chance to reach `cap` after filtering.
    let per_page = cap + 5;

    // NOT `reqwest::Client::new()` (30.1 item 10) — the second member of the same class
    // as the probe in `check_sidecar_version`. One releases page on a user-initiated
    // request; the check budgets are the right size and they live in exactly one place.
    let client = build_update_check_client(UPDATE_CHECK_CONNECT_TIMEOUT, UPDATE_CHECK_TIMEOUT)?;
    let res = client
        .get(format!(
            "https://api.github.com/repos/TrustTunnel/TrustTunnel/releases?per_page={per_page}"
        ))
        .header("User-Agent", "TrustTunnel-UpdateChecker")
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await
        .map_err(|e| {
            eprintln!("[list_sidecar_versions] GitHub API request failed: {e}");
            "UPDATE_CHECK_FAILED".to_string()
        })?;

    if !res.status().is_success() {
        eprintln!("[list_sidecar_versions] GitHub API status {}", res.status());
        return Err("UPDATE_CHECK_FAILED".into());
    }

    let releases: Vec<serde_json::Value> = res
        .json()
        .await
        .map_err(|_| "UPDATE_CHECK_FAILED".to_string())?;

    Ok(parse_releases_to_info(&releases, cap))
}

/// Self-update: download NSIS setup.exe, verify checksum, launch silent install, restart.
#[tauri::command]
pub async fn self_update(
    app: tauri::AppHandle,
    download_url: String,
    expected_sha256: String,
    language: Option<String>,
    theme: Option<String>,
) -> Result<(), String> {
    use std::io::Write as StdWrite;
    use tokio::io::AsyncWriteExt;

    let emit = |stage: &str, percent: u32, msg: &str| {
        app.emit(
            "update-progress",
            UpdateProgress {
                stage: stage.to_string(),
                percent,
                message: msg.to_string(),
            },
        )
        .ok();
    };

    validate_download_url(&download_url)?;

    // SEC-01 fail-CLOSED up-front gate: refuse before spending bandwidth if no
    // checksum was supplied. There is no longer any "skip verification" path —
    // a missing checksum can never lead to an unverified elevated install.
    if expected_sha256.trim().is_empty() {
        return Err("UPDATE_CHECKSUM_MISSING".into());
    }

    let _lang = language.as_deref().unwrap_or("ru");
    let _theme = theme.as_deref().unwrap_or("dark");

    emit("download", 0, "update.starting");

    let exe_path = std::env::current_exe()
        .map_err(|e| format!("Cannot determine exe path: {e}"))?;
    let app_dir = exe_path
        .parent()
        .ok_or("Cannot determine app directory")?;

    // be-1: reclaim any `tt_update_*` dirs orphaned by an earlier run BEFORE we
    // create ours (so our fresh dir is never swept). Best-effort; keeps temp
    // usage bounded even if a prior run's delayed cleanup lost the loader race.
    sweep_stale_update_dirs_in(&std::env::temp_dir());

    // SEC-05/06 TOCTOU: all four updater artifacts live in a fresh, unguessable
    // per-run dir (`tt_update_<uuid>`) instead of fixed names in the shared,
    // world-writable %TEMP%. An attacker cannot predict the path to pre-stage a
    // malicious file. The .bat removes the whole run_dir on completion.
    let run_dir = std::env::temp_dir().join(make_run_dir_name());
    std::fs::create_dir_all(&run_dir)
        .map_err(|e| format!("Cannot create update dir: {e}"))?;
    let setup_path = run_dir.join("trusttunnel_setup.exe");

    // Download setup.exe with progress
    emit("download", 5, "update.connecting");
    // DELIBERATELY UNTIMED, AND IT MUST STAY THAT WAY (30.1 item 10, the other half).
    //
    // Its two siblings above were just moved onto `build_update_check_client`, and the
    // obvious next step — «sweep the third one too» — would be a regression dressed as a
    // hardening. Those are small JSON documents; this is a multi-megabyte installer, and
    // `UPDATE_CHECK_TIMEOUT` would abort a transfer that is slow but PROGRESSING, on
    // exactly the connections that most need the update to arrive. See the rationale on
    // `UPDATE_CHECK_TIMEOUT` itself.
    //
    // The failure this leaves open — a transfer that connects and then goes silent — is
    // real, and it is caught where the evidence actually is: the front end sees the
    // `update-progress` events this loop emits stop arriving, and `UpdateCard.tsx` flips
    // the card to a closeable failure after the shared watchdog gap. A GAP between events,
    // not a deadline for the whole download. `no_version_probe_builds_its_own_untimed_client`
    // therefore does NOT list `self_update` as a subject.
    let client = reqwest::Client::new();
    let resp = client
        .get(&download_url)
        .header("User-Agent", "TrustTunnel-Updater")
        .send()
        .await
        .map_err(|e| format!("Download failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Download HTTP error: {}", resp.status()));
    }

    let total_size = resp.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut file = tokio::fs::File::create(&setup_path)
        .await
        .map_err(|e| format!("Cannot create temp file: {e}"))?;

    let mut stream = resp.bytes_stream();
    use tokio_stream::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download error: {e}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Write error: {e}"))?;
        downloaded += chunk.len() as u64;
        if total_size > 0 {
            let pct = ((downloaded as f64 / total_size as f64) * 80.0) as u32 + 5;
            emit(
                "download",
                pct.min(85),
                &format!(
                    "update.downloading|{:.1}|{:.1}",
                    downloaded as f64 / 1_048_576.0,
                    total_size as f64 / 1_048_576.0
                ),
            );
        }
    }
    file.flush().await.ok();
    drop(file);

    // SEC-01 fail-CLOSED: re-verify the downloaded bytes (defence in depth with
    // the up-front gate + the per-run TOCTOU dir). On ANY failure — missing,
    // malformed, or mismatched — delete the file and abort with the error code;
    // the launch path below is never reached. There is no skip-verification else
    // branch anymore.
    emit("verify", 88, "update.verifying");
    let bytes =
        std::fs::read(&setup_path).map_err(|e| format!("Cannot read downloaded file: {e}"))?;
    if let Err(code) = verify_checksum(&bytes, &expected_sha256) {
        let _ = std::fs::remove_file(&setup_path);
        let _ = std::fs::remove_dir_all(&run_dir);
        return Err(code);
    }
    eprintln!("[self_update] SHA256 verified");

    emit("install", 92, "update.preparing");

    // Kill only our own VPN sidecar before exit (not other app's processes)
    if let Some(state) = app.try_state::<AppState>() {
        kill_sidecar_from_state(&state);
    }

    emit("install", 96, "update.launching");

    // Create updater batch script: run setup /S → wait → launch app
    // SEC-05/06: all artifacts in the per-run run_dir, not fixed names in %TEMP%.
    let bat_path = run_dir.join("trusttunnel_updater.bat");
    let pid = std::process::id();
    let exe_name = exe_path.file_name().unwrap_or_default().to_os_string();
    let app_exe = app_dir.join(&exe_name);
    let setup_str = setup_path.to_string_lossy();
    let app_str = app_exe.to_string_lossy();
    let vbs_path = run_dir.join("trusttunnel_updater.vbs");

    // be-1: build the .bat via the pure helper so the cleanup contract (no
    // self-blocking non-recursive rmdir; whole run_dir reclaimed by a detached
    // delayed `rmdir /S /Q`) is unit-tested in `self_update_cleanup_tests`.
    //
    // D-10.3: `app_str` is the PRE-install path and is now only the fallback. The
    // basename goes in separately because the batch composes the real target from it
    // and the install directory it reads back from the registry after installing.
    //
    // WIN-16: that registry directory is adopted only under the Program Files root
    // resolved here from HKLM; `None` (unreadable) makes the batch use `app_str` only.
    let exe_name_str = exe_name.to_string_lossy();
    let vbs_str = vbs_path.to_string_lossy();
    let loader_path = run_dir.join("trusttunnel_loader.ps1");
    let loader_str = loader_path.to_string_lossy();
    let run_dir_str = run_dir.to_string_lossy();
    let program_files_dir = resolve_program_files_dir();
    let bat_content = build_updater_bat(&UpdaterBatPaths {
        pid,
        setup: &setup_str,
        app: &app_str,
        exe_name: &exe_name_str,
        vbs: &vbs_str,
        loader: &loader_str,
        run_dir: &run_dir_str,
        program_files_dir: program_files_dir.as_deref(),
    });

    {
        let mut bat_file = std::fs::File::create(&bat_path)
            .map_err(|e| format!("Cannot create updater script: {e}"))?;
        bat_file
            .write_all(bat_content.as_bytes())
            .map_err(|e| format!("Cannot write updater script: {e}"))?;
    }

    // Launch bat hidden via VBS wrapper. See `build_vbs_launcher_content` (CR-01) for
    // why the command string routes through `cmd.exe /d /c "<bat>"` rather than the
    // bare `.bat` path.
    let vbs_content = build_vbs_launcher_content(&bat_path.to_string_lossy());
    std::fs::write(&vbs_path, &vbs_content)
        .map_err(|e| format!("Cannot create VBS launcher: {e}"))?;

    // T-20: gate on WinVerifyTrust here once the binary is signed.
    // The checksum gate above proves INTEGRITY (the bytes match the published
    // hash) but NOT AUTHENTICITY — a compromised release could supply a matching
    // checksum for a malicious .exe. Verifying the installer's Authenticode
    // signature with WinVerifyTrust before this spawn is the authenticity check;
    // it requires a code-signing cert + signing pipeline (BACKLOG T-20).
    std::process::Command::new(wscript_exe_path())
        .arg(&vbs_path)
        .creation_flags(0x08000000)
        .spawn()
        .map_err(|e| format!("Cannot launch updater: {e}"))?;

    // Launch a small loader window (parallel to bat, cosmetic only)
    let is_ru = _lang != "en";
    let is_light = _theme == "light";
    let loader_text = if is_ru { "Обновление TrustTunnel..." } else { "Updating TrustTunnel..." };
    let wait_text = if is_ru { "Подождите..." } else { "Please wait..." };
    let (bg, fg, sub_c, bar_bg) = if is_light {
        ("245,246,250", "26,26,46", "100,100,120", "220,220,230")
    } else {
        ("24,24,31", "240,240,245", "120,120,140", "40,40,50")
    };

    let loader_ps = run_dir.join("trusttunnel_loader.ps1");
    let loader_content = format!(
        "Add-Type -AssemblyName System.Windows.Forms\n\
         Add-Type -AssemblyName System.Drawing\n\
         $f=New-Object Windows.Forms.Form\n\
         $f.FormBorderStyle='None'\n\
         $f.Size=New-Object Drawing.Size(320,90)\n\
         $f.StartPosition='CenterScreen'\n\
         $f.TopMost=$true\n\
         $f.ShowInTaskbar=$false\n\
         $f.BackColor=[Drawing.Color]::FromArgb({bg})\n\
         $l=New-Object Windows.Forms.Label\n\
         $l.Text='{loader_text}'\n\
         $l.ForeColor=[Drawing.Color]::FromArgb({fg})\n\
         $l.Font=New-Object Drawing.Font('Segoe UI Semibold',11)\n\
         $l.AutoSize=$true\n\
         $l.Location=New-Object Drawing.Point(20,14)\n\
         $f.Controls.Add($l)\n\
         $s=New-Object Windows.Forms.Label\n\
         $s.Text='{wait_text}'\n\
         $s.ForeColor=[Drawing.Color]::FromArgb({sub_c})\n\
         $s.Font=New-Object Drawing.Font('Segoe UI',8.5)\n\
         $s.AutoSize=$true\n\
         $s.Location=New-Object Drawing.Point(20,58)\n\
         $f.Controls.Add($s)\n\
         $bgp=New-Object Windows.Forms.Panel\n\
         $bgp.BackColor=[Drawing.Color]::FromArgb({bar_bg})\n\
         $bgp.Size=New-Object Drawing.Size(280,3)\n\
         $bgp.Location=New-Object Drawing.Point(20,46)\n\
         $f.Controls.Add($bgp)\n\
         $b=New-Object Windows.Forms.Panel\n\
         $b.BackColor=[Drawing.Color]::FromArgb(99,102,241)\n\
         $b.Size=New-Object Drawing.Size(80,3)\n\
         $b.Location=New-Object Drawing.Point(20,46)\n\
         $f.Controls.Add($b)\n\
         $b.BringToFront()\n\
         $script:d=1; $script:x=0\n\
         $anim=New-Object Windows.Forms.Timer\n\
         $anim.Interval=30\n\
         $anim.Add_Tick({{$script:x+=$script:d*4; if($script:x -gt 200){{$script:d=-1}}; if($script:x -lt 0){{$script:d=1;$script:x=0}}; $b.Location=New-Object Drawing.Point((20+$script:x),46); $b.Size=New-Object Drawing.Size(80,3)}})\n\
         $anim.Start()\n\
         $close=New-Object Windows.Forms.Timer\n\
         $close.Interval=30000\n\
         $close.Add_Tick({{$f.Close()}})\n\
         $close.Start()\n\
         $f.ShowDialog()\n\
         Remove-Item $MyInvocation.MyCommand.Path -Force -EA 0\n"
    );
    std::fs::write(&loader_ps, &loader_content).ok();
    std::process::Command::new(powershell_exe_path())
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", &loader_ps.to_string_lossy()])
        .creation_flags(0x08000000)
        .spawn()
        .ok(); // Non-critical — if loader fails, update still works

    // Give bat a moment to start, then exit
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    app.exit(0);

    Ok(())
}

#[cfg(test)]
mod self_update_integrity_tests {
    use super::*;

    // SEC-01 fail-CLOSED: an empty/whitespace checksum must REJECT (was: silently
    // skipped with a stderr-only warning → unverified elevated install).
    #[test]
    fn empty_checksum_is_rejected() {
        assert_eq!(
            verify_checksum(b"any bytes", ""),
            Err("UPDATE_CHECKSUM_MISSING".into())
        );
        assert_eq!(
            verify_checksum(b"any bytes", "   "),
            Err("UPDATE_CHECKSUM_MISSING".into())
        );
    }

    // SEC-01: a syntactically invalid digest (wrong length / non-hex) must REJECT.
    #[test]
    fn malformed_checksum_is_rejected() {
        // too short
        assert_eq!(
            verify_checksum(b"x", "deadbeef"),
            Err("UPDATE_CHECKSUM_MALFORMED".into())
        );
        // 64 chars but non-hex
        assert_eq!(
            verify_checksum(b"x", &"z".repeat(64)),
            Err("UPDATE_CHECKSUM_MALFORMED".into())
        );
    }

    // SEC-01: a well-formed but WRONG digest must REJECT (mismatch).
    #[test]
    fn wrong_checksum_is_rejected() {
        let wrong = "0".repeat(64);
        assert_eq!(
            verify_checksum(b"hello", &wrong),
            Err("UPDATE_CHECKSUM_MISMATCH".into())
        );
    }

    // SEC-01: the correct digest passes, case-insensitively.
    #[test]
    fn correct_checksum_passes() {
        // sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
        let h = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
        assert!(verify_checksum(b"hello", h).is_ok());
        assert!(verify_checksum(b"hello", &h.to_uppercase()).is_ok()); // case-insensitive
    }

    // SEC-03: the url::Url-based validator rejects the userinfo/@-bypass that the
    // old hand-rolled `trim_start_matches("https://").split('/')` parser accepted
    // (it read `github.com@evil.com` as host `github.com`). url::Url::host_str()
    // correctly resolves the authority to `evil.com` → reject.
    #[test]
    fn validate_download_url_rejects_userinfo_bypass() {
        assert!(validate_download_url("https://github.com@evil.com/x").is_err());
        assert!(validate_download_url("https://github.com:tok@evil.com/x").is_err());
    }

    // SEC-05/06: per-run temp dirs are unguessable AND distinct across runs, so an
    // attacker cannot pre-stage a fixed-name artifact (TOCTOU). The dir name uses a
    // fresh uuid each call.
    #[test]
    fn per_run_update_dir_is_unique() {
        let a = make_run_dir_name();
        let b = make_run_dir_name();
        assert_ne!(a, b, "two runs must produce distinct dir names");
        assert!(a.starts_with("tt_update_"));
        assert!(b.starts_with("tt_update_"));
    }
}

#[cfg(test)]
mod self_update_cleanup_tests {
    use super::*;

    const RUN_DIR: &str = r"C:\Temp\tt_update_abc123";
    const PROGRAM_FILES: &str = r"C:\Program Files";

    /// The batch `self_update` would write for `app`, with the fixed per-run dir above.
    fn bat_for(app: &str, exe_name: &str, program_files_dir: Option<&str>) -> String {
        let setup = format!(r"{RUN_DIR}\trusttunnel_setup.exe");
        let vbs = format!(r"{RUN_DIR}\trusttunnel_updater.vbs");
        let loader = format!(r"{RUN_DIR}\trusttunnel_loader.ps1");
        build_updater_bat(&UpdaterBatPaths {
            pid: 4242,
            setup: &setup,
            app,
            exe_name,
            vbs: &vbs,
            loader: &loader,
            run_dir: RUN_DIR,
            program_files_dir,
        })
    }

    // be-1 regression: the updater .bat must NOT try to remove its own run_dir
    // with a non-recursive `rmdir "{run_dir}"` while the still-running .bat (and
    // any open loader.ps1) sits inside it — a non-empty dir makes that rmdir fail
    // and orphans an empty tt_update_<uuid> dir in %TEMP% after every update.
    // The dir must instead be reclaimed by a DETACHED, delayed, RECURSIVE removal
    // that outlives the .bat's own self-delete.
    #[test]
    fn updater_bat_schedules_detached_recursive_cleanup() {
        let run_dir = RUN_DIR;
        let bat = bat_for(
            r"C:\Program Files\TrustTunnel\app.exe",
            "app.exe",
            Some(PROGRAM_FILES),
        );

        // The leaky inline non-recursive form must be gone.
        assert!(
            !bat.contains(&format!("rmdir \"{run_dir}\" >nul")),
            "must not run a self-blocking non-recursive rmdir of run_dir inline:\n{bat}"
        );

        // The whole run_dir must be removed recursively and quietly...
        assert!(
            bat.contains(&format!("rmdir /S /Q \"\"{run_dir}\"\"")),
            "must recursively (/S /Q) remove the whole run_dir:\n{bat}"
        );
        // ...by a DETACHED process (start "" /b cmd.exe /c ...) so it survives the
        // .bat's own (goto)/del self-delete on the final line. D-11: by full path.
        assert!(
            bat.contains(r#"start "" /b %SystemRoot%\System32\cmd.exe /c"#),
            "recursive cleanup must run in a detached cmd that outlives the .bat:\n{bat}"
        );
        // ...after a short delay so the .bat + loader release their handles.
        assert!(
            bat.contains(r"%SystemRoot%\System32\timeout.exe /t 5 /nobreak >nul & rmdir /S /Q"),
            "detached cleanup must wait before removing the dir:\n{bat}"
        );

        // The .bat still self-deletes as the very last step.
        assert!(
            bat.trim_end().ends_with("(goto) 2>nul & del \"%~f0\""),
            "the .bat must still self-delete last:\n{bat}"
        );
    }

    // be-1 belt-and-suspenders: a start-time sweep removes ONLY our own
    // tt_update_* orphans and never touches unrelated temp content.
    #[test]
    fn sweep_removes_only_our_orphan_dirs() {
        let base = std::env::temp_dir().join(format!("tt_sweep_test_{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&base).unwrap();

        // An orphaned updater dir (our prefix) with a leftover file inside,
        // a foreign dir we must NOT touch, and a foreign file.
        let ours = base.join("tt_update_deadbeef");
        std::fs::create_dir_all(&ours).unwrap();
        std::fs::write(ours.join("leftover.bat"), b"x").unwrap();
        let foreign_dir = base.join("someone_elses_dir");
        std::fs::create_dir_all(&foreign_dir).unwrap();
        let foreign_file = base.join("tt_update_not_a_dir.txt");
        std::fs::write(&foreign_file, b"x").unwrap();

        sweep_stale_update_dirs_in(&base);

        assert!(!ours.exists(), "our orphaned tt_update_* dir must be removed (incl. its contents)");
        assert!(foreign_dir.exists(), "an unrelated dir must be left untouched");
        assert!(foreign_file.exists(), "a non-dir name must be left untouched");

        // Cleanup the test scratch dir.
        let _ = std::fs::remove_dir_all(&base);
    }

    // ── D-10.3: the one update that crosses the relocation ───────────────────────
    //
    // THE DEFECT: `build_updater_bat` composes the relaunch target from
    // `current_exe()` captured BEFORE the installer runs (`self_update`, :1187/:1294).
    // Phase 32-01 moved the install out of `%LOCALAPPDATA%\TrustTunnel Client Pro`
    // and into Program Files, so the ONE update that crosses that move installs
    // perfectly and then runs `start "" "<the old path>"` on an executable that no
    // longer exists.
    //
    // THE SYMPTOM: «обновилось и не открылось» — the user reads it as a crash. It
    // happens exactly once per machine, which is precisely why it has to be pinned by
    // an assertion over the generated text rather than reasoned about: there is no
    // second chance to notice it.
    //
    // THE CONSTRAINT that shapes the fix: the .bat is written BEFORE the installer
    // runs, so the destination cannot be interpolated into it. The batch has to
    // discover it at run time, from the registry value the installer itself writes
    // (research F7), and must degrade to the captured path — today's behaviour —
    // rather than to nothing when the registry cannot answer.
    #[test]
    fn updater_bat_learns_the_install_dir_from_the_registry_after_installing() {
        let setup = format!(r"{RUN_DIR}\trusttunnel_setup.exe");
        let captured = r"C:\Users\me\AppData\Local\TrustTunnel Client Pro\trusttunnel.exe";
        let bat = bat_for(captured, "trusttunnel.exe", Some(PROGRAM_FILES));

        // The old shape — relaunching the captured path unconditionally — must be GONE.
        assert!(
            !bat.contains(&format!("start \"\" \"{captured}\"")),
            "the relaunch must not name the pre-install path unconditionally:\n{bat}"
        );
        // ...and replaced by a relaunch of the resolved target.
        assert!(
            bat.contains("start \"\" \"%TT_EXE%\""),
            "the relaunch must go through the resolved target:\n{bat}"
        );

        // Machine hive FIRST (that is where the per-machine installer writes it now),
        // user hive SECOND (a machine that has not yet crossed the relocation still
        // has its value in HKCU — confirmed on a real Windows install, 32-01).
        let hklm = bat
            .find(&format!("HKLM\\{INSTALL_DIR_PRODUCT_KEY}"))
            .unwrap_or_else(|| panic!("no machine-hive probe in the batch:\n{bat}"));
        let hkcu = bat
            .find(&format!("HKCU\\{INSTALL_DIR_PRODUCT_KEY}"))
            .unwrap_or_else(|| panic!("no user-hive probe in the batch:\n{bat}"));
        assert!(
            hklm < hkcu,
            "the machine hive must be probed before the user hive:\n{bat}"
        );

        // Both probes must come AFTER the silent install. Reading before it would
        // answer with the directory the app is about to LEAVE — the bug, restored.
        let installed_at = bat
            .find(&format!("\"{setup}\" /S"))
            .unwrap_or_else(|| panic!("no silent-install invocation in the batch:\n{bat}"));
        assert!(
            installed_at < hklm,
            "the registry must be read AFTER the installer has run, not before:\n{bat}"
        );

        // The discovered directory is only used when the expected executable is really
        // inside it (T-32-12: a registry value becomes a launch target).
        assert!(
            bat.contains(
                "if defined TT_DIR if exist \"%TT_DIR%\\trusttunnel.exe\" \
                 set \"TT_EXE=%TT_DIR%\\trusttunnel.exe\""
            ),
            "the resolved directory must be guarded by an existence check:\n{bat}"
        );

        // The captured path survives as the fallback, and is assigned BEFORE the guard
        // so the guard can override it — never the other way round.
        let fallback_at = bat
            .find(&format!("set \"TT_EXE={captured}\""))
            .unwrap_or_else(|| panic!("the captured path is not the fallback target:\n{bat}"));
        let guard_at = bat
            .find("if defined TT_DIR if exist")
            .unwrap_or_else(|| panic!("no existence guard in the batch:\n{bat}"));
        assert!(
            fallback_at < guard_at,
            "the captured path must be the DEFAULT that the guard overrides:\n{bat}"
        );

        // The detached recursive cleanup and the self-delete are untouched by all this.
        assert!(
            bat.trim_end().ends_with("(goto) 2>nul & del \"%~f0\""),
            "the .bat must still self-delete last:\n{bat}"
        );
    }

    // MEASURED, not assumed, on a real Russian Windows 11:
    //
    //     > reg query "HKLM\SOFTWARE\Classes\.txt" /ve
    //         (по умолчанию)    REG_SZ    txtfilelegacy
    //
    // The default-value column is LOCALIZED, so it is THREE whitespace-separated
    // tokens («(по», «умолчанию)»), not the one that `(Default)` would be. Research
    // F7 proposed `for /f "tokens=2,*"`, which on this machine captures
    // `A=умолчанию)` and `B=REG_SZ    txtfilelegacy` — the path lands in the wrong
    // variable, prefixed with the type name.
    //
    // Why that is worse than an ordinary bug: the mis-parsed value fails the `if exist`
    // guard, so the batch degrades silently to the captured path — i.e. to exactly the
    // crash this whole fix exists to prevent — on precisely the machines this
    // application is built for. It would look fixed and be broken.
    //
    // The parse must therefore key off `REG_SZ`, which is NOT localized, and take
    // everything after it.
    #[test]
    fn updater_bat_registry_parse_survives_a_localized_default_value_name() {
        let bat = bat_for(
            r"C:\Users\me\AppData\Local\TrustTunnel Client Pro\trusttunnel.exe",
            "trusttunnel.exe",
            Some(PROGRAM_FILES),
        );

        assert!(
            !bat.contains("tokens=2,*"),
            "a positional token parse breaks on a localized «(по умолчанию)» column:\n{bat}"
        );
        assert!(
            bat.contains("for /f \"delims=\""),
            "the value line must be captured whole, then split on REG_SZ:\n{bat}"
        );
        assert!(
            bat.contains("set \"TT_DIR=!TT_LINE:*REG_SZ    =!\""),
            "the path must be taken as everything after the untranslated REG_SZ column:\n{bat}"
        );
        // The substring split above needs delayed expansion, and its result has to
        // survive the `endlocal` that ends the delayed-expansion window.
        assert!(
            bat.contains("setlocal enabledelayedexpansion"),
            "the REG_SZ split needs delayed expansion to read the loop variable:\n{bat}"
        );
        assert!(
            bat.contains("endlocal & set \"TT_DIR=%TT_DIR%\""),
            "the resolved directory must survive the endlocal:\n{bat}"
        );
    }

    // The .bat inherits its parent's environment. A `TT_DIR` that happened to already
    // be defined there would satisfy `if not defined TT_DIR`, skip the second probe,
    // and then be handed straight to the `if exist` guard — an outside-supplied launch
    // target. Clearing it first costs one line and closes that off.
    #[test]
    fn updater_bat_clears_an_inherited_tt_dir_before_probing_the_registry() {
        let bat = bat_for(
            r"C:\Users\me\AppData\Local\TrustTunnel Client Pro\trusttunnel.exe",
            "trusttunnel.exe",
            Some(PROGRAM_FILES),
        );

        let cleared_at = bat
            .find("set \"TT_DIR=\"")
            .unwrap_or_else(|| panic!("TT_DIR is never cleared before the probe:\n{bat}"));
        let probed_at = bat
            .find(&format!("HKLM\\{INSTALL_DIR_PRODUCT_KEY}"))
            .unwrap_or_else(|| panic!("no machine-hive probe in the batch:\n{bat}"));
        assert!(
            cleared_at < probed_at,
            "an inherited TT_DIR must be cleared before the registry is probed:\n{bat}"
        );
    }

    // WIN-16 / D-10 / D-12: an install OUTSIDE Program Files relaunches the path
    // captured before the install. The narrowing (proven by cmd.exe in
    // `registry_narrowing_tests`) sits between the probes and `endlocal`, so a
    // rejected registry value never reaches the guard, and TT_EXE is already set.
    #[test]
    fn updater_bat_relaunches_the_captured_path_when_the_install_is_outside_program_files() {
        let captured = r"D:\TrustTunnel\trusttunnel.exe";
        let bat = bat_for(captured, "trusttunnel.exe", Some(PROGRAM_FILES));

        let fallback_at = bat
            .find(&format!("set \"TT_EXE={captured}\""))
            .unwrap_or_else(|| panic!("the captured path is not assigned as TT_EXE:\n{bat}"));
        let hklm_at = bat
            .find(&format!("HKLM\\{INSTALL_DIR_PRODUCT_KEY}"))
            .unwrap_or_else(|| panic!("no machine-hive probe in the batch:\n{bat}"));
        assert!(
            fallback_at < hklm_at,
            "TT_EXE must hold the captured path before any registry probe runs:\n{bat}"
        );

        let narrowing = registry_dir_narrowing(Some(PROGRAM_FILES));
        let hkcu_at = bat
            .find(&format!("HKCU\\{INSTALL_DIR_PRODUCT_KEY}"))
            .unwrap_or_else(|| panic!("no user-hive probe in the batch:\n{bat}"));
        let narrowing_at = bat
            .find(&narrowing)
            .unwrap_or_else(|| panic!("the narrowing is not in the batch verbatim:\n{bat}"));
        let endlocal_at = bat
            .find("endlocal & set \"TT_DIR=%TT_DIR%\"")
            .unwrap_or_else(|| panic!("no endlocal hand-over of TT_DIR:\n{bat}"));
        assert!(
            hkcu_at < narrowing_at && narrowing_at + narrowing.len() == endlocal_at,
            "the narrowing must run after both probes and immediately before endlocal:\n{bat}"
        );

        assert!(
            bat.contains("start \"\" \"%TT_EXE%\""),
            "the relaunch must go through TT_EXE:\n{bat}"
        );
    }

    // When HKLM cannot give a Program Files root, the batch must still relaunch: TT_EXE
    // is assigned before the probes, the narrowing collapses to clearing TT_DIR, and
    // the relaunch goes through TT_EXE (P-02-02-1: never launch nothing).
    #[test]
    fn updater_bat_without_a_program_files_root_still_relaunches_the_captured_path() {
        let captured = r"D:\TrustTunnel\trusttunnel.exe";
        let bat = bat_for(captured, "trusttunnel.exe", None);

        let fallback_at = bat
            .find(&format!("set \"TT_EXE={captured}\""))
            .unwrap_or_else(|| panic!("the captured path is not assigned as TT_EXE:\n{bat}"));
        let hklm_at = bat
            .find(&format!("HKLM\\{INSTALL_DIR_PRODUCT_KEY}"))
            .unwrap_or_else(|| panic!("no machine-hive probe in the batch:\n{bat}"));
        assert!(fallback_at < hklm_at, "TT_EXE must be assigned before the probes:\n{bat}");
        assert!(
            bat.contains("set \"TT_DIR=\"\nendlocal & set \"TT_DIR=%TT_DIR%\""),
            "without a root, TT_DIR must be cleared right before endlocal:\n{bat}"
        );
        assert!(
            bat.contains("start \"\" \"%TT_EXE%\""),
            "the relaunch must go through TT_EXE:\n{bat}"
        );
    }

    // D-11 / T-02-06: the batch runs elevated, so no program it starts may be found
    // through PATH or the current directory, where a user-writable entry ahead of
    // System32 would win. Each external executable is named by full path, and a regex
    // over the whole text proves no bare command word is left.
    #[test]
    fn updater_bat_calls_external_commands_by_full_path() {
        let bat = bat_for(
            r"C:\Program Files\TrustTunnel Client Pro\trusttunnel.exe",
            "trusttunnel.exe",
            Some(PROGRAM_FILES),
        );
        for name in ["tasklist", "find", "timeout", "reg", "cmd"] {
            assert!(
                bat.contains(&format!(r"%SystemRoot%\System32\{name}.exe")),
                "{name} is never called by full path:\n{bat}"
            );
        }
        let bare = regex::Regex::new(r"(?im)(^|[\s|&('])(tasklist|find|timeout|reg|cmd)(\.exe)?\s")
            .unwrap();
        let hits: Vec<&str> = bare.find_iter(&bat).map(|m| m.as_str()).collect();
        assert!(hits.is_empty(), "bare command words left: {hits:?}\n{bat}");

        // `for /f ('...')` runs its command through %ComSpec%, an environment variable a
        // per-user setting can redirect. It is pinned before the first such loop.
        let comspec_at = bat
            .find(r#"set "ComSpec=%SystemRoot%\System32\cmd.exe""#)
            .unwrap_or_else(|| panic!("ComSpec is not pinned to System32:\n{bat}"));
        let first_for_at = bat
            .find("for /f")
            .unwrap_or_else(|| panic!("no for /f probe in the batch:\n{bat}"));
        assert!(
            comspec_at < first_for_at,
            "ComSpec must be pinned before the first for /f spawns a shell:\n{bat}"
        );
    }

    // `start` is a cmd.exe built-in: there is no start.exe to name by path. D-11 is
    // met for it by what it launches: every target is an absolute path.
    #[test]
    fn updater_bat_start_targets_are_absolute() {
        let bat = bat_for(
            r"C:\Program Files\TrustTunnel Client Pro\trusttunnel.exe",
            "trusttunnel.exe",
            Some(PROGRAM_FILES),
        );
        let starts: Vec<&str> = bat
            .lines()
            .map(str::trim_start)
            .filter(|l| l.starts_with("start "))
            .collect();
        assert_eq!(starts.len(), 2, "expected the relaunch and the cleanup start:\n{bat}");
        for line in starts {
            let target = line
                .strip_prefix("start \"\" ")
                .map(|rest| rest.strip_prefix("/b ").unwrap_or(rest))
                .unwrap_or_else(|| panic!("start without an empty title: {line}"));
            assert!(
                target.starts_with("\"%TT_EXE%\"")
                    || target.starts_with(r"%SystemRoot%\System32\cmd.exe "),
                "start launches a target that is not an absolute path: {line}"
            );
        }
    }
}

// WIN-16: the registry install-dir narrowing, executed by the real cmd.exe.
//
// Reading the generated text proves the lines are THERE; only the interpreter proves
// what they DO. Batch quoting, delayed expansion and `!var:*str=!` substitution have
// enough corner cases that a string assertion could pass over a check cmd.exe reads
// differently. So each case writes a tiny batch that feeds a candidate into TT_DIR,
// runs the exact text `registry_dir_narrowing` returns, and reports whether TT_DIR
// survived.
#[cfg(all(test, windows))]
mod registry_narrowing_tests {
    use super::*;

    /// Run the narrowing for `candidate` under the given Program Files root through
    /// `%SystemRoot%\System32\cmd.exe` and return its trimmed stdout+stderr:
    /// `ADOPTED` when TT_DIR survives, `REJECTED` when the narrowing cleared it.
    ///
    /// The candidate arrives through an environment variable and is copied with
    /// delayed expansion, so quotes and ampersands in it reach the narrowing exactly as
    /// a registry value would after the `REG_SZ` split: unparsed.
    fn run_narrowing(program_files: Option<&str>, candidate: &str) -> String {
        let scratch = std::env::temp_dir()
            .join(format!("tt_narrow_test_{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&scratch).unwrap();
        let bat_path = scratch.join("narrow.bat");
        let harness = [
            "@echo off".to_string(),
            "setlocal enabledelayedexpansion".to_string(),
            "set \"TT_DIR=!TT_CANDIDATE!\"".to_string(),
            registry_dir_narrowing(program_files),
            "if defined TT_DIR (echo ADOPTED) else (echo REJECTED)".to_string(),
        ]
        .join("\r\n");
        std::fs::write(&bat_path, format!("{harness}\r\n")).unwrap();

        let system_root =
            std::env::var("SystemRoot").expect("SystemRoot is set on every Windows install");
        let out = std::process::Command::new(format!(r"{system_root}\System32\cmd.exe"))
            .args(["/d", "/c"])
            .arg(&bat_path)
            .env("TT_CANDIDATE", candidate)
            .output()
            .expect("cmd.exe must run");
        let _ = std::fs::remove_dir_all(&scratch);

        let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
        text.push_str(&String::from_utf8_lossy(&out.stderr));
        text.trim().to_string()
    }

    const PROGRAM_FILES: &str = r"C:\Program Files";

    // D-02: the first case written. A custom-folder install outside Program Files is
    // the one live configuration the narrowing can break; it must be REJECTED here so
    // the relaunch falls back to TT_EXE (the installer writes over that same folder).
    #[test]
    fn narrowing_rejects_an_install_dir_outside_program_files() {
        assert_eq!(
            run_narrowing(Some(PROGRAM_FILES), r"D:\TrustTunnel"),
            "REJECTED"
        );
    }

    // The per-machine install the installer writes to HKLM is adopted, which is the
    // D-10.3 relocation fix this narrowing must not undo.
    #[test]
    fn narrowing_adopts_an_install_dir_inside_program_files() {
        assert_eq!(
            run_narrowing(Some(PROGRAM_FILES), r"C:\Program Files\TrustTunnel Client Pro"),
            "ADOPTED"
        );
    }

    // `self_update` passes this value in; it must be a root the sanitiser accepts on a
    // real Windows install, or every update would silently ignore the registry.
    #[test]
    fn program_files_dir_resolves_from_hklm() {
        let root = resolve_program_files_dir().expect("HKLM ProgramFilesDir is readable");
        let b = root.as_bytes();
        assert!(
            b.len() > 3 && b[0].is_ascii_alphabetic() && &b[1..3] == b":\\",
            "not in drive-letter form: {root}"
        );
        assert!(!root.ends_with('\\'), "trailing backslash: {root}");
        assert_eq!(sanitize_program_files_dir(&root).as_deref(), Some(root.as_str()));
    }

    // ── The rejection surface, one class per case ─────────────────────────────────

    // D-10: a custom folder at a drive root is outside Program Files → TT_EXE.
    #[test]
    fn narrowing_rejects_a_drive_root_custom_folder() {
        assert_eq!(run_narrowing(Some(PROGRAM_FILES), r"C:\TrustTunnel"), "REJECTED");
    }

    #[test]
    fn narrowing_rejects_a_unc_path() {
        assert_eq!(
            run_narrowing(Some(PROGRAM_FILES), r"\\server\share\Program Files\TT"),
            "REJECTED"
        );
    }

    #[test]
    fn narrowing_rejects_a_device_path() {
        assert_eq!(
            run_narrowing(Some(PROGRAM_FILES), r"\\?\C:\Program Files\TT"),
            "REJECTED"
        );
    }

    #[test]
    fn narrowing_rejects_a_relative_path() {
        assert_eq!(run_narrowing(Some(PROGRAM_FILES), r"Program Files\TT"), "REJECTED");
    }

    #[test]
    fn narrowing_rejects_a_traversal_out_of_program_files() {
        assert_eq!(
            run_narrowing(Some(PROGRAM_FILES), r"C:\Program Files\..\Users\Public\TT"),
            "REJECTED"
        );
    }

    // The prefix test must end at a path separator: a sibling that merely starts with
    // the same letters is a different directory.
    #[test]
    fn narrowing_rejects_a_sibling_sharing_the_root_prefix() {
        assert_eq!(run_narrowing(Some(PROGRAM_FILES), r"C:\Program FilesX\TT"), "REJECTED");
        assert_eq!(
            run_narrowing(Some(PROGRAM_FILES), r"C:\Program Files (x86)\TT"),
            "REJECTED"
        );
    }

    // The root itself is not an install directory, with or without the separator.
    #[test]
    fn narrowing_rejects_the_bare_root() {
        assert_eq!(run_narrowing(Some(PROGRAM_FILES), r"C:\Program Files"), "REJECTED");
        assert_eq!(run_narrowing(Some(PROGRAM_FILES), "C:\\Program Files\\"), "REJECTED");
    }

    #[test]
    fn narrowing_rejects_an_empty_value() {
        assert_eq!(run_narrowing(Some(PROGRAM_FILES), ""), "REJECTED");
    }

    // Windows paths are case-insensitive; the registry may spell the root differently.
    #[test]
    fn narrowing_adopts_the_root_in_any_letter_case() {
        assert_eq!(
            run_narrowing(Some(PROGRAM_FILES), r"c:\PROGRAM FILES\TrustTunnel Client Pro"),
            "ADOPTED"
        );
    }

    // T-02-05 / P-02-02-2: a value built to close the quote and chain a command. The
    // narrowing must refuse it AND nothing in it may run while it is being examined.
    #[test]
    fn narrowing_rejects_a_quote_injection_without_running_it() {
        let out = run_narrowing(
            Some(PROGRAM_FILES),
            r#"C:\Program Files\TT" & echo INJECTED & ""#,
        );
        assert!(!out.contains("INJECTED"), "the injected command ran: {out}");
        assert_eq!(out, "REJECTED");
    }

    // P-02-02-1: `if exist` matches wildcards but `start` cannot launch them, so a
    // wildcard value that got through would relaunch nothing at all.
    #[test]
    fn narrowing_rejects_wildcards() {
        assert_eq!(run_narrowing(Some(PROGRAM_FILES), r"C:\Program Files\Trust*"), "REJECTED");
        assert_eq!(run_narrowing(Some(PROGRAM_FILES), r"C:\Program Files\Trust?"), "REJECTED");
    }

    // A second colon is an alternate data stream or a second drive spec; neither is an
    // install directory.
    #[test]
    fn narrowing_rejects_a_colon_after_the_drive() {
        assert_eq!(run_narrowing(Some(PROGRAM_FILES), r"C:\Program Files\TT:ads"), "REJECTED");
        assert_eq!(
            run_narrowing(Some(PROGRAM_FILES), r"C:\Program Files\C:\Program Files\TT"),
            "REJECTED"
        );
    }

    // No resolvable root: every registry value is discarded and TT_EXE is used.
    #[test]
    fn narrowing_without_a_root_rejects_everything() {
        assert_eq!(
            run_narrowing(None, r"C:\Program Files\TrustTunnel Client Pro"),
            "REJECTED"
        );
    }

    // ── The builder's own tail, end to end ────────────────────────────────────────
    //
    // The lines from `set "TT_EXE=..."` up to the relaunch, cut out of the real
    // builder output. The two registry probes are swapped for the candidate, and the
    // relaunch for `set TT_EXE`, which prints the target without parsing it.
    fn run_tail(program_files: &str, candidate: &str) -> String {
        let captured = r"C:\Captured\trusttunnel.exe";
        let bat = build_updater_bat(&UpdaterBatPaths {
            pid: 4242,
            setup: r"C:\Temp\tt_update_abc\trusttunnel_setup.exe",
            app: captured,
            exe_name: "trusttunnel.exe",
            vbs: r"C:\Temp\tt_update_abc\trusttunnel_updater.vbs",
            loader: r"C:\Temp\tt_update_abc\trusttunnel_loader.ps1",
            run_dir: r"C:\Temp\tt_update_abc",
            program_files_dir: Some(program_files),
        });
        let from = bat.find("set \"TT_EXE=").expect("TT_EXE assignment");
        let to = bat.find("start \"\" \"%TT_EXE%\"").expect("relaunch line");
        let mut lines = vec!["@echo off".to_string()];
        for line in bat[from..to].lines() {
            if line.contains(r"HKLM\") {
                lines.push("set \"TT_DIR=!TT_CANDIDATE!\"".to_string());
            } else if !line.contains(r"HKCU\") {
                lines.push(line.to_string());
            }
        }
        lines.push("set TT_EXE".to_string());

        let scratch = std::env::temp_dir()
            .join(format!("tt_narrow_test_{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&scratch).unwrap();
        let bat_path = scratch.join("tail.bat");
        std::fs::write(&bat_path, format!("{}\r\n", lines.join("\r\n"))).unwrap();
        let system_root =
            std::env::var("SystemRoot").expect("SystemRoot is set on every Windows install");
        let out = std::process::Command::new(format!(r"{system_root}\System32\cmd.exe"))
            .args(["/d", "/c"])
            .arg(&bat_path)
            .env("TT_CANDIDATE", candidate)
            .output()
            .expect("cmd.exe must run");
        let _ = std::fs::remove_dir_all(&scratch);
        let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
        text.push_str(&String::from_utf8_lossy(&out.stderr));
        text.trim().to_string()
    }

    /// A scratch "Program Files" with one install dir named `name` holding the exe, so
    /// the builder's `if exist` guard has something real to find.
    fn scratch_root_with_install(name: &str) -> (std::path::PathBuf, String, String) {
        let root = std::env::temp_dir()
            .join(format!("tt_narrow_root_{}", uuid::Uuid::new_v4().simple()));
        let install = root.join(name);
        std::fs::create_dir_all(&install).unwrap();
        std::fs::write(install.join("trusttunnel.exe"), b"").unwrap();
        let root_str = root.to_string_lossy().into_owned();
        assert!(
            sanitize_program_files_dir(&root_str).is_some(),
            "the scratch root must be a root the sanitiser accepts: {root_str}"
        );
        let install_str = install.to_string_lossy().into_owned();
        (root, root_str, install_str)
    }

    // D-10 end to end: a rejected value leaves TT_EXE at the captured path.
    #[test]
    fn tail_relaunches_the_captured_path_when_the_value_is_rejected() {
        let (root, root_str, _) = scratch_root_with_install("TrustTunnel Client Pro");
        let out = run_tail(&root_str, r"D:\TrustTunnel");
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(out, r"TT_EXE=C:\Captured\trusttunnel.exe");
    }

    // An adopted value is expanded with %...% on the lines after `endlocal`. Batch
    // metacharacters other than the quote are legal in a folder name; they must stay
    // data there too, so the relaunch target is exactly the folder + exe and nothing
    // in the name runs.
    #[test]
    fn tail_keeps_metacharacters_of_an_adopted_value_inert() {
        let (root, root_str, install) = scratch_root_with_install("TT & echo INJECTED");
        let out = run_tail(&root_str, &install);
        let _ = std::fs::remove_dir_all(&root);
        assert!(
            !out.lines().any(|l| l.trim() == "INJECTED"),
            "the folder name ran as a command: {out}"
        );
        assert_eq!(out, format!(r"TT_EXE={install}\trusttunnel.exe"));
    }
}

// CR-01 (code review, phase 02): `build_vbs_launcher_content` is proven two ways, same
// split as `registry_narrowing_tests` above — a pure string check that the generated
// VBS text has the expected shape, then a behavioral check through the real
// interpreter. The behavioral half runs `%SystemRoot%\System32\cmd.exe /d /c "<bat>"`
// directly rather than through `wscript.exe`/WSH: that is the command
// `WScript.Shell.Run` executes once its own string literal is parsed (VBS's `""`
// decodes to one literal `"`; VBScript does NOT collapse the doubled backslashes the
// launcher writes into the path, but Windows path parsing tolerates `\\` separators,
// so the batch that runs is the same one — and `/d` is what the test is about), and
// running it directly makes the assertion synchronous instead of racing an async,
// fire-and-forget `Run(..., False)` child process. `AutoRunGuard` plants a real,
// temporary `HKCU\Software\Microsoft\Command Processor\AutoRun` value for the
// duration of one test and restores the prior value (or removes it if there was none)
// on drop, including on panic/assertion failure, so a red run never leaves a foreign
// AutoRun behind on the machine running the suite.
#[cfg(all(test, windows))]
mod autorun_bypass_tests {
    use super::*;

    /// Sets `HKCU\Software\Microsoft\Command Processor\AutoRun` to `marker_cmd` for the
    /// lifetime of the guard and restores whatever was there before (or removes the
    /// value if it was previously undefined) when the guard drops.
    //
    // The two behavioral tests below are `#[ignore]`d on purpose and serialized by
    // `AUTORUN_LOCK`. They write the real per-user AutoRun value of whoever runs the
    // suite, and the libtest harness runs tests in parallel: in the first version two of
    // them interleaved — each guard saved the other's marker as "the original" — and the
    // machine was left with a test command in its AutoRun, displacing the value that was
    // there. A routine `cargo test --lib` (and CI) must never touch a real user
    // registry, so these run only on request:
    //   cargo test --lib autorun_bypass_tests -- --ignored --test-threads=1
    // The pure shape tests above stay in the default run and pin the launcher text.
    static AUTORUN_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct AutoRunGuard {
        key: winreg::RegKey,
        original: Option<String>,
        // Held for the guard's whole life so no other AutoRun test can save or restore
        // the value in between; released after `drop` has put the original back.
        _serial: std::sync::MutexGuard<'static, ()>,
    }

    impl AutoRunGuard {
        const PATH: &'static str = r"Software\Microsoft\Command Processor";

        fn set(marker_cmd: &str) -> Self {
            use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};
            use winreg::RegKey;

            let serial = AUTORUN_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let key = RegKey::predef(HKEY_CURRENT_USER)
                .create_subkey_with_flags(Self::PATH, KEY_READ | KEY_SET_VALUE)
                .expect("HKCU Command Processor is writable by the current user")
                .0;
            let original = key.get_value::<String, _>("AutoRun").ok();
            key.set_value("AutoRun", &marker_cmd)
                .expect("setting a per-user AutoRun value needs no admin rights");
            Self { key, original, _serial: serial }
        }
    }

    impl Drop for AutoRunGuard {
        fn drop(&mut self) {
            match &self.original {
                Some(v) => {
                    let _ = self.key.set_value("AutoRun", v);
                }
                None => {
                    let _ = self.key.delete_value("AutoRun");
                }
            }
        }
    }

    // Pure shape check: the doubled quotes wrap the bat path, the doubled backslashes
    // are the same escaping the code used before this fix, and the interpreter path is
    // the System32 one, not a bare `wscript`/`cmd` name.
    #[test]
    fn launcher_content_wraps_the_bat_in_system32_cmd_with_slash_d() {
        let vbs = build_vbs_launcher_content(r"C:\Temp\tt_update_abc\trusttunnel_updater.bat");
        // `%SystemRoot%\System32\cmd.exe` is literal template text (single backslash);
        // only the interpolated `bat_path` goes through `.replace('\\', "\\\\")`, so it
        // carries doubled backslashes. Both live in this one raw string.
        assert_eq!(
            vbs,
            r#"CreateObject("Wscript.Shell").Run "%SystemRoot%\System32\cmd.exe /d /c ""C:\\Temp\\tt_update_abc\\trusttunnel_updater.bat""", 0, False"#
        );
    }

    // A quote in the bat path (should never happen in practice, but the escaping is
    // meant to hold regardless) must still close correctly and not break out of the
    // `cmd.exe /d /c "..."` argument.
    #[test]
    fn launcher_content_escapes_quotes_in_the_bat_path() {
        let vbs = build_vbs_launcher_content(r#"C:\Temp\weird "quoted" dir\updater.bat"#);
        assert!(vbs.contains(r#"weird ""quoted"" dir"#), "unexpected escaping: {vbs}");
    }

    // CR-02 and the security audit's follow-up: both interpreters the elevated
    // `self_update` spawns are addressed by absolute System32 paths, never by a bare
    // name that Windows would resolve through PATH/CWD under the admin token.
    #[test]
    fn elevated_interpreters_are_spawned_by_absolute_system32_path() {
        let root = std::env::var("SystemRoot").expect("SystemRoot is set on every Windows install");
        let system32 = std::path::Path::new(&root).join("System32");

        let wscript = wscript_exe_path();
        assert!(wscript.is_absolute(), "wscript path is not absolute: {wscript:?}");
        assert_eq!(wscript, system32.join("wscript.exe"));

        let powershell = powershell_exe_path();
        assert!(powershell.is_absolute(), "powershell path is not absolute: {powershell:?}");
        assert_eq!(
            powershell,
            system32.join("WindowsPowerShell").join("v1.0").join("powershell.exe")
        );
    }

    /// Runs the exact command `WScript.Shell.Run` would execute for `bat_path` (decoded
    /// from `build_vbs_launcher_content`'s output) through real `%SystemRoot%\System32`
    /// `cmd.exe`, with the given `/c`-vs-`/d` flag set, and returns whether each marker
    /// file exists afterward: `(bat_ran, autorun_ran)`.
    fn run_launcher_command(bat_path: &std::path::Path, use_slash_d: bool) -> (bool, bool) {
        let dir = bat_path.parent().unwrap();
        let bat_marker = dir.join("bat_ran.marker");
        let autorun_marker = dir.join("autorun_ran.marker");
        let _ = std::fs::remove_file(&bat_marker);
        let _ = std::fs::remove_file(&autorun_marker);

        std::fs::write(
            bat_path,
            format!("@echo off\r\necho ran>\"{}\"\r\n", bat_marker.display()),
        )
        .unwrap();

        let autorun_cmd = format!(r#"echo ran>"{}""#, autorun_marker.display());
        let _guard = AutoRunGuard::set(&autorun_cmd);

        let system_root =
            std::env::var("SystemRoot").expect("SystemRoot is set on every Windows install");
        let mut cmd = std::process::Command::new(format!(r"{system_root}\System32\cmd.exe"));
        if use_slash_d {
            cmd.arg("/d");
        }
        cmd.arg("/c").arg(bat_path);
        let out = cmd.output().expect("cmd.exe must run");
        assert!(out.status.success(), "stand-in .bat failed: {out:?}");

        (bat_marker.exists(), autorun_marker.exists())
    }

    // Positive control: without `/d`, the AutoRun value from `HKCU` DOES fire before the
    // batch's own first line. This proves the harness actually detects AutoRun running
    // at all — without it, a passing "AutoRun did not run" assertion in the `/d` test
    // below would be meaningless.
    #[test]
    #[ignore = "writes the real HKCU AutoRun value; run on request with -- --ignored --test-threads=1"]
    fn without_slash_d_autorun_fires_before_the_batch() {
        let scratch =
            std::env::temp_dir().join(format!("tt_autorun_test_{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&scratch).unwrap();
        let bat_path = scratch.join("stand_in.bat");

        let (bat_ran, autorun_ran) = run_launcher_command(&bat_path, false);
        let _ = std::fs::remove_dir_all(&scratch);

        assert!(bat_ran, "the stand-in .bat did not run at all");
        assert!(autorun_ran, "AutoRun did not fire without /d — harness cannot detect it");
    }

    // CR-01: with `/d` — the flag `build_vbs_launcher_content` now uses — the AutoRun
    // value is skipped, while the batch itself still runs normally.
    #[test]
    #[ignore = "writes the real HKCU AutoRun value; run on request with -- --ignored --test-threads=1"]
    fn with_slash_d_autorun_is_skipped_and_the_batch_still_runs() {
        let scratch =
            std::env::temp_dir().join(format!("tt_autorun_test_{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&scratch).unwrap();
        let bat_path = scratch.join("stand_in.bat");

        // Sanity: `build_vbs_launcher_content` for this exact path really does produce
        // the `/d` command this test then runs directly.
        let vbs = build_vbs_launcher_content(&bat_path.to_string_lossy());
        assert!(vbs.contains("cmd.exe /d /c"), "generated command lost /d: {vbs}");

        let (bat_ran, autorun_ran) = run_launcher_command(&bat_path, true);
        let _ = std::fs::remove_dir_all(&scratch);

        assert!(bat_ran, "the stand-in .bat did not run under /d");
        assert!(!autorun_ran, "AutoRun ran despite /d — the CR-01 fix regressed");
    }
}

// The Program Files root is spliced into batch text verbatim, so its sanitiser is
// pinned on its own (pure; runs on any host).
#[cfg(test)]
mod program_files_root_tests {
    use super::*;

    #[test]
    fn sanitizer_trims_one_trailing_backslash() {
        assert_eq!(
            sanitize_program_files_dir("C:\\Program Files\\").as_deref(),
            Some(r"C:\Program Files")
        );
        assert_eq!(
            sanitize_program_files_dir(r"C:\Program Files").as_deref(),
            Some(r"C:\Program Files")
        );
    }

    #[test]
    fn sanitizer_refuses_anything_but_drive_letter_form() {
        for raw in ["", "Program Files", r"\\srv\pf", "C:", "C:\\", r"\Program Files"] {
            assert_eq!(sanitize_program_files_dir(raw), None, "accepted {raw:?}");
        }
    }

    // `%`/`!` would expand, `"` would close a quote, `=` would end the search string of
    // the `!TT_DIR:*<root>\=!` substitution early.
    #[test]
    fn sanitizer_refuses_batch_metacharacters() {
        for raw in [r"C:\Pro%gram", r"C:\A=B", r#"C:\x"y"#, r"C:\a!b", r"C:\a^b", r"C:\a&b"] {
            assert_eq!(sanitize_program_files_dir(raw), None, "accepted {raw:?}");
        }
    }
}

#[cfg(test)]
mod sidecar_version_tests {
    use super::*;

    #[test]
    fn parse_version_extracts_semver_from_plain() {
        assert_eq!(parse_version_from_output("1.0.33"), "1.0.33");
        assert_eq!(parse_version_from_output("v1.0.33\n"), "1.0.33");
        assert_eq!(parse_version_from_output("trusttunnel 1.0.33\n"), "1.0.33");
        assert_eq!(parse_version_from_output("trusttunnel-endpoint 1.0.33 (release)\n"), "1.0.33");
    }

    #[test]
    fn parse_version_handles_empty_and_unknown() {
        assert_eq!(parse_version_from_output(""), "unknown");
        assert_eq!(parse_version_from_output("unknown"), "unknown");
        assert_eq!(parse_version_from_output("\n\n"), "unknown");
        assert_eq!(parse_version_from_output("no-version-here"), "unknown");
    }

    #[test]
    fn compare_semver_orders_correctly() {
        assert_eq!(compare_semver("1.0.0", "1.0.1"), -1);
        assert_eq!(compare_semver("1.0.1", "1.0.0"), 1);
        assert_eq!(compare_semver("1.0.0", "1.0.0"), 0);
        assert_eq!(compare_semver("v1.0.0", "1.0.0"), 0);
        assert_eq!(compare_semver("1.0.0-beta.1", "1.0.0"), 0); // pre-release stripped
        assert_eq!(compare_semver("0.9.99", "1.0.0"), -1);
        assert_eq!(compare_semver("1.10.0", "1.9.0"), 1); // numeric, not lexicographic
    }

    #[test]
    fn select_asset_picks_correct_arch_and_excludes_dbgsym() {
        let assets = serde_json::json!([
            { "name": "trusttunnel-v1.0.33-linux-x86_64.tar.gz",
              "browser_download_url": "https://github.com/x/y/releases/download/v1.0.33/trusttunnel-v1.0.33-linux-x86_64.tar.gz",
              "size": 10700000_u64 },
            { "name": "trusttunnel-v1.0.33-linux-x86_64-dbgsym.tar.gz",
              "browser_download_url": "https://github.com/x/y/dbg.tar.gz",
              "size": 107000000_u64 },
            { "name": "trusttunnel-v1.0.33-linux-aarch64.tar.gz",
              "browser_download_url": "https://github.com/x/y/aarch64.tar.gz",
              "size": 9600000_u64 },
        ]);
        let arr = assets.as_array().unwrap();
        let (url, size) = select_sidecar_asset(arr, "x86_64").expect("should find x86_64");
        assert!(url.contains("x86_64"));
        assert!(!url.contains("dbgsym"));
        assert_eq!(size, 10_700_000);

        let (url_arm, _) = select_sidecar_asset(arr, "aarch64").expect("should find aarch64");
        assert!(url_arm.contains("aarch64"));
    }

    #[test]
    fn select_asset_returns_none_for_unknown_arch() {
        let assets = serde_json::json!([
            { "name": "trusttunnel-v1.0.33-linux-x86_64.tar.gz",
              "browser_download_url": "https://x.com/y.tar.gz",
              "size": 100_u64 }
        ]);
        assert!(select_sidecar_asset(assets.as_array().unwrap(), "mips").is_none());
    }

    #[test]
    fn validate_download_url_rejects_non_github() {
        assert!(validate_download_url("https://evil.com/setup.exe").is_err());
        assert!(validate_download_url("http://github.com/file").is_err()); // not HTTPS
        assert!(validate_download_url("https://github.com/x/y/releases/download/v1/file.tar.gz").is_ok());
        assert!(validate_download_url("https://objects.githubusercontent.com/x/y").is_ok());
    }
}

// ─── Phase 30: update-failure classification (ABOUT-01) ────────────────────
//
// The FULL input space, one #[test] per row plus one test over the whole table:
// two booleans is four rows, and enumerating all four proves the "ambiguity
// resolves to server-unreachable" rule instead of sampling it. Every assertion
// names a const rather than a quoted string — the same discipline
// `sidecar_version_tests` follows — so renaming a token becomes a compile error
// here rather than a silent divergence from the front end's lookup table.
//
// THESE TESTS USED TO LOCK IN THE WRONG RULE. The first version asserted the
// implemented eight-row table, in which a bare `is_connect()` meant no-internet.
// That contradicted `30-RESEARCH.md` §3, and because the tests were written from
// the implementation rather than from the rule, they could not catch it: they
// were green over a card telling connected users they had no internet.
#[cfg(test)]
mod update_failure_classification_tests {
    use super::*;

    #[test]
    fn a_named_resolution_failure_is_no_internet() {
        // The resolver could not turn the hostname into an address: no DNS server
        // answered, or the machine has no working resolver at all. This is POSITIVE
        // evidence that nothing left the box, and the only kind that earns the
        // «нет интернета» verdict.
        assert_eq!(
            classify_update_failure(false, true),
            UPDATE_NO_INTERNET_REASON
        );
    }

    #[test]
    fn a_connect_failure_with_nothing_in_the_chain_is_server_unreachable() {
        // REGRESSION. This used to be no-internet, on the reading that
        // `reqwest::Error::is_connect()` means the request never got out of the
        // machine. It does not: `is_connect()` covers TCP refused, TCP reset, TLS
        // handshake failure and proxy errors, all of which happen AFTER the address
        // resolved and the packet left. Telling a connected user «нет интернета» is
        // a claim the app cannot support, so an unexplained connect failure takes
        // the honest default instead — its copy («С приложением всё в порядке —
        // попробуйте позже») stays true whichever of the ambiguous causes it was.
        assert_eq!(
            classify_update_failure(false, false),
            UPDATE_SERVER_UNREACHABLE_REASON
        );
    }

    #[test]
    fn a_timeout_outranks_a_no_network_marker() {
        // A CONNECT-PHASE timeout: reqwest reports is_connect() and is_timeout()
        // together. The address resolved and the handshake was attempted — the far
        // end simply never answered, which is the server's problem, not the
        // network's. A stale marker further down the chain is noise here.
        assert_eq!(
            classify_update_failure(true, true),
            UPDATE_SERVER_UNREACHABLE_REASON
        );
    }

    #[test]
    fn a_plain_timeout_is_server_unreachable() {
        // The update server accepted the connection and then went quiet, or a
        // filtered port swallowed the handshake.
        assert_eq!(
            classify_update_failure(true, false),
            UPDATE_SERVER_UNREACHABLE_REASON
        );
    }

    #[test]
    fn only_a_named_cause_can_reach_the_no_internet_verdict() {
        // The rule stated as a whole, over the FULL input space: two booleans is
        // four rows, and exactly one of them may say «нет интернета». Enumerating
        // them here proves «ambiguity resolves to server-unreachable» rather than
        // sampling it — and it is the assertion that fails if anyone widens the
        // no-internet arm again.
        let no_internet_rows = [(false, true), (false, false), (true, true), (true, false)]
            .into_iter()
            .filter(|(is_timeout, names_no_network)| {
                classify_update_failure(*is_timeout, *names_no_network) == UPDATE_NO_INTERNET_REASON
            })
            .count();
        assert_eq!(no_internet_rows, 1);
    }
}

// ─── The timeout that makes the `is_timeout` branch reachable (S3) ─────────
//
// The truth table above is exhaustive over `classify_update_failure`'s inputs,
// and two of its four rows describe a timeout — but until this change the update
// check ran on a bare `reqwest::Client::new()`, which configures no timeout at
// all. Those two rows therefore tested a path production could not take, and the
// real behaviour was the opposite of what the table implied: a server that
// accepted the connection and never answered hung the `invoke` promise for the
// session and pinned the card on «Проверяем обновления…».
//
// WHY THIS IS A SOCKET TEST AND NOT A GREP. Asserting «the source contains
// `.timeout(`» proves a string exists; asserting «UPDATE_CHECK_TIMEOUT == 30s»
// proves a number exists. Neither proves the budget is WIRED INTO the client the
// command uses. So the test drives the production builder — the same function
// `check_app_update_info` calls — against a listener that accepts the connection
// and then deliberately says nothing, which is precisely the failure the OS
// connect timeout cannot catch.
#[cfg(test)]
mod update_check_timeout_tests {
    use super::*;
    use std::time::Duration;

    /// A socket that completes the TCP handshake and then never writes a byte.
    ///
    /// Returns the bound address. The accept loop holds each connection open in a
    /// detached task rather than dropping it: dropping the `TcpStream` would send
    /// FIN and the client would fail immediately with a connection error, which is
    /// a DIFFERENT failure from the one under test and would let a client with no
    /// timeout pass.
    async fn silent_listener() -> std::net::SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((stream, _)) = listener.accept().await {
                held.push(stream);
            }
        });
        addr
    }

    /// Send one request at millisecond budgets and return the error it must produce.
    ///
    /// THE OUTER BOUND IS NOT BELT-AND-BRACES, IT IS THE FAILURE MODE. Without it,
    /// a client built with no total budget — the very regression these tests exist
    /// to catch — would not fail the test, it would HANG it, and a hanging test in
    /// CI reads as an infrastructure problem rather than as the defect it is.
    /// Five seconds against a 300 ms budget is a sixteen-fold margin, so a slow
    /// machine cannot trip it while a missing budget always does.
    ///
    /// Millisecond budgets keep the run under a second. The production consts are
    /// asserted separately; what these prove is that the BUILDER wires whatever
    /// budget it is given into the client the command uses.
    async fn error_from_a_silent_server() -> reqwest::Error {
        let addr = silent_listener().await;
        let client =
            build_update_check_client(Duration::from_millis(500), Duration::from_millis(300))
                .expect("the update-check client must build");

        let outcome = tokio::time::timeout(
            Duration::from_secs(5),
            client
                .get(format!("http://{addr}/repos/x/y/releases/latest"))
                .send(),
        )
        .await
        .expect(
            "the request never came back — the client was built without a total timeout, \
             which is exactly the unbounded wait that pinned the card on «Проверяем обновления…»",
        );

        outcome.expect_err("a silent server must not resolve — that is the whole point")
    }

    #[tokio::test]
    async fn a_server_that_accepts_and_never_answers_times_out() {
        let err = error_from_a_silent_server().await;
        assert!(
            err.is_timeout(),
            "the request must fail as a TIMEOUT, not as some other error: {err}"
        );
    }

    #[tokio::test]
    async fn a_timed_out_check_is_reported_as_server_unreachable() {
        // The other half of the fix: the branch is now reachable AND it lands on
        // the verdict `30-RESEARCH.md` §3 mandates for it. «С приложением всё в
        // порядке — попробуйте позже» is true of a server that went quiet;
        // «нет интернета» would be the app stating something it did not verify.
        let err = error_from_a_silent_server().await;
        assert_eq!(
            classify_reqwest_failure(err),
            UPDATE_SERVER_UNREACHABLE_REASON
        );
    }

    #[test]
    fn the_production_budgets_are_finite_and_sane() {
        // A budget of zero would be a client that can never succeed; an hour-long
        // one would be indistinguishable from the unbounded wait this replaced.
        // The check is one small JSON document on a 24h background timer, so the
        // upper bound is generous by an order of magnitude and still bounded.
        assert!(UPDATE_CHECK_CONNECT_TIMEOUT > Duration::ZERO);
        assert!(UPDATE_CHECK_TIMEOUT > UPDATE_CHECK_CONNECT_TIMEOUT);
        assert!(UPDATE_CHECK_TIMEOUT <= Duration::from_secs(60));
    }

    /// Every whole-line `//` comment blanked, so a rule cannot be tripped by the
    /// prose that DOCUMENTS it.
    ///
    /// This is not tidiness. Each of the four functions below now carries a comment
    /// naming `reqwest::Client::new()` as the thing that must not come back — and an
    /// unfiltered `contains` would read that comment as the violation, fail on the
    /// commit that added the explanation, and teach the next reader that the guard
    /// cries wolf. Only a line whose FIRST non-space characters are `//` is dropped:
    /// truncating from a mid-line `//` would also swallow anything after a `"https://…"`,
    /// and a filter must never be able to HIDE code from the rules that follow it.
    /// (Same shape, and the same reason, as `about-hygiene.sh`'s `strip_comments`.)
    fn strip_line_comments(body: &str) -> String {
        body.lines()
            .map(|l| if l.trim_start().starts_with("//") { "" } else { l })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The source span of one top-level `pub async fn`, or an explanation of why it
    /// could not be found.
    ///
    /// THE NEEDLE IS BUILT AT RUNTIME AND ANCHORED AT BOTH ENDS. All three of those
    /// are load-bearing, and the third was found by mutation rather than by reasoning.
    ///
    /// * Built with `format!` — the guard this replaced spelled its subject as the
    ///   literal `"pub async fn check_app_update_info"`, which `include_str!` then
    ///   embedded in the very source it was searching. Rename the function and the
    ///   first hit becomes the test's own string, `body` comes back non-empty, and the
    ///   guard passes forever over a subject that no longer exists.
    /// * Anchored to `\n` — column zero, so an indented mention inside another test
    ///   cannot be mistaken for a definition.
    /// * Anchored to the opening `(` — WITHOUT IT THE RENAME ARM IS A LIE. Renaming
    ///   `server_get_available_versions` to `server_get_available_versions_renamed`
    ///   leaves the shorter name present as a PREFIX of the longer one, so a substring
    ///   count still returns exactly 1, the body of the renamed function is scanned,
    ///   and the guard reports PASS on a subject it did not find. Measured: it did
    ///   exactly that. A locate-or-fail arm that can be satisfied by a prefix is the
    ///   same vacuous pass it exists to prevent, one level down.
    ///
    /// Exactly one hit is required — zero means renamed or removed, two means
    /// duplicated, and neither is something this guard may measure through. A future
    /// generic signature (`pub async fn foo<T>(`) would also land on zero, which is
    /// the right outcome: it fails loudly and asks to be looked at.
    fn function_body(source: &str, func: &str) -> Result<String, String> {
        let needle = format!("\npub async fn {func}(");
        let hits = source.matches(needle.as_str()).count();
        if hits != 1 {
            return Err(format!(
                "cannot measure `{func}`: {hits} top-level definitions found, expected exactly 1 — \
                 the function was renamed, removed or duplicated and this guard has lost its \
                 subject. This is a FAILURE, not a pass."
            ));
        }
        let after = source.split(needle.as_str()).nth(1).unwrap_or("");
        // The body ends at the next item that starts at column zero.
        let end = ["\npub async fn ", "\npub fn ", "\nfn ", "\n#[cfg(test)]"]
            .iter()
            .filter_map(|t| after.find(t))
            .min()
            .unwrap_or(after.len());
        Ok(strip_line_comments(&after[..end]))
    }

    #[test]
    fn no_version_probe_builds_its_own_untimed_client() {
        // THE CLASS, NOT THE INSTANCE (30.1 item 10, CONTEXT standing rule 3).
        //
        // Phase 30 removed the untimed client from `check_app_update_info` and guarded
        // that ONE function. Its three siblings kept theirs: two in this file, and a
        // third in `server_version.rs` that the review never named and that only a
        // sweep of the class would ever have found. A guard scoped to one member of a
        // class is how the other members stay broken while the gate reads green.
        //
        // Belt to the socket test's braces: the socket test proves the BUILDER honours
        // a budget, this proves every probe COMMAND goes through it. Neither alone is
        // the property — a command that builds its own client leaves the socket tests
        // perfectly green.
        //
        // `self_update`'s DOWNLOAD is deliberately NOT a subject here. It is untimed on
        // purpose (see `UPDATE_CHECK_TIMEOUT`'s doc): a total budget would abort a slow
        // but progressing multi-megabyte transfer. Its stall is caught by the front-end
        // watchdog in `UpdateCard.tsx`, not by a deadline. Adding it to this list would
        // read as rigour and would in fact be a regression.
        let updater = include_str!("./updater.rs");
        let server_version = include_str!("../ssh/server/server_version.rs");

        let subjects: [(&str, &str, &str); 4] = [
            ("commands/updater.rs", updater, "check_app_update_info"),
            ("commands/updater.rs", updater, "check_sidecar_version"),
            ("commands/updater.rs", updater, "list_sidecar_versions"),
            (
                "ssh/server/server_version.rs",
                server_version,
                "server_get_available_versions",
            ),
        ];

        let mut violations: Vec<String> = Vec::new();
        for (file, source, func) in subjects {
            let body = match function_body(source, func) {
                Ok(b) => b,
                Err(why) => {
                    violations.push(format!("{file}: {why}"));
                    continue;
                }
            };
            // Both constructors, not just the bare one. `Client::builder()` without a
            // `.timeout(...)` is the same defect wearing a longer spelling — it is what
            // `server_get_available_versions` actually shipped, setting only a user
            // agent — so the rule is «no probe constructs its own client», which needs
            // no per-site reasoning about which builder calls were remembered.
            if body.contains("reqwest::Client::new()") {
                violations.push(format!(
                    "{file}::{func} constructs `reqwest::Client::new()` — no timeout of any kind, \
                     so a server that accepts and then goes silent hangs the call for the rest of \
                     the session"
                ));
            }
            if body.contains("reqwest::Client::builder()") {
                violations.push(format!(
                    "{file}::{func} constructs its own `reqwest::Client::builder()` — a builder \
                     that forgets `.timeout(..)` is the same unbounded wait; the budgets live in \
                     ONE place and this function must take them from there"
                ));
            }
            if !body.contains("build_update_check_client(") {
                violations.push(format!(
                    "{file}::{func} must obtain its client from `build_update_check_client(\
                     UPDATE_CHECK_CONNECT_TIMEOUT, UPDATE_CHECK_TIMEOUT)`"
                ));
            }
        }

        assert!(
            violations.is_empty(),
            "the untimed version-probe class has reopened:\n  {}",
            violations.join("\n  ")
        );
    }
}

// ─── The digest read is bounded even when nothing is declared (S4) ────────
//
// `digest_body_too_large` is a pure function over `Option<u64>` and its unit
// tests were always green — but they measured the ANNOUNCEMENT, and a hostile
// release simply does not have to make one. These tests exercise the read
// itself — `read_capped_digest_text` pulling chunks from a real
// `reqwest::Response` — against a body that declares no length and then keeps
// going far past the cap: the exact case the declared-length cap lets through.
//
// WHY THE BODY IS IN MEMORY AND NOT ON A SOCKET (WINDOWS.md entry 39, fixed in
// phase 02 of v3.1.0). The first versions served the body from a chunked HTTP
// server on an ephemeral loopback port. Under the full parallel suite that
// fixture failed about once in eighty runs and once hung the test binary for ten
// minutes: the verdict depended on whether the fixture's server task got
// scheduled in time, which is a property of the machine, not of the code. Moving
// the server to its own worker thread and adding deadlines only changed the
// symptom (a `TimedOut` on `send()` in roughly one run in five under load). The
// property under test is «the reader stops at the cap», and the reader only ever
// sees `Response::chunk()` — so the body is now a stream built in memory and
// converted into a `reqwest::Response`, with no socket, server task or scheduler
// left to starve. Chunked-transfer decoding itself is reqwest's contract, not
// this module's.
#[cfg(test)]
mod digest_read_cap_tests {
    use super::*;
    use futures_util::stream;

    type ChunkResult = Result<String, std::io::Error>;

    /// A `reqwest::Response` whose body is `chunks`, streamed with NO declared
    /// length — the in-memory equivalent of `Transfer-Encoding: chunked`, so
    /// `res.content_length()` is `None` and the cheap arm of the guard cannot
    /// fire. Whatever these tests prove, they prove about the streaming arm alone.
    fn undeclared_response<S>(chunks: S) -> reqwest::Response
    where
        S: futures_util::Stream<Item = ChunkResult> + Send + 'static,
    {
        let body = reqwest::Body::wrap_stream(chunks);
        reqwest::Response::from(tauri::http::Response::new(body))
    }

    async fn read_capped(res: reqwest::Response) -> Option<String> {
        // The premise of the whole test: nothing was declared, so the
        // declared-length arm has no opinion here.
        assert_eq!(
            res.content_length(),
            None,
            "the fixture must carry NO declared length, or it is testing the other arm"
        );
        assert!(!digest_body_too_large(res.content_length()));
        read_capped_digest_text(res, MAX_DIGEST_BYTES as usize).await
    }

    #[tokio::test]
    async fn an_ordinary_undeclared_digest_body_still_reads() {
        // The guard must not defend by breaking the normal case: a real
        // `sha256sum` line is about eighty bytes and may perfectly well arrive
        // in more than one chunk.
        const LINE: &str =
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  Setup.exe\n";
        let (head, tail) = LINE.split_at(40);
        let res = undeclared_response(stream::iter(vec![
            Ok::<_, std::io::Error>(head.to_string()),
            Ok(tail.to_string()),
        ]));
        let text = read_capped(res).await.expect("a short body must read normally");
        assert_eq!(text, LINE);
        assert!(is_hex_sha256(text.split_whitespace().next().unwrap()));
    }

    #[tokio::test]
    async fn an_undeclared_oversized_body_is_refused_at_the_cap() {
        // 64 KiB — sixteen times `MAX_DIGEST_BYTES` — arriving with no declared
        // length: `digest_body_too_large` has nothing to refuse (asserted inside
        // `read_capped`), so if this comes back as a string, the only bound on the
        // read was the sender's goodwill.
        //
        // WHY FINITE AND NOT ENDLESS. An endless in-memory stream is always ready,
        // so a reader WITHOUT the cap would spin on it forever without ever
        // yielding to the runtime — the timeout below could never fire, and a
        // regression would hang the suite instead of failing it (checked by
        // mutation: removing the cap hung the endless variant). A finite body turns
        // the same regression into a returned 64 KiB string, which the `is_none()`
        // assertion rejects; the property is «the reader stops at the cap», not «the
        // sender never stops».
        const OVERSIZED_CHUNKS: usize = 64;
        let filler = "x".repeat(1024);
        let chunks: Vec<ChunkResult> = std::iter::once(Ok("start".to_string()))
            .chain((0..OVERSIZED_CHUNKS).map(|_| Ok(filler.clone())))
            .collect();
        let outcome = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            read_capped(undeclared_response(stream::iter(chunks))),
        )
        .await
        .expect(
            "the read never returned — an undeclared body is being read without bound, \
             which is the defect this cap exists to remove",
        );
        assert!(
            outcome.is_none(),
            "an oversized body must yield None, not a truncated string that could \
             coincidentally look like a digest"
        );
    }
}

// ─── Phase 30: installer digest resolution (T-30-03) ───────────────────────
//
// The digest lookup moved out of the webview and into Rust; without these, the
// only thing standing between a release body and `self_update`'s tamper control
// would be hand-reading. The network half (`resolve_release_sha256`) needs a
// live client and is covered by the end-of-phase manual check; the parsing half
// below is where a silent regression would actually hide.
#[cfg(test)]
mod update_sha256_tests {
    use super::*;

    const VALID: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    #[test]
    fn accepts_exactly_sixty_four_hex_characters() {
        assert!(is_hex_sha256(VALID));
        assert!(!is_hex_sha256(&VALID[..63])); // one short
        assert!(!is_hex_sha256(&format!("{VALID}a"))); // one long
        assert!(!is_hex_sha256("")); // the "no digest published" value
        assert!(!is_hex_sha256(&VALID.replace('e', "z"))); // not hex
    }

    #[test]
    fn extracts_a_digest_from_a_release_body() {
        let body = format!("## What's new\n\n- fixes\n\nSHA256: {VALID}\n");
        assert_eq!(extract_sha256_from_body(&body), VALID);
    }

    #[test]
    fn tolerates_case_and_punctuation_around_the_marker() {
        let body = format!("sha256 = {VALID}");
        assert_eq!(extract_sha256_from_body(&body), VALID);
    }

    #[test]
    fn a_digest_body_larger_than_a_digest_is_refused() {
        // The real thing is ~80 bytes; the cap is 4 KiB. Unknown length is still
        // accepted (chunked responses declare none), which is the deliberate limit
        // of this guard, not an oversight.
        assert!(!digest_body_too_large(Some(80)));
        assert!(!digest_body_too_large(Some(MAX_DIGEST_BYTES)));
        assert!(!digest_body_too_large(None));
        assert!(digest_body_too_large(Some(MAX_DIGEST_BYTES + 1)));
        assert!(digest_body_too_large(Some(4 * 1024 * 1024 * 1024)));
    }

    #[test]
    fn only_this_editions_installer_is_recognised() {
        // REGRESSION for the digest fallback: it used to accept the first `.sha256` asset in the
        // release regardless of which edition it belonged to. Both editions ship from one release,
        // so the Light digest paired with the Pro installer turned a good download into
        // UPDATE_CHECKSUM_MISMATCH — a tamper warning for a file nobody tampered with.
        assert!(is_pro_installer_asset_name(
            "TrustTunnel Client Pro_3.0.0_x64-setup.exe"
        ));
        assert!(!is_pro_installer_asset_name(
            "TrustTunnel Client Light_2.7.0_x64-setup.exe"
        ));
        // Not an installer at all, and the digest file's own name (the caller strips `.sha256`
        // before asking).
        assert!(!is_pro_installer_asset_name("trusttunnel-v1.0.49-linux-x86_64.tar.gz"));
        assert!(!is_pro_installer_asset_name(
            "TrustTunnel Client Pro_3.0.0_x64-setup.exe.sha256"
        ));
    }

    #[test]
    fn a_prose_mention_before_the_digest_line_does_not_hide_it() {
        // REGRESSION. The scan used to stop at the FIRST `sha256` in the body. This body — the
        // ordinary shape of a Russian release description for this project — mentions the word in
        // a sentence before the line that carries the value, and the old code returned "", which
        // `self_update` turns into UPDATE_CHECKSUM_MISSING and a dead in-app update.
        let body = format!(
            "Проверьте контрольную сумму SHA256 перед установкой.\n\nSHA256: {VALID}\n"
        );
        assert_eq!(extract_sha256_from_body(&body), VALID);

        // Two mentions where neither of the first two is well formed.
        let noisy = format!("sha256 sums:\nSHA256: deadbeef\nSHA256 = {VALID}");
        assert_eq!(extract_sha256_from_body(&noisy), VALID);
    }

    #[test]
    fn a_character_that_changes_length_when_lowercased_does_not_break_the_scan() {
        // REGRESSION. The scan searched the lowercased copy and sliced the ORIGINAL. 'İ' is two
        // bytes and lowercases to three, so the marker sat at byte 3 of `body` and byte 4 of
        // `lower`; slicing `body` at 10 landed inside the em dash and PANICKED. 'ẞ' shifts the
        // other way and silently truncated the hex run instead.
        // Written as escapes rather than as literals so the intent survives any editor or
        // encoding that would otherwise normalize them away.
        let grows = format!("\u{0130} SHA256\u{2014} {VALID}"); // 'İ' 2 bytes -> 3, then an em dash
        assert_eq!(extract_sha256_from_body(&grows), VALID);

        let shrinks = format!("\u{1E9E} SHA256: {VALID}"); // 'ẞ' 3 bytes -> 2
        assert_eq!(extract_sha256_from_body(&shrinks), VALID);

        let kelvin = format!("\u{212A} SHA256: {VALID}"); // KELVIN SIGN, 3 bytes -> 1
        assert_eq!(extract_sha256_from_body(&kelvin), VALID);
    }

    #[test]
    fn a_body_without_a_digest_yields_empty_not_garbage() {
        // "Missing digest" must come back as "", never as a truncated or
        // neighbouring hex run that `self_update` would then compare against.
        assert_eq!(extract_sha256_from_body("no checksum here"), "");
        assert_eq!(extract_sha256_from_body("SHA256: deadbeef"), "");
        assert_eq!(extract_sha256_from_body(""), "");
    }
}

#[cfg(test)]
mod d29_invariant_tests {
    /// D-29 invariant — check_sidecar_version + check_app_update_info MUST NOT
    /// call activity_log / emit_log channels.
    ///
    /// Rationale: эти команды получают `password: String` parameter (SSH probe)
    /// и binary paths (ENDPOINT_BINARY). Логирование в activity.log таких
    /// metadata = D-29 invariant violation. Debug-only `eprintln!` ok (stderr,
    /// not persisted log file).
    ///
    /// Static-grep approach — читает source файл и проверяет тело каждой
    /// функции. Aligns с Phase 17.1 surgical invariant test pattern
    /// (server_mtproto.rs::uninstall body grep). CI catches regression при
    /// добавлении emit_log в новую функцию.
    fn function_body(source: &str, signature: &str) -> String {
        let after_sig = source.split(signature).nth(1).unwrap_or("");
        // function body ends at next `pub async fn`, `pub fn`, `async fn`, `fn`, или конце модуля.
        //
        // `\nasync fn ` was missing here. A private `async fn` written after a command silently
        // joined that command's window — which sounds harmless, but the window is what the D-29
        // grep inspects, and a window that swallows an unrelated function is a window nobody can
        // reason about. It is also the mirror of the real hole this splitter had: see the helper
        // test below.
        let body_until_next = after_sig
            .split("\npub async fn ")
            .next()
            .unwrap_or("")
            .split("\npub fn ")
            .next()
            .unwrap_or("")
            .split("\nasync fn ")
            .next()
            .unwrap_or("")
            .split("\nfn ")
            .next()
            .unwrap_or("");
        body_until_next.to_string()
    }

    #[test]
    fn check_sidecar_version_does_not_call_activity_log_or_emit_log() {
        let source = include_str!("./updater.rs");
        let body = function_body(source, "pub async fn check_sidecar_version");
        assert!(
            !body.contains("activity_log"),
            "D-29: check_sidecar_version must NOT call activity_log"
        );
        assert!(
            !body.contains("emit_log("),
            "D-29: check_sidecar_version must NOT call emit_log (use eprintln! for debug only)"
        );
    }

    #[test]
    fn check_app_update_info_does_not_call_activity_log_or_emit_log() {
        let source = include_str!("./updater.rs");
        let body = function_body(source, "pub async fn check_app_update_info");
        assert!(
            !body.contains("activity_log"),
            "D-29: check_app_update_info must NOT call activity_log"
        );
        assert!(
            !body.contains("emit_log("),
            "D-29: check_app_update_info must NOT call emit_log (use eprintln! for debug only)"
        );
    }

    /// The command's CALL GRAPH, not just its lexical window.
    ///
    /// The placement banner above the phase-30 helpers argues — correctly — that writing them
    /// BEFORE `check_app_update_info` leaves that command's `function_body` window intact. What it
    /// does not say is that the window then contains none of them, and two of those helpers are
    /// precisely the material D-29 exists to keep out of the log channel:
    /// `resolve_release_sha256` handles a URL and an HTTP response body, and
    /// `error_chain_names_no_network` renders error strings that may carry the hostname. An
    /// `emit_log(...)` added inside either one is executed by the command and was invisible to the
    /// test that claims to protect it.
    ///
    /// WHY THE LIST GREW (phase-30 security follow-up, finding S5). The docstring said CALL GRAPH
    /// while the array named TWO of roughly a dozen helpers the command actually reaches, and the
    /// unnamed ones handle exactly the material the invariant is about: `extract_sha256_from_body`
    /// scans a third-party release body, `validate_download_url` handles the URL,
    /// `read_capped_digest_text` streams an untrusted response. The invariant HELD — the whole
    /// file emits nothing — so nothing was leaking; what was weaker than its own wording was the
    /// regression detection, and a guard whose green means less than a reader takes it for is
    /// worse than an honest narrow one. Widening the coverage rather than narrowing the wording is
    /// the choice that keeps D-29 (secrets and untrusted payloads never reach the log channel)
    /// actually enforced.
    ///
    /// SIGNATURES CARRY THEIR FIRST PARAMETER wherever a bare `fn name` also occurs earlier in the
    /// file — in a doc comment, a banner or another test. `function_body` takes the text after the
    /// FIRST match, so a needle that hits prose first would silently measure the wrong window and
    /// report a vacuous pass. The `!body.is_empty()` arm is what catches a needle that a rename
    /// has stopped matching altogether.
    #[test]
    fn app_update_check_helpers_do_not_call_activity_log_or_emit_log() {
        let source = include_str!("./updater.rs");
        for sig in [
            "async fn resolve_release_sha256",
            "fn error_chain_names_no_network",
            "async fn read_capped_digest_text",
            "fn extract_sha256_from_body(body: &str)",
            "fn validate_download_url(url: &str)",
            "fn build_update_check_client(",
            "fn digest_body_too_large(content_length",
            "fn is_pro_installer_asset_name(name: &str)",
            "fn is_hex_sha256(s: &str)",
            "fn compare_semver(a: &str, b: &str)",
            "fn classify_reqwest_failure(e: reqwest::Error)",
            "fn classify_update_failure(is_timeout: bool",
        ] {
            let body = function_body(source, sig);
            assert!(
                !body.is_empty(),
                "D-29: helper {sig} not found — the guard has lost its subject and cannot measure anything"
            );
            assert!(
                !body.contains("activity_log"),
                "D-29: {sig} must NOT call activity_log"
            );
            assert!(
                !body.contains("emit_log("),
                "D-29: {sig} must NOT call emit_log (use eprintln! for debug only)"
            );
        }
    }
}

// ─── Phase 19: list_sidecar_versions tests (RED phase — written first) ─────
//
// Tests written before implementation per TDD discipline. Reference the pure
// helper `parse_releases_to_info` (extracted from `list_sidecar_versions` for
// testability) — this lets us validate parsing logic against fixture JSON
// without HTTP mocking. The Tauri command itself just wraps an HTTP fetch +
// `parse_releases_to_info(...)`.
#[cfg(test)]
mod list_sidecar_versions_tests {
    use super::*;

    /// Test 1 — cap respected: max_count caps result length and backend cap=10
    /// blocks oversized frontend requests.
    #[test]
    fn cap_max_count_clamps_to_backend_cap() {
        // Construct fixture with 12 release entries (more than backend cap=10).
        let mut releases = Vec::new();
        for i in 0..12 {
            releases.push(serde_json::json!({
                "tag_name": format!("v1.0.{}", 33 - i),
                "prerelease": false,
                "published_at": format!("2026-05-{:02}T12:00:00Z", 22 - i.min(20)),
                "assets": [
                    {
                        "name": format!("trusttunnel-v1.0.{}-linux-x86_64.tar.gz", 33 - i),
                        "browser_download_url": format!(
                            "https://github.com/TrustTunnel/TrustTunnel/releases/download/v1.0.{}/trusttunnel-v1.0.{}-linux-x86_64.tar.gz",
                            33 - i,
                            33 - i
                        ),
                        "size": 10_700_000_u64,
                    }
                ],
            }));
        }
        // Frontend asks for 4 → should get 4
        let res = parse_releases_to_info(&releases, 4);
        assert_eq!(res.len(), 4, "cap=4 should clamp result to 4 entries");

        // Frontend asks for 50 → backend cap=10 still applies. parse_releases_to_info
        // honors `cap` it's given, but the wrapping Tauri command must enforce
        // backend cap upstream. Verify the helper respects its own cap.
        let res_capped = parse_releases_to_info(&releases, 10);
        assert_eq!(res_capped.len(), 10, "cap=10 should clamp result to 10 entries");
    }

    /// Test 2 — prerelease entries are filtered out.
    #[test]
    fn filters_prereleases_from_result() {
        let releases = vec![
            serde_json::json!({
                "tag_name": "v1.0.34-beta",
                "prerelease": true,
                "published_at": "2026-05-22T12:00:00Z",
                "assets": [
                    {
                        "name": "trusttunnel-v1.0.34-beta-linux-x86_64.tar.gz",
                        "browser_download_url": "https://github.com/TrustTunnel/TrustTunnel/releases/download/v1.0.34-beta/trusttunnel-v1.0.34-beta-linux-x86_64.tar.gz",
                        "size": 10_000_000_u64,
                    }
                ],
            }),
            serde_json::json!({
                "tag_name": "v1.0.33",
                "prerelease": false,
                "published_at": "2026-05-20T12:00:00Z",
                "assets": [
                    {
                        "name": "trusttunnel-v1.0.33-linux-x86_64.tar.gz",
                        "browser_download_url": "https://github.com/TrustTunnel/TrustTunnel/releases/download/v1.0.33/trusttunnel-v1.0.33-linux-x86_64.tar.gz",
                        "size": 10_700_000_u64,
                    }
                ],
            }),
        ];

        let res = parse_releases_to_info(&releases, 4);
        assert_eq!(res.len(), 1, "prerelease should be filtered, only 1 entry remains");
        assert_eq!(res[0].version, "1.0.33");
        assert_eq!(res[0].tag, "v1.0.33");
    }

    /// Test 3 — dbgsym assets are excluded via select_sidecar_asset reuse.
    #[test]
    fn excludes_dbgsym_assets() {
        let releases = vec![serde_json::json!({
            "tag_name": "v1.0.33",
            "prerelease": false,
            "published_at": "2026-05-20T12:00:00Z",
            "assets": [
                {
                    "name": "trusttunnel-v1.0.33-linux-x86_64-dbgsym.tar.gz",
                    "browser_download_url": "https://github.com/TrustTunnel/TrustTunnel/releases/download/v1.0.33/trusttunnel-v1.0.33-linux-x86_64-dbgsym.tar.gz",
                    "size": 107_000_000_u64,
                },
                {
                    "name": "trusttunnel-v1.0.33-linux-x86_64.tar.gz",
                    "browser_download_url": "https://github.com/TrustTunnel/TrustTunnel/releases/download/v1.0.33/trusttunnel-v1.0.33-linux-x86_64.tar.gz",
                    "size": 10_700_000_u64,
                },
            ],
        })];

        let res = parse_releases_to_info(&releases, 4);
        assert_eq!(res.len(), 1);
        assert!(
            !res[0].asset_download_url.contains("dbgsym"),
            "dbgsym asset must be excluded; got URL: {}",
            res[0].asset_download_url
        );
        assert_eq!(res[0].asset_size_bytes, 10_700_000);
    }

    /// Test 4 (D-29 invariant) — static-grep the `list_sidecar_versions` function
    /// body in source. NO emit_log / activity_log / vpn-log / log_message_i18n.
    ///
    /// Pattern reference: Phase 18 `check_sidecar_version_does_not_call_activity_log_or_emit_log`
    /// (mod d29_invariant_tests above) uses identical body-extraction technique.
    #[test]
    fn list_versions_no_emit_log_d29_static_grep() {
        let source = include_str!("./updater.rs");
        // Extract body span: from `pub async fn list_sidecar_versions` to the
        // next `pub fn` / `pub async fn` / `fn ` / `#[cfg(test)]` / EOF.
        let span = source.split("pub async fn list_sidecar_versions").nth(1).unwrap_or("");
        let body = span
            .split("\npub async fn ")
            .next()
            .unwrap_or("")
            .split("\npub fn ")
            .next()
            .unwrap_or("")
            .split("\nfn ")
            .next()
            .unwrap_or("")
            .split("#[cfg(test)]")
            .next()
            .unwrap_or("");

        assert!(
            !body.contains("activity_log"),
            "D-29: list_sidecar_versions must NOT call activity_log"
        );
        assert!(
            !body.contains("emit_log"),
            "D-29: list_sidecar_versions must NOT call emit_log (asset URLs / tags MUST NOT leak)"
        );
        assert!(
            !body.contains("vpn-log"),
            "D-29: list_sidecar_versions must NOT emit vpn-log event"
        );
        assert!(
            !body.contains("log_message_i18n"),
            "D-29: list_sidecar_versions must NOT call log_message_i18n"
        );
    }

    /// Test 5 — S-02 invariant: tags that fail `validate_version` (shell
    /// metacharacters) are skipped. Defends against a hostile/compromised
    /// GitHub Releases API response.
    #[test]
    fn skips_releases_with_invalid_version_tag() {
        let releases = vec![
            serde_json::json!({
                "tag_name": "v1.0.33; rm -rf /",  // shell-injection attempt
                "prerelease": false,
                "published_at": "2026-05-22T12:00:00Z",
                "assets": [
                    {
                        "name": "trusttunnel-v1.0.33-linux-x86_64.tar.gz",
                        "browser_download_url": "https://github.com/TrustTunnel/TrustTunnel/releases/download/v1.0.33/trusttunnel-v1.0.33-linux-x86_64.tar.gz",
                        "size": 10_700_000_u64,
                    }
                ],
            }),
            serde_json::json!({
                "tag_name": "v1.0.32",
                "prerelease": false,
                "published_at": "2026-05-15T12:00:00Z",
                "assets": [
                    {
                        "name": "trusttunnel-v1.0.32-linux-x86_64.tar.gz",
                        "browser_download_url": "https://github.com/TrustTunnel/TrustTunnel/releases/download/v1.0.32/trusttunnel-v1.0.32-linux-x86_64.tar.gz",
                        "size": 10_600_000_u64,
                    }
                ],
            }),
        ];

        let res = parse_releases_to_info(&releases, 4);
        assert_eq!(
            res.len(),
            1,
            "malicious tag should be skipped; only v1.0.32 survives"
        );
        assert_eq!(res[0].tag, "v1.0.32");
    }

    /// Bonus — empty tag name handled gracefully (skipped, not error).
    #[test]
    fn skips_releases_with_empty_tag() {
        let releases = vec![serde_json::json!({
            "tag_name": "",
            "prerelease": false,
            "published_at": "2026-05-22T12:00:00Z",
            "assets": [],
        })];
        let res = parse_releases_to_info(&releases, 4);
        assert_eq!(res.len(), 0);
    }

    /// Bonus — release without assets (or missing asset for x86_64) is skipped.
    #[test]
    fn skips_release_with_missing_x86_64_asset() {
        let releases = vec![serde_json::json!({
            "tag_name": "v1.0.33",
            "prerelease": false,
            "published_at": "2026-05-22T12:00:00Z",
            "assets": [
                {
                    "name": "trusttunnel-v1.0.33-linux-aarch64.tar.gz",
                    "browser_download_url": "https://github.com/TrustTunnel/TrustTunnel/releases/download/v1.0.33/trusttunnel-v1.0.33-linux-aarch64.tar.gz",
                    "size": 9_600_000_u64,
                }
            ],
        })];
        let res = parse_releases_to_info(&releases, 4);
        assert_eq!(res.len(), 0, "no x86_64 asset → release skipped");
    }

    /// Bonus — version field strips the leading `v` from tag.
    #[test]
    fn version_field_strips_v_prefix() {
        let releases = vec![serde_json::json!({
            "tag_name": "v1.0.33",
            "prerelease": false,
            "published_at": "2026-05-22T12:00:00Z",
            "assets": [
                {
                    "name": "trusttunnel-v1.0.33-linux-x86_64.tar.gz",
                    "browser_download_url": "https://github.com/TrustTunnel/TrustTunnel/releases/download/v1.0.33/trusttunnel-v1.0.33-linux-x86_64.tar.gz",
                    "size": 10_700_000_u64,
                }
            ],
        })];
        let res = parse_releases_to_info(&releases, 4);
        assert_eq!(res.len(), 1);
        assert_eq!(res[0].version, "1.0.33", "version strips leading v");
        assert_eq!(res[0].tag, "v1.0.33", "tag keeps original v prefix");
        assert_eq!(res[0].published_at, "2026-05-22T12:00:00Z");
    }
}
