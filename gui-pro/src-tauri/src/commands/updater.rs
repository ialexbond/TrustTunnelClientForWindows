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

// ─── Phase 30: app-update failure classification (REQ ABOUT-01) ────────────
//
// PLACEMENT IS LOAD-BEARING. Everything below lives BEFORE the update command
// on purpose: the D-29 invariant test slices that command's body with
// `function_body`, which cuts at the next `\nfn ` / `\npub fn ` /
// `\npub async fn `. A helper written AFTER the command would silently shrink
// the window that test inspects and turn a real regression into a green run.

/// Stable, secret-free ASCII reason code — the app-update probe never reached
/// the network: name resolution failed, or the machine has no route out at all.
///
/// The frontend (`useUpdateChecker` → `UpdateCard`) is what localizes this; the
/// backend never ships user-facing prose. Spelling is deliberately identical to
/// `lifecycle::NO_INTERNET_REASON` — the same real-world condition should not
/// have two names across two subsystems.
///
/// D-09/D-29: a FIXED ASCII token. It carries no host, no URL, no path, no HTTP
/// status and no exception text, so nothing GitHub or the network stack prints
/// can leak into the UI or the log channel through this value.
pub const UPDATE_NO_INTERNET_REASON: &str = "no-internet";

/// Stable, secret-free ASCII reason code — the machine has network, but the
/// update server did not produce a usable answer: it did not respond in time,
/// answered with a non-success status, or answered with something we could not
/// parse or trust.
///
/// Localized by the frontend, same as the sibling above. This is also the
/// DEFAULT verdict for every ambiguous case: its user-facing copy («С
/// приложением всё в порядке — попробуйте позже») stays true no matter which of
/// the ambiguous causes actually happened, whereas telling a connected user
/// that they have no internet is a claim we would be getting wrong.
///
/// D-09/D-29: a FIXED ASCII token — no host, path, status code or exit code.
pub const UPDATE_SERVER_UNREACHABLE_REASON: &str = "server-unreachable";

/// Pure decision helper for the two update-check failure causes.
///
/// Takes OBSERVED FACTS rather than a `reqwest::Error`, because a
/// `reqwest::Error` cannot be constructed in a unit test — the same reason
/// `lifecycle.rs` keeps its decision helpers free of IO. `classify_reqwest_failure`
/// below is the thin adapter that reads those facts off a real error.
///
/// The model, in words:
/// - `is_timeout` DOMINATES. A timeout means packets went out and nothing came
///   back in time, which is exactly the "resolved address that did not answer"
///   case — the server's problem, not the network's. reqwest reports a connect
///   PHASE timeout as both `is_connect()` and `is_timeout()`, so this is also
///   what makes the connect+timeout combination land on server-unreachable.
/// - Absent a timeout, `no-internet` requires POSITIVE EVIDENCE that the machine
///   itself has no path out: the source chain naming a name-resolution failure or
///   an unreachable/down network. That evidence is what the user can act on.
/// - Everything else — decode failures, non-success statuses, protocol errors,
///   and a bare connect failure with nothing in the chain to explain it — is
///   server-unreachable.
///
/// Ambiguity therefore always resolves to `UPDATE_SERVER_UNREACHABLE_REASON`.
///
/// WHAT THIS USED TO BE, AND WHY IT CHANGED. The first implementation read
/// `!is_timeout && (is_connect || source_names_dns)`, treating a bare
/// `reqwest::Error::is_connect()` as sufficient evidence of "no internet". It is
/// not: `is_connect()` is true for EVERY error raised while establishing the
/// connection, which includes TCP `connection refused`, `connection reset`, TLS
/// handshake failure and proxy errors — all of which happen after the address
/// resolved and the packet left the machine. A user on working internet whose
/// network resets the TLS handshake to `api.github.com` was told «нет интернета»
/// and asked to check a connection that was fine. That is the app stating
/// something it did not verify, which is the exact class of defect this phase
/// exists to remove; `30-RESEARCH.md` §3 had already written the rule down
/// («ambiguity resolves to server-unreachable, never to no-internet»).
/// `is_connect` is therefore no longer an input at all: keeping a fact that
/// carries no decision weight in the signature is an invitation to wire it back
/// into the verdict.
pub fn classify_update_failure(is_timeout: bool, source_names_no_network: bool) -> &'static str {
    if !is_timeout && source_names_no_network {
        UPDATE_NO_INTERNET_REASON
    } else {
        UPDATE_SERVER_UNREACHABLE_REASON
    }
}

/// Does this error's source chain name a machine-has-no-network problem?
///
/// Walks `std::error::Error::source()` rather than matching on a type, because
/// the resolver error is buried several layers down (reqwest → hyper → hyper-util
/// → the resolver) and those layers are not part of reqwest's public API. Matching
/// the rendered text is blunt, but the alternative is depending on private types.
///
/// D-29: only the CLASSIFICATION escapes this function. The message it inspects
/// never leaves it, so a resolver that echoes the hostname cannot leak it.
fn error_chain_names_no_network(e: &dyn std::error::Error) -> bool {
    // Markers as printed by the Windows and POSIX resolvers and socket layers,
    // plus hyper's own wrapper text. Lowercased before matching so casing drift
    // does not matter.
    //
    // TWO GROUPS, BOTH POSITIVE EVIDENCE. Name resolution failing and having no
    // route out are the two ways the machine itself is the reason nothing left
    // it; `30-RESEARCH.md` §3 lists both under `no-internet`. The "no route" group
    // is what keeps the honest, actionable «нет интернета» verdict for the
    // Wi-Fi-off / cable-out case now that a bare `is_connect()` no longer counts.
    //
    // THE BARE THREE-LETTER TOKEN "dns" IS DELIBERATELY ABSENT. Matched with
    // `contains`, it fired on any rendered text that happened to hold that
    // sequence — a hostname like `cdns.example`, a proxy naming `dnsmasq`, a
    // Windows message mentioning a DNS *server* while failing for some other
    // reason — and flipped the verdict to `no-internet`. Every phrase below is
    // specific enough to mean what it says.
    const NO_NETWORK_MARKERS: [&str; 10] = [
        // — name resolution
        "name resolution",
        "failed to lookup address",
        "getaddrinfo",
        "no such host",
        "nodename nor servname",
        "os error 11001", // WSAHOST_NOT_FOUND
        // — no route out of the machine at all
        "network is unreachable",
        "network is down",
        "no route to host",
        "os error 10051", // WSAENETUNREACH
    ];

    let mut current: Option<&dyn std::error::Error> = Some(e);
    while let Some(err) = current {
        let rendered = err.to_string().to_lowercase();
        if NO_NETWORK_MARKERS.iter().any(|m| rendered.contains(m)) {
            return true;
        }
        current = err.source();
    }
    false
}

