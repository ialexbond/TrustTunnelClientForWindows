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
    /// D-17 — the single update serializer, shared by the manual «Обновить» button and the
    /// background scheduler. Before this, two rapid clicks already raced two writers against the
    /// same two files; the only guard was a per-window React boolean that evaporates on remount.
    ///
    /// `tokio::sync::Mutex` (NOT `std::sync::Mutex`) because the critical section spans `.await`
    /// points — the same choice the benchmark serializer in `commands/vpn.rs` documents.
    ///
    /// It lives on `GeoDataState` rather than in a new managed type because this struct is managed
    /// as an `Arc`, so the scheduler's clone and the command's `tauri::State` extractor reach the
    /// SAME mutex — which is the entire point.
    pub update_in_flight: tokio::sync::Mutex<()>,
}

impl GeoDataState {
    pub fn new() -> Self {
        Self {
            geoip_categories: Mutex::new(Vec::new()),
            geosite_categories: Mutex::new(Vec::new()),
            geoip_data: Mutex::new(None),
            geosite_data: Mutex::new(None),
            update_in_flight: tokio::sync::Mutex::new(()),
        }
    }
}

/// Process-wide "a geodata write is in flight" flag, plus a notifier that fires whenever it flips.
///
/// Why this exists: the card's download button was enabled during a BACKGROUND download, because
/// the frontend only ever knew about downloads it started itself (a React boolean in
/// `useRoutingState`). Clicking it reached the backend, lost the `update_in_flight` race and came
/// back as `GEODATA_ALREADY_UPDATING` — an explanation after the fact instead of a control that
/// simply cannot be pressed. Owner's standing rule: while an operation runs, DISABLE the existing
/// element; do not invent a new state to explain it afterwards.
///
/// Why a process-wide statics pair rather than a field on `GeoDataState`: the flag has to be
/// readable and observable from `lib.rs`'s emitter task, which holds the `AppHandle` — and the
/// scheduler deliberately holds none (D-04), so it cannot emit anything itself. This keeps that
/// structural guarantee intact: the scheduler still cannot reach the UI; it only flips a bool, and
/// the shell decides what to do about it.
///
/// `AtomicBool` (not a mutex) because it is read from the emitter and a command while the writer
/// holds the real guard — a lock here would serialise readers against a multi-minute download.
fn update_busy_state() -> &'static (std::sync::atomic::AtomicBool, tokio::sync::Notify) {
    static BUSY: std::sync::OnceLock<(std::sync::atomic::AtomicBool, tokio::sync::Notify)> =
        std::sync::OnceLock::new();
    BUSY.get_or_init(|| {
        (
            std::sync::atomic::AtomicBool::new(false),
            tokio::sync::Notify::new(),
        )
    })
}

/// Is a geodata write in flight right now? Read by the `geodata_update_in_flight` command so a card
/// mounting mid-download starts out correct, and by the emitter task after each flip.
pub fn is_update_in_flight() -> bool {
    update_busy_state()
        .0
        .load(std::sync::atomic::Ordering::SeqCst)
}

/// A future that resolves on the next flip of the busy flag.
///
/// Returns the `Notified` future INSTEAD of awaiting it, so the caller can register itself as a
/// waiter BEFORE it reads the flag. That ordering is the whole point: `notify_waiters()` stores no
/// permit, so a flip landing between a read and the next park is gone for good — the relay in
/// `lib.rs` would then sit on a stale value, and if the lost flip was the `false` one the card's
/// button stays disabled until the next flip (up to a day). The scheduler's wake future is pinned
/// and enabled at the top of its loop for exactly this reason (`geodata_scheduler.rs`); this signature
/// is what lets the relay do the same.
pub fn update_busy_notified() -> tokio::sync::futures::Notified<'static> {
    update_busy_state().1.notified()
}

/// RAII marker: sets the busy flag on construction and clears it on drop, notifying both times.
///
/// Drop-based on purpose — every early return, `?` and panic in a download path must clear it, and
/// there are many. A forgotten manual reset would leave the button disabled until restart, which is
/// a worse failure than the one this fixes.
pub struct BusyFlag;

impl BusyFlag {
    pub fn acquire() -> Self {
        let (flag, notify) = update_busy_state();
        flag.store(true, std::sync::atomic::Ordering::SeqCst);
        notify.notify_waiters();
        Self
    }
}

impl Drop for BusyFlag {
    fn drop(&mut self) {
        let (flag, notify) = update_busy_state();
        flag.store(false, std::sync::atomic::Ordering::SeqCst);
        notify.notify_waiters();
    }
}

