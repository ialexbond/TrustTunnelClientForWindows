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
///
/// C-01 (Phase 18): `secret` and `trusttunnel` were added so the MTProto (telemt)
/// proxy secret line — `trusttunnel = "<32-hex>"` under `[access.users]`, or a bare
/// `secret = "…"` — is redacted as belt-and-suspenders even if a telemt.toml body
/// ever reaches the log echo channel (exec_command → emit_log → sanitize). The
/// primary defence is that the uninstall paths now read ONLY the port (grep), never
/// the whole file; this redactor is the second line.
const SENSITIVE_KEYS: &[&str] =
    &["password", "certificate", "username", "client_random", "host", "secret", "trusttunnel"];

/// Replace values of sensitive keys with `***`.
///
/// FIX-OO-5: earlier revision scanned for `{key}: ` ANYWHERE in the text and
/// replaced the "value" with `***`. That caught prose like
/// `Failed to verify certificate: <wincrypt error>` — redacting the real
/// diagnostic and making cert-verify failures undebuggable. Now we only
/// redact when the key appears as a real assignment at the start of a line
/// (optionally indented): `  certificate = "<PEM>"` or
/// `password: hunter2`. Free-form prose containing the key word is left
/// alone. IPv4 masking and quoted-value handling unchanged.
pub fn sanitize(text: &str) -> String {
    // D-10: pasted SSH key data must never reach any log channel. A pasted private
    // key (`-----BEGIN OPENSSH PRIVATE KEY-----` / `-----BEGIN RSA PRIVATE KEY-----`
    // …) is a MULTI-LINE block whose base64 body lines are NOT `key = value`
    // assignments, so the assignment redactor below would let them through. We run a
    // stateful key-block pass FIRST that replaces every line inside a PEM/OpenSSH
    // key block with `***`, keeping the BEGIN/END marker lines (non-secret) so the
    // log still records that a key was present. This EXTENDS the existing D-29
    // password redaction; the assignment + IPv4 passes still run afterwards.
    let mut in_key_block = false;
    let mut redacted = text
        .lines()
        .map(|line| {
            let trimmed = line.trim();
            let is_begin = trimmed.starts_with("-----BEGIN ") && trimmed.contains("KEY-----");
            let is_end = trimmed.starts_with("-----END ") && trimmed.contains("KEY-----");
            if is_begin {
                in_key_block = true;
                return line.to_string(); // keep the non-secret marker line
            }
            if is_end {
                in_key_block = false;
                return line.to_string();
            }
            if in_key_block {
                // A body line of the key block — redact the secret material entirely.
                return "***".to_string();
            }
            // Outside any key block: the existing assignment redaction (D-29).
            redact_assignment_line(line)
        })
        .collect::<Vec<_>>()
        .join("\n");
    if text.ends_with('\n') {
        redacted.push('\n');
    }
    // Mask bare IPv4 addresses in freetext (e.g. "Connected to 1.2.3.4:443").
    mask_ipv4_addresses(&redacted)
}