/// Adapter: read the observable facts off a real `reqwest::Error` and delegate.
///
/// Returns `String` because that is what a Tauri command's `Err` variant is; the
/// value is always one of the two consts above, never a rendered error.
fn classify_reqwest_failure(e: reqwest::Error) -> String {
    classify_update_failure(e.is_timeout(), error_chain_names_no_network(&e)).to_string()
}

/// How long the update check waits for the TCP+TLS connection to be established.
///
/// Separate from the total budget below because the two failures are different
/// events: a connect that never completes is a machine/route problem, a request
/// that connects and then stalls is the server's. reqwest reports a connect-PHASE
/// timeout as both `is_connect()` and `is_timeout()`, which `classify_update_failure`
/// already accounts for.
const UPDATE_CHECK_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// The total budget for one update-check request, connect included.
///
/// WHY THIS EXISTS (phase-30 security follow-up, finding S3). `check_app_update_info`
/// used a bare `reqwest::Client::new()`, which sets NO timeout of any kind — only the
/// OS connect timeout applies, and that one does not fire at all once the peer has
/// accepted the connection. A server that accepts and then never answers left the
/// `invoke` promise unresolved for the rest of the session, and the card sat on
/// «Проверяем обновления…» with no way out: exactly the stuck-card outcome the
/// panic fix in `extract_sha256_from_body` removed, reached by a different route.
/// Worse, `classify_update_failure` takes `is_timeout` as a first-class input, so
/// that whole branch — and the truth table testing it — described a path production
/// could not take. A configured timeout is what makes the branch real.
///
/// 30s is chosen against what the request IS: one small JSON document from
/// api.github.com on a 24h background timer. Nothing here streams, so there is no
/// legitimate slow-but-progressing case to protect. `self_update`'s DOWNLOAD client
/// is deliberately NOT given this budget — a multi-megabyte installer on a slow link
/// would be aborted mid-transfer, which is a regression, not a hardening.
const UPDATE_CHECK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// The HTTP client the app-update check and its digest fetch share.
///
/// Takes its two budgets as arguments rather than reading the consts directly, so a
/// test can drive the same builder with millisecond budgets and prove the timeout is
/// real against a socket that accepts and never answers. A test that only asserted
/// «the const is 30s» would prove that a number exists, not that it is wired in.
///
/// Returns the reason code rather than the builder error: `ClientBuilder::build`
/// fails on TLS-backend initialisation, which the user can do nothing about and
/// which must not put a rendered error on the wire (D-29).
fn build_update_check_client(
    connect_timeout: std::time::Duration,
    total_timeout: std::time::Duration,
) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(connect_timeout)
        .timeout(total_timeout)
        .build()
        .map_err(|_| UPDATE_SERVER_UNREACHABLE_REASON.to_string())
}

/// The largest body `resolve_release_sha256` will read from a `.sha256` asset.
///
/// A `sha256sum` line is «<64 hex>  <filename>» — about eighty bytes. 4 KiB is
/// two orders of magnitude of headroom for a BOM, CRLFs and a long filename, and
/// still nowhere near a size worth pulling into memory.
const MAX_DIGEST_BYTES: u64 = 4 * 1024;

/// Is the ANNOUNCED digest body too large to be a digest?
///
/// The check runs on a 24h background timer and reads whatever URL the release
/// payload names. `validate_download_url` already pins the HOST, but nothing
/// pinned the SIZE: a release publishing a multi-gigabyte file named `*.sha256`
/// — or a compromised release account — turned a routine background check into an
/// out-of-memory kill of the whole app.
///
/// This is the CHEAP arm only: it refuses a body whose declared length is already
/// absurd, before a single byte is read. It is not the whole guard, and it never
/// was — a chunked response declares no length at all, so `None` reaches here and
/// this function correctly says «nothing to refuse yet». The bound that does not
/// depend on the server's honesty is `read_capped_digest_text`.
fn digest_body_too_large(content_length: Option<u64>) -> bool {
    content_length.is_some_and(|n| n > MAX_DIGEST_BYTES)
}

