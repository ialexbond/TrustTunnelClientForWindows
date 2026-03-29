use serde::{Deserialize, Serialize};
use crate::ssh;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRecord {
    pub id: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub duration_secs: Option<u64>,
    pub server_host: String,
    pub status: String, // "connected", "error", "disconnected"
}

fn history_path() -> std::path::PathBuf {
    ssh::portable_data_dir().join("connection_history.json")
}

fn load_history() -> Vec<SessionRecord> {
    std::fs::read_to_string(history_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_history(records: &[SessionRecord]) {
    // Keep last 100 records
    let trimmed: Vec<&SessionRecord> = records.iter().rev().take(100).collect::<Vec<_>>().into_iter().rev().collect();
    if let Ok(json) = serde_json::to_string_pretty(&trimmed) {
        let _ = std::fs::write(history_path(), json);
    }
}

#[tauri::command]
pub fn record_session_start(server_host: String) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    let record = SessionRecord {
        id: id.clone(),
        started_at: chrono_now(),
        ended_at: None,
        duration_secs: None,
        server_host,
        status: "connected".into(),
    };
    let mut history = load_history();
    history.push(record);
    save_history(&history);
    id
}

#[tauri::command]
pub fn record_session_end(id: String, status: String) {
    let mut history = load_history();
    if let Some(rec) = history.iter_mut().find(|r| r.id == id) {
        let now = chrono_now();
        rec.ended_at = Some(now);
        rec.status = status;
        // Calculate duration from started_at
        if let (Ok(start), Ok(end)) = (
            parse_timestamp(&rec.started_at),
            parse_timestamp(rec.ended_at.as_deref().unwrap_or("")),
        ) {
            if end > start {
                rec.duration_secs = Some((end - start) as u64);
            }
        }
    }
    save_history(&history);
}

#[tauri::command]
pub fn get_connection_history() -> Vec<SessionRecord> {
    let history = load_history();
    // Return newest first
    history.into_iter().rev().collect()
}

#[tauri::command]
pub fn clear_connection_history() {
    let _ = std::fs::remove_file(history_path());
}

/// Simple ISO timestamp
fn chrono_now() -> String {
    use std::time::SystemTime;
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format_timestamp(now)
}

fn format_timestamp(secs: u64) -> String {
    // Simple UTC timestamp without external crate
    let s = secs % 60;
    let m = (secs / 60) % 60;
    let h = (secs / 3600) % 24;
    let days = secs / 86400;
    // Days since epoch to Y-M-D (approximate, good enough for display)
    let (y, mo, d) = days_to_ymd(days);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

fn parse_timestamp(ts: &str) -> Result<i64, ()> {
    // Parse "YYYY-MM-DDThh:mm:ssZ" back to epoch seconds
    let parts: Vec<&str> = ts.split(['T', '-', ':', 'Z']).collect();
    if parts.len() < 6 { return Err(()); }
    let y: i64 = parts[0].parse().map_err(|_| ())?;
    let mo: i64 = parts[1].parse().map_err(|_| ())?;
    let d: i64 = parts[2].parse().map_err(|_| ())?;
    let h: i64 = parts[3].parse().map_err(|_| ())?;
    let m: i64 = parts[4].parse().map_err(|_| ())?;
    let s: i64 = parts[5].parse().map_err(|_| ())?;
    // Approximate: good enough for duration calc
    let days = ymd_to_days(y, mo, d);
    Ok(days * 86400 + h * 3600 + m * 60 + s)
}

fn days_to_ymd(total_days: u64) -> (u64, u64, u64) {
    // Gregorian calendar approximation from Unix epoch days
    let mut y = 1970u64;
    let mut remaining = total_days as i64;
    loop {
        let days_in_year = if is_leap(y) { 366 } else { 365 };
        if remaining < days_in_year { break; }
        remaining -= days_in_year;
        y += 1;
    }
    let months = [31, if is_leap(y) { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut mo = 1u64;
    for &m in &months {
        if remaining < m { break; }
        remaining -= m;
        mo += 1;
    }
    (y, mo, remaining as u64 + 1)
}

fn ymd_to_days(y: i64, mo: i64, d: i64) -> i64 {
    // Approximate days since epoch
    let mut days = 0i64;
    for year in 1970..y {
        days += if is_leap(year as u64) { 366 } else { 365 };
    }
    let months = [31, if is_leap(y as u64) { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    for i in 0..(mo - 1) as usize {
        if i < months.len() { days += months[i]; }
    }
    days + d - 1
}

fn is_leap(y: u64) -> bool {
    y % 4 == 0 && (y % 100 != 0 || y % 400 == 0)
}
