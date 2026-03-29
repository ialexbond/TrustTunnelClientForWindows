use crate::ssh::portable_data_dir;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::Emitter;

// ─── Protobuf wire format parser (no .proto files needed) ───
// v2ray geoip.dat / geosite.dat use standard protobuf encoding.
// We parse them manually to avoid prost-build complexity.

/// GeoIP entry: country_code + list of CIDRs
#[derive(Debug, Clone)]
pub struct GeoIP {
    pub country_code: String,
    pub cidrs: Vec<CidrEntry>,
}

#[derive(Debug, Clone)]
pub struct CidrEntry {
    pub ip: Vec<u8>,
    pub prefix: u32,
}

/// GeoSite entry: country_code (category name) + list of domains
#[derive(Debug, Clone)]
pub struct GeoSite {
    pub country_code: String,
    pub domains: Vec<GeoDomain>,
}

#[derive(Debug, Clone)]
pub struct GeoDomain {
    pub domain_type: u32, // 0=Plain, 1=Regex, 2=Domain (suffix), 3=Full
    pub value: String,
}

/// Cached geodata state
pub struct GeoDataState {
    pub geoip_categories: Mutex<Vec<String>>,
    pub geosite_categories: Mutex<Vec<String>>,
    pub geoip_data: Mutex<Option<Vec<GeoIP>>>,
    pub geosite_data: Mutex<Option<Vec<GeoSite>>>,
}