/// Read a response body, giving up the moment it exceeds `cap` bytes.
///
/// WHY THIS EXISTS (phase-30 security follow-up, finding S4). The size guard added
/// earlier only ever consulted `Content-Length`, and the code then called
/// `res.text()`, which reads to the end of the stream. Declaring a length is the
/// server's choice: a chunked response declares none, `digest_body_too_large`
/// returned false for it, and an unbounded read followed. So the cap protected
/// against a hostile release that announces its payload and not against one that
/// does not — which is the wrong way round, since announcing it is the honest
/// behaviour. A guard that a hostile party opts into is not a guard.
///
/// Streaming chunk by chunk with a running total is what makes the bound
/// independent of the declaration. `None` on overrun rather than a truncated
/// string: a partial read of a digest file is not a digest, and returning the
/// first 4 KiB would hand `is_hex_sha256` something that could coincidentally
/// pass. The caller treats `None` exactly as it treats a malformed body — fall
/// through to the release-body scan — so an oversized asset degrades to «this
/// release published no usable digest» instead of killing the app.
///
/// D-29: the body is inspected here and never rendered anywhere.
async fn read_capped_digest_text(mut res: reqwest::Response, cap: usize) -> Option<String> {
    let mut buf: Vec<u8> = Vec::new();
    loop {
        match res.chunk().await {
            Ok(Some(chunk)) => {
                // Checked BEFORE extending, so the high-water mark is one chunk
                // over the cap rather than the whole remaining body.
                if buf.len() + chunk.len() > cap {
                    return None;
                }
                buf.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            // A truncated or broken stream is not a digest either.
            Err(_) => return None,
        }
    }
    String::from_utf8(buf).ok()
}

/// Is this release asset THIS edition's Windows installer?
///
/// One definition for both readers — the installer lookup in `check_app_update_info` and the
/// digest fallback in `resolve_release_sha256`. They used to spell the rule separately, and the
/// copy in the fallback was simply missing, which is how a Light digest could be paired with a Pro
/// installer. The repository ships two editions from one release, so "any installer-shaped asset"
/// is never the right answer here.
fn is_pro_installer_asset_name(name: &str) -> bool {
    name.contains("Pro") && name.contains("setup") && name.ends_with(".exe")
}

/// Resolve the expected installer digest for a release, or "" when it has none.
///
/// Ported from `useUpdateChecker.ts` when the check moved into Rust. Every step is
/// best-effort by design: the previous behaviour was that a missing or unreachable
/// checksum left `expectedSha256` empty rather than failing the whole check, and a
/// stricter rule here would turn "release without a digest" into "no update check
/// at all". `self_update` is what decides whether an empty expectation is
/// acceptable — that decision is not this function's to make.
async fn resolve_release_sha256(
    client: &reqwest::Client,
    assets: &[serde_json::Value],
    installer_asset_name: Option<&str>,
    release_notes: &str,
) -> String {
    let digest_asset_url = installer_asset_name
        .and_then(|installer| {
            let expected = format!("{installer}.sha256");
            assets.iter().find_map(|a| {
                if a.get("name").and_then(|v| v.as_str()) == Some(expected.as_str()) {
                    a.get("browser_download_url").and_then(|v| v.as_str())
                } else {
                    None
                }
            })
        })
        .or_else(|| {
            assets.iter().find_map(|a| {
                let name = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
                // THE EDITION FILTER BELONGS HERE TOO. The front-end fallback this replaced kept
                // it (`…endsWith(".sha256") && ASSET_PATTERN.test(name.replace(".sha256",""))`);
                // the port dropped it and took the first `.sha256` asset in the release, whatever
                // it belonged to. This repository publishes Pro and Light from the same release,
                // so a Light digest listed first was handed to `self_update` as the expectation
                // for a Pro installer — and `verify_checksum` then reports
                // UPDATE_CHECKSUM_MISMATCH, i.e. a tamper-style failure for a perfectly good
                // download. A digest belonging to the OTHER edition is strictly worse than none.
                let base = name.strip_suffix(".sha256")?;
                if is_pro_installer_asset_name(base) {
                    a.get("browser_download_url").and_then(|v| v.as_str())
                } else {
                    None
                }
            })
        });

    if let Some(url) = digest_asset_url {
        // V9 whitelist applies to the digest asset too: it is fetched from the
        // same untrusted release payload as the installer URL.
        if validate_download_url(url).is_ok() {
            if let Ok(res) = client
                .get(url)
                .header("User-Agent", "TrustTunnel-UpdateChecker")
                .send()
                .await
            {
                // TWO ARMS, AND THE SECOND IS THE LOAD-BEARING ONE. The declared
                // length is refused first because it costs nothing; the streaming
                // cap is what holds when the server declares nothing at all.
                if res.status().is_success() && !digest_body_too_large(res.content_length()) {
                    if let Some(text) = read_capped_digest_text(res, MAX_DIGEST_BYTES as usize).await
                    {
                        // `sha256sum` output is "<digest>  <filename>" — take the digest.
                        let candidate = text.split_whitespace().next().unwrap_or("").to_string();
                        if is_hex_sha256(&candidate) {
                            return candidate;
                        }
                    }
                }
            }
        }
    }

    // Fallback: a "SHA256: <64 hex>" line in the release body.
    extract_sha256_from_body(release_notes)
}

/// Is this exactly 64 hex characters — the shape of a SHA-256 digest?
fn is_hex_sha256(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// Pull a `SHA256: <64 hex>` digest out of a release body, or "" when absent.
///
/// Scans EVERY `sha256` marker in the body and returns the first that is followed by a well-formed
/// 64-character run, so a prose mention of the word before the real digest line cannot hide it.
///
/// Hand-rolled rather than regex: `regex` is not a dependency of this crate and a
/// checksum-shaped scan is not worth adding one for.
fn extract_sha256_from_body(body: &str) -> String {
    // INDEX AND SLICE THE SAME STRING. This used to search `lower` and then slice `body` with the
    // offset it found. `str::to_lowercase` is not length-preserving in UTF-8 — 'İ' (U+0130) grows
    // 2 bytes to 3, 'ẞ' shrinks 3 to 2, the Kelvin sign (U+212A) shrinks 3 to 1 — so one such
    // character anywhere before the marker shifted every later index. Best case the hex run came
    // out truncated and the digest was silently lost (`self_update` then rejects the whole update
    // as UPDATE_CHECKSUM_MISSING); worst case the offset landed on a continuation byte and the
    // slice PANICKED inside the async command, leaving the `invoke` promise unresolved and the
    // card stuck on «Проверяем обновления…» for the rest of the session.
    // Scanning the lowercased copy is safe: a digest is ASCII hex, and `verify_checksum` compares
    // case-insensitively anyway.
    let lower = body.to_lowercase();

    // EVERY OCCURRENCE, NOT JUST THE FIRST. The code this replaced took `lower.find("sha256")`,
    // read the one hex run after it and gave up if that run was not 64 characters — a regression
    // against the front-end regex it was ported from, which scanned the whole body. A Russian
    // release body that says «Проверьте контрольную сумму SHA256 перед установкой» before the
    // real `SHA256: …` line stopped at the prose mention and returned "", which silently killed
    // the in-app update for that release. Walking on until a run is well formed restores the old
    // behaviour and cannot loop: `from` advances past the marker every iteration.
    let mut from = 0usize;
    while let Some(rel) = lower[from..].find("sha256") {
        let at = from + rel + "sha256".len();
        let digest: String = lower[at..]
            .chars()
            .skip_while(|c| !c.is_ascii_hexdigit())
            .take_while(|c| c.is_ascii_hexdigit())
            .collect();
        if is_hex_sha256(&digest) {
            return digest;
        }
        from = at;
    }
    String::new()
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
    /// Expected SHA-256 of the installer, or "" when the release publishes none.
    ///
    /// Phase 30: this moved here from the webview. The frontend used to fetch the
    /// `.sha256` asset itself and hand the digest to `self_update` as
    /// `expectedSha256`. Once the CHECK moved into Rust, leaving the CHECKSUM on a
    /// webview request would have quietly emptied that argument — the tamper
    /// control would have disappeared as a side effect of a refactor rather than
    /// by anyone's decision. Empty is not an error: it means the release has no
    /// published digest, exactly as before.
    pub sha256: String,
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
/// Errors (Phase 30 — the two localizable causes, see the consts above):
/// `UPDATE_NO_INTERNET_REASON` when the probe never left the machine, and
/// `UPDATE_SERVER_UNREACHABLE_REASON` for every other failure. The single
/// collapsed token this used to return is gone: the frontend could not tell
/// «нет интернета» from «сервер не ответил» through it, so the card silently
/// claimed the installed version was current after a failed check. The sidecar
/// commands in this file still use the old collapsed token — that is the OTHER
/// update track, with its own surfaces, and it is out of this change's scope.
#[tauri::command]
pub async fn check_app_update_info(
    app: tauri::AppHandle,
) -> Result<AppUpdateInfo, String> {
    let current_version = app.package_info().version.to_string();

    // Built, never defaulted — see `UPDATE_CHECK_TIMEOUT` for why the default
    // constructor is banned here. The same client is handed to
    // `resolve_release_sha256`, so the digest fetch inherits both budgets.
    //
    // The banned constructor is NOT spelled out in this comment on purpose: the
    // guard below counts occurrences inside this function, and a comment naming
    // the thing it forbids would report a violation of the rule it documents.
    // Same shape as the hygiene gate's comment stripper (`about-hygiene.sh`).
    let client = build_update_check_client(UPDATE_CHECK_CONNECT_TIMEOUT, UPDATE_CHECK_TIMEOUT)?;
    let res = client
        .get("https://api.github.com/repos/ialexbond/TrustTunnelClientForWindows/releases/latest")
        .header("User-Agent", "TrustTunnel-UpdateChecker")
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await
        .map_err(classify_reqwest_failure)?;

    // Everything from here on has already proved the network works — the answer
    // itself is what is unusable, so every branch below is server-unreachable.
    if !res.status().is_success() {
        return Err(UPDATE_SERVER_UNREACHABLE_REASON.into());
    }

    let data: serde_json::Value = res
        .json()
        .await
        .map_err(|_| UPDATE_SERVER_UNREACHABLE_REASON.to_string())?;

    let latest_tag = data
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if latest_tag.is_empty() {
        return Err(UPDATE_SERVER_UNREACHABLE_REASON.into());
    }

    ssh::sanitize::validate_version(&latest_tag)
        .map_err(|_| UPDATE_SERVER_UNREACHABLE_REASON.to_string())?;

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
    let installer_asset_name = assets
        .iter()
        .find_map(|a| {
            let name = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if is_pro_installer_asset_name(name) {
                Some(name.to_string())
            } else {
                None
            }
        });
    let download_url = installer_asset_name
        .as_ref()
        .and_then(|name| {
            assets.iter().find_map(|a| {
                if a.get("name").and_then(|v| v.as_str()) == Some(name.as_str()) {
                    a.get("browser_download_url")
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                } else {
                    None
                }
            })
        })
        .unwrap_or(html_url);

    if !download_url.is_empty() {
        validate_download_url(&download_url)
            .map_err(|_| UPDATE_SERVER_UNREACHABLE_REASON.to_string())?;
    }

    // Installer integrity expectation — see the doc comment on `AppUpdateInfo::sha256`.
    // Same three-step resolution the frontend used to perform: the digest asset
    // that belongs to THIS installer, else any published digest asset, else a
    // 64-hex string in the release body. A missing digest is not an error.
    let sha256 = resolve_release_sha256(&client, &assets, installer_asset_name.as_deref(), &release_notes).await;

    let available = compare_semver(&current_version, &latest_version) < 0;

    Ok(AppUpdateInfo {
        current_version,
        latest_version,
        latest_tag,
        available,
        download_url,
        release_notes,
        sha256,
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

// ─── Phase 30: update-failure classification (ABOUT-01) ────────────────────
//
// The FULL input space, one #[test] per row plus one test over the whole table:
// two booleans is four rows, and enumerating all four proves the "ambiguity
// resolves to server-unreachable" rule instead of sampling it. Every assertion
// names a const rather than a quoted string — the same discipline
// `sidecar_version_tests` follows — so renaming a token becomes a compile error
// here rather than a silent divergence from the front end's lookup table.
//
// THESE TESTS USED TO LOCK IN THE WRONG RULE. The first version asserted the
// implemented eight-row table, in which a bare `is_connect()` meant no-internet.
// That contradicted `30-RESEARCH.md` §3, and because the tests were written from
// the implementation rather than from the rule, they could not catch it: they
// were green over a card telling connected users they had no internet.
#[cfg(test)]
mod update_failure_classification_tests {
    use super::*;

    #[test]
    fn a_named_resolution_failure_is_no_internet() {
        // The resolver could not turn the hostname into an address: no DNS server
        // answered, or the machine has no working resolver at all. This is POSITIVE
        // evidence that nothing left the box, and the only kind that earns the
        // «нет интернета» verdict.
        assert_eq!(
            classify_update_failure(false, true),
            UPDATE_NO_INTERNET_REASON
        );
    }

    #[test]
    fn a_connect_failure_with_nothing_in_the_chain_is_server_unreachable() {
        // REGRESSION. This used to be no-internet, on the reading that
        // `reqwest::Error::is_connect()` means the request never got out of the
        // machine. It does not: `is_connect()` covers TCP refused, TCP reset, TLS
        // handshake failure and proxy errors, all of which happen AFTER the address
        // resolved and the packet left. Telling a connected user «нет интернета» is
        // a claim the app cannot support, so an unexplained connect failure takes
        // the honest default instead — its copy («С приложением всё в порядке —
        // попробуйте позже») stays true whichever of the ambiguous causes it was.
        assert_eq!(
            classify_update_failure(false, false),
            UPDATE_SERVER_UNREACHABLE_REASON
        );
    }

    #[test]
    fn a_timeout_outranks_a_no_network_marker() {
        // A CONNECT-PHASE timeout: reqwest reports is_connect() and is_timeout()
        // together. The address resolved and the handshake was attempted — the far
        // end simply never answered, which is the server's problem, not the
        // network's. A stale marker further down the chain is noise here.
        assert_eq!(
            classify_update_failure(true, true),
            UPDATE_SERVER_UNREACHABLE_REASON
        );
    }

    #[test]
    fn a_plain_timeout_is_server_unreachable() {
        // The update server accepted the connection and then went quiet, or a
        // filtered port swallowed the handshake.
        assert_eq!(
            classify_update_failure(true, false),
            UPDATE_SERVER_UNREACHABLE_REASON
        );
    }

    #[test]
    fn only_a_named_cause_can_reach_the_no_internet_verdict() {
        // The rule stated as a whole, over the FULL input space: two booleans is
        // four rows, and exactly one of them may say «нет интернета». Enumerating
        // them here proves «ambiguity resolves to server-unreachable» rather than
        // sampling it — and it is the assertion that fails if anyone widens the
        // no-internet arm again.
        let no_internet_rows = [(false, true), (false, false), (true, true), (true, false)]
            .into_iter()
            .filter(|(is_timeout, names_no_network)| {
                classify_update_failure(*is_timeout, *names_no_network) == UPDATE_NO_INTERNET_REASON
            })
            .count();
        assert_eq!(no_internet_rows, 1);
    }
}

// ─── The timeout that makes the `is_timeout` branch reachable (S3) ─────────
//
// The truth table above is exhaustive over `classify_update_failure`'s inputs,
// and two of its four rows describe a timeout — but until this change the update
// check ran on a bare `reqwest::Client::new()`, which configures no timeout at
// all. Those two rows therefore tested a path production could not take, and the
// real behaviour was the opposite of what the table implied: a server that
// accepted the connection and never answered hung the `invoke` promise for the
// session and pinned the card on «Проверяем обновления…».
//
// WHY THIS IS A SOCKET TEST AND NOT A GREP. Asserting «the source contains
// `.timeout(`» proves a string exists; asserting «UPDATE_CHECK_TIMEOUT == 30s»
// proves a number exists. Neither proves the budget is WIRED INTO the client the
// command uses. So the test drives the production builder — the same function
// `check_app_update_info` calls — against a listener that accepts the connection
// and then deliberately says nothing, which is precisely the failure the OS
// connect timeout cannot catch.
#[cfg(test)]
mod update_check_timeout_tests {
    use super::*;
    use std::time::Duration;

    /// A socket that completes the TCP handshake and then never writes a byte.
    ///
    /// Returns the bound address. The accept loop holds each connection open in a
    /// detached task rather than dropping it: dropping the `TcpStream` would send
    /// FIN and the client would fail immediately with a connection error, which is
    /// a DIFFERENT failure from the one under test and would let a client with no
    /// timeout pass.
    async fn silent_listener() -> std::net::SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((stream, _)) = listener.accept().await {
                held.push(stream);
            }
        });
        addr
    }

    /// Send one request at millisecond budgets and return the error it must produce.
    ///
    /// THE OUTER BOUND IS NOT BELT-AND-BRACES, IT IS THE FAILURE MODE. Without it,
    /// a client built with no total budget — the very regression these tests exist
    /// to catch — would not fail the test, it would HANG it, and a hanging test in
    /// CI reads as an infrastructure problem rather than as the defect it is.
    /// Five seconds against a 300 ms budget is a sixteen-fold margin, so a slow
    /// machine cannot trip it while a missing budget always does.
    ///
    /// Millisecond budgets keep the run under a second. The production consts are
    /// asserted separately; what these prove is that the BUILDER wires whatever
    /// budget it is given into the client the command uses.
    async fn error_from_a_silent_server() -> reqwest::Error {
        let addr = silent_listener().await;
        let client =
            build_update_check_client(Duration::from_millis(500), Duration::from_millis(300))
                .expect("the update-check client must build");

        let outcome = tokio::time::timeout(
            Duration::from_secs(5),
            client
                .get(format!("http://{addr}/repos/x/y/releases/latest"))
                .send(),
        )
        .await
        .expect(
            "the request never came back — the client was built without a total timeout, \
             which is exactly the unbounded wait that pinned the card on «Проверяем обновления…»",
        );

        outcome.expect_err("a silent server must not resolve — that is the whole point")
    }

    #[tokio::test]
    async fn a_server_that_accepts_and_never_answers_times_out() {
        let err = error_from_a_silent_server().await;
        assert!(
            err.is_timeout(),
            "the request must fail as a TIMEOUT, not as some other error: {err}"
        );
    }

    #[tokio::test]
    async fn a_timed_out_check_is_reported_as_server_unreachable() {
        // The other half of the fix: the branch is now reachable AND it lands on
        // the verdict `30-RESEARCH.md` §3 mandates for it. «С приложением всё в
        // порядке — попробуйте позже» is true of a server that went quiet;
        // «нет интернета» would be the app stating something it did not verify.
        let err = error_from_a_silent_server().await;
        assert_eq!(
            classify_reqwest_failure(err),
            UPDATE_SERVER_UNREACHABLE_REASON
        );
    }

    #[test]
    fn the_production_budgets_are_finite_and_sane() {
        // A budget of zero would be a client that can never succeed; an hour-long
        // one would be indistinguishable from the unbounded wait this replaced.
        // The check is one small JSON document on a 24h background timer, so the
        // upper bound is generous by an order of magnitude and still bounded.
        assert!(UPDATE_CHECK_CONNECT_TIMEOUT > Duration::ZERO);
        assert!(UPDATE_CHECK_TIMEOUT > UPDATE_CHECK_CONNECT_TIMEOUT);
        assert!(UPDATE_CHECK_TIMEOUT <= Duration::from_secs(60));
    }

    #[test]
    fn the_update_check_does_not_build_an_untimed_client() {
        // Belt to the socket test's braces, and the arm that survives a refactor:
        // the socket test proves the BUILDER works, this proves the COMMAND uses
        // it. Someone reintroducing `reqwest::Client::new()` inside
        // `check_app_update_info` would leave both socket tests green.
        let source = include_str!("./updater.rs");
        let body = source
            .split("pub async fn check_app_update_info")
            .nth(1)
            .and_then(|s| s.split("\n// ─── Phase 19").next())
            .unwrap_or("");
        assert!(
            !body.is_empty(),
            "check_app_update_info not found — this guard has lost its subject"
        );
        assert!(
            !body.contains("reqwest::Client::new()"),
            "check_app_update_info must build its client through build_update_check_client — \
             `Client::new()` configures no timeout and reopens the stuck-card defect"
        );
        assert!(
            body.contains("build_update_check_client("),
            "check_app_update_info must obtain its client from build_update_check_client"
        );
    }
}

// ─── The digest read is bounded even when nothing is declared (S4) ────────
//
// `digest_body_too_large` is a pure function over `Option<u64>` and its unit
// tests were always green — but they measured the ANNOUNCEMENT, and a hostile
// release simply does not have to make one. These tests exercise the read
// itself, over a real socket, against a server that declares no length and then
// never stops sending: the exact case the declared-length cap lets through.
#[cfg(test)]
mod digest_read_cap_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// How many 1 KiB filler chunks the oversized fixture sends: 64 KiB, sixteen
    /// times `MAX_DIGEST_BYTES`.
    ///
    /// WHY A FINITE NUMBER AND NOT AN ENDLESS STREAM. The first version of this
    /// fixture wrote forever, on the reasoning that «unbounded» is the property
    /// under test. It hung the test binary: the client stops reading at the cap
    /// and drops the response, but the writer task and the pooled connection are
    /// still on the test's runtime, and the runtime cannot be torn down under
    /// them. A test that hangs reports as CI infrastructure trouble, not as a
    /// defect — the exact failure mode the timeout work in this same file just
    /// removed from production.
    ///
    /// A finite body loses nothing, because the property is not «the server never
    /// stops», it is «the reader stops at the cap». A reader without the cap
    /// returns a 64 KiB string here and the `is_none()` assertion fails; a reader
    /// with it returns `None`. The mutation check below confirms exactly that.
    const OVERSIZED_CHUNKS: usize = 64;

    /// An HTTP/1.1 server that answers with `Transfer-Encoding: chunked`, sends
    /// `body`, and then optionally sends `OVERSIZED_CHUNKS` filler chunks.
    ///
    /// Chunked on purpose: it is the standard way to answer WITHOUT a
    /// `Content-Length`, so `res.content_length()` is `None` and the cheap arm of
    /// the guard cannot fire. Whatever these tests prove, they prove about the
    /// streaming arm alone.
    async fn chunked_server(body: &'static str, keep_sending: bool) -> std::net::SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                tokio::spawn(async move {
                    // DRAIN THE REQUEST FIRST, even though its contents are irrelevant
                    // to what is measured. Skipping this made the test flaky under the
                    // full parallel suite (~1 run in 3): closing a socket that still has
                    // unread received data makes Windows send RST instead of FIN, and the
                    // RST discards the response the client had not finished reading. The
                    // symptom was `send().await.unwrap()` panicking on a connection
                    // reset — a fixture defect that looks exactly like a product defect,
                    // which is the worst kind of flake to leave in a security test.
                    let mut request = Vec::new();
                    let mut byte = [0u8; 1];
                    while !request.ends_with(b"\r\n\r\n") {
                        match stream.read(&mut byte).await {
                            Ok(0) | Err(_) => return,
                            Ok(_) => request.push(byte[0]),
                        }
                    }
                    let head = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n";
                    if stream.write_all(head.as_bytes()).await.is_err() {
                        return;
                    }
                    let first = format!("{:x}\r\n{}\r\n", body.len(), body);
                    if stream.write_all(first.as_bytes()).await.is_err() {
                        return;
                    }
                    if keep_sending {
                        // 1 KiB per chunk, `OVERSIZED_CHUNKS` of them.
                        let filler = "x".repeat(1024);
                        let chunk = format!("400\r\n{filler}\r\n");
                        for _ in 0..OVERSIZED_CHUNKS {
                            if stream.write_all(chunk.as_bytes()).await.is_err() {
                                return;
                            }
                        }
                    }
                    let _ = stream.write_all(b"0\r\n\r\n").await;
                });
            }
        });
        addr
    }

    async fn read_from(addr: std::net::SocketAddr) -> Option<String> {
        let client = reqwest::Client::new();
        let res = client.get(format!("http://{addr}/x.sha256")).send().await.unwrap();
        // The premise of the whole test: the server declared nothing, so the
        // declared-length arm has no opinion here.
        assert_eq!(
            res.content_length(),
            None,
            "the fixture must answer WITHOUT a Content-Length, or it is testing the other arm"
        );
        assert!(!digest_body_too_large(res.content_length()));
        read_capped_digest_text(res, MAX_DIGEST_BYTES as usize).await
    }

    #[tokio::test]
    async fn an_ordinary_undeclared_digest_body_still_reads() {
        // The guard must not defend by breaking the normal case: a real
        // `sha256sum` line is about eighty bytes and may perfectly well arrive
        // chunked.
        const LINE: &str =
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  Setup.exe\n";
        let addr = chunked_server(LINE, false).await;
        let text = read_from(addr).await.expect("a short body must read normally");
        assert_eq!(text, LINE);
        assert!(is_hex_sha256(text.split_whitespace().next().unwrap()));
    }

    #[tokio::test]
    async fn an_undeclared_oversized_body_is_refused_at_the_cap() {
        // 64 KiB arriving with no declared length: `digest_body_too_large` has
        // nothing to refuse (asserted inside `read_from`), so if this comes back
        // as a string, the only bound on the read was the server's goodwill.
        let addr = chunked_server("start", true).await;
        let outcome = tokio::time::timeout(std::time::Duration::from_secs(10), read_from(addr))
            .await
            .expect(
                "the read never returned — an undeclared body is being read without bound, \
                 which is the defect this cap exists to remove",
            );
        assert!(
            outcome.is_none(),
            "an oversized body must yield None, not a truncated string that could \
             coincidentally look like a digest"
        );
    }
}

