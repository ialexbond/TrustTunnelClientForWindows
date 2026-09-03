//! Shared path-traversal validators (V12 / T-11-06).
//!
//! WR-03: this `validate_app_path` / `validate_path_in_dir` pair was copy-pasted byte-similar
//! into `config.rs`, `manifest.rs`, and `ping.rs`. Three independent copies of a SECURITY
//! control drift apart — a hardening fix to one (e.g. rejecting NTFS reparse points, or an
//! allow-list change) would silently miss the others. Consolidating into one module keeps the
//! single guard the whole `commands` layer shares, so a future tightening lands everywhere at
//! once. The semantics are IDENTICAL to the prior copies (canonicalize the path — or its parent
//! for a not-yet-existing destination — and require it to start with the allowed dir); nothing
//! is loosened.

use std::path::{Path, PathBuf};

use crate::ssh::user_data_dir;

/// Validate that a path lives inside the app's per-user data root (`ssh::user_data_dir`).
///
/// D-03 C: the root MOVED out of the install directory. This guard derives from the same helper
/// the data does, deliberately — a guard left pointing at the executable's directory would
/// refuse every config the app itself had just written, i.e. every connect would fail.
/// Prevents path-traversal where the frontend could read/write arbitrary files over IPC.
pub fn validate_app_path(path: &str) -> Result<(), String> {
    validate_path_in_dir(path, &user_data_dir())
}

/// F16 (Fable-5 review): the canonical-output variant of `validate_app_path`. Returns the
/// SAME canonical `PathBuf` the confinement check ran against, so a caller can spawn/open
/// exactly that path instead of re-canonicalizing the raw string — closing the CA-2 guard's
/// check-then-use (TOCTOU) window where validate and spawn resolved the string twice. Same
/// confinement semantics as `validate_app_path`; only the success value differs.
pub fn validate_app_path_canonical(path: &str) -> Result<PathBuf, String> {
    validate_path_in_dir_canonical(path, &user_data_dir())
}

/// Generalized form: require `path` to canonicalize to a location inside `allowed_dir`.
///
/// The final `file_name` is appended UN-canonicalized after canonicalizing the parent, but
/// `Path::file_name()` returns None for `..`, so traversal via the last segment is blocked.
/// `starts_with` is a lexical prefix check on the canonical buffer (both sides canonicalized,
/// so it is symlink-free for the parent chain).
pub fn validate_path_in_dir(path: &str, allowed_dir: &Path) -> Result<(), String> {
    validate_path_in_dir_canonical(path, allowed_dir).map(|_| ())
}

/// F16: the canonical-output form of `validate_path_in_dir`. Confines `path` to `allowed_dir`
/// EXACTLY like `validate_path_in_dir` (this is now the single implementation both share — the
/// unit form just drops the returned path), but on success returns the canonical `PathBuf` the
/// confinement was decided against. Returning it lets the caller use the same resolved path it
/// just validated, so the validate and the subsequent use cannot resolve the raw string to two
/// different targets (TOCTOU). The canonical value is ONLY produced on the Ok branch — the
/// fail-closed Err branch (path + parent both non-existent) has no path to return.
pub fn validate_path_in_dir_canonical(path: &str, allowed_dir: &Path) -> Result<PathBuf, String> {
    let allowed =
        std::fs::canonicalize(allowed_dir).unwrap_or_else(|_| allowed_dir.to_path_buf());

    let canonical = std::fs::canonicalize(path)
        .or_else(|_| {
            // File may not exist yet (e.g. copy destination) — canonicalize the parent and
            // re-append the file name.
            let p = Path::new(path);
            if let Some(parent) = p.parent() {
                std::fs::canonicalize(parent).map(|cp| cp.join(p.file_name().unwrap_or_default()))
            } else {
                Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "Invalid path",
                ))
            }
        });

    match canonical {
        Ok(c) => {
            if !c.starts_with(&allowed) {
                return Err(
                    "Access denied: path is outside the application data directory".into(),
                );
            }
            Ok(c)
        }
        // The path AND its parent are both non-existent, so we cannot canonicalize it
        // to compare symlink-free. Fail CLOSED: a security guard must not report a
        // non-existent path differently (which would leak "this file/dir doesn't
        // exist" AND let an outside-but-missing path slip through with a generic
        // "Invalid path" that callers might treat as a distinct, non-access error).
        // Fall back to a LEXICAL prefix check: an absolute path that does not start
        // with the allowed dir is unambiguously outside → the same access-denied
        // message. Since neither side is fully canonicalized here this is a coarser
        // check, but it only ever REJECTS more (never loosens): the earlier
        // Ok-branch already handles every path that DOES canonicalize inside.
        Err(_) => {
            let p = Path::new(path);
            if p.is_absolute() && !p.starts_with(&allowed) {
                Err("Access denied: path is outside the application data directory".into())
            } else {
                // Relative or ambiguous non-existent path: preserve the prior
                // "Invalid path" behaviour (cannot resolve → reject).
                Err("Invalid path: unable to resolve path".into())
            }
        }
    }
}

