use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use chrono::Local;
use tokio::sync::mpsc;

use crate::ssh::portable_data_dir;

const MAX_LOG_SIZE: u64 = 5 * 1024 * 1024; // 5 MB

// ─── Async Channel Architecture ───

enum LogEntry {
    App { level: String, message: String },
    Sidecar { line: String },
}

/// The Mutex only protects an Option<Sender> (nanosecond lock).
/// No file I/O happens under this lock -- massive improvement over the old
/// Mutex<Option<LogState>> which held the lock during write_all+flush.
static LOG_TX: Mutex<Option<mpsc::Sender<LogEntry>>> = Mutex::new(None);

/// Sensitive keys whose values must never appear in logs.
const SENSITIVE_KEYS: &[&str] = &["password", "certificate", "username", "client_random", "host"];

/// Replace values of sensitive keys with `***`.
/// Handles patterns like `key = "value"`, `key: value`, `key=value`.
/// Also masks bare IPv4 addresses in freetext (e.g. "Connected to 1.2.3.4:443").
pub fn sanitize(text: &str) -> String {
    let mut result = text.to_string();
    for key in SENSITIVE_KEYS {
        // TOML style: key = "value" or key = 'value'
        let patterns = [
            format!(r#"{key} = ""#),
            format!("{key} = '"),
            format!("{key}="),
            format!("{key}: "),
        ];
        for pat in &patterns {
            let mut search_from = 0usize;
            loop {
                let lower = result.to_lowercase();
                let pat_lower = pat.to_lowercase();
                let Some(start) = lower[search_from..].find(&pat_lower).map(|i| i + search_from) else { break };
                let after = start + pat.len();
                if after >= result.len() { break; }
                let rest = &result[after..];
                let end = rest
                    .find(|c: char| c == '"' || c == '\'' || c == '\n' || c == '\r')
                    .unwrap_or(rest.len());
                result = format!("{}***{}", &result[..after], &result[after + end..]);
                // Advance past the replacement to avoid infinite re-matching
                search_from = after + 3; // 3 = "***".len()
            }
        }
    }

    // Mask bare IPv4 addresses in freetext (e.g. "Connected to 1.2.3.4:443").
    // Uses a manual scan to avoid pulling in the `regex` crate.
    result = mask_ipv4_addresses(&result);

    result
}

/// Replace all bare IPv4 addresses (e.g. `1.2.3.4`) with `***`.
/// A "bare" address is one not immediately preceded or followed by a digit or dot,
/// so CIDR suffixes and decimal-heavy version strings are left untouched only when
/// they don't form a valid quad. Each octet must be 1–3 decimal digits.
fn mask_ipv4_addresses(text: &str) -> String {
    let bytes = text.as_bytes();
    let len = bytes.len();
    let mut out = String::with_capacity(len);
    let mut i = 0usize;

    while i < len {
        // A potential IP can only start with a digit that is NOT preceded by a digit or dot.
        if bytes[i].is_ascii_digit() && (i == 0 || (!bytes[i - 1].is_ascii_digit() && bytes[i - 1] != b'.')) {
            if let Some((ip_len, valid)) = try_parse_ipv4(bytes, i) {
                if valid {
                    out.push_str("***");
                    i += ip_len;
                    continue;
                }
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }

    out
}

/// Try to parse an IPv4 address starting at `pos` in `bytes`.
/// Returns `Some((length, true))` if a valid quad was found,
/// `Some((length, false))` if it looked like a quad but was invalid,
/// or `None` if it doesn't start with an octet pattern.
fn try_parse_ipv4(bytes: &[u8], pos: usize) -> Option<(usize, bool)> {
    let len = bytes.len();
    let mut i = pos;
    let mut octets: [u16; 4] = [0; 4];

    for oct_idx in 0..4 {
        // Read up to 3 digits
        let start = i;
        let mut val: u16 = 0;
        let mut digit_count = 0usize;
        while i < len && bytes[i].is_ascii_digit() && digit_count < 3 {
            val = val * 10 + (bytes[i] - b'0') as u16;
            i += 1;
            digit_count += 1;
        }
        if digit_count == 0 {
            return None; // no digits at all
        }
        octets[oct_idx] = val;

        if oct_idx < 3 {
            // Must be followed by a dot
            if i >= len || bytes[i] != b'.' {
                return None;
            }
            i += 1; // consume dot
        }
        let _ = start;
    }

    // The character after the 4th octet must NOT be a digit or dot
    // (to avoid matching inside longer number sequences like version strings).
    if i < len && (bytes[i].is_ascii_digit() || bytes[i] == b'.') {
        return None;
    }

    let ip_len = i - pos;
    let valid = octets.iter().all(|&o| o <= 255);
    Some((ip_len, valid))
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
    let (tx, rx) = mpsc::channel::<LogEntry>(1024);
    {
        let mut guard = LOG_TX.lock().unwrap_or_else(|e| e.into_inner());
        *guard = Some(tx);
    }
    tauri::async_runtime::spawn(log_writer_task(rx));
    eprintln!("[logging] Async file logging initialized");
}

/// Shut down logging: drop sender to close channel; writer task drains remaining and exits.
pub fn shutdown_logging() {
    let mut guard = LOG_TX.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(tx) = guard.take() {
        drop(tx);
    }
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

/// Rotate log file if it exceeds MAX_LOG_SIZE. Returns true if rotation happened.
fn rotate_if_needed(path: &PathBuf) -> bool {
    if let Ok(meta) = fs::metadata(path) {
        if meta.len() > MAX_LOG_SIZE {
            let backup = path.with_extension("log.1");
            let _ = fs::copy(path, &backup);
            let _ = fs::write(path, "");
            return true;
        }
    }
    false
}

fn timestamp() -> String {
    Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

fn open_log_file(path: &PathBuf) -> Option<File> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .ok()
}

fn process_entry(
    entry: &LogEntry,
    app_file: &mut Option<File>,
    sidecar_file: &mut Option<File>,
) {
    match entry {
        LogEntry::App { level, message } => {
            if let Some(ref mut f) = app_file {
                let sanitized = sanitize(message);
                let line = format!("[{}] [{}] {}\n", timestamp(), level.to_uppercase(), sanitized);
                let _ = f.write_all(line.as_bytes());
            }
        }
        LogEntry::Sidecar { line } => {
            if let Some(ref mut f) = sidecar_file {
                let sanitized = sanitize(line);
                let entry = format!("[{}] {}\n", timestamp(), sanitized);
                let _ = f.write_all(entry.as_bytes());
            }
        }
    }
}

/// Background writer task: receives log entries via channel, batches writes, flushes per-batch.
async fn log_writer_task(mut rx: mpsc::Receiver<LogEntry>) {
    let dir = logs_dir();
    let app_path = dir.join("app.log");
    let sidecar_path = dir.join("sidecar.log");

    rotate_if_needed(&app_path);
    rotate_if_needed(&sidecar_path);

    let mut app_file = open_log_file(&app_path);
    let mut sidecar_file = open_log_file(&sidecar_path);
    let mut write_count: u32 = 0;

    while let Some(entry) = rx.recv().await {
        let mut batch_count: u32 = 1;

        // Process first entry
        process_entry(&entry, &mut app_file, &mut sidecar_file);

        // Drain up to 63 more (total 64 per batch)
        while batch_count < 64 {
            match rx.try_recv() {
                Ok(e) => {
                    process_entry(&e, &mut app_file, &mut sidecar_file);
                    batch_count += 1;
                }
                Err(_) => break,
            }
        }

        // Flush after batch (ONE flush, not per-line)
        if let Some(ref mut f) = app_file { let _ = f.flush(); }
        if let Some(ref mut f) = sidecar_file { let _ = f.flush(); }

        write_count += batch_count;

        // Check rotation every ~1000 writes
        if write_count >= 1000 {
            if rotate_if_needed(&app_path) {
                app_file = open_log_file(&app_path);
            }
            if rotate_if_needed(&sidecar_path) {
                sidecar_file = open_log_file(&sidecar_path);
            }
            write_count = 0;
        }
    }

    // Channel closed -- drain remaining
    while let Ok(entry) = rx.try_recv() {
        process_entry(&entry, &mut app_file, &mut sidecar_file);
    }

    // Final flush
    if let Some(ref mut f) = app_file { let _ = f.flush(); }
    if let Some(ref mut f) = sidecar_file { let _ = f.flush(); }
}

/// Write an application event to app.log (non-blocking).
pub fn log_app(level: &str, message: &str) {
    let guard = LOG_TX.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(ref tx) = *guard {
        let _ = tx.try_send(LogEntry::App {
            level: level.to_string(),
            message: message.to_string(),
        });
    }
}

/// Write a sidecar output line to sidecar.log (non-blocking).
pub fn log_sidecar(line: &str) {
    let guard = LOG_TX.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(ref tx) = *guard {
        let _ = tx.try_send(LogEntry::Sidecar {
            line: line.to_string(),
        });
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
        let canonical = fs::canonicalize(&dir).map_err(|e| e.to_string())?;
        std::process::Command::new("explorer")
            .arg(canonical.to_string_lossy().to_string())
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ─── Tests ───

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_replaces_all_occurrences() {
        let input = r#"password = "secret1" and password = "secret2""#;
        let result = sanitize(input);
        assert!(!result.contains("secret1"), "first occurrence not sanitized");
        assert!(!result.contains("secret2"), "second occurrence not sanitized");
        assert_eq!(result.matches("***").count(), 2);
    }

    #[test]
    fn sanitize_handles_toml_colon_equals_patterns() {
        // TOML style: key = "value"
        let toml = r#"password = "mysecret""#;
        assert!(sanitize(toml).contains("***"));
        assert!(!sanitize(toml).contains("mysecret"));

        // Colon style: key: value
        let colon = "username: admin";
        assert!(sanitize(colon).contains("***"));
        assert!(!sanitize(colon).contains("admin"));

        // Equals style: key=value
        let equals = "certificate=abc123";
        assert!(sanitize(equals).contains("***"));
        assert!(!sanitize(equals).contains("abc123"));
    }

    #[test]
    fn sanitize_handles_empty_and_no_match() {
        // Empty string
        assert_eq!(sanitize(""), "");

        // No sensitive keys
        let safe = "this is a safe log line with no secrets";
        assert_eq!(sanitize(safe), safe);
    }

    #[test]
    fn sanitize_all_sensitive_keys() {
        for key in SENSITIVE_KEYS {
            let input = format!(r#"{key} = "sensitive_value""#);
            let result = sanitize(&input);
            assert!(!result.contains("sensitive_value"), "Key '{key}' not sanitized");
            assert!(result.contains("***"), "Key '{key}' missing *** replacement");
        }
    }

    #[test]
    fn sanitize_case_insensitive() {
        let upper = r#"PASSWORD = "secret""#;
        assert!(!sanitize(upper).contains("secret"), "uppercase PASSWORD not sanitized");

        let mixed = r#"Password = "secret""#;
        assert!(!sanitize(mixed).contains("secret"), "mixed-case Password not sanitized");
    }

    #[test]
    fn sanitize_quoted_value_boundaries() {
        let input = r#"password = "abc"def"#;
        let result = sanitize(input);
        assert!(!result.contains("abc"), "value inside quotes not sanitized");
        assert!(result.contains("def"), "text after closing quote should remain");
    }

    #[test]
    fn sanitize_masks_bare_ipv4_in_freetext() {
        let input = "Connected to 1.2.3.4:443";
        let result = sanitize(input);
        assert!(!result.contains("1.2.3.4"), "bare IP not masked");
        assert!(result.contains("***"), "masked placeholder missing");
    }

    #[test]
    fn sanitize_masks_multiple_ips() {
        let input = "peer 10.0.0.1 via gateway 192.168.1.1";
        let result = sanitize(input);
        assert!(!result.contains("10.0.0.1"), "first IP not masked");
        assert!(!result.contains("192.168.1.1"), "second IP not masked");
    }

    #[test]
    fn sanitize_does_not_mask_non_ip_numbers() {
        let input = "version 1.2.3 and build 10.0";
        let result = sanitize(input);
        // These do not form valid IPv4 quads (only 3 / 2 octets)
        assert_eq!(result, input, "non-IP numbers should not be modified");
    }
}