impl GeoDataState {
    pub fn new() -> Self {
        Self {
            geoip_categories: Mutex::new(Vec::new()),
            geosite_categories: Mutex::new(Vec::new()),
            geoip_data: Mutex::new(None),
            geosite_data: Mutex::new(None),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeoDataStatus {
    pub downloaded: bool,
    pub geoip_exists: bool,
    pub geosite_exists: bool,
    pub release_tag: Option<String>,
    pub downloaded_at: Option<String>,
    pub geoip_categories_count: usize,
    pub geosite_categories_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeoDataIndex {
    pub geoip: Vec<String>,
    pub geosite: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeoUpdateCheck {
    pub update_available: bool,
    pub current_tag: Option<String>,
    pub latest_tag: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GeoDataMeta {
    #[serde(default)]
    release_tag: Option<String>,
    // Legacy compat
    #[serde(default)]
    version: Option<String>,
    downloaded_at: String,
}

// ─── File paths ─────────────────────────────────────

fn geodata_dir() -> PathBuf {
    let dir = portable_data_dir().join("geodata");
    std::fs::create_dir_all(&dir).ok();
    dir
}

fn geoip_dat_path() -> PathBuf {
    geodata_dir().join("geoip.dat")
}

fn geosite_dat_path() -> PathBuf {
    geodata_dir().join("geosite.dat")
}

fn geodata_meta_path() -> PathBuf {
    geodata_dir().join("geodata_meta.json")
}

// ─── Protobuf wire format parser ────────────────────
// Minimal protobuf decoder for v2ray .dat files.
// Field tags: varint=0, length-delimited=2

struct ProtobufReader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> ProtobufReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    fn remaining(&self) -> usize {
        self.data.len().saturating_sub(self.pos)
    }

    fn read_varint(&mut self) -> Option<u64> {
        let mut result: u64 = 0;
        let mut shift = 0;
        loop {
            if self.pos >= self.data.len() {
                return None;
            }
            let byte = self.data[self.pos];
            self.pos += 1;
            result |= ((byte & 0x7F) as u64) << shift;
            if byte & 0x80 == 0 {
                return Some(result);
            }
            shift += 7;
            if shift >= 64 {
                return None;
            }
        }
    }

    fn read_tag(&mut self) -> Option<(u32, u32)> {
        let varint = self.read_varint()?;
        let field_number = (varint >> 3) as u32;
        let wire_type = (varint & 0x7) as u32;
        Some((field_number, wire_type))
    }

    fn read_bytes(&mut self) -> Option<&'a [u8]> {
        let len = self.read_varint()? as usize;
        if self.pos + len > self.data.len() {
            return None;
        }
        let result = &self.data[self.pos..self.pos + len];
        self.pos += len;
        result.into()
    }

    fn read_string(&mut self) -> Option<String> {
        let bytes = self.read_bytes()?;
        String::from_utf8(bytes.to_vec()).ok()
    }

    fn skip_field(&mut self, wire_type: u32) -> Option<()> {
        match wire_type {
            0 => { self.read_varint()?; }          // varint
            1 => { self.pos += 8; }                 // 64-bit
            2 => { let b = self.read_bytes()?; let _ = b; }  // length-delimited
            5 => { self.pos += 4; }                 // 32-bit
            _ => return None,
        }
        Some(())
    }
}

/// Parse geoip.dat — protobuf message GeoIPList { repeated GeoIP entry = 1; }
/// GeoIP { string country_code = 1; repeated CIDR cidr = 2; }
/// CIDR { bytes ip = 1; uint32 prefix = 2; }
fn parse_geoip_dat(data: &[u8]) -> Vec<GeoIP> {
    let mut reader = ProtobufReader::new(data);
    let mut entries = Vec::new();

    while reader.remaining() > 0 {
        let Some((field, wire_type)) = reader.read_tag() else { break };
        if field == 1 && wire_type == 2 {
            // GeoIP entry
            let Some(entry_bytes) = reader.read_bytes() else { break };
            if let Some(entry) = parse_single_geoip(entry_bytes) {
                entries.push(entry);
            }
        } else {
            if reader.skip_field(wire_type).is_none() { break; }
        }
    }

    entries
}

fn parse_single_geoip(data: &[u8]) -> Option<GeoIP> {
    let mut reader = ProtobufReader::new(data);
    let mut country_code = String::new();
    let mut cidrs = Vec::new();

    while reader.remaining() > 0 {
        let (field, wire_type) = reader.read_tag()?;
        match (field, wire_type) {
            (1, 2) => { country_code = reader.read_string()?; }
            (2, 2) => {
                let cidr_bytes = reader.read_bytes()?;
                if let Some(cidr) = parse_cidr(cidr_bytes) {
                    cidrs.push(cidr);
                }
            }
            _ => { reader.skip_field(wire_type)?; }
        }
    }

    if country_code.is_empty() {
        return None;
    }
    Some(GeoIP { country_code, cidrs })
}

fn parse_cidr(data: &[u8]) -> Option<CidrEntry> {
    let mut reader = ProtobufReader::new(data);
    let mut ip = Vec::new();
    let mut prefix: u32 = 0;

    while reader.remaining() > 0 {
        let (field, wire_type) = reader.read_tag()?;
        match (field, wire_type) {
            (1, 2) => { ip = reader.read_bytes()?.to_vec(); }
            (2, 0) => { prefix = reader.read_varint()? as u32; }
            _ => { reader.skip_field(wire_type)?; }
        }
    }

    if ip.is_empty() { return None; }
    Some(CidrEntry { ip, prefix })
}

/// Parse geosite.dat — GeoSiteList { repeated GeoSite entry = 1; }
/// GeoSite { string country_code = 1; repeated Domain domain = 2; }
/// Domain { Type type = 1; string value = 2; repeated Attribute attribute = 3; }
fn parse_geosite_dat(data: &[u8]) -> Vec<GeoSite> {
    let mut reader = ProtobufReader::new(data);
    let mut entries = Vec::new();

    while reader.remaining() > 0 {
        let Some((field, wire_type)) = reader.read_tag() else { break };
        if field == 1 && wire_type == 2 {
            let Some(entry_bytes) = reader.read_bytes() else { break };
            if let Some(entry) = parse_single_geosite(entry_bytes) {
                entries.push(entry);
            }
        } else {
            if reader.skip_field(wire_type).is_none() { break; }
        }
    }

    entries
}

fn parse_single_geosite(data: &[u8]) -> Option<GeoSite> {
    let mut reader = ProtobufReader::new(data);
    let mut country_code = String::new();
    let mut domains = Vec::new();

    while reader.remaining() > 0 {
        let (field, wire_type) = reader.read_tag()?;
        match (field, wire_type) {
            (1, 2) => { country_code = reader.read_string()?; }
            (2, 2) => {
                let domain_bytes = reader.read_bytes()?;
                if let Some(domain) = parse_geo_domain(domain_bytes) {
                    domains.push(domain);
                }
            }
            _ => { reader.skip_field(wire_type)?; }
        }
    }

    if country_code.is_empty() {
        return None;
    }
    Some(GeoSite { country_code, domains })
}

fn parse_geo_domain(data: &[u8]) -> Option<GeoDomain> {
    let mut reader = ProtobufReader::new(data);
    let mut domain_type: u32 = 0;
    let mut value = String::new();

    while reader.remaining() > 0 {
        let (field, wire_type) = reader.read_tag()?;
        match (field, wire_type) {
            (1, 0) => { domain_type = reader.read_varint()? as u32; }
            (2, 2) => { value = reader.read_string()?; }
            _ => { reader.skip_field(wire_type)?; }
        }
    }

    if value.is_empty() { return None; }
    Some(GeoDomain { domain_type, value })
}

// ─── CIDR formatting ────────────────────────────────

fn format_cidr(entry: &CidrEntry) -> Option<String> {
    match entry.ip.len() {
        4 => {
            // IPv4
            let ip = format!("{}.{}.{}.{}", entry.ip[0], entry.ip[1], entry.ip[2], entry.ip[3]);
            Some(format!("{}/{}", ip, entry.prefix))
        }
        16 => {
            // IPv6
            let mut parts = Vec::with_capacity(8);
            for i in 0..8 {
                let val = ((entry.ip[i * 2] as u16) << 8) | (entry.ip[i * 2 + 1] as u16);
                parts.push(format!("{:x}", val));
            }
            let ip = parts.join(":");
            Some(format!("{}/{}", ip, entry.prefix))
        }
        _ => None,
    }
}

/// Format domain for sidecar consumption
fn format_geo_domain(domain: &GeoDomain) -> String {
    match domain.domain_type {
        0 => domain.value.clone(),         // Plain — keyword match
        1 => domain.value.clone(),         // Regex — pass as-is (sidecar doesn't support regex, but keep for compatibility)
        2 => domain.value.clone(),         // Domain — suffix match (most common, sidecar handles this)
        3 => domain.value.clone(),         // Full — exact match
        _ => domain.value.clone(),
    }
}

// ─── Tauri commands ─────────────────────────────────

const GEOIP_URL: &str = "https://github.com/runetfreedom/russia-v2ray-rules-dat/releases/latest/download/geoip.dat";
const GEOSITE_URL: &str = "https://github.com/runetfreedom/russia-v2ray-rules-dat/releases/latest/download/geosite.dat";
const RELEASES_API: &str = "https://api.github.com/repos/runetfreedom/russia-v2ray-rules-dat/releases/latest";

#[derive(Debug, Clone, Serialize)]
struct GeoDataProgressPayload {
    file: String,
    downloaded_bytes: u64,
    total_bytes: u64,
    percent: u8,
    step: String,
}

/// Download a file with progress and retry
async fn download_with_progress(
    app: &tauri::AppHandle,
    client: &reqwest::Client,
    url: &str,
    file_name: &str,
    dest: std::path::PathBuf,
) -> Result<Vec<u8>, String> {
    let max_retries = 3;
    let mut last_error = String::new();

    for attempt in 1..=max_retries {
        eprintln!("[geodata] Downloading {file_name} (attempt {attempt}/{max_retries})...");
        app.emit("geodata-progress", GeoDataProgressPayload {
            file: file_name.into(), downloaded_bytes: 0, total_bytes: 0, percent: 0,
            step: if attempt > 1 {
                format!("Retry {file_name} ({attempt}/{max_retries})...")
            } else {
                "Connecting...".into()
            },
        }).ok();

        match download_single_attempt(app, client, url, file_name).await {
            Ok(buffer) => {
                std::fs::write(&dest, &buffer)
                    .map_err(|e| format!("Failed to save {file_name}: {e}"))?;
                eprintln!("[geodata] {file_name} saved ({} bytes)", buffer.len());

                app.emit("geodata-progress", GeoDataProgressPayload {
                    file: file_name.into(), downloaded_bytes: buffer.len() as u64,
                    total_bytes: buffer.len() as u64, percent: 100,
                    step: format!("{file_name} downloaded"),
                }).ok();

                return Ok(buffer);
            }
            Err(e) => {
                eprintln!("[geodata] Attempt {attempt} failed: {e}");
                last_error = e;
                if attempt < max_retries {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                }
            }
        }
    }

    Err(format!("Failed to download {file_name} after {max_retries} attempts: {last_error}"))
}

async fn download_single_attempt(
    app: &tauri::AppHandle,
    client: &reqwest::Client,
    url: &str,
    file_name: &str,
) -> Result<Vec<u8>, String> {
    use futures_util::StreamExt;

    let resp = client.get(url).send().await
        .map_err(|e| format!("{e}"))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }

    let total = resp.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut buffer = Vec::with_capacity(total as usize);
    let mut stream = resp.bytes_stream();
    let mut last_percent: u8 = 0;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("{e}"))?;
        downloaded += chunk.len() as u64;
        buffer.extend_from_slice(&chunk);

        let percent = if total > 0 { (downloaded * 100 / total) as u8 } else { 0 };
        if percent != last_percent || percent == 0 {
            last_percent = percent;
            let mb = downloaded as f64 / 1024.0 / 1024.0;
            let total_mb = total as f64 / 1024.0 / 1024.0;
            app.emit("geodata-progress", GeoDataProgressPayload {
                file: file_name.into(),
                downloaded_bytes: downloaded,
                total_bytes: total,
                percent,
                step: if total > 0 {
                    format!("{file_name}: {mb:.1} / {total_mb:.1} MB ({percent}%)")
                } else {
                    format!("{file_name}: {mb:.1} MB...")
                },
            }).ok();
        }
    }

    Ok(buffer)
}

#[tauri::command]
pub async fn download_geodata(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<GeoDataState>>,
) -> Result<GeoDataStatus, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    // Download only missing files
    let geoip_path = geoip_dat_path();
    let geosite_path = geosite_dat_path();
    let need_geoip = !geoip_path.exists();
    let need_geosite = !geosite_path.exists();
    let need_both = !need_geoip && !need_geosite; // Force update — redownload both

