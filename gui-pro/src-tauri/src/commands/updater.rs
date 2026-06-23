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
fn build_updater_bat(
    pid: u32,
    setup_str: &str,
    app_str: &str,
    vbs_str: &str,
    loader_str: &str,
    run_dir_str: &str,
) -> String {
    format!(
        r#"@echo off
title TrustTunnel Updater
echo Waiting for TrustTunnel to exit (PID {pid})...
:waitloop
tasklist /FI "PID eq {pid}" 2>NUL | find "{pid}" >NUL
if not errorlevel 1 (
    timeout /t 1 /nobreak >nul
    goto waitloop
)
echo Installing update...
"{setup_str}" /S
echo Starting TrustTunnel...
timeout /t 2 /nobreak >nul
start "" "{app_str}"
echo Cleaning up...
del "{vbs_str}" >nul 2>&1
del "{loader_str}" >nul 2>&1
del "{setup_str}" >nul 2>&1
start "" /b cmd /c "timeout /t 5 /nobreak >nul & rmdir /S /Q ""{run_dir_str}""" >nul 2>&1
(goto) 2>nul & del "%~f0"
"#
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
/// (10× size: 107 MB vs 10.7 MB на v1.0.33 per 18-RESEARCH.md §Finding 1).
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
    let client = reqwest::Client::new();
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
/// Errors: `UPDATE_CHECK_FAILED` (silent fail per D-2.x).
#[tauri::command]
pub async fn check_app_update_info(
    app: tauri::AppHandle,
) -> Result<AppUpdateInfo, String> {
    let current_version = app.package_info().version.to_string();

    let client = reqwest::Client::new();
    let res = client
        .get("https://api.github.com/repos/ialexbond/TrustTunnelClientForWindows/releases/latest")
        .header("User-Agent", "TrustTunnel-UpdateChecker")
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await
        .map_err(|_| "UPDATE_CHECK_FAILED".to_string())?;

    if !res.status().is_success() {
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

    ssh::sanitize::validate_version(&latest_tag)
        .map_err(|_| "UPDATE_CHECK_FAILED".to_string())?;

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
    let download_url = assets
        .iter()
        .filter_map(|a| {
            let name = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let url = a.get("browser_download_url").and_then(|v| v.as_str()).unwrap_or("");
            if name.contains("Pro") && name.contains("setup") && name.ends_with(".exe") {
                Some(url.to_string())
            } else {
                None
            }
        })
        .next()
        .unwrap_or(html_url);

    if !download_url.is_empty() {
        validate_download_url(&download_url)
            .map_err(|_| "UPDATE_CHECK_FAILED".to_string())?;
    }

    let available = compare_semver(&current_version, &latest_version) < 0;

    Ok(AppUpdateInfo {
        current_version,
        latest_version,
        latest_tag,
        available,
        download_url,
        release_notes,
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

    let client = reqwest::Client::new();
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
    let app_exe = app_dir.join(exe_path.file_name().unwrap_or_default());
    let setup_str = setup_path.to_string_lossy();
    let app_str = app_exe.to_string_lossy();
    let vbs_path = run_dir.join("trusttunnel_updater.vbs");

    // be-1: build the .bat via the pure helper so the cleanup contract (no
    // self-blocking non-recursive rmdir; whole run_dir reclaimed by a detached
    // delayed `rmdir /S /Q`) is unit-tested in `self_update_cleanup_tests`.
    let bat_content = build_updater_bat(
        pid,
        &setup_str,
        &app_str,
        &vbs_path.to_string_lossy(),
        &run_dir.join("trusttunnel_loader.ps1").to_string_lossy(),
        &run_dir.to_string_lossy(),
    );

    {
        let mut bat_file = std::fs::File::create(&bat_path)
            .map_err(|e| format!("Cannot create updater script: {e}"))?;
        bat_file
            .write_all(bat_content.as_bytes())
            .map_err(|e| format!("Cannot write updater script: {e}"))?;
    }

    // Launch bat hidden via VBS wrapper
    let vbs_content = format!(
        "CreateObject(\"Wscript.Shell\").Run \"{}\", 0, False",
        bat_path
            .to_string_lossy()
            .replace('\\', "\\\\")
            .replace('"', "\"\"")
    );
    std::fs::write(&vbs_path, &vbs_content)
        .map_err(|e| format!("Cannot create VBS launcher: {e}"))?;

    // T-20: gate on WinVerifyTrust here once the binary is signed.
    // The checksum gate above proves INTEGRITY (the bytes match the published
    // hash) but NOT AUTHENTICITY — a compromised release could supply a matching
    // checksum for a malicious .exe. Verifying the installer's Authenticode
    // signature with WinVerifyTrust before this spawn is the authenticity check;
    // it requires a code-signing cert + signing pipeline (BACKLOG T-20).
    std::process::Command::new("wscript.exe")
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
    std::process::Command::new("powershell")
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

    // be-1 regression: the updater .bat must NOT try to remove its own run_dir
    // with a non-recursive `rmdir "{run_dir}"` while the still-running .bat (and
    // any open loader.ps1) sits inside it — a non-empty dir makes that rmdir fail
    // and orphans an empty tt_update_<uuid> dir in %TEMP% after every update.
    // The dir must instead be reclaimed by a DETACHED, delayed, RECURSIVE removal
    // that outlives the .bat's own self-delete.
    #[test]
    fn updater_bat_schedules_detached_recursive_cleanup() {
        let run_dir = r"C:\Temp\tt_update_abc123";
        let bat = build_updater_bat(
            4242,
            &format!(r"{run_dir}\trusttunnel_setup.exe"),
            r"C:\Program Files\TrustTunnel\app.exe",
            &format!(r"{run_dir}\trusttunnel_updater.vbs"),
            &format!(r"{run_dir}\trusttunnel_loader.ps1"),
            run_dir,
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
        // ...by a DETACHED process (start "" /b cmd /c ...) so it survives the
        // .bat's own (goto)/del self-delete on the final line.
        assert!(
            bat.contains("start \"\" /b cmd /c"),
            "recursive cleanup must run in a detached cmd that outlives the .bat:\n{bat}"
        );
        // ...after a short delay so the .bat + loader release their handles.
        assert!(
            bat.contains("timeout /t 5 /nobreak >nul & rmdir /S /Q"),
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
        // function body ends at next `pub async fn`, `pub fn`, или конце модуля.
        let body_until_next = after_sig
            .split("\npub async fn ")
            .next()
            .unwrap_or("")
            .split("\npub fn ")
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