// ─── Copy SOURCE validator (FLOW-01 / Phase 25) ───────────────────────────────────────
//
// Stable machine codes in the `CODE` / `CODE|detail` convention this codebase already uses
// (`SSH_MKDIR_FAILED|{e}`, `WRITE_FAILED|{e}`). The frontend localizes BY CODE — D-05
// forbids pattern-matching English prose, which is what broke when these strings were
// user-visible sentences. None of them echoes the caller-supplied path back: a rejection is
// rendered in a snackbar and must not become an oracle for the filesystem layout.

/// The source resolved to a location outside every allowed root.
pub const COPY_SOURCE_OUTSIDE_ROOTS: &str = "COPY_SOURCE_OUTSIDE_ROOTS";
/// The source, or its parent directory, is an NTFS reparse point (symlink/junction).
pub const COPY_SOURCE_REPARSE_POINT: &str = "COPY_SOURCE_REPARSE_POINT";
/// The source could not be resolved at all. Carries the io error as detail (never the path).
pub const COPY_SOURCE_UNRESOLVABLE: &str = "COPY_SOURCE_UNRESOLVABLE";

/// Validate the SOURCE argument of `config.rs::copy_file` and return the canonical path the
/// confinement decision was made against (the F16 shape `validate_app_path_canonical` uses —
/// the caller copies from THIS buffer, so validate and copy cannot resolve the raw string to
/// two different targets).
///
/// Allow-list: `user_data_dir()` + `std::env::temp_dir()`. Two roots, and only two.
/// The temp root is what makes the Users-tab «Скачать конфиг» download work at all —
/// `ssh/server/server_config.rs:524` stages the exported config there on purpose (Phase-19
/// UAT fix, D-01), and the old `validate_app_path` source check rejected the very file the
/// app had just written.
///
/// **This is deliberately NOT `config.rs::validate_save_destination`, and the asymmetry must
/// not be "unified" away (D-02).** The destination validator also allows `%USERPROFILE%`,
/// which is right for a *write* the user picked in the OS Save-As dialog. The source is a
/// *read* whose path the frontend names, and a registered Tauri command is callable from ANY
/// script in the webview — granting `%USERPROFILE%` here would turn `copy_file` into an
/// arbitrary-read primitive over the user's profile (`%USERPROFILE%\.ssh\id_rsa` → anywhere),
/// which is exactly the hole `copy_file`'s own doc comment says it exists to prevent.
///
/// D-03 — the OS temp dir is world-writable, so a planted junction/symlink is a real attack
/// surface, not a hypothetical. Hence the check ORDER below, where each step earns its place.
pub fn validate_copy_source(path: &str) -> Result<PathBuf, String> {
    let p = Path::new(path);

    // 1. The LEAF itself, BEFORE canonicalizing.
    //
    //    WR-03 — what this check is, and what it is NOT. Confinement is enforced by steps 4
    //    and 5 together: `canonicalize` resolves the ENTIRE component chain, so a link is
    //    judged by where it really points, and the prefix test then compares canonical against
    //    canonical roots. A link whose target sits inside temp resolves to a path inside temp
    //    and is harmless; a link whose target sits outside is rejected by step 5. This leaf
    //    check therefore does not hold the boundary. It is an earlier, ADDITIONAL refusal, and
    //    it earns its place twice over: a link-shaped source is reported AS a link
    //    (`COPY_SOURCE_REPARSE_POINT`) instead of as a generic outside-roots path, and the
    //    guard does not rest on `canonicalize`'s link-following alone. Do not "simplify" away
    //    steps 4/5 believing this check covers them — it does not.
    //    `validate_save_destination` has no leaf check and needs none: its leaf does not exist
    //    yet (Save-As creates it); a copy source does.
    //
    //    IN-04 — the `if let Ok(...)` deliberately SKIPS the check when the metadata read
    //    fails (permission denied, path too long, a locked file) rather than rejecting, and
    //    that fallthrough is safe by construction: steps 4 and 5 run unconditionally
    //    afterwards, so a source that will not canonicalize is refused outright and one that
    //    does is still compared against the canonical roots. A metadata failure can only cost
    //    the clearer error CODE, never the boundary. Promoting it to a rejection would invent
    //    a fresh way for a legitimate download to fail — which is exactly the WR-02 mistake
    //    in a different spot. Best-effort is the intended semantics here. Same reasoning
    //    applies to the parent check below and to `config.rs::validate_save_destination`.
    if let Ok(meta) = std::fs::symlink_metadata(p) {
        if meta.file_type().is_symlink() {
            return Err(COPY_SOURCE_REPARSE_POINT.into());
        }
    }

    // 2. Build the allow-list, canonicalizing each root (falling back to the raw buffer when
    //    a root cannot be canonicalized, exactly as `validate_save_destination` does) so both
    //    sides of every comparison below are symlink-free. WR-02 moved this construction ABOVE
    //    the parent check, which now needs the roots to decide what is exempt.
    let mut allowed_roots: Vec<PathBuf> = Vec::new();
    let mut push_root = |r: PathBuf| match std::fs::canonicalize(&r) {
        Ok(c) => allowed_roots.push(c),
        Err(_) => allowed_roots.push(r),
    };
    push_root(user_data_dir());
    push_root(std::env::temp_dir());

    // 3. The PARENT directory, same reparse-point test — but ONLY when the parent is not one
    //    of our own roots.
    //
    //    WR-02: for a file staged directly in the OS temp dir — which is precisely what
    //    «Скачать конфиг» produces (`ssh/server/server_config.rs:524`) — `p.parent()` IS the
    //    temp dir. Relocating %TEMP% or the whole AppData tree behind a junction is an
    //    ordinary configuration (corporate roaming profiles, `mklink /J`), and Rust reports a
    //    junction as a symlink, so an unconditional check failed EVERY download on such a
    //    machine with COPY_SOURCE_REPARSE_POINT — the same blocker this phase exists to
    //    remove, wearing a different hat. The same applies to `user_data_dir()` when the
    //    install path is reached through a junction.
    //
    //    The exemption costs no confinement. It compares CANONICAL parent against CANONICAL
    //    roots, so a junction is waved through only when it resolves to exactly a root this
    //    validator would have accepted anyway; a junction pointing anywhere else does not
    //    match and is still rejected. And even for an exempt parent, step 5 re-tests the
    //    resolved source against the same roots.
    if let Some(parent) = p.parent() {
        let parent_is_an_allowed_root = std::fs::canonicalize(parent)
            .is_ok_and(|canonical_parent| allowed_roots.contains(&canonical_parent));
        if !parent_is_an_allowed_root {
            // Best-effort, same as the leaf check — see the IN-04 note above.
            if let Ok(meta) = std::fs::symlink_metadata(parent) {
                if meta.file_type().is_symlink() {
                    return Err(COPY_SOURCE_REPARSE_POINT.into());
                }
            }
        }
    }

    // 4. Canonicalize the FULL path. A copy source must already exist, so — unlike the
    //    destination case — there is no canonicalize-the-parent-and-re-append dance and no
    //    fail-open branch to reason about: if it does not resolve, it is rejected.
    let canonical = std::fs::canonicalize(p)
        .map_err(|e| format!("{COPY_SOURCE_UNRESOLVABLE}|{e}"))?;

    // 5. Accept only inside an allowed root. Together with step 4 this is THE control that
    //    enforces confinement (see the WR-03 note at step 1).
    if allowed_roots.iter().any(|root| canonical.starts_with(root)) {
        Ok(canonical)
    } else {
        Err(COPY_SOURCE_OUTSIDE_ROOTS.into())
    }
}