    let geoip_bytes = if need_geoip || need_both {
        download_with_progress(&app, &client, GEOIP_URL, "geoip.dat", geoip_path.clone()).await?
    } else {
        std::fs::read(&geoip_path).unwrap_or_default()
    };

    let geosite_bytes = if need_geosite || need_both {
        download_with_progress(&app, &client, GEOSITE_URL, "geosite.dat", geosite_path.clone()).await?
    } else {
        std::fs::read(&geosite_path).unwrap_or_default()
    };

    // Parsing step
    app.emit("geodata-progress", GeoDataProgressPayload {
        file: "".into(), downloaded_bytes: 0, total_bytes: 0, percent: 100,
        step: "Parsing categories...".into(),
    }).ok();

    // Fetch release tag from GitHub API
    let release_tag = match client.get(RELEASES_API)
        .header("User-Agent", "TrustTunnel")
        .timeout(std::time::Duration::from_secs(10))
        .send().await
    {
        Ok(resp) => {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                json.get("tag_name").and_then(|v| v.as_str()).map(String::from)
            } else { None }
        }
        Err(_) => None,
    };

    eprintln!("[geodata] Release tag: {:?}", release_tag);

    // Save metadata
    let meta = GeoDataMeta {
        release_tag: release_tag.clone(),
        version: release_tag, // legacy compat
        downloaded_at: chrono_now(),
    };
    if let Ok(json) = serde_json::to_string_pretty(&meta) {
        std::fs::write(geodata_meta_path(), json).ok();
    }

    // Parse and cache categories
    load_and_cache_geodata(&state, &geoip_bytes, &geosite_bytes);

    app.emit("geodata-progress", GeoDataProgressPayload {
        file: "".into(), downloaded_bytes: 0, total_bytes: 0, percent: 100,
        step: "Done!".into(),
    }).ok();

    get_geodata_status_inner(&state)
}