// ─── Phase 30: installer digest resolution (T-30-03) ───────────────────────
//
// The digest lookup moved out of the webview and into Rust; without these, the
// only thing standing between a release body and `self_update`'s tamper control
// would be hand-reading. The network half (`resolve_release_sha256`) needs a
// live client and is covered by the end-of-phase manual check; the parsing half
// below is where a silent regression would actually hide.
#[cfg(test)]
mod update_sha256_tests {
    use super::*;

    const VALID: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    #[test]
    fn accepts_exactly_sixty_four_hex_characters() {
        assert!(is_hex_sha256(VALID));
        assert!(!is_hex_sha256(&VALID[..63])); // one short
        assert!(!is_hex_sha256(&format!("{VALID}a"))); // one long
        assert!(!is_hex_sha256("")); // the "no digest published" value
        assert!(!is_hex_sha256(&VALID.replace('e', "z"))); // not hex
    }

    #[test]
    fn extracts_a_digest_from_a_release_body() {
        let body = format!("## What's new\n\n- fixes\n\nSHA256: {VALID}\n");
        assert_eq!(extract_sha256_from_body(&body), VALID);
    }

    #[test]
    fn tolerates_case_and_punctuation_around_the_marker() {
        let body = format!("sha256 = {VALID}");
        assert_eq!(extract_sha256_from_body(&body), VALID);
    }