/// Read by the frontend when the card mounts: a background cycle may already be running by then
/// (the first one fires 8s after launch, which is exactly when a user opens Маршрутизация).
#[tauri::command]
pub fn geodata_update_in_flight() -> bool {
    is_update_in_flight()
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

/// Download a file with retry, returning its bytes. **Writes nothing.**
///
/// Phase 23 (D-16): this was `download_with_progress`, which wrote the buffer to `dest` itself.
/// That made a parse-before-commit guard impossible — by the time the caller saw the bytes, the
/// live `geoip.dat` had already been replaced. The write moved out to `commit_dat_files`, so the
/// sequence is now bytes → parse → non-empty check → atomic rename.
///
/// D-04: `app` is an `Option`. The automatic path passes `None` and is therefore silent on
/// `geodata-progress` **by construction** — there is no handle to emit through, so a future edit
/// cannot accidentally give the scheduler a progress bar nobody asked for.
async fn download_bytes(
    app: Option<&tauri::AppHandle>,
    client: &reqwest::Client,
    url: &str,
    file_name: &str,
) -> Result<Vec<u8>, String> {
    // Defence in depth: refuse anything that is not HTTPS on an allowlisted host before a single
    // byte is requested. A rejection is an ordinary `Err`, which the silent-failure convention
    // (D-09) already handles on the automatic path.
    validate_geodata_url(url)?;

    let max_retries = 3;
    let mut last_error = String::new();

    for attempt in 1..=max_retries {
        eprintln!("[geodata] Downloading {file_name} (attempt {attempt}/{max_retries})...");
        if let Some(app) = app {
            app.emit("geodata-progress", GeoDataProgressPayload {
                file: file_name.into(), downloaded_bytes: 0, total_bytes: 0, percent: 0,
                step: if attempt > 1 {
                    format!("Retry {file_name} ({attempt}/{max_retries})...")
                } else {
                    "Connecting...".into()
                },
            }).ok();
        }

        match download_single_attempt(app, client, url, file_name).await {
            Ok(buffer) => {
                eprintln!("[geodata] {file_name} downloaded ({} bytes)", buffer.len());

                if let Some(app) = app {
                    app.emit("geodata-progress", GeoDataProgressPayload {
                        file: file_name.into(), downloaded_bytes: buffer.len() as u64,
                        total_bytes: buffer.len() as u64, percent: 100,
                        step: format!("{file_name} downloaded"),
                    }).ok();
                }

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

/// IN-06 — hard ceiling on a single geodata download.
///
/// Both `.dat` files sit in the tens of megabytes, so 256 MB is far above any legitimate release
/// while still bounding what a hostile or broken upstream can make this process hold: the whole
/// body is materialised in RAM here and only then parsed.
const MAX_GEODATA_DOWNLOAD_BYTES: u64 = 256 * 1024 * 1024;

/// IN-06 — ceiling on the PRE-allocation, which is a separate concern from the download cap.
///
/// `Content-Length` is attacker-controlled input that used to be handed straight to
/// `Vec::with_capacity`, so a single header could demand an arbitrary allocation before any data
/// arrived. Lower than the download cap on purpose: this is a sizing hint, and under-guessing costs
/// only a few reallocations as the body streams in.
const MAX_GEODATA_PREALLOC_BYTES: u64 = 64 * 1024 * 1024;

/// How much to reserve up front for a body advertising `content_length` bytes. Pure, so the
/// clamping is testable without a server.
fn prealloc_capacity(content_length: u64) -> usize {
    content_length.min(MAX_GEODATA_PREALLOC_BYTES) as usize
}

/// D-04: `app` is an `Option` for the same reason as in `download_bytes` — a `None` handle makes
/// the per-chunk progress emission below unreachable for the automatic path.
async fn download_single_attempt(
    app: Option<&tauri::AppHandle>,
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

    // IN-06: refuse an advertised length that is already past the ceiling, before a single byte is
    // pulled. Both `.dat` files are tens of megabytes; anything approaching the cap is either a
    // broken upstream or a hostile one, and this now runs unattended once a day.
    if total > MAX_GEODATA_DOWNLOAD_BYTES {
        return Err(format!(
            "{file_name} advertises {total} bytes, over the {} MB cap",
            MAX_GEODATA_DOWNLOAD_BYTES / 1024 / 1024
        ));
    }

    let mut downloaded: u64 = 0;
    // IN-06: `Vec::with_capacity(total as usize)` allocated whatever the server claimed, in one go,
    // before any data arrived. Cap the PRE-allocation — being wrong costs a few reallocations while
    // the rest of the body streams in, which is nothing next to an attacker-chosen allocation.
    let mut buffer = Vec::with_capacity(prealloc_capacity(total));
    let mut stream = resp.bytes_stream();
    let mut last_percent: u8 = 0;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("{e}"))?;
        downloaded += chunk.len() as u64;
        // IN-06: and the ACCUMULATED size is capped too — `Content-Length` is a claim, not a
        // promise. A chunked or simply lying response can stream past it forever, and the whole
        // file is materialised in RAM here before it is parsed.
        if downloaded > MAX_GEODATA_DOWNLOAD_BYTES {
            return Err(format!(
                "{file_name} exceeded the {} MB download cap",
                MAX_GEODATA_DOWNLOAD_BYTES / 1024 / 1024
            ));
        }
        buffer.extend_from_slice(&chunk);

        // checked_div: clippy 1.95 `manual_checked_ops` flagged the prior
        // `if total > 0 { ... }` form as a re-implementation of `checked_div`.
        // Semantics preserved — `None` (total == 0) maps to 0% progress.
        let percent = (downloaded * 100).checked_div(total).unwrap_or(0) as u8;
        if percent != last_percent || percent == 0 {
            last_percent = percent;
            if let Some(app) = app {
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
    }

    Ok(buffer)
}

/// Opaque code returned when a downloaded `.dat` parses to zero categories (D-16). Opaque rather
/// than prose so the automatic path can classify the outcome without string-matching a message
/// that a later edit might reword.
const GEODATA_PARSE_EMPTY: &str = "GEODATA_PARSE_EMPTY";

/// D-17 — opaque code returned to the frontend when a download is already running. Mirrors the
/// existing `BENCHMARK_ALREADY_RUNNING` convention: the UI maps it to a localised message and must
/// never render it raw.
pub const GEODATA_ALREADY_UPDATING: &str = "GEODATA_ALREADY_UPDATING";

/// The D-16 parse guard, split out from `commit_dat_files` as a PURE function so it can be tested
/// without touching the filesystem. Both buffers are checked before either is written, so a good
/// geoip paired with a broken geosite cannot leave the pair half-replaced.
fn guard_dat_buffers(geoip: Option<&[u8]>, geosite: Option<&[u8]>) -> Result<(), String> {
    if let Some(bytes) = geoip {
        if parse_geoip_dat(bytes).is_empty() {
            return Err(format!("{GEODATA_PARSE_EMPTY}: geoip.dat parsed to zero categories"));
        }
    }
    if let Some(bytes) = geosite {
        if parse_geosite_dat(bytes).is_empty() {
            return Err(format!("{GEODATA_PARSE_EMPTY}: geosite.dat parsed to zero categories"));
        }
    }
    Ok(())
}

/// The ONE commit sequence for a downloaded geodata release — used by both the manual button and
/// the scheduler (OQ-1: one path, no "do it anyway" override, because a user cannot meaningfully
/// judge a protobuf parse).
///
/// D-16 (parse before commit): each supplied buffer must parse to a NON-EMPTY category vector
/// before anything is renamed. The in-tree parsers are deliberately tolerant — malformed wire data
/// `break`s out of the top-level loop instead of erroring — so upstream format drift surfaces
/// exactly as an empty `Vec`. That is why emptiness is the correct signal and there is no `Err` to
/// check. A category with zero CIDRs/domains is still a category and is NOT rejected: some upstream
/// categories legitimately carry very few entries.
///
/// Both buffers are guarded BEFORE either is written, so a good geoip + a broken geosite cannot
/// leave the pair half-replaced.
///
/// D-15/D-18 (atomic): every write goes through the shared temp → fsync → rename → parent-dir-fsync
/// writer, so the C++ core can never read a torn `.dat`. This replaces the old `std::fs::write`
/// that lived inside the download helper.
///
/// Ordering is deliberate: data files FIRST, meta LAST. A crash between them costs one extra
/// redownload next cycle; the reverse order would leave a fresh release tag pointing at stale
/// files, i.e. an update that never happens again. The meta error is PROPAGATED, not `.ok()`-ed as
/// it was before — a silently failed meta write makes the next check see the old tag and
/// re-download forever.
fn commit_dat_files(
    geoip: Option<&[u8]>,
    geosite: Option<&[u8]>,
    release_tag: Option<&str>,
) -> Result<(), String> {
    guard_dat_buffers(geoip, geosite)?;

    if let Some(bytes) = geoip {
        crate::commands::manifest::write_bytes_atomic(&geoip_dat_path(), bytes)?;
    }
    if let Some(bytes) = geosite {
        crate::commands::manifest::write_bytes_atomic(&geosite_dat_path(), bytes)?;
    }

    let tag = release_tag.map(String::from);
    let meta = GeoDataMeta {
        release_tag: tag.clone(),
        version: tag, // legacy compat
        downloaded_at: chrono_now(),
    };
    let json = serde_json::to_string_pretty(&meta)
        .map_err(|e| format!("Failed to serialize geodata meta: {e}"))?;
    crate::commands::manifest::write_bytes_atomic(&geodata_meta_path(), json.as_bytes())?;

    Ok(())
}

/// Commit a downloaded release and refresh the in-memory categories — on a BLOCKING thread.
///
/// WR-04: everything inside here is synchronous and slow. `commit_dat_files` performs two
/// `write_bytes_atomic` calls of tens of megabytes each, and that writer does `sync_all` plus a
/// parent-directory fsync; `load_and_cache_geodata` then parses both protobuf files in full into
/// `Vec<GeoIP>` / `Vec<GeoSite>`. Called inline from an async fn, that parks a tokio worker for
/// seconds while the connectivity monitor, the SSH pool and every async Tauri command share the
/// same pool. It was survivable while only a user-initiated click did it; the scheduler now does it
/// unprompted, once a day, with nobody waiting. `spawn_blocking` is the runtime's own answer.
///
/// The two steps stay in ONE blocking task rather than two, which also tightens an existing
/// invariant: `resolve_entries` reads geoip/geosite from MEMORY but group caches from DISK, so any
/// suspension between the rename and the in-memory refresh is a mixed-state window a concurrent
/// connect could resolve against. One task means there is no await point between them at all.
async fn commit_and_cache_blocking(
    state: Arc<GeoDataState>,
    geoip_bytes: Vec<u8>,
    geosite_bytes: Vec<u8>,
    release_tag: Option<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        commit_dat_files(
            Some(&geoip_bytes),
            Some(&geosite_bytes),
            release_tag.as_deref(),
        )?;
        load_and_cache_geodata(&state, &geoip_bytes, &geosite_bytes);
        Ok(())
    })
    .await
    // A JoinError here means the blocking task panicked — surfaced rather than swallowed, because
    // the alternative is reporting a successful update that never wrote anything.
    .map_err(|e| format!("geodata commit task failed: {e}"))?
}

/// What one automatic update cycle did. Consumed by the scheduler's single D-06 log line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AutoUpdateOutcome {
    /// The upstream release tag is unchanged — nothing was downloaded at all.
    UpToDate,
    /// A new release was downloaded, guarded, committed and loaded into memory.
    Updated { tag: String },
    /// A new release was downloaded but failed the D-16 parse guard; the previous database is
    /// untouched and still live.
    Rejected,
}

/// Hosts geodata may be fetched from. Exact match or dot-suffix match, lower-cased.
///
/// `githubusercontent.com` is listed as a SUFFIX so it covers both `raw.` (the whitelist sources)
/// and `objects.` (GitHub's release-asset CDN, where the `/releases/latest/download/` URLs
/// redirect to). Note this list is deliberately SEPARATE from the sidecar updater's
/// `validate_download_url`: that one guards a download of an executable which later runs elevated,
/// so its host set must stay minimal and is NOT widened to accommodate geodata.
const GEODATA_ALLOWED_HOSTS: [&str; 3] = ["github.com", "githubusercontent.com", "iplist.opencck.org"];

/// How many redirects a geodata fetch may follow. Every hop is re-validated below.
const GEODATA_MAX_REDIRECTS: usize = 5;

/// Whitelist guard for a geodata fetch URL: HTTPS only, host on `GEODATA_ALLOWED_HOSTS`.
///
/// Modelled on `commands::updater::validate_download_url` — in particular it parses with the `url`
/// crate rather than splitting strings, because a hand-rolled "everything before the first `/`"
/// parser reads `https://github.com@evil.com/x` as the host `github.com@evil.com` and accepts it.
/// `Url::host_str()` resolves the authority properly and returns `evil.com`.
///
/// **Honest scope.** Every geodata URL is a compile-time constant today, and the one interpolated
/// component anywhere in the geodata code is a group id that is already whitelist-guarded. So this
/// is defence-in-depth against future drift, NOT a fix for a live vulnerability.
///
/// **Honest limitation.** Unlike the sidecar updater, upstream publishes no checksum for these
/// releases, so there is no authenticity check available here. The D-16 parse guard proves the
/// bytes are well-formed; it is not integrity verification and must not be described as such.
///
/// `pub(crate)` so the group-cache fetch URLs (Plan 23-03) can route through this same function
/// instead of growing a third copy.
pub(crate) fn validate_geodata_url(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|_| "Invalid geodata URL".to_string())?;
    if parsed.scheme() != "https" {
        return Err("Geodata URL must use HTTPS".into());
    }
    let host = parsed
        .host_str()
        .ok_or("Geodata URL has no host")?
        .to_lowercase();
    if !GEODATA_ALLOWED_HOSTS
        .iter()
        .any(|d| host == *d || host.ends_with(&format!(".{d}")))
    {
        return Err(format!(
            "Geodata downloads only allowed from: {}",
            GEODATA_ALLOWED_HOSTS.join(", ")
        ));
    }
    Ok(())
}

/// The ONE HTTP client every geodata fetch must use — `.dat` downloads, the release-API call, the
/// RU-whitelist sources and the iplist group fetches alike.
///
/// CR-02: `pub(crate)` because Plan 23-03's group fetchers built their own bare
/// `reqwest::Client::builder()`, which silently inherits reqwest's default `Policy::limited(10)` —
/// ten redirects to ANY host, including an https → http downgrade. That made the
/// `validate_geodata_url` call those fetchers do a FIRST-HOP-ONLY check: one 302 from a hijacked or
/// misconfigured source and the response is parsed straight into `group_cache/<id>.json`, which
/// `routing_rules::resolve_entries` reads on every resolve to decide what bypasses the tunnel.
/// There must be exactly one constructor here, and it is this one.
pub(crate) fn geodata_http_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    // Re-validate EVERY redirect hop against the same allowlist instead of following it blindly.
    // Without this the guard is defeated by the first 302: `/releases/latest/download/` always
    // redirects, and a validated URL that redirects to an arbitrary host would sail straight
    // through. Hops are also capped, so a redirect loop cannot spin.
    let redirect = reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= GEODATA_MAX_REDIRECTS {
            return attempt.error("too many geodata redirects");
        }
        match validate_geodata_url(attempt.url().as_str()) {
            Ok(()) => attempt.follow(),
            Err(e) => attempt.error(e),
        }
    });

    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .connect_timeout(std::time::Duration::from_secs(timeout_secs.min(15)))
        .redirect(redirect)
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))
}