#[tauri::command]
pub fn get_geodata_status(state: tauri::State<'_, Arc<GeoDataState>>) -> Result<GeoDataStatus, String> {
    get_geodata_status_inner(&state)
}

fn get_geodata_status_inner(state: &GeoDataState) -> Result<GeoDataStatus, String> {
    let geoip_exists = geoip_dat_path().exists();
    let geosite_exists = geosite_dat_path().exists();

    let (release_tag, downloaded_at) = if let Ok(content) = std::fs::read_to_string(geodata_meta_path()) {
        if let Ok(meta) = serde_json::from_str::<GeoDataMeta>(&content) {
            // Use release_tag, fallback to legacy version field
            let tag = meta.release_tag.or(meta.version);
            (tag, Some(meta.downloaded_at))
        } else {
            (None, None)
        }
    } else {
        (None, None)
    };

    let geoip_count = state.geoip_categories.lock().map(|c| c.len()).unwrap_or(0);
    let geosite_count = state.geosite_categories.lock().map(|c| c.len()).unwrap_or(0);

    Ok(GeoDataStatus {
        downloaded: geoip_exists && geosite_exists,
        geoip_exists,
        geosite_exists,
        release_tag,
        downloaded_at,
        geoip_categories_count: geoip_count,
        geosite_categories_count: geosite_count,
    })
}