// ─── Staged-temp CLEANUP validator (CR-01 / Phase 25) ─────────────────────────────────
//
// Same `CODE` / `CODE|detail` convention as the copy-source codes above. These never reach a
// snackbar — the cleanup is best-effort and its failure is swallowed by the caller (see
// `config.rs::delete_staged_temp_file`) — so they carry no i18n entries on purpose. They exist
// to be greppable in the activity log, which is the only place they surface.

/// The path resolved inside the app data dir. The refusal is UNCONDITIONAL — it is not gated on
/// the temp test, on a flag, or on the layout — so the guarantee "this command cannot be aimed at
/// the app's own files" holds even when the data dir sits inside the temp root (a portable exe
/// unpacked into `%TEMP%`). It is NOT the first check in the function: the leaf-symlink refusal
/// and the canonicalize both run before it, and both are refusals in their own right.
pub const TEMP_CLEANUP_APP_DATA_DIR: &str = "TEMP_CLEANUP_APP_DATA_DIR";
/// The path resolved outside the OS temp root.
pub const TEMP_CLEANUP_OUTSIDE_TEMP: &str = "TEMP_CLEANUP_OUTSIDE_TEMP";
/// The path is an NTFS reparse point (symlink/junction), so deleting it would either destroy a
/// link the app never created or delete through it.
pub const TEMP_CLEANUP_REPARSE_POINT: &str = "TEMP_CLEANUP_REPARSE_POINT";
/// The path could not be resolved. Carries the io error as detail (never the path).
pub const TEMP_CLEANUP_UNRESOLVABLE: &str = "TEMP_CLEANUP_UNRESOLVABLE";
/// The path resolved to something that is not a regular file (a directory).
pub const TEMP_CLEANUP_NOT_A_FILE: &str = "TEMP_CLEANUP_NOT_A_FILE";