/// The quiet, version-aware `.dat` update entry point (D-04, D-07, D-08, D-09).
///
/// Deliberately NOT `download_geodata`: that command's `need_both` branch force-redownloads both
/// files whenever both already exist, which on a 24-hour loop means tens of megabytes every cycle
/// forever. Here the release tag is compared first and an unchanged tag costs one small API call.
///
/// `app` is `None` on the automatic path, so nothing is emitted on `geodata-progress` (D-04).
///
/// The in-memory refresh happens in the same breath as the rename, on purpose:
/// `resolve_entries` reads geoip/geosite from MEMORY but group caches from DISK, so any gap between
/// the two is a mixed-state window a concurrent connect could resolve against.
pub async fn auto_update_dat_inner(
    app: Option<&tauri::AppHandle>,
    state: &Arc<GeoDataState>,
) -> Result<AutoUpdateOutcome, String> {
    let check = check_geodata_updates_inner(state).await?;
    if !check.update_available {
        return Ok(AutoUpdateOutcome::UpToDate);
    }

    let client = geodata_http_client(600)?;
    let geoip_bytes = download_bytes(app, &client, GEOIP_URL, "geoip.dat").await?;
    let geosite_bytes = download_bytes(app, &client, GEOSITE_URL, "geosite.dat").await?;

    let tag = check.latest_tag.clone();
    // WR-04: the write + parse run on a blocking thread. Nothing else changes — the guard still
    // runs before either rename, and the memory refresh still happens without an await in between.
    match commit_and_cache_blocking(
        Arc::clone(state),
        geoip_bytes,
        geosite_bytes,
        tag.clone(),
    )
    .await
    {
        Ok(()) => {}
        // D-07: a database that parses to nothing is discarded, silently. The previous one stays
        // live and keeps working; the next cycle simply tries again (D-08).
        Err(e) if e.starts_with(GEODATA_PARSE_EMPTY) => return Ok(AutoUpdateOutcome::Rejected),
        Err(e) => return Err(e),
    }

    Ok(AutoUpdateOutcome::Updated {
        tag: tag.unwrap_or_else(|| "unknown".to_string()),
    })
}