#[tauri::command]
pub fn load_geodata_categories(state: tauri::State<'_, Arc<GeoDataState>>) -> Result<GeoDataIndex, String> {
    // Try from cache first
    {
        let geoip = state.geoip_categories.lock().map_err(|e| e.to_string())?;
        let geosite = state.geosite_categories.lock().map_err(|e| e.to_string())?;
        if !geoip.is_empty() || !geosite.is_empty() {
            return Ok(GeoDataIndex {
                geoip: geoip.clone(),
                geosite: geosite.clone(),
            });
        }
    }

    // Load from disk
    let geoip_path = geoip_dat_path();
    let geosite_path = geosite_dat_path();

    if !geoip_path.exists() && !geosite_path.exists() {
        return Ok(GeoDataIndex {
            geoip: Vec::new(),
            geosite: Vec::new(),
        });
    }

    let geoip_bytes = std::fs::read(&geoip_path).unwrap_or_default();
    let geosite_bytes = std::fs::read(&geosite_path).unwrap_or_default();

    load_and_cache_geodata(&state, &geoip_bytes, &geosite_bytes);

    let geoip = state.geoip_categories.lock().map_err(|e| e.to_string())?;
    let geosite = state.geosite_categories.lock().map_err(|e| e.to_string())?;

    Ok(GeoDataIndex {
        geoip: geoip.clone(),
        geosite: geosite.clone(),
    })
}

fn load_and_cache_geodata(state: &GeoDataState, geoip_bytes: &[u8], geosite_bytes: &[u8]) {
    // Parse geoip
    if !geoip_bytes.is_empty() {
        let geoip_entries = parse_geoip_dat(geoip_bytes);
        let categories: Vec<String> = geoip_entries.iter()
            .map(|e| e.country_code.to_lowercase())
            .collect();
        eprintln!("[geodata] Parsed {} geoip categories", categories.len());
        if let Ok(mut cats) = state.geoip_categories.lock() {
            *cats = categories;
        }
        if let Ok(mut data) = state.geoip_data.lock() {
            *data = Some(geoip_entries);
        }
    }

    // Parse geosite
    if !geosite_bytes.is_empty() {
        let geosite_entries = parse_geosite_dat(geosite_bytes);
        let categories: Vec<String> = geosite_entries.iter()
            .map(|e| e.country_code.to_lowercase())
            .collect();
        eprintln!("[geodata] Parsed {} geosite categories", categories.len());
        if let Ok(mut cats) = state.geosite_categories.lock() {
            *cats = categories;
        }
        if let Ok(mut data) = state.geosite_data.lock() {
            *data = Some(geosite_entries);
        }
    }
}