    #[test]
    fn a_digest_body_larger_than_a_digest_is_refused() {
        // The real thing is ~80 bytes; the cap is 4 KiB. Unknown length is still
        // accepted (chunked responses declare none), which is the deliberate limit
        // of this guard, not an oversight.
        assert!(!digest_body_too_large(Some(80)));
        assert!(!digest_body_too_large(Some(MAX_DIGEST_BYTES)));
        assert!(!digest_body_too_large(None));
        assert!(digest_body_too_large(Some(MAX_DIGEST_BYTES + 1)));
        assert!(digest_body_too_large(Some(4 * 1024 * 1024 * 1024)));
    }

    #[test]
    fn only_this_editions_installer_is_recognised() {
        // REGRESSION for the digest fallback: it used to accept the first `.sha256` asset in the
        // release regardless of which edition it belonged to. Both editions ship from one release,
        // so the Light digest paired with the Pro installer turned a good download into
        // UPDATE_CHECKSUM_MISMATCH — a tamper warning for a file nobody tampered with.
        assert!(is_pro_installer_asset_name(
            "TrustTunnel Client Pro_3.0.0_x64-setup.exe"
        ));
        assert!(!is_pro_installer_asset_name(
            "TrustTunnel Client Light_2.7.0_x64-setup.exe"
        ));
        // Not an installer at all, and the digest file's own name (the caller strips `.sha256`
        // before asking).
        assert!(!is_pro_installer_asset_name("trusttunnel-v1.0.49-linux-x86_64.tar.gz"));
        assert!(!is_pro_installer_asset_name(
            "TrustTunnel Client Pro_3.0.0_x64-setup.exe.sha256"
        ));
    }