/// Validate the argument of `config.rs::delete_staged_temp_file` and return the canonical path
/// the decision was made against, so the delete cannot be redirected between check and use.
///
/// **Why a DELETE validator exists at all.** `fetch_server_config(stageToTemp: true)` stages the
/// Users-tab download in `std::env::temp_dir()`, and that file carries the endpoint PASSWORD
/// (`ssh/server/server_config.rs`, PP-1). Nothing removed it, so every «Скачать конфиг» left a
/// plaintext VPN credential in `%TEMP%` under a predictable name, readable by any process
/// running as that user, for as long as the profile lived (Windows does not clear `%TEMP%` on
/// reboot). The download flow now deletes it down every exit.
///
/// **Why this is NOT folded into `copy_file`.** `copy_file` has a second caller — the wizard's
/// Save-As (`components/wizard/useWizardState.ts`) — whose source is the app's LIVE config in
/// the data dir. A `copy_file` that deleted its own source would destroy it. So deletion is a
/// separate, explicitly named command with a strictly narrower allow-list than the copy source:
/// **temp only, and never the app data dir**, checked in that order. `validate_copy_source`
/// accepts two roots; this accepts one, minus one.
///
/// **Why there is no parent reparse-point check** (unlike `validate_copy_source`): the parent of
/// a directly-staged file IS the temp root, and relocating `%TEMP%` behind a junction is an
/// ordinary configuration — checking it would only re-create the WR-02 false positive. It also
/// buys nothing here: step 2 canonicalizes the entire chain, so a junction parent pointing
/// outside temp resolves outside temp and step 4 refuses it.
pub fn validate_temp_staged_path(path: &str) -> Result<PathBuf, String> {
    let p = Path::new(path);

    // 1. Refuse a link-shaped leaf outright. `canonicalize` below would resolve it and we would
    //    delete the TARGET rather than the link — a delete must never travel through a link the
    //    app did not create. Best-effort on a metadata error, exactly as in
    //    `validate_copy_source` (IN-04): steps 2-4 run unconditionally afterwards and are what
    //    actually hold the boundary, so a failed stat can only cost the clearer code.
    if let Ok(meta) = std::fs::symlink_metadata(p) {
        if meta.file_type().is_symlink() {
            return Err(TEMP_CLEANUP_REPARSE_POINT.into());
        }
    }

    // 2. The file must exist to be deleted, so there is no canonicalize-the-parent fallback and
    //    no fail-open branch: unresolvable → refused.
    let canonical = std::fs::canonicalize(p)
        .map_err(|e| format!("{TEMP_CLEANUP_UNRESOLVABLE}|{e}"))?;

    let canonicalize_root = |r: PathBuf| std::fs::canonicalize(&r).unwrap_or(r);
    let app_data_root = canonicalize_root(user_data_dir());
    let temp_root = canonicalize_root(std::env::temp_dir());

    // 3. Refuse the app data dir. Correctness here does NOT rest on this running before the temp
    //    test: every step of this validator is a guard-clause REFUSAL, never an accept-and-return,
    //    so with the two swapped a data-dir-inside-`%TEMP%` path would simply pass the temp test
    //    WITHOUT returning and still be refused here. What actually holds the invariant is that
    //    both checks are refusals and both run before the single `Ok`. Order decides only WHICH
    //    code such a path reports, and app-data-first is the sharper reason for the log.
    if canonical.starts_with(&app_data_root) {
        return Err(TEMP_CLEANUP_APP_DATA_DIR.into());
    }

    // 4. Confinement: canonical-vs-canonical prefix test against the single allowed root.
    if !canonical.starts_with(&temp_root) {
        return Err(TEMP_CLEANUP_OUTSIDE_TEMP.into());
    }

    // 5. Only a regular file. `remove_file` on a directory would fail anyway, but refusing here
    //    keeps the command's contract narrow and the failure legible.
    if !canonical.is_file() {
        return Err(TEMP_CLEANUP_NOT_A_FILE.into());
    }

    Ok(canonical)
}