#[tauri::command]
pub async fn download_geodata(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<GeoDataState>>,
) -> Result<GeoDataStatus, String> {
    // D-17: skip, never queue. `try_lock` (not `lock().await`) so a click arriving while the
    // scheduler is mid-download is REFUSED with an opaque code the UI localises, rather than
    // silently parking for minutes behind a download the user did not start.
    //
    // Deadlock safety is structural: the guard is taken once at the top of each of the two entry
    // points (this command and the scheduler's cycle), nothing inside the critical section calls
    // back into a function that takes it, and there are no other holders.
    //
    // It is held for the WHOLE download → parse → write → memory-refresh sequence on purpose:
    // `resolve_entries` reads geoip/geosite from MEMORY but group caches from DISK, so releasing
    // it between the rename and the in-memory refresh would leave a window where a concurrent
    // connect resolves old category data against new group data.
    let _update_guard = state
        .update_in_flight
        .try_lock()
        .map_err(|_| GEODATA_ALREADY_UPDATING.to_string())?;
    // Raised for the whole critical section so the card's button is disabled while THIS download
    // runs too — not only during a background one. Dropped with the guard on every exit path.
    let _busy = BusyFlag::acquire();

    // Validate the release-API constant up front rather than after the two downloads, so a
    // mis-edited constant fails before tens of megabytes are pulled.
    validate_geodata_url(RELEASES_API)?;
    let client = geodata_http_client(600)?;

    // An explicit user click is a FORCE refresh: both files are re-fetched even when the tag
    // matches. Both are always fetched together (the old code fetched only the missing one when
    // exactly one file was absent), so the committed pair always comes from a single release
    // instead of possibly mixing an old geoip with a new geosite.
    let geoip_bytes = download_bytes(Some(&app), &client, GEOIP_URL, "geoip.dat").await?;
    let geosite_bytes = download_bytes(Some(&app), &client, GEOSITE_URL, "geosite.dat").await?;

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

    // D-16/D-15 (OQ-1): the manual button commits through the SAME guarded, atomic sequence as the
    // scheduler. Previously the bytes were written inside the download helper (non-atomic, no
    // guard) and the meta write swallowed its own error.
    //
    // WR-04: and through the same blocking-thread wrapper. The manual path had this stall first —
    // it is a Tauri command on the async runtime, so tens of megabytes of fsync plus two full
    // protobuf parses parked a shared worker while the user watched a progress bar that had already
    // reached 100%.
    commit_and_cache_blocking(
        state.inner().clone(),
        geoip_bytes,
        geosite_bytes,
        release_tag,
    )
    .await?;

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
        .filter_map(format_cidr)
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
        .map(format_geo_domain)
        .collect();

    Ok(domains)
}