    #[test]
    fn a_prose_mention_before_the_digest_line_does_not_hide_it() {
        // REGRESSION. The scan used to stop at the FIRST `sha256` in the body. This body — the
        // ordinary shape of a Russian release description for this project — mentions the word in
        // a sentence before the line that carries the value, and the old code returned "", which
        // `self_update` turns into UPDATE_CHECKSUM_MISSING and a dead in-app update.
        let body = format!(
            "Проверьте контрольную сумму SHA256 перед установкой.\n\nSHA256: {VALID}\n"
        );
        assert_eq!(extract_sha256_from_body(&body), VALID);

        // Two mentions where neither of the first two is well formed.
        let noisy = format!("sha256 sums:\nSHA256: deadbeef\nSHA256 = {VALID}");
        assert_eq!(extract_sha256_from_body(&noisy), VALID);
    }

    #[test]
    fn a_character_that_changes_length_when_lowercased_does_not_break_the_scan() {
        // REGRESSION. The scan searched the lowercased copy and sliced the ORIGINAL. 'İ' is two
        // bytes and lowercases to three, so the marker sat at byte 3 of `body` and byte 4 of
        // `lower`; slicing `body` at 10 landed inside the em dash and PANICKED. 'ẞ' shifts the
        // other way and silently truncated the hex run instead.
        // Written as escapes rather than as literals so the intent survives any editor or
        // encoding that would otherwise normalize them away.
        let grows = format!("\u{0130} SHA256\u{2014} {VALID}"); // 'İ' 2 bytes -> 3, then an em dash
        assert_eq!(extract_sha256_from_body(&grows), VALID);

        let shrinks = format!("\u{1E9E} SHA256: {VALID}"); // 'ẞ' 3 bytes -> 2
        assert_eq!(extract_sha256_from_body(&shrinks), VALID);

        let kelvin = format!("\u{212A} SHA256: {VALID}"); // KELVIN SIGN, 3 bytes -> 1
        assert_eq!(extract_sha256_from_body(&kelvin), VALID);
    }