/// IN-05: the ONE extension classifier shared by both import doors (the file-picker read in
/// `deeplink.rs::read_config_file_for_import` and the drag-drop `config.rs::import_dropped_content`).
///
/// The two paths previously derived the extension differently — `rsplit('.').next().to_lowercase()`
/// vs `to_ascii_lowercase().ends_with(".toml")` — a consistency smell on parallel doors. This uses
/// `Path::extension()` (the canonical parse: it splits on the LAST `.`, returns None for a dotfile
/// like `.toml` with no stem and for a name with no `.`) and lowercases it, so both doors classify
/// identically. Returns the lowercase extension WITHOUT the dot (e.g. `"toml"`, `"json"`), or an
/// empty string when there is no extension.
pub fn lowercase_extension(file_name: &str) -> String {
    Path::new(file_name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default()
}

// ═══════════════════════════════════════════════════════════════
//   Tests
// ═══════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    // ── validate_copy_source: the rejections D-03 says a path validator earns ─────────
    //
    // Every case asserts the SPECIFIC code, never a bare "any error will do" check. That
    // discipline is the point: a validator that rejected everything for the wrong reason would
    // satisfy a mere error check and would have sailed past this very bug class. Same reasoning
    // `deeplink_local.rs:462` records for its own path-guard test.

    /// **The D-02 machine check.** `%USERPROFILE%` exists, and the DESTINATION validator
    /// (`config.rs::validate_save_destination`) explicitly allows that whole subtree — Desktop,
    /// Downloads and Documents all live under it. The SOURCE validator must refuse it anyway.
    ///
    /// This assertion exists to fail loudly the day someone "unifies" the two allow-lists:
    /// the source list becoming a copy of the destination list would hand any script in the
    /// webview an arbitrary read over the user's profile (`%USERPROFILE%\.ssh\id_rsa`) through
    /// a registered Tauri command.
    #[test]
    fn copy_source_refuses_the_user_profile_root_the_destination_validator_allows() {
        let Ok(profile) = std::env::var("USERPROFILE") else {
            println!(
                "SKIPPED: %USERPROFILE% is not set (non-Windows CI) — nothing to assert here."
            );
            return;
        };
        if profile.is_empty() {
            println!("SKIPPED: %USERPROFILE% is empty — nothing to assert here.");
            return;
        }

        let err = validate_copy_source(&profile)
            .expect_err("the source allow-list must NOT contain the user profile root (D-02)");
        assert_eq!(
            err, COPY_SOURCE_OUTSIDE_ROOTS,
            "the profile root must be refused with the outside-roots code, got: {err}"
        );
    }

    /// **The D-03 machine check.** The OS temp dir is world-writable, so a planted reparse
    /// point is a real attack surface, and a link-shaped source must be refused AS a link.
    ///
    /// WR-03 — what this test does and does not prove. The link's target deliberately sits
    /// INSIDE an allowed root, which means the read would have been *confined* either way:
    /// canonicalization resolves the link and the prefix test would see a path under temp and
    /// accept it. So this test does not prove confinement — canonicalize + the canonical-root
    /// prefix comparison is what enforces that, and the outside-roots and non-existent cases
    /// below cover it. What this test pins is the pre-canonicalize leaf check itself: that a
    /// source which IS a link is rejected with `COPY_SOURCE_REPARSE_POINT` rather than
    /// silently followed, so the guard never rests on `canonicalize`'s link-following alone.
    /// Pointing the link outside the roots would let the prefix test satisfy the assertion and
    /// prove nothing about the leaf check.
    #[cfg(windows)]
    #[test]
    fn copy_source_refuses_a_symlink_planted_in_the_temp_dir() {
        let dir = std::env::temp_dir();
        let target = dir.join(format!("tt_test_link_target_{}.toml", std::process::id()));
        let link = dir.join(format!("tt_test_link_{}.toml", std::process::id()));
        let _ = std::fs::remove_file(&link);
        std::fs::write(&target, "loglevel = \"info\"\n").expect("target write must succeed");

        // Creating a symlink on Windows needs Developer Mode or an elevated process. Skip
        // honestly rather than fail when the privilege is absent — a red test nobody can run
        // locally gets muted, and a muted test guards nothing.
        match std::os::windows::fs::symlink_file(&target, &link) {
            Ok(()) => {}
            Err(_) => {
                let _ = std::fs::remove_file(&target);
                println!(
                    "SKIPPED: cannot create a symlink here — Windows requires Developer Mode \
                     or an elevated process for symlink_file."
                );
                return;
            }
        }

        let result = validate_copy_source(&link.to_string_lossy());
        let _ = std::fs::remove_file(&link);
        let _ = std::fs::remove_file(&target);

        let err = result.expect_err(
            "a reparse point must be refused even when its target sits inside an allowed root",
        );
        assert_eq!(
            err, COPY_SOURCE_REPARSE_POINT,
            "the rejection must name the reparse point, got: {err}"
        );
    }

    /// A copy source must EXIST. This module fails closed: a path that merely looks like it
    /// sits under an allowed root, but cannot be canonicalized, is refused rather than
    /// accepted on a lexical prefix match (the naive check D-03 forbids).
    #[test]
    fn copy_source_refuses_a_path_that_does_not_exist() {
        let missing = std::env::temp_dir()
            .join(format!("tt_test_never_created_{}.toml", std::process::id()));
        assert!(!missing.exists(), "the fixture must genuinely not exist");

        let err = validate_copy_source(&missing.to_string_lossy())
            .expect_err("a non-existent source must be refused, not prefix-matched");
        assert!(
            err.starts_with(COPY_SOURCE_UNRESOLVABLE),
            "the rejection must carry the unresolvable code, got: {err}"
        );
    }

    /// D-03 C (phase 30.1 plan 08) — **the confinement root follows the data root.**
    ///
    /// This is the guard that would have failed silently and catastrophically. `validate_app_path`
    /// confines every path-taking IPC command to the app's data directory. When the data moved
    /// out of the install directory, a guard left deriving from `current_exe()` would have
    /// refused every config the app itself had just written — i.e. EVERY CONNECT WOULD FAIL,
    /// with a path-traversal rejection as the only clue.
    ///
    /// Two halves, because either alone is vacuous: a file genuinely inside the data root is
    /// ACCEPTED (proves the guard did not stay behind), and a file in a sibling directory
    /// outside it is REFUSED (proves the guard is still a guard and did not simply widen).
    #[test]
    fn the_confinement_root_follows_the_data_root() {
        let root = user_data_dir();
        let inside = root.join(format!("tt_d03c_inside_{}.toml", std::process::id()));
        std::fs::write(&inside, "loglevel = \"info\"\n").expect("data-root write must succeed");

        let accepted = validate_app_path(&inside.to_string_lossy());

        // A sibling of the data root — outside it, but not somewhere exotic.
        let outside_dir = root
            .parent()
            .expect("the data root must have a parent")
            .join(format!("tt_d03c_outside_{}", std::process::id()));
        std::fs::create_dir_all(&outside_dir).expect("sibling dir must be creatable");
        let outside = outside_dir.join("intruder.toml");
        std::fs::write(&outside, "loglevel = \"info\"\n").expect("sibling write must succeed");

        let refused = validate_app_path(&outside.to_string_lossy());

        let _ = std::fs::remove_file(&inside);
        let _ = std::fs::remove_file(&outside);
        let _ = std::fs::remove_dir(&outside_dir);

        accepted.expect(
            "a config INSIDE the data root must be accepted — a guard that refuses it makes \
             every connect fail",
        );
        refused.expect_err(
            "a config OUTSIDE the data root must still be refused — the guard must follow the \
             data, not be widened away",
        );
    }

    /// The wizard's Save-As door (`components/wizard/useWizardState.ts:1675`) hands `copy_file`
    /// an APP-DIR source. Adding the temp root must not cost the data-dir root. Under
    /// `cargo test --lib` `user_data_dir()` resolves to a per-process temp sandbox (D-03 C),
    /// which is writable. The returned buffer is asserted CANONICAL — that is what lets
    /// `copy_file` read from the exact path the confinement decision was made against.
    #[test]
    fn copy_source_accepts_a_file_in_the_user_data_dir() {
        let src = user_data_dir()
            .join(format!("tt_test_source_appdir_{}.toml", std::process::id()));
        std::fs::write(&src, "loglevel = \"info\"\n").expect("app-dir write must succeed");

        let result = validate_copy_source(&src.to_string_lossy());
        let expected = std::fs::canonicalize(&src).expect("the fixture must canonicalize");
        let _ = std::fs::remove_file(&src);

        let resolved = result.expect("a source inside the app data dir must remain allowed");
        assert_eq!(
            resolved, expected,
            "the validator must return the canonical path it decided against"
        );
    }

    /// D-04's temp half — and the baseline the WR-02 case below builds on. «Скачать конфиг»
    /// stages its export STRAIGHT into `std::env::temp_dir()`, so the source's parent is the
    /// temp root itself. That exact shape had no test: the app-dir case above covers the other
    /// root, and every temp-rooted test was a rejection.
    #[test]
    fn copy_source_accepts_a_file_staged_directly_in_the_temp_dir() {
        let src = std::env::temp_dir()
            .join(format!("tt_test_source_tempdir_{}.toml", std::process::id()));
        std::fs::write(&src, "loglevel = \"info\"\n").expect("temp write must succeed");

        let result = validate_copy_source(&src.to_string_lossy());
        let expected = std::fs::canonicalize(&src).expect("the fixture must canonicalize");
        let _ = std::fs::remove_file(&src);

        let resolved = result.expect("the staged download source must be accepted");
        assert_eq!(
            resolved, expected,
            "the validator must return the canonical path it decided against"
        );
    }

    /// **The WR-02 regression.** A file staged directly in the temp dir must still be accepted
    /// when the temp root is reached through a reparse point. Relocating %TEMP% or the whole
    /// AppData tree behind a junction is an ordinary configuration (corporate roaming profiles,
    /// `mklink /J`), and the parent of a directly-staged file IS that root — so before the
    /// allowed-root exemption, every «Скачать конфиг» on such a machine died with
    /// `COPY_SOURCE_REPARSE_POINT`: the very download blocker this phase exists to remove.
    ///
    /// %TEMP% cannot be repointed for one test, so the fixture reproduces the *shape* instead:
    /// a junction inside temp that resolves back to the temp root, with the source addressed
    /// through it. The parent is then a genuine reparse point whose canonical target is exactly
    /// an allowed root — the condition the exemption turns on. Junctions, unlike the symlink
    /// used above, need neither elevation nor Developer Mode on NTFS, so this runs on an
    /// ordinary dev machine (verified: `mklink /J` returns 0 unelevated here).
    #[cfg(windows)]
    #[test]
    fn copy_source_accepts_a_temp_file_whose_parent_junction_resolves_to_the_temp_root() {
        let temp = std::env::temp_dir();
        let junction = temp.join(format!("tt_test_temp_junction_{}", std::process::id()));
        let file_name = format!("tt_test_via_junction_{}.toml", std::process::id());
        let physical_file = temp.join(&file_name);

        let _ = std::fs::remove_dir(&junction);
        std::fs::write(&physical_file, "loglevel = \"info\"\n").expect("temp write must succeed");

        // `mklink` is a cmd builtin, hence `/C`.
        let created = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&junction)
            .arg(&temp)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        if !created {
            // Deliberately NOT a silent skip — a test that no-ops on the dev machine is how
            // WR-02 shipped. Assert the closest honest equivalent (the same staged file by its
            // direct temp path, parent = the temp root) and name the half left uncovered.
            let resolved = validate_copy_source(&physical_file.to_string_lossy())
                .expect("a file staged directly in the temp dir must be accepted");
            let expected = std::fs::canonicalize(&physical_file).expect("must canonicalize");
            let _ = std::fs::remove_file(&physical_file);
            assert_eq!(resolved, expected);
            println!(
                "DEGRADED: `mklink /J` failed on this machine (temp dir on a filesystem without \
                 reparse points?), so the junction half of WR-02 was NOT exercised — only the \
                 plain file-in-temp acceptance was asserted."
            );
            return;
        }

        // Without this the test would pass identically against the pre-fix code: if the fixture
        // were not a reparse point, the parent check would never have fired in the first place.
        let meta = std::fs::symlink_metadata(&junction).expect("the junction must be stat-able");
        let is_reparse_point = meta.file_type().is_symlink();

        let source = junction.join(&file_name);
        let result = validate_copy_source(&source.to_string_lossy());
        let expected = std::fs::canonicalize(&physical_file).expect("the fixture must canonicalize");

        // Remove the junction ENTRY only. `remove_dir_all` here would descend into %TEMP%.
        let _ = std::fs::remove_dir(&junction);
        let _ = std::fs::remove_file(&physical_file);

        assert!(
            is_reparse_point,
            "the fixture is not a reparse point — this test would pass vacuously"
        );
        let resolved = result.expect(
            "a source staged directly in the temp dir must be accepted even when the temp root \
             is reached through a junction (WR-02)",
        );
        assert_eq!(
            resolved, expected,
            "the validator must return the canonical path under the real temp root"
        );
    }

    // ── validate_temp_staged_path: the CR-01 credential-cleanup guard ─────────────────
    //
    // This validator authorizes a DELETE, so its rejections matter more than its acceptance:
    // every case below names the exact code, and the two that pin the guard's whole reason for
    // existing (app data dir, outside temp) also assert the fixture SURVIVED.

    /// The happy path the download flow depends on: the staged export sits directly in the OS
    /// temp dir, and the validator hands back the canonical buffer the delete will use — so the
    /// path cannot be re-resolved to a different target between check and `remove_file`.
    #[test]
    fn temp_cleanup_accepts_a_file_staged_directly_in_the_temp_dir() {
        let staged = std::env::temp_dir()
            .join(format!("tt_test_cleanup_ok_{}.toml", std::process::id()));
        std::fs::write(&staged, "loglevel = \"info\"\n").expect("temp write must succeed");
        let expected = std::fs::canonicalize(&staged).expect("the fixture must canonicalize");

        let result = validate_temp_staged_path(&staged.to_string_lossy());
        let _ = std::fs::remove_file(&staged);

        assert_eq!(
            result.expect("a file staged in the temp dir must be deletable"),
            expected,
            "the validator must return the canonical path it decided against"
        );
    }

    /// **The guard this validator exists for.** The wizard's Save-As hands `copy_file` the app's
    /// LIVE config out of the data dir; if the cleanup could be aimed there, the download flow
    /// would delete the config the user connects with. The refusal is unconditional and runs
    /// FIRST, so it holds even for a portable install unpacked inside `%TEMP%`.
    #[test]
    fn temp_cleanup_refuses_a_file_in_the_app_data_dir_and_leaves_it_on_disk() {
        let live = user_data_dir()
            .join(format!("tt_test_cleanup_appdir_{}.toml", std::process::id()));
        std::fs::write(&live, "loglevel = \"info\"\n").expect("app-dir write must succeed");

        let err = validate_temp_staged_path(&live.to_string_lossy())
            .expect_err("the app data dir must never be a cleanup target");
        let survived = live.exists();
        let _ = std::fs::remove_file(&live);

        assert_eq!(
            err, TEMP_CLEANUP_APP_DATA_DIR,
            "the refusal must name the app data dir, got: {err}"
        );
        assert!(survived, "a refused cleanup must not have touched the file");
    }

    /// Anything outside the single allowed root is refused. `%USERPROFILE%` is the pointed
    /// case: `validate_save_destination` allows writing there, and this must not inherit that.
    #[test]
    fn temp_cleanup_refuses_a_path_outside_the_temp_root() {
        let Ok(profile) = std::env::var("USERPROFILE") else {
            println!("SKIPPED: %USERPROFILE% is not set (non-Windows CI).");
            return;
        };
        if profile.is_empty() {
            println!("SKIPPED: %USERPROFILE% is empty.");
            return;
        }

        let err = validate_temp_staged_path(&profile)
            .expect_err("the profile root is not a cleanup target");
        assert_eq!(
            err, TEMP_CLEANUP_OUTSIDE_TEMP,
            "the refusal must name the temp-root boundary, got: {err}"
        );
        assert!(
            std::path::Path::new(&profile).exists(),
            "a refused cleanup must not have touched anything"
        );
    }

    /// Fails closed: a path that merely LOOKS like it sits under temp but cannot be
    /// canonicalized is refused rather than accepted on a lexical prefix match.
    #[test]
    fn temp_cleanup_refuses_a_path_that_does_not_exist() {
        let missing = std::env::temp_dir()
            .join(format!("tt_test_cleanup_missing_{}.toml", std::process::id()));
        assert!(!missing.exists(), "the fixture must genuinely not exist");

        let err = validate_temp_staged_path(&missing.to_string_lossy())
            .expect_err("a non-existent path must be refused, not prefix-matched");
        assert!(
            err.starts_with(TEMP_CLEANUP_UNRESOLVABLE),
            "the rejection must carry the unresolvable code, got: {err}"
        );
    }

    /// A directory inside temp is not a staged config. Refusing it keeps the command's contract
    /// to "one regular file" instead of relying on `remove_file`'s io error to say no.
    #[test]
    fn temp_cleanup_refuses_a_directory_inside_the_temp_root() {
        let dir = std::env::temp_dir()
            .join(format!("tt_test_cleanup_dir_{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp mkdir must succeed");

        let err = validate_temp_staged_path(&dir.to_string_lossy())
            .expect_err("a directory must not be accepted by a file-cleanup guard");
        let survived = dir.exists();
        let _ = std::fs::remove_dir(&dir);

        assert_eq!(err, TEMP_CLEANUP_NOT_A_FILE, "got: {err}");
        assert!(survived, "a refused cleanup must not have touched the directory");
    }

    /// A link inside temp is refused BEFORE canonicalization, so a delete can never travel
    /// through a link the app did not create — even one whose target sits inside temp.
    #[cfg(windows)]
    #[test]
    fn temp_cleanup_refuses_a_symlink_planted_in_the_temp_dir() {
        let dir = std::env::temp_dir();
        let target = dir.join(format!("tt_test_cleanup_target_{}.toml", std::process::id()));
        let link = dir.join(format!("tt_test_cleanup_link_{}.toml", std::process::id()));
        let _ = std::fs::remove_file(&link);
        std::fs::write(&target, "loglevel = \"info\"\n").expect("target write must succeed");

        // Symlink creation needs Developer Mode or elevation on Windows — skip honestly
        // rather than ship a test that is red on every ordinary dev machine.
        if std::os::windows::fs::symlink_file(&target, &link).is_err() {
            let _ = std::fs::remove_file(&target);
            println!(
                "SKIPPED: cannot create a symlink here — Windows requires Developer Mode \
                 or an elevated process for symlink_file."
            );
            return;
        }

        let result = validate_temp_staged_path(&link.to_string_lossy());
        let target_survived = target.exists();
        let _ = std::fs::remove_file(&link);
        let _ = std::fs::remove_file(&target);

        let err = result.expect_err("a link-shaped cleanup target must be refused");
        assert_eq!(err, TEMP_CLEANUP_REPARSE_POINT, "got: {err}");
        assert!(target_survived, "the link's target must be untouched");
    }
}