/// Check if geodata update is available by comparing release tags (Tauri command wrapper).
#[tauri::command]
pub async fn check_geodata_updates(
    state: tauri::State<'_, Arc<GeoDataState>>,
) -> Result<GeoUpdateCheck, String> {
    check_geodata_updates_inner(&state).await
}

/// Core logic of the release-tag comparison, following the house `_inner` convention
/// (`resolve_and_apply_inner`, `get_geodata_status_inner`).
///
/// This split is mandatory, not cosmetic: `tauri::State` is a COMMAND EXTRACTOR and is unreachable
/// from a spawned background task, which holds a plain `Arc<GeoDataState>` instead.
pub async fn check_geodata_updates_inner(
    state: &GeoDataState,
) -> Result<GeoUpdateCheck, String> {
    // Get current tag from meta
    let current_tag = if let Ok(content) = std::fs::read_to_string(geodata_meta_path()) {
        serde_json::from_str::<GeoDataMeta>(&content)
            .ok()
            .and_then(|m| m.release_tag.or(m.version))
    } else {
        None
    };

    // Fetch latest tag from GitHub API — same allowlist + redirect re-validation as the download
    // path, so the release-tag lookup cannot be steered somewhere else either.
    validate_geodata_url(RELEASES_API)?;
    let client = geodata_http_client(10)?;

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
    let _ = get_geodata_status_inner(state);

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

#[cfg(test)]
mod tests {
    use super::*;

    // ─── protobuf fixture builders ──────────────────
    // The in-tree parsers read raw protobuf wire format, so a realistic fixture has to be framed
    // the same way. Hand-rolled rather than pulled from a real .dat file: a checked-in multi-MB
    // binary would be a maintenance liability, and the guard only cares about the framing.

    fn varint(mut value: u64) -> Vec<u8> {
        let mut out = Vec::new();
        loop {
            let mut byte = (value & 0x7F) as u8;
            value >>= 7;
            if value != 0 {
                byte |= 0x80;
            }
            out.push(byte);
            if value == 0 {
                return out;
            }
        }
    }

    /// One length-delimited field: tag (field number + wire type 2), length, payload.
    fn len_delimited(field: u32, payload: &[u8]) -> Vec<u8> {
        let mut out = varint(((field as u64) << 3) | 2);
        out.extend(varint(payload.len() as u64));
        out.extend_from_slice(payload);
        out
    }

    /// A minimal but VALID `.dat`: one entry carrying a non-empty `country_code` in field 1.
    /// Both parsers share this shape (`GeoIPList`/`GeoSiteList` → repeated entry = 1, entry →
    /// country_code = 1), so one builder serves both.
    fn dat_with_one_category(country_code: &str) -> Vec<u8> {
        let entry = len_delimited(1, country_code.as_bytes());
        len_delimited(1, &entry)
    }

    /// D-16 truth: a buffer that parses to zero categories never reaches a rename, while a buffer
    /// with at least one category is accepted. This is the guard that stops an upstream format
    /// drift from silently zeroing routing — and because the parsers are TOLERANT (malformed wire
    /// data breaks out of the loop instead of erroring), emptiness is the only signal available.
    #[test]
    fn the_commit_guard_refuses_a_dat_that_parses_to_zero_categories() {
        // Accepted: real framing, one category.
        let good = dat_with_one_category("ru");
        assert!(
            !parse_geoip_dat(&good).is_empty(),
            "fixture sanity: the builder must produce a parseable category"
        );
        assert!(
            guard_dat_buffers(Some(&good), Some(&good)).is_ok(),
            "a .dat with at least one category must be accepted"
        );

        // Refused: empty, and non-empty-but-unparseable — both yield zero categories.
        for (label, bytes) in [
            ("an empty file", Vec::new()),
            ("random bytes that parse to nothing", vec![0xFF, 0xFF, 0xFF, 0xFF]),
            ("an entry with an empty country_code", dat_with_one_category("")),
        ] {
            let err = guard_dat_buffers(Some(&bytes), None)
                .expect_err(&format!("{label} must be refused"));
            assert!(
                err.starts_with(GEODATA_PARSE_EMPTY),
                "{label}: the refusal must carry the opaque code the auto path classifies on, got {err}"
            );
            let err = guard_dat_buffers(None, Some(&bytes))
                .expect_err(&format!("{label} must be refused on the geosite side too"));
            assert!(err.starts_with(GEODATA_PARSE_EMPTY));
        }

        // A good geoip paired with a broken geosite must refuse the WHOLE commit — otherwise the
        // pair would be half-replaced.
        assert!(
            guard_dat_buffers(Some(&good), Some(&[])).is_err(),
            "one broken buffer must fail the commit for both files"
        );
    }

    /// The URL allowlist accepts exactly the three real geodata endpoints and refuses everything
    /// that is not HTTPS on an allowlisted host. The look-alike case is the one that matters: a
    /// suffix check written as "contains github.com" would accept `github.com.evil.test`, which is
    /// an attacker-registrable domain.
    #[test]
    fn the_url_allowlist_accepts_the_real_endpoints_and_refuses_look_alikes() {
        for url in [GEOIP_URL, GEOSITE_URL, RELEASES_API] {
            validate_geodata_url(url)
                .unwrap_or_else(|e| panic!("the real geodata URL {url} must be accepted: {e}"));
        }
        // The release-asset CDN and the raw-content host both arrive via the suffix entry.
        assert!(validate_geodata_url("https://objects.githubusercontent.com/x").is_ok());
        assert!(validate_geodata_url("https://raw.githubusercontent.com/x").is_ok());
        assert!(validate_geodata_url("https://iplist.opencck.org/?format=json").is_ok());

        // Plaintext is refused even on an allowlisted host — the bytes replace the routing database.
        assert!(
            validate_geodata_url("http://github.com/x").is_err(),
            "an http scheme must be refused"
        );
        // Suffix look-alike: ends WITH the allowlisted string but is a different registrable domain.
        assert!(
            validate_geodata_url("https://github.com.evil.test/x").is_err(),
            "a host merely ending in the allowlisted name must be refused"
        );
        // Userinfo bypass — the reason this parses with the `url` crate instead of splitting strings.
        assert!(
            validate_geodata_url("https://github.com@evil.test/x").is_err(),
            "a userinfo-prefixed host must resolve to evil.test and be refused"
        );
        // No host at all.
        assert!(
            validate_geodata_url("not-a-url").is_err(),
            "a hostless string must be refused"
        );
    }

    /// IN-06: a server-controlled `Content-Length` must not size an allocation.
    ///
    /// The pre-allocation used to be `Vec::with_capacity(total as usize)` with `total` taken
    /// verbatim from the response header, so one header line could demand an arbitrary allocation
    /// before a single byte of body arrived — on a path that now runs unattended once a day.
    #[test]
    fn the_download_prealloc_is_capped_regardless_of_what_the_server_claims() {
        // A real release sizes its own buffer exactly.
        assert_eq!(prealloc_capacity(40 * 1024 * 1024), 40 * 1024 * 1024);
        // A missing Content-Length reserves nothing, and the Vec simply grows.
        assert_eq!(prealloc_capacity(0), 0);
        // Absurd claims clamp, including the value that would otherwise be the worst case.
        assert_eq!(prealloc_capacity(u64::MAX), MAX_GEODATA_PREALLOC_BYTES as usize);
        assert_eq!(
            prealloc_capacity(8 * 1024 * 1024 * 1024),
            MAX_GEODATA_PREALLOC_BYTES as usize
        );

        // The two ceilings must stay ordered: the prealloc hint is a sizing guess bounded well
        // below the hard cap on the accumulated body, which is what actually refuses the download.
        // Const blocks: both ceilings are compile-time constants, so an edit that inverts them
        // fails while the test binary COMPILES instead of only on a test run someone may have
        // filtered out. See connectivity.rs `offline_floor_is_snappy` for the enforcement point.
        const {
            assert!(
                MAX_GEODATA_PREALLOC_BYTES < MAX_GEODATA_DOWNLOAD_BYTES,
                "the prealloc hint must stay below the hard download cap"
            )
        };
        // Both `.dat` files are tens of megabytes — the cap must leave real releases plenty of room.
        const {
            assert!(
                MAX_GEODATA_DOWNLOAD_BYTES >= 128 * 1024 * 1024,
                "the cap must not be tight enough to refuse a legitimate release"
            )
        };
    }

    /// WR-04: moving the commit onto a blocking thread must not blur the error classification the
    /// silent path depends on. `auto_update_dat_inner` distinguishes "rejected by the parse guard"
    /// (D-07 — discard, keep the previous database, retry next cycle) from a real failure by
    /// matching the `GEODATA_PARSE_EMPTY` prefix, and that string now travels back through a
    /// `JoinHandle`. If the wrapper ever wraps or replaces it, the outcome silently degrades from
    /// `Rejected` to `Err`.
    ///
    /// Safe against the real data dir on purpose: the guard runs before either rename, so a pair of
    /// unparseable buffers returns without writing anything.
    #[tokio::test]
    async fn the_blocking_commit_preserves_the_parse_guard_error_code() {
        let state = Arc::new(GeoDataState::new());
        let err = commit_and_cache_blocking(state, vec![0xff, 0xff], vec![0xff, 0xff], None)
            .await
            .expect_err("two unparseable buffers must be refused before anything is written");
        assert!(
            err.starts_with(GEODATA_PARSE_EMPTY),
            "the guard's opaque code must survive the spawn_blocking round trip, or D-07's silent \
             discard becomes a hard error: {err}"
        );
    }

    /// CR-02: assert the CLIENT's behaviour, not the constants.
    ///
    /// The allowlist tests above (and `geodata::every_group_fetch_url_passes_the_geodata_allowlist`)
    /// all check `validate_geodata_url` in isolation. They stay green while the client that actually
    /// follows those URLs has no redirect control whatsoever — which is exactly how Plan 23-03's
    /// group fetchers shipped with a bare `reqwest::Client::builder()` and reqwest's default
    /// `Policy::limited(10)`: ten hops to any host, https → http downgrade included.
    ///
    /// So this drives the client from the outside. A one-shot loopback server answers `302` with an
    /// off-policy `Location`, and the client must fail with a REDIRECT error — i.e. the refusal came
    /// from our policy. Hand a geodata fetch a plain client again and reqwest follows the hop
    /// instead, failing (if at all) with a connect/DNS error whose `is_redirect()` is false, and
    /// this test goes red.
    ///
    /// Two cases, because they fail for different reasons: a foreign host, and an allowlisted host
    /// reached over plaintext.
    #[tokio::test]
    async fn the_geodata_client_refuses_an_off_policy_redirect_hop() {
        use std::io::{Read, Write};

        async fn assert_hop_refused(location: &str) {
            let listener = std::net::TcpListener::bind("127.0.0.1:0")
                .expect("a loopback listener must bind");
            let addr = listener.local_addr().expect("the bound port must be readable");
            let response = format!(
                "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            // One request, one response, then the thread ends — no runtime, no test server crate.
            let server = std::thread::spawn(move || {
                if let Ok((mut stream, _)) = listener.accept() {
                    let mut buf = [0u8; 1024];
                    let _ = stream.read(&mut buf);
                    let _ = stream.write_all(response.as_bytes());
                    let _ = stream.flush();
                }
            });

            let client = geodata_http_client(5).expect("the shared geodata client must build");
            let err = client
                .get(format!("http://{addr}/geoip.dat"))
                .send()
                .await
                .expect_err("an off-policy redirect must never be followed");

            assert!(
                err.is_redirect(),
                "the refusal must come from the redirect policy, not from the network \
                 (a default-policy client would have followed {location}): {err}"
            );
            let _ = server.join();
        }

        // A hijacked or misconfigured source redirecting anywhere it likes.
        assert_hop_refused("http://redirect-target.invalid/geoip.dat").await;
        // Allowlisted HOST, plaintext scheme — the downgrade the default policy also permits.
        assert_hop_refused("http://raw.githubusercontent.com/geoip.dat").await;
    }

    /// The busy flag is raised for the duration of a write and CLEARED BY DROP.
    ///
    /// Why this is worth a test rather than a code comment: the flag is what disables the card's
    /// button. If it ever stuck true — a marker that outlives its scope, someone swapping the RAII
    /// type for a manual set/clear pair and missing an early return — the button stays dead until
    /// the app restarts, which is a worse failure than the enabled-button bug it was added to fix.
    ///
    /// It also pins the drop ORDER that makes two markers impossible: both call sites take the
    /// single-writer mutex first and the marker second, so the marker is released before the mutex
    /// and no second acquirer can ever observe a stale `true` from a finished writer.
    #[test]
    fn the_busy_flag_is_raised_for_the_write_and_cleared_by_drop() {
        assert!(!is_update_in_flight(), "nothing is writing at rest");

        {
            let _busy = BusyFlag::acquire();
            assert!(is_update_in_flight(), "a write in progress must report busy");
        }

        assert!(
            !is_update_in_flight(),
            "leaving the scope must clear the flag — a stuck flag disables the card's button until restart"
        );

        // An early return out of a nested scope must clear it just the same.
        fn writer_that_bails() -> Result<(), String> {
            let _busy = BusyFlag::acquire();
            Err("upstream unreachable".into())
        }
        assert!(writer_that_bails().is_err());
        assert!(
            !is_update_in_flight(),
            "an error path must clear the flag too — every download leg can fail"
        );
    }

    /// D-17 truth: the second writer is refused, not queued. A held guard blocks a `try_lock`, and
    /// dropping it releases the next attempt — which is exactly the "skip this cycle / report
    /// already updating" behaviour both entry points rely on.
    #[tokio::test]
    async fn the_in_flight_guard_refuses_a_second_concurrent_updater() {
        let state = GeoDataState::new();

        let first = state
            .update_in_flight
            .try_lock()
            .expect("the first updater must acquire the guard");

        assert!(
            state.update_in_flight.try_lock().is_err(),
            "a second updater must be refused while the first is alive (skip, not queue)"
        );

        drop(first);

        assert!(
            state.update_in_flight.try_lock().is_ok(),
            "the guard must be released when the first updater finishes"
        );
    }
}
