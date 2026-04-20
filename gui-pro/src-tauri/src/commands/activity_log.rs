use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use chrono::Local;

use crate::ssh::portable_data_dir;
use crate::logging::sanitize;

const MAX_ACTIVITY_LOG_SIZE: u64 = 10 * 1024 * 1024; // 10 MB per D-08
const MAX_ACTIVITY_LOG_AGE_DAYS: u64 = 7; // 7 days per D-08

static ACTIVITY_LOG: Mutex<Option<File>> = Mutex::new(None);

fn activity_log_path() -> PathBuf {
    portable_data_dir().join("logs").join("activity.log")
}

/// Rotate activity.log if it exceeds size limit or age limit.
/// Returns `true` when rotation happened so the caller can re-open the file.
fn rotate_if_needed(path: &PathBuf) -> bool {
    let Ok(meta) = fs::metadata(path) else { return false };

    // Rotation by size
    if meta.len() > MAX_ACTIVITY_LOG_SIZE {
        let backup = path.with_extension("log.1");
        let _ = fs::copy(path, &backup);
        let _ = fs::write(path, "");
        return true;
    }

    // Rotation by age
    if let Ok(modified) = meta.modified() {
        let age_threshold = Duration::from_secs(MAX_ACTIVITY_LOG_AGE_DAYS * 24 * 3600);
        if SystemTime::now()
            .duration_since(modified)
            .map(|age| age > age_threshold)
            .unwrap_or(false)
        {
            let backup = path.with_extension("log.1");
            let _ = fs::copy(path, &backup);
            let _ = fs::write(path, "");
            return true;
        }
    }

    false
}

/// Initialize activity log at application startup.
/// Creates the logs directory, rotates if needed, and opens the file for appending.
pub fn init_activity_log() {
    let logs_dir = portable_data_dir().join("logs");
    if fs::create_dir_all(&logs_dir).is_err() {
        eprintln!("[activity_log] Failed to create logs directory: {}", logs_dir.display());
        return;
    }

    let path = activity_log_path();
    rotate_if_needed(&path); // return value ignored here — file not yet open

    match OpenOptions::new().create(true).append(true).open(&path) {
        Ok(file) => {
            let mut guard = ACTIVITY_LOG.lock().unwrap_or_else(|e| e.into_inner());
            *guard = Some(file);
        }
        Err(e) => {
            eprintln!("[activity_log] Failed to open activity log: {e}");
        }
    }
}

/// Write a structured entry to the activity log.
///
/// Format (with details):    `[2024-01-01T15:00:00.000+03:00] [TAG] message (details)\n`
/// Format (without details): `[2024-01-01T15:00:00.000+03:00] [TAG] message\n`
///
/// FIX-LL: timestamps are in LOCAL TIME with a numeric offset instead of the
/// old Z (UTC). Users open activity.log to correlate with things they just
/// did on their PC clock — UTC forced them to do timezone math every time.
/// The `%z` offset keeps entries unambiguous across timezones.
///
/// Log injection is prevented by replacing embedded newlines in message/details.
/// IP addresses and sensitive values are masked via `sanitize()` per D-13.
#[tauri::command]
pub fn write_activity_log(tag: String, message: String, details: Option<String>) -> Result<(), String> {
    let ts = Local::now().format("%Y-%m-%dT%H:%M:%S%.3f%z");

    // L-03: strip characters that break the structured log format from tag
    let safe_tag = tag.replace(['[', ']', '\n', '\r'], "");

    // Prevent log injection: replace embedded newlines inside message and details
    let safe_message = message.replace('\n', "\\n").replace('\r', "\\r");
    let safe_details = details.map(|d| d.replace('\n', "\\n").replace('\r', "\\r"));

    let raw_line = if let Some(d) = safe_details {
        format!("[{ts}] [{safe_tag}] {safe_message} ({d})\n")
    } else {
        format!("[{ts}] [{safe_tag}] {safe_message}\n")
    };

    // Sanitize to mask IP addresses and other sensitive values (D-13)
    let sanitized = sanitize(&raw_line);

    let path = activity_log_path();
    let mut guard = ACTIVITY_LOG.lock().unwrap_or_else(|e| e.into_inner());

    // Rotation: if the file exceeds limits, truncate and re-open to avoid stale handle
    if rotate_if_needed(&path) {
        if let Ok(file) = OpenOptions::new().create(true).append(true).open(&path) {
            *guard = Some(file);
        }
    }

    if let Some(ref mut file) = *guard {
        file.write_all(sanitized.as_bytes())
            .and_then(|_| file.flush())
            .map_err(|e| format!("activity_log write error: {e}"))
    } else {
        // Log not initialized — silently succeed (non-critical path)
        Ok(())
    }
}

/// Return the absolute path to the activity log file.
#[tauri::command]
pub fn export_activity_log() -> Result<String, String> {
    Ok(activity_log_path().to_string_lossy().to_string())
}
