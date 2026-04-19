use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use chrono::Local;

use crate::portable_data_dir;

const MAX_LOG_SIZE: u64 = 5 * 1024 * 1024; // 5 MB

static LOG_STATE: Mutex<Option<LogState>> = Mutex::new(None);

struct LogState {
    app_log: File,
    sidecar_log: File,
    logs_dir: PathBuf,
}

/// Sensitive keys whose values must never appear in logs.
const SENSITIVE_KEYS: &[&str] = &["password", "certificate", "username", "client_random"];

/// Replace values of sensitive keys with `***`.
///
/// FIX-OO-5: earlier revision matched `{key}: ` ANYWHERE in the text, which
/// swallowed error-message detail like `Failed to verify certificate: <wincrypt
/// error>` (the `<error>` got replaced by `***` and cert-verify failures became
/// undebuggable). Now we scan line-by-line and only redact values that
/// appear as a TOML/config-style key=value assignment — i.e. the line
/// starts with optional whitespace, then the key, then `=` or `:`, then the
/// quoted value. Free-form prose that merely contains the key word is left
/// intact. This keeps leak prevention for real config dumps without
/// destroying diagnostic detail.
pub fn sanitize(text: &str) -> String {
    text.lines()
        .map(|line| redact_if_assignment(line))
        .collect::<Vec<_>>()
        .join("\n")
}

fn redact_if_assignment(line: &str) -> String {
    let trimmed = line.trim_start();
    let indent = &line[..line.len() - trimmed.len()];
    let lower = trimmed.to_lowercase();
    for key in SENSITIVE_KEYS {
        if !lower.starts_with(&key.to_lowercase()) {
            continue;
        }
        let after_key = &trimmed[key.len()..];
        // Separator must be `=`, `:`, or whitespace-then-one-of-those.
        // `Failed to verify certificate: <err>` has ` to ...` after `certificate`,
        // which starts with whitespace but then `to` — not a separator.
        let after_trimmed = after_key.trim_start();
        let sep_char = after_trimmed.chars().next().unwrap_or(' ');
        if sep_char != '=' && sep_char != ':' {
            continue;
        }
        // Take whatever follows as "the value" and replace with ***.
        return format!("{indent}{key} {sep_char} ***");
    }
    line.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_redacts_toml_assignment() {
        let input = r#"password = "s3cret""#;
        let out = sanitize(input);
        assert!(!out.contains("s3cret"));
        assert!(out.contains("***"));
    }

    #[test]
    fn sanitize_redacts_indented_assignment() {
        let input = r#"    username = "alice""#;
        let out = sanitize(input);
        assert!(!out.contains("alice"));
    }

    #[test]
    fn sanitize_preserves_error_message_containing_certificate_word() {
        // FIX-OO-5 regression guard: previous sanitizer treated every
        // occurrence of "certificate: " as a key=value pair and redacted
        // the actual wincrypt error — making cert-verify failures
        // undebuggable. Now the key is only redacted when it starts the
        // line as a real assignment.
        let input = "ERROR Failed to verify certificate: WCRYPT_E_TRUST_STATUS";
        let out = sanitize(input);
        assert!(out.contains("WCRYPT_E_TRUST_STATUS"), "real error must survive sanitization");
    }

    #[test]
    fn sanitize_preserves_username_in_prose() {
        let input = "User logged in with username alice — activity";
        let out = sanitize(input);
        assert!(out.contains("alice"));
    }

    #[test]
    fn sanitize_redacts_client_random_assignment() {
        let input = "client_random = \"aabbccdd\"";
        let out = sanitize(input);
        assert!(!out.contains("aabbccdd"));
    }
}

fn logs_dir() -> PathBuf {
    portable_data_dir().join("logs")
}

/// Initialize logging if enabled (flag file exists).
pub fn init_logging() {
    if !is_logging_enabled() {
        return;
    }
    let dir = logs_dir();
    if fs::create_dir_all(&dir).is_err() {
        eprintln!("[logging] Failed to create logs directory: {}", dir.display());
        return;
    }

    let app_path = dir.join("app.log");
    let sidecar_path = dir.join("sidecar.log");

    rotate_if_needed(&app_path);
    rotate_if_needed(&sidecar_path);

    let app_log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&app_path);
    let sidecar_log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&sidecar_path);

    match (app_log, sidecar_log) {
        (Ok(app), Ok(sidecar)) => {
            let mut state = LOG_STATE.lock().unwrap_or_else(|e| e.into_inner());
            *state = Some(LogState {
                app_log: app,
                sidecar_log: sidecar,
                logs_dir: dir,
            });
            eprintln!("[logging] File logging initialized");
        }
        _ => {
            eprintln!("[logging] Failed to open log files");
        }
    }
}

/// Shut down logging (close files).
pub fn shutdown_logging() {
    let mut state = LOG_STATE.lock().unwrap_or_else(|e| e.into_inner());
    *state = None;
}

/// Re-initialize logging after enable/disable toggle.
pub fn reinit_logging() {
    shutdown_logging();
    init_logging();
}

/// Check if logging is enabled via flag file.
pub fn is_logging_enabled() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|d| d.join(".enable_logs")))
        .map(|p| p.exists())
        .unwrap_or(false)
}

/// Rotate log file if it exceeds MAX_LOG_SIZE.
fn rotate_if_needed(path: &PathBuf) {
    if let Ok(meta) = fs::metadata(path) {
        if meta.len() > MAX_LOG_SIZE {
            let backup = path.with_extension("log.1");
            let _ = fs::copy(path, &backup);
            let _ = fs::write(path, "");
        }
    }
}

fn timestamp() -> String {
    Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

/// Write an application event to app.log.
pub fn log_app(level: &str, message: &str) {
    let sanitized = sanitize(message);
    let line = format!("[{}] [{}] {}\n", timestamp(), level.to_uppercase(), sanitized);

    let mut state = LOG_STATE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(ref mut s) = *state {
        rotate_if_needed(&s.logs_dir.join("app.log"));
        let _ = s.app_log.write_all(line.as_bytes());
        let _ = s.app_log.flush();
    }
}

/// Write a sidecar output line to sidecar.log.
pub fn log_sidecar(line: &str) {
    let sanitized = sanitize(line);
    let entry = format!("[{}] {}\n", timestamp(), sanitized);

    let mut state = LOG_STATE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(ref mut s) = *state {
        rotate_if_needed(&s.logs_dir.join("sidecar.log"));
        let _ = s.sidecar_log.write_all(entry.as_bytes());
        let _ = s.sidecar_log.flush();
    }
}

// ─── Tauri Commands ───

#[tauri::command]
pub fn set_logging_enabled(enabled: bool) -> Result<(), String> {
    let flag_path = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .ok_or("no parent dir")?
        .join(".enable_logs");
    if enabled {
        fs::write(&flag_path, "1").map_err(|e| e.to_string())?;
    } else {
        let _ = fs::remove_file(&flag_path);
    }
    reinit_logging();
    Ok(())
}

#[tauri::command]
pub fn get_logging_enabled() -> bool {
    is_logging_enabled()
}

#[tauri::command]
pub fn open_logs_folder() -> Result<(), String> {
    let dir = logs_dir();
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(dir.to_string_lossy().to_string())
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