/// Redact a single line if it looks like `<indent><sensitive_key><sep><value>`.
fn redact_assignment_line(line: &str) -> String {
    let indent_len = line.len() - line.trim_start().len();
    let (indent, trimmed) = line.split_at(indent_len);
    let lower = trimmed.to_lowercase();
    for key in SENSITIVE_KEYS {
        if !lower.starts_with(&key.to_lowercase()) {
            continue;
        }
        let after_key = &trimmed[key.len()..];
        let after_ws = after_key.trim_start();
        let sep = after_ws.chars().next().unwrap_or(' ');
        if sep != '=' && sep != ':' {
            continue;
        }
        // Looks like a real assignment — redact whatever follows.
        return format!("{indent}{key} {sep} ***");
    }
    line.to_string()
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

    for (oct_idx, octet) in octets.iter_mut().enumerate() {
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
        *octet = val;

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

/// Install a global panic hook that routes Rust panics through `log_app`
/// (after `init_logging()`) and the default panic handler (always).
///
/// Audit M-627-01 (ln-627 observability) — without this hook, a Rust
/// panic on a Tauri command thread silently kills the worker, the
/// frontend sees a one-shot IPC error with no stderr trail, and there
/// is no on-disk record of where the panic originated.
///
/// Design notes:
/// - Install BEFORE `tauri::Builder::default()` so panics during early
///   init are also captured.
/// - Run the previous (default) hook first so stderr / Windows debugger
///   integration keep working — we only ADD a file log line.
/// - Sanitize the payload before persisting (same SENSITIVE_KEYS +
///   IPv4 mask used everywhere else) so a panic that includes
///   `password = "..."` in the message never lands in app.log.
/// - If `init_logging()` has not run yet (panic during very early
///   startup), `log_app` is a no-op — the default hook still prints
///   to stderr, and Windows event log keeps the trail.
/// - Hook must never panic. Use `unwrap_or_else(|e| e.into_inner())`
///   pattern that already protects every other lock in this module.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // Format: "PANIC at {location} | thread={name}: {message}"
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown>".to_string());
        let thread = std::thread::current()
            .name()
            .unwrap_or("<unnamed>")
            .to_string();
        let payload = info.payload();
        let message = payload
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| payload.downcast_ref::<String>().map(|s| s.as_str()))
            .unwrap_or("<non-string payload>");
        let line = format!("PANIC at {location} | thread={thread}: {message}");
        let sanitized = sanitize(&line);
        log_app("error", &sanitized);
        // Run the previous (default) hook so stderr + Windows debugger
        // integration stay intact.
        previous(info);
    }));
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
    fn sanitize_redacts_assignments_on_separate_lines() {
        // FIX-OO-5: sanitizer is now line-based. Multiple secrets on separate
        // lines all get redacted; multiple on the same line are collapsed
        // into one `***` because that line reads as a single assignment.
        let input = "password = \"secret1\"\npassword = \"secret2\"";
        let result = sanitize(input);
        assert!(!result.contains("secret1"));
        assert!(!result.contains("secret2"));
        assert_eq!(result.matches("***").count(), 2);
    }

    #[test]
    fn sanitize_handles_toml_colon_equals_patterns() {
        assert!(!sanitize(r#"password = "mysecret""#).contains("mysecret"));
        assert!(!sanitize("username: admin").contains("admin"));
        assert!(!sanitize("certificate=abc123").contains("abc123"));
    }

    #[test]
    fn sanitize_handles_empty_and_no_match() {
        assert_eq!(sanitize(""), "");
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
        assert!(!sanitize(r#"PASSWORD = "hunter2""#).contains("hunter2"));
        assert!(!sanitize(r#"Password = "hunter2""#).contains("hunter2"));
    }

    #[test]
    fn sanitize_redacts_telemt_proxy_secret_line() {
        // C-01: if a telemt.toml body ever reaches the log echo channel, the
        // `[access.users] trusttunnel = "<hex>"` secret line must be redacted. Also
        // a generic `secret = …` assignment.
        let hex = "0123456789abcdef0123456789abcdef";
        let input = format!("[access.users]\ntrusttunnel = \"{hex}\"");
        let result = sanitize(&input);
        assert!(!result.contains(hex), "telemt proxy secret leaked through sanitize: {result}");
        assert!(!sanitize(r#"secret = "deadbeef""#).contains("deadbeef"), "bare secret= not redacted");
        // The section header itself is harmless prose and must survive.
        assert!(result.contains("[access.users]"));
    }

    #[test]
    fn sanitize_preserves_error_prose_with_certificate_word() {
        // FIX-OO-5 regression guard: free-form prose containing the key word
        // (but NOT as an assignment) must survive so cert-verify failures
        // stay debuggable.
        let input = "ERROR [5792] Failed to verify certificate: WCRYPT_E_TRUST_STATUS";
        let result = sanitize(input);
        assert!(
            result.contains("WCRYPT_E_TRUST_STATUS"),
            "real cert-verify error must survive sanitization — got: {result}"
        );
    }

    #[test]
    fn sanitize_redacts_assignments_with_leading_indent() {
        let input = r#"    password = "secret""#;
        let result = sanitize(input);
        assert!(!result.contains("secret"));
        assert!(result.starts_with("    password"));
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

    // ─── D-10: pasted SSH key data redaction (extends the D-29 spies) ──

    #[test]
    fn sanitize_redacts_pasted_openssh_private_key_block() {
        // D-10 spy: a pasted OpenSSH private key dropped into a log message (e.g. an
        // error that echoes the user's pasted key) must NEVER reach the sink. The
        // base64 body lines are NOT key=value assignments, so the prior line-based
        // redactor would have leaked them — this proves the PEM-block redaction.
        let secret_body = "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAASECRETKEYMATERIAL";
        let input = format!(
            "Failed to load key:\n-----BEGIN OPENSSH PRIVATE KEY-----\n{secret_body}\nAAAAtrailerline==\n-----END OPENSSH PRIVATE KEY-----\nretrying"
        );
        let result = sanitize(&input);
        assert!(
            !result.contains(secret_body),
            "pasted OpenSSH key body must be redacted — got: {result}"
        );
        assert!(
            !result.contains("AAAAtrailerline"),
            "every key body line must be redacted — got: {result}"
        );
        // The non-secret prose around the block survives so the log stays useful.
        assert!(result.contains("Failed to load key"));
        assert!(result.contains("retrying"));
        // A redaction marker is present where the key body was.
        assert!(result.contains("***"));
    }

    #[test]
    fn sanitize_redacts_pasted_rsa_pem_private_key_block() {
        // The classic `-----BEGIN RSA PRIVATE KEY-----` PEM shape too.
        let secret_body = "MIIEpAIBAAKCAQEAvSECRETrsaKEYbytes0123456789abcdef";
        let input = format!(
            "-----BEGIN RSA PRIVATE KEY-----\n{secret_body}\n-----END RSA PRIVATE KEY-----"
        );
        let result = sanitize(&input);
        assert!(
            !result.contains(secret_body),
            "pasted RSA PEM key body must be redacted — got: {result}"
        );
    }

    #[test]
    fn sanitize_still_redacts_password_assignment_alongside_key() {
        // The existing password redaction must remain intact (no regression) even when
        // a key block is present in the same message (D-29 + D-10 together).
        let input = "password = \"hunter2\"\n-----BEGIN OPENSSH PRIVATE KEY-----\nSECRETkeyBODYline\n-----END OPENSSH PRIVATE KEY-----";
        let result = sanitize(input);
        assert!(!result.contains("hunter2"), "password must still be redacted");
        assert!(!result.contains("SECRETkeyBODYline"), "key body must be redacted");
    }

    #[test]
    fn sanitize_preserves_prose_without_key_block() {
        // Regression guard: a normal log line that merely mentions "key" (no PEM
        // markers) is untouched — only real PEM/OpenSSH key blocks are redacted.
        let input = "Generated SSH key fingerprint OK; reconnecting";
        let result = sanitize(input);
        assert_eq!(result, input, "non-key-block prose must survive");
    }
}
