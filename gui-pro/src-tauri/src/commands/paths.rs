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

use std::path::Path;

use crate::ssh::portable_data_dir;

/// Validate that a path lives inside the app's portable data directory (next to the exe).
/// Prevents path-traversal where the frontend could read/write arbitrary files over IPC.
pub fn validate_app_path(path: &str) -> Result<(), String> {
    validate_path_in_dir(path, &portable_data_dir())
}

/// Generalized form: require `path` to canonicalize to a location inside `allowed_dir`.
///
/// The final `file_name` is appended UN-canonicalized after canonicalizing the parent, but
/// `Path::file_name()` returns None for `..`, so traversal via the last segment is blocked.
/// `starts_with` is a lexical prefix check on the canonical buffer (both sides canonicalized,
/// so it is symlink-free for the parent chain).
pub fn validate_path_in_dir(path: &str, allowed_dir: &Path) -> Result<(), String> {
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
        })
        .map_err(|e| format!("Invalid path: {e}"))?;

    let allowed =
        std::fs::canonicalize(allowed_dir).unwrap_or_else(|_| allowed_dir.to_path_buf());

    if !canonical.starts_with(&allowed) {
        return Err("Access denied: path is outside the application data directory".into());
    }
    Ok(())
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