/// Resolve a geoip category to CIDR list
pub fn resolve_geoip(state: &GeoDataState, category: &str) -> Result<Vec<String>, String> {
    let data = state.geoip_data.lock().map_err(|e| e.to_string())?;
    let entries = data.as_ref().ok_or("GeoIP data not loaded. Download geodata first.")?;

    let cat_lower = category.to_lowercase();
    let entry = entries.iter()
        .find(|e| e.country_code.to_lowercase() == cat_lower)
        .ok_or(format!("GeoIP category '{}' not found", category))?;

    let cidrs: Vec<String> = entry.cidrs.iter()
        .filter_map(|c| format_cidr(c))
        .collect();

    Ok(cidrs)
}

/// Resolve a geosite category to domain list
pub fn resolve_geosite(state: &GeoDataState, category: &str) -> Result<Vec<String>, String> {
    let data = state.geosite_data.lock().map_err(|e| e.to_string())?;
    let entries = data.as_ref().ok_or("GeoSite data not loaded. Download geodata first.")?;

    let cat_lower = category.to_lowercase();
    let entry = entries.iter()
        .find(|e| e.country_code.to_lowercase() == cat_lower)
        .ok_or(format!("GeoSite category '{}' not found", category))?;

    let domains: Vec<String> = entry.domains.iter()
        .map(|d| format_geo_domain(d))
        .collect();

    Ok(domains)
}

/// Check if geodata update is available by comparing release tags
#[tauri::command]
pub async fn check_geodata_updates(
    state: tauri::State<'_, Arc<GeoDataState>>,
) -> Result<GeoUpdateCheck, String> {
    // Get current tag from meta
    let current_tag = if let Ok(content) = std::fs::read_to_string(geodata_meta_path()) {
        serde_json::from_str::<GeoDataMeta>(&content)
            .ok()
            .and_then(|m| m.release_tag.or(m.version))
    } else {
        None
    };

    // Fetch latest tag from GitHub API
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP error: {e}"))?;

    let resp = client.get(RELEASES_API)
        .header("User-Agent", "TrustTunnel")
        .send().await
        .map_err(|e| format!("Failed to check for updates: {e}"))?;

    let json: serde_json::Value = resp.json().await
        .map_err(|e| format!("Failed to parse response: {e}"))?;

    let latest_tag = json.get("tag_name")
        .and_then(|v| v.as_str())
        .map(String::from);

    let update_available = match (&current_tag, &latest_tag) {
        (Some(current), Some(latest)) => current != latest,
        (None, Some(_)) => true,   // never downloaded
        _ => false,
    };

    // Also refresh category counts if data is loaded
    let _ = get_geodata_status_inner(&state);

    eprintln!("[geodata] Update check: current={:?}, latest={:?}, available={}", current_tag, latest_tag, update_available);

    Ok(GeoUpdateCheck {
        update_available,
        current_tag,
        latest_tag,
    })
}

fn chrono_now() -> String {
    let duration = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}", duration.as_millis())
}

// ─── File System Watcher ────────────────────────────
// Watches geodata/ directory for changes and emits "geodata-files-changed" event.

pub fn start_geodata_watcher(app: tauri::AppHandle, state: Arc<GeoDataState>) {
    use notify::{Watcher, RecursiveMode, Event, EventKind};

    let dir = geodata_dir();
    eprintln!("[geodata] Starting file watcher on {}", dir.display());

    std::thread::spawn(move || {
        let app_handle = app.clone();
        let state_ref = state.clone();

        let mut watcher = match notify::recommended_watcher(
            move |res: Result<Event, notify::Error>| {
                if let Ok(event) = res {
                    match event.kind {
                        EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(_) => {
                            // Debounce: check actual file state
                            let status = get_geodata_status_inner(&state_ref).ok();
                            if let Some(s) = status {
                                app_handle.emit("geodata-files-changed", s).ok();
                            }
                        }
                        _ => {}
                    }
                }
            },
        ) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("[geodata] Failed to create watcher: {e}");
                return;
            }
        };

        if let Err(e) = watcher.watch(&dir, RecursiveMode::NonRecursive) {
            eprintln!("[geodata] Failed to watch directory: {e}");
            return;
        }

        eprintln!("[geodata] File watcher active");

        // Keep thread alive — watcher drops when thread exits
        loop {
            std::thread::sleep(std::time::Duration::from_secs(60));
        }
    });
}