    #[test]
    fn a_body_without_a_digest_yields_empty_not_garbage() {
        // "Missing digest" must come back as "", never as a truncated or
        // neighbouring hex run that `self_update` would then compare against.
        assert_eq!(extract_sha256_from_body("no checksum here"), "");
        assert_eq!(extract_sha256_from_body("SHA256: deadbeef"), "");
        assert_eq!(extract_sha256_from_body(""), "");
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
        // function body ends at next `pub async fn`, `pub fn`, `async fn`, `fn`, или конце модуля.
        //
        // `\nasync fn ` was missing here. A private `async fn` written after a command silently
        // joined that command's window — which sounds harmless, but the window is what the D-29
        // grep inspects, and a window that swallows an unrelated function is a window nobody can
        // reason about. It is also the mirror of the real hole this splitter had: see the helper
        // test below.
        let body_until_next = after_sig
            .split("\npub async fn ")
            .next()
            .unwrap_or("")
            .split("\npub fn ")
            .next()
            .unwrap_or("")
            .split("\nasync fn ")
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

    /// The command's CALL GRAPH, not just its lexical window.
    ///
    /// The placement banner above the phase-30 helpers argues — correctly — that writing them
    /// BEFORE `check_app_update_info` leaves that command's `function_body` window intact. What it
    /// does not say is that the window then contains none of them, and two of those helpers are
    /// precisely the material D-29 exists to keep out of the log channel:
    /// `resolve_release_sha256` handles a URL and an HTTP response body, and
    /// `error_chain_names_no_network` renders error strings that may carry the hostname. An
    /// `emit_log(...)` added inside either one is executed by the command and was invisible to the
    /// test that claims to protect it.
    ///
    /// WHY THE LIST GREW (phase-30 security follow-up, finding S5). The docstring said CALL GRAPH
    /// while the array named TWO of roughly a dozen helpers the command actually reaches, and the
    /// unnamed ones handle exactly the material the invariant is about: `extract_sha256_from_body`
    /// scans a third-party release body, `validate_download_url` handles the URL,
    /// `read_capped_digest_text` streams an untrusted response. The invariant HELD — the whole
    /// file emits nothing — so nothing was leaking; what was weaker than its own wording was the
    /// regression detection, and a guard whose green means less than a reader takes it for is
    /// worse than an honest narrow one. Widening the coverage rather than narrowing the wording is
    /// the choice that keeps D-29 (secrets and untrusted payloads never reach the log channel)
    /// actually enforced.
    ///
    /// SIGNATURES CARRY THEIR FIRST PARAMETER wherever a bare `fn name` also occurs earlier in the
    /// file — in a doc comment, a banner or another test. `function_body` takes the text after the
    /// FIRST match, so a needle that hits prose first would silently measure the wrong window and
    /// report a vacuous pass. The `!body.is_empty()` arm is what catches a needle that a rename
    /// has stopped matching altogether.
    #[test]
    fn app_update_check_helpers_do_not_call_activity_log_or_emit_log() {
        let source = include_str!("./updater.rs");
        for sig in [
            "async fn resolve_release_sha256",
            "fn error_chain_names_no_network",
            "async fn read_capped_digest_text",
            "fn extract_sha256_from_body(body: &str)",
            "fn validate_download_url(url: &str)",
            "fn build_update_check_client(",
            "fn digest_body_too_large(content_length",
            "fn is_pro_installer_asset_name(name: &str)",
            "fn is_hex_sha256(s: &str)",
            "fn compare_semver(a: &str, b: &str)",
            "fn classify_reqwest_failure(e: reqwest::Error)",
            "fn classify_update_failure(is_timeout: bool",
        ] {
            let body = function_body(source, sig);
            assert!(
                !body.is_empty(),
                "D-29: helper {sig} not found — the guard has lost its subject and cannot measure anything"
            );
            assert!(
                !body.contains("activity_log"),
                "D-29: {sig} must NOT call activity_log"
            );
            assert!(
                !body.contains("emit_log("),
                "D-29: {sig} must NOT call emit_log (use eprintln! for debug only)"
            );
        }
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
