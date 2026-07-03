// SSH command functions intentionally take many flat parameters because
// they mirror the frontend `invoke()` argument shape (host, port, user,
// password, key_path, key_data + per-command extras). Bundling them into
// a struct would force the React layer to construct it on every call site
// without functional benefit, so we silence `too_many_arguments` for the
// whole module.
#![allow(clippy::too_many_arguments)]

use crate::ssh;

// ─── Macro to eliminate SshParams boilerplate (direct connect) ─────

/// Generates a `#[tauri::command]` that constructs `SshParams` from the
/// standard (host, port, user, password, key_path) arguments and delegates
/// to an `ssh::` function.  Used for long-running / one-shot commands
/// (deploy, install, upgrade, uninstall) that should NOT reuse pooled connections.
macro_rules! ssh_command {
    ($name:ident, $method:path $(, $extra_param:ident : $extra_type:ty)*) => {
        #[tauri::command]
        pub async fn $name(
            app: tauri::AppHandle,
            host: String,
            port: u16,
            user: String,
            password: String,
            key_path: Option<String>,
            key_data: Option<String>,
            // D-06 (Codex #2): the wizard's explicit single auth choice. Threading it
            // through the macro is the load-bearing fix — without it the frontend can
            // never deliver auth_method to SshParams. `#[serde(default)]` on the struct
            // field keeps callers that omit it (non-wizard) working with None ⇒ legacy.
            auth_method: Option<String>,
            $($extra_param: $extra_type,)*
        ) -> Result<impl serde::Serialize, String> {
            let params = ssh::SshParams { host, port, ssh_user: user, ssh_password: password, key_path, key_data, auth_method };
            $method(&app, params $(, $extra_param)*).await
        }
    };
}

// ─── Macro for pooled SSH commands ────────────────────────────────

/// Like `ssh_command!` but uses the SshPool to reuse persistent connections.
/// Acquires a connection from the pool (creating one if needed) and passes
/// `&Handle` to the server function. Does NOT disconnect after — pool manages lifecycle.
macro_rules! ssh_pool_command {
    ($name:ident, $method:path $(, $extra_param:ident : $extra_type:ty)*) => {
        #[tauri::command]
        pub async fn $name(
            app: tauri::AppHandle,
            pool: tauri::State<'_, crate::ssh::SshPool>,
            host: String,
            port: u16,
            user: String,
            password: String,
            key_path: Option<String>,
            key_data: Option<String>,
            // D-06 (Codex #2): explicit single auth choice threaded through the pooled
            // macro too, so wizard-facing pooled commands deliver it to SshParams.
            auth_method: Option<String>,
            $($extra_param: $extra_type,)*
        ) -> Result<serde_json::Value, String> {
            let params = ssh::SshParams { host, port, ssh_user: user, ssh_password: password, key_path, key_data, auth_method };
            let handle = pool.acquire(&params, Some(app.clone())).await?;
            let result = $method(&app, &*handle $(, $extra_param)*).await?;
            serde_json::to_value(&result).map_err(|e| format!("Serialize error: {e}"))
        }
    };
}

// ─── Direct-connect commands (long-running / one-shot) ────────────

// overwrite_config (round-3 LOW C, finding C): the ONLY frontend overwrite
// surface. The 05-03 "apply my settings" recovery action calls
// invoke("deploy_server", { ..., overwriteConfig: true }); deploy_configure stays
// internal (never a Tauri command). Default false on a normal deploy.
// #22 (06-uat): deploy_server / fetch_server_config take a per-run `op_id` so the
// streamed deploy events can be stamped with the run that produced them and the frontend
// can drop a stale event from a cancelled run (see ssh/mod.rs CURRENT_DEPLOY_OP_ID).
ssh_command!(deploy_server, ssh::deploy_server, settings: ssh::EndpointSettings, overwrite_config: bool, op_id: u64);

/// Cancel the in-flight deploy (06-uat cancel→reinstall race). Bumps the active deploy
/// generation so every `exec_command_cancellable` in the running deploy_server aborts
/// (~250 ms) and the run unwinds — freeing the backend single-flight guard so the next
/// install is clean. The frontend then awaits `uninstall_server` for the server-side
/// kill + rollback. No SSH params: a pure local signal.
#[tauri::command]
pub fn cancel_deploy() {
    crate::ssh::CURRENT_DEPLOY_OP_ID.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
}

ssh_command!(diagnose_server, ssh::diagnose_server);
ssh_command!(check_server_installation, ssh::check_server_installation);
ssh_command!(uninstall_server, ssh::uninstall_server);
// country_code (Option<String>, Tauri maps JS `countryCode`): best-effort GeoIP code used
// only to brand the LOCAL config filename `[<CC>_]TrustTunnel_<login>.toml` so a re-export
// writes the SAME name the Save-As dialog defaults to. Optional → omitting it (legacy
// callers) yields None ⇒ unbranded-by-country, still a valid branded filename.
ssh_command!(fetch_server_config, ssh::fetch_server_config, client_name: String, op_id: u64, country_code: Option<String>);
ssh_command!(server_upgrade, ssh::server_upgrade, version: String);

// ─── Pooled server management commands ────────────────────────────

ssh_pool_command!(server_get_stats, ssh::server_get_stats);
ssh_pool_command!(server_get_uptime, ssh::server_get_uptime);
ssh_pool_command!(server_get_config, ssh::get_server_config);
ssh_pool_command!(server_get_cert_info, ssh::get_cert_info);
ssh_pool_command!(server_get_logs, ssh::server_get_logs);
ssh_pool_command!(server_renew_cert, ssh::renew_cert);
ssh_pool_command!(server_update_config_feature, ssh::update_config_feature, feature: String, enabled: bool);
ssh_pool_command!(server_export_config_deeplink, ssh::export_config_deeplink, client_name: String);
ssh_pool_command!(server_restart_service, ssh::server_restart_service);
ssh_pool_command!(server_stop_service, ssh::server_stop_service);
ssh_pool_command!(server_start_service, ssh::server_start_service);
ssh_pool_command!(server_reboot, ssh::server_reboot);
ssh_pool_command!(server_remove_user, ssh::server_remove_user, vpn_username: String);
ssh_pool_command!(add_server_user, ssh::add_server_user, vpn_username: String, vpn_password: String);

// ─── Phase 15: vpn.toml Quick Settings + Bundle reader (REQ-15.0, 15.2) ───
ssh_pool_command!(server_get_config_bundle, ssh::get_config_bundle);
// The per-field vpn.toml setter commands (server_update_listen_address /
// _log_level / _allow_private / _auth_status / _ping_path / _speedtest_path) were
// REMOVED — the Configuration tab now persists vpn.toml exclusively via the generic
// server_save_config_file command, so these had zero frontend invoke() callers.

// ─── Phase 15: Advanced raw TOML write (REQ-15.3) ─────────────────────────
ssh_pool_command!(server_write_vpn_toml_raw, ssh::write_vpn_toml_raw, content: String);

// ─── Phase 15: hosts.toml allowed_sni mutation (REQ-15.A) ─────────────────
ssh_pool_command!(
    server_update_hosts_allowed_sni,
    ssh::update_hosts_allowed_sni,
    hostname: String,
    allowed_sni: Vec<String>
);

// ─── Phase 15.1: schema-driven generic save (REQ-15.0, 15.7, 15.8) ────────
ssh_pool_command!(
    server_save_config_file,
    ssh::save_config_file,
    file_name: String,
    raw_content: String
);

// ─── Pooled security commands ─────────────────────────────────────

// security_get_status and security_install_firewall are manual because they
// need `port` (the SSH port) passed as an extra parameter to the server function,
// but `port` is already part of the standard SSH params (no extra frontend field needed).

#[tauri::command]
pub async fn security_get_status(
    app: tauri::AppHandle,
    pool: tauri::State<'_, crate::ssh::SshPool>,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
    key_data: Option<String>,
) -> Result<serde_json::Value, String> {
    let params = ssh::SshParams { host, port, ssh_user: user, ssh_password: password, key_path, key_data, auth_method: None };
    let handle = pool.acquire(&params, Some(app.clone())).await?;
    let result = ssh::get_security_status(&app, &handle, port).await?;
    serde_json::to_value(&result).map_err(|e| format!("Serialize error: {e}"))
}

#[tauri::command]
pub async fn security_install_firewall(
    app: tauri::AppHandle,
    pool: tauri::State<'_, crate::ssh::SshPool>,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
    key_data: Option<String>,
    keep_http_open: bool,
) -> Result<serde_json::Value, String> {
    let params = ssh::SshParams { host, port, ssh_user: user, ssh_password: password, key_path, key_data, auth_method: None };
    let handle = pool.acquire(&params, Some(app.clone())).await?;
    ssh::install_firewall(&app, &handle, port, keep_http_open).await?;
    Ok(serde_json::Value::Null)
}

ssh_pool_command!(security_install_fail2ban, ssh::install_fail2ban);
ssh_pool_command!(security_uninstall_fail2ban, ssh::uninstall_fail2ban);
ssh_pool_command!(security_start_fail2ban, ssh::start_fail2ban);
ssh_pool_command!(security_stop_fail2ban, ssh::stop_fail2ban);
// P UAT 2026-05-04: security_start_firewall — manual (extra ssh_port param).
// Previously macro-based; now нужен SSH port для defensive rule add перед enable.
#[tauri::command]
pub async fn security_start_firewall(
    app: tauri::AppHandle,
    pool: tauri::State<'_, crate::ssh::SshPool>,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
    key_data: Option<String>,
) -> Result<(), String> {
    let params = ssh::SshParams {
        host,
        port,
        ssh_user: user,
        ssh_password: password,
        key_path,
        key_data,
        // Internal (non-wizard) caller — keep the legacy try-key-then-password
        // sequence; the D-06 single-method choice only flows from the wizard.
        auth_method: None,
    };
    let handle = pool.acquire(&params, Some(app.clone())).await?;
    ssh::start_firewall(&app, &handle, port).await
}
ssh_pool_command!(security_stop_firewall, ssh::stop_firewall);
ssh_pool_command!(security_fail2ban_unban, ssh::fail2ban_unban, jail: String, ip: String);
ssh_pool_command!(security_fail2ban_ban, ssh::fail2ban_ban, jail: String, ip: String);
ssh_pool_command!(security_fail2ban_set_jail, ssh::fail2ban_set_jail_config, jail: String, config: ssh::JailConfigUpdate);
ssh_pool_command!(security_fail2ban_tail_log, ssh::fail2ban_tail_log, lines: u32);
ssh_pool_command!(security_uninstall_firewall, ssh::uninstall_firewall);
ssh_pool_command!(security_firewall_add_rule, ssh::firewall_add_rule, rule: ssh::NewFirewallRule);
// SACRED SSH PORT (post-UAT brick fix): manual (not macro) so the connected SSH `port`
// is threaded to firewall_delete_rule, which refuses to delete the active SSH port's
// rule — deleting it (with ufw default-deny) would lock the admin out entirely.
#[tauri::command]
pub async fn security_firewall_delete_rule(
    app: tauri::AppHandle,
    pool: tauri::State<'_, crate::ssh::SshPool>,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
    key_data: Option<String>,
    // D-06 parity (Fable LOW-7): thread auth_method exactly like the ssh_pool_command!
    // macro so this command shares the SAME pooled connection key as the other security_*
    // commands — the pool fingerprint hashes auth_method, so hardcoding None here would
    // fork a second connection if the security tab ever starts sending it.
    auth_method: Option<String>,
    number: u32,
) -> Result<(), String> {
    let params = ssh::SshParams { host, port, ssh_user: user, ssh_password: password, key_path, key_data, auth_method };
    let handle = pool.acquire(&params, Some(app.clone())).await?;
    ssh::firewall_delete_rule(&app, &handle, number, port).await
}
ssh_pool_command!(security_firewall_set_logging, ssh::firewall_set_logging, level: String);
ssh_pool_command!(security_firewall_tail_log, ssh::firewall_tail_log, lines: u32);
ssh_pool_command!(security_firewall_set_http_port, ssh::firewall_set_http_port, open: bool);

// ─── Manual pooled security commands (port reuse) ────────────────

#[tauri::command]
pub async fn security_change_ssh_port(
    app: tauri::AppHandle,
    pool: tauri::State<'_, crate::ssh::SshPool>,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
    key_data: Option<String>,
    new_port: u16,
) -> Result<serde_json::Value, String> {
    let params = ssh::SshParams { host, port, ssh_user: user, ssh_password: password, key_path, key_data, auth_method: None };
    let handle = pool.acquire(&params, Some(app.clone())).await?;
    let actual_port = ssh::change_ssh_port(&app, &handle, new_port, port).await?;
    // Drop stale handle and invalidate pool — the SSH daemon restarted on a new port
    drop(handle);
    pool.invalidate().await;
    Ok(serde_json::json!({ "newPort": actual_port }))
}

// ─── MTProto proxy commands ──────────────────────────────────────

// UAT 2026-05-20 — `mtproto_install` is cancellable. Replaces `ssh_command!` macro
// (which can't reach AppState) so we can read the shared `mtproto_install_cancel`
// flag and reset it on every exit path. See `mtproto_cancel_install` below.
#[tauri::command]
pub async fn mtproto_install(
    app: tauri::AppHandle,
    cancel_state: tauri::State<'_, crate::AppState>,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
    key_data: Option<String>,
    mtproto_port: u16,
) -> Result<crate::ssh::MtProtoStatus, String> {
    use std::sync::atomic::Ordering;
    let params = ssh::SshParams {
        host,
        port,
        ssh_user: user,
        ssh_password: password,
        key_path,
        key_data,
        // Internal (non-wizard) caller — keep the legacy try-key-then-password
        // sequence; the D-06 single-method choice only flows from the wizard.
        auth_method: None,
    };
    // Reset cancel flag at start (in case it was left set by a previous cancel
    // before this install kicked off). The reset gives a clean slate per-attempt.
    cancel_state.mtproto_install_cancel.store(false, Ordering::SeqCst);
    let flag = cancel_state.mtproto_install_cancel.clone();
    let result = ssh::mtproto_install(&app, params, mtproto_port, flag).await;
    // Cleanup on every exit path (success / cancel / error) so a subsequent
    // install isn't pre-cancelled by stale state.
    cancel_state.mtproto_install_cancel.store(false, Ordering::SeqCst);
    result
}

/// UAT 2026-05-20 — request cancellation of an in-progress MTProto install.
///
/// Sets the shared AppState flag; the install loop checks it between each
/// `exec_command` and returns `"MTPROTO_INSTALL_CANCELLED"` at the next
/// checkpoint. Safe to call when no install is running — the flag will be
/// reset by the next install start.
#[tauri::command]
pub async fn mtproto_cancel_install(
    cancel_state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    cancel_state.mtproto_install_cancel.store(true, Ordering::SeqCst);
    Ok(())
}

ssh_command!(mtproto_uninstall, ssh::mtproto_uninstall);

// ─── Phase 18 — sidecar update commands (Plan 18-05) ──────────────

/// Phase 18 — atomic-swap sidecar update entry point (REQ-18-UPDATE-FLOW-03..07).
///
/// Mirrors Phase 17.1 `mtproto_install` cancel-flag wiring: AppState owns
/// `update_sidecar_cancel: Arc<AtomicBool>`; reset to `false` на start, передаётся
/// в `ssh::update_sidecar`, и обязательно reset обратно на каждом exit path
/// (success / cancel / error) чтобы следующий update не получил stale `true`.
///
/// **Single-flight guard:** check current flag value перед reset. Если flag уже `true`,
/// значит кто-то отменил previous update которая ещё не cleaned up — допускаем
/// fresh run (reset cleans). Если concurrent invocation реально нужна — этот
/// guard расширится в Plan 18-06 frontend через UI disable button-while-running.
#[tauri::command]
pub async fn update_sidecar(
    app: tauri::AppHandle,
    cancel_state: tauri::State<'_, crate::AppState>,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
    key_data: Option<String>,
    target_version: String,
) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    let params = ssh::SshParams {
        host,
        port,
        ssh_user: user,
        ssh_password: password,
        key_path,
        key_data,
        // Internal (non-wizard) caller — keep the legacy try-key-then-password
        // sequence; the D-06 single-method choice only flows from the wizard.
        auth_method: None,
    };
    // Reset cancel flag at start (in case it was left set by a previous cancel
    // before this update kicked off). The reset gives a clean slate per-attempt.
    cancel_state.update_sidecar_cancel.store(false, Ordering::SeqCst);
    let flag = cancel_state.update_sidecar_cancel.clone();
    let result = ssh::update_sidecar(&app, params, target_version, flag).await;
    // Cleanup on every exit path (success / cancel / error) so a subsequent
    // update isn't pre-cancelled by stale state.
    cancel_state.update_sidecar_cancel.store(false, Ordering::SeqCst);
    result
}

/// Phase 18 — request cancellation of an in-progress sidecar update (REQ-18-UPDATE-FLOW-07).
///
/// Sets the shared AppState flag; the update pipeline checks it between each
/// step AND inside `restart_trusttunnel_and_wait` 12s verify retry loop (PLAN-REVIEW
/// Blocker #4 fix). Returns `"UPDATE_CANCELLED"` at the next checkpoint.
///
/// Safe to call when no update is running — the flag will be reset by the next update start.
#[tauri::command]
pub async fn cancel_update_sidecar(
    cancel_state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    ssh::update_sidecar_cancel(&cancel_state.update_sidecar_cancel);
    Ok(())
}

// mtproto_get_status needs host for proxy link construction -- manual command like security_get_status
#[tauri::command]
pub async fn mtproto_get_status(
    app: tauri::AppHandle,
    pool: tauri::State<'_, crate::ssh::SshPool>,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
    key_data: Option<String>,
) -> Result<serde_json::Value, String> {
    let params = ssh::SshParams { host: host.clone(), port, ssh_user: user, ssh_password: password, key_path, key_data, auth_method: None };
    let handle = pool.acquire(&params, Some(app.clone())).await?;
    let result = ssh::mtproto_get_status(&app, &handle, &host).await?;
    serde_json::to_value(&result).map_err(|e| format!("Serialize error: {e}"))
}

// UAT 2026-05-21 — Start/Stop verbs for the MtProtoModal toggle.
// Same pooled pattern as `mtproto_get_status` (host is needed to rebuild
// the proxy_link in the returned MtProtoStatus).
#[tauri::command]
pub async fn mtproto_start(
    app: tauri::AppHandle,
    pool: tauri::State<'_, crate::ssh::SshPool>,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
    key_data: Option<String>,
) -> Result<serde_json::Value, String> {
    let params = ssh::SshParams { host: host.clone(), port, ssh_user: user, ssh_password: password, key_path, key_data, auth_method: None };
    let handle = pool.acquire(&params, Some(app.clone())).await?;
    let result = ssh::mtproto_start(&app, &handle, &host).await?;
    serde_json::to_value(&result).map_err(|e| format!("Serialize error: {e}"))
}

#[tauri::command]
pub async fn mtproto_stop(
    app: tauri::AppHandle,
    pool: tauri::State<'_, crate::ssh::SshPool>,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
    key_data: Option<String>,
) -> Result<serde_json::Value, String> {
    let params = ssh::SshParams { host: host.clone(), port, ssh_user: user, ssh_password: password, key_path, key_data, auth_method: None };
    let handle = pool.acquire(&params, Some(app.clone())).await?;
    let result = ssh::mtproto_stop(&app, &handle, &host).await?;
    serde_json::to_value(&result).map_err(|e| format!("Serialize error: {e}"))
}

// ─── BBR optimization commands ───────────────────────────────────────

ssh_pool_command!(detect_bbr_status, ssh::detect_bbr_status);
ssh_pool_command!(enable_bbr, ssh::enable_bbr);
ssh_pool_command!(disable_bbr, ssh::disable_bbr);

// ─── Server Benchmark (Phase 17) — streaming SSH execution ──────────

/// Start an IP.Check.Place benchmark on the remote server.
///
/// Collects full stdout and returns on completion (may run 1-3 minutes).
///
/// **B7 Tauri camelCase ↔ snake_case convention:**
/// TypeScript caller sends `{ host, port, user, password, keyPath, keyData }` (camelCase).
/// Tauri 2 default auto-rename converts to snake_case in this Rust signature.
/// Matches existing `security_install_firewall` and `mtproto_install` patterns.
///
/// **Single-flight invariant (D-1.1):**
/// Returns `Err("BENCHMARK_ALREADY_RUNNING")` immediately if another benchmark is in progress.
/// The `benchmark_cancel_tx` slot in `AppState` is cleared on ALL exit paths.
///
/// **Cancel support:**
/// `server_cancel_benchmark` sends a `()` through the oneshot channel stored in `AppState`,
/// which triggers the biased cancel branch in `run_benchmark`.
///
/// **B5:** Returns `BenchmarkResult { raw_stdout, duration_seconds }` — NO parsed sections.
/// Frontend TypeScript owns section parsing via `parseBenchmarkOutput()` (Plan 17-02).
///
/// **UAT-F16 overall timeout:** a real check completes in 1-3 minutes; 300s gives
/// generous headroom (including the auto-install of missing deps) while still bounding
/// any unexpected hang so the single-flight slot is freed.
const BENCHMARK_OVERALL_TIMEOUT_SECS: u64 = 300;

#[tauri::command]
pub async fn server_run_benchmark(
    app: tauri::AppHandle,
    pool: tauri::State<'_, crate::ssh::SshPool>,
    cancel_state: tauri::State<'_, crate::AppState>,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
    key_data: Option<String>,
) -> Result<serde_json::Value, String> {
    let params = ssh::SshParams {
        host,
        port,
        ssh_user: user,
        ssh_password: password,
        key_path,
        key_data,
        // Internal (non-wizard) caller — keep the legacy try-key-then-password
        // sequence; the D-06 single-method choice only flows from the wizard.
        auth_method: None,
    };
    let handle = pool.acquire(&params, Some(app.clone())).await?;

    // Single-flight guard: reject concurrent benchmark invocations (D-1.1 / T-17-01).
    let (tx, rx) = tokio::sync::oneshot::channel();
    {
        let mut guard = cancel_state.benchmark_cancel_tx.lock().await;
        if guard.is_some() {
            return Err("BENCHMARK_ALREADY_RUNNING".into());
        }
        *guard = Some(tx);
    }

    // Run the streaming benchmark (may take 1-3 minutes).
    // run_benchmark is re-exported via ssh::server::mod.rs pub use server_benchmark::*
    //
    // UAT-F16 defense-in-depth: the `-y` / stdin-/dev/null guards in run_benchmark's
    // command (see server_benchmark.rs) eliminate the KNOWN deps-missing hang. This
    // outer timeout bounds ANY residual/unknown hang so the single-flight slot is
    // always freed and the frontend gets a distinct, actionable result instead of
    // spinning forever. A real check completes well under this ceiling (1-3 min).
    let start = std::time::Instant::now();
    let timed = tokio::time::timeout(
        tokio::time::Duration::from_secs(BENCHMARK_OVERALL_TIMEOUT_SECS),
        ssh::run_benchmark(&app, &handle, rx),
    )
    .await;

    // Cleanup on ALL exit paths: success / cancel / error / watchdog-forced / overall-timeout
    // (cleanup invariant — the slot MUST be cleared whether the inner future completed,
    // errored, or the outer timeout elapsed, so a future benchmark can start).
    *cancel_state.benchmark_cancel_tx.lock().await = None;

    let result = match timed {
        Ok(inner) => inner,
        // Overall timeout elapsed — return a DISTINCT error the frontend can detect,
        // mirroring the existing BENCHMARK_CANCELLED|dur=N format for parser consistency.
        Err(_) => {
            let dur = start.elapsed().as_secs();
            return Err(format!("BENCHMARK_TIMEOUT|dur={dur}"));
        }
    };

    // Surface error to TypeScript (BENCHMARK_CANCELLED|dur=N or BENCHMARK_CANCELLED|dur=N|forced).
    let res: ssh::BenchmarkResult = result?;
    serde_json::to_value(&res).map_err(|e| format!("Serialize error: {e}"))
}

/// Cancel an in-progress benchmark by sending through the oneshot channel AND
/// opening a second SSH channel to kill the remote process group via PID file.
///
/// Two-layer kill strategy:
/// 1. Send `()` through the oneshot → `run_benchmark` sends `Sig::TERM` + `Sig::INT`
///    to the bash entry-point (effective when script is simple, may not reach subprocesses).
/// 2. Open a second SSH channel → `kill -TERM -- -$PID` → kills the entire process
///    group including curl/dig/traceroute spawned by the IPQuality script.
///    `set -m` in the run command makes $$ the PGID leader. The PID file is written
///    as the very first command before exec: `echo $$ > /tmp/tt-benchmark.pid`.
///
/// SSH params are passed from the frontend (same params used in server_run_benchmark),
/// so the pool can reuse the existing connection for the kill channel.
///
/// Best-effort: errors from the second channel are silently ignored (PID file may
/// already be gone if the benchmark finished on its own before cancel arrived).
///
/// Safe to call when no benchmark is running — `guard.take()` on `None` is a no-op.
#[tauri::command]
pub async fn server_cancel_benchmark(
    pool: tauri::State<'_, crate::ssh::SshPool>,
    cancel_state: tauri::State<'_, crate::AppState>,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
    key_data: Option<String>,
) -> Result<(), String> {
    // Step 1: Signal the oneshot to trigger Sig::TERM in the streaming loop.
    {
        let mut guard = cancel_state.benchmark_cancel_tx.lock().await;
        if let Some(tx) = guard.take() {
            let _ = tx.send(());
        }
    }

    // Step 2: Open a second SSH channel and kill the process group.
    // Best-effort: silently ignore errors — benchmark may already be terminating.
    let params = ssh::SshParams {
        host,
        port,
        ssh_user: user,
        ssh_password: password,
        key_path,
        key_data,
        // Internal (non-wizard) caller — keep the legacy try-key-then-password
        // sequence; the D-06 single-method choice only flows from the wizard.
        auth_method: None,
    };

    let kill_result: Result<(), String> = async {
        let handle = pool.acquire(&params, None).await
            .map_err(|e| format!("kill_channel_acquire: {e}"))?;
        let mut kill_chan = crate::ssh::open_session_with_retry(&handle).await
            .map_err(|e| format!("kill_channel_open: {e}"))?;
        // Read PID from file, send SIGTERM to process group (-PGID), wait 1s,
        // then SIGKILL the group, and clean up the PID file.
        let kill_cmd = "PID=$(cat /tmp/tt-benchmark.pid 2>/dev/null); \
            [ -n \"$PID\" ] && kill -TERM -- -$PID 2>/dev/null; \
            sleep 1; \
            [ -n \"$PID\" ] && kill -KILL -- -$PID 2>/dev/null; \
            rm -f /tmp/tt-benchmark.pid";
        kill_chan
            .exec(true, kill_cmd.as_bytes())
            .await
            .map_err(|e| format!("kill_exec: {e}"))?;
        // Drain channel to completion (best-effort, 3s timeout).
        let _ = tokio::time::timeout(
            tokio::time::Duration::from_secs(3),
            async {
                while kill_chan.wait().await.is_some() {
                    // drain
                }
            },
        )
        .await;
        Ok(())
    }
    .await;

    if let Err(e) = kill_result {
        // Non-fatal: log to stderr but do not surface to frontend.
        eprintln!("[benchmark_cancel] kill-pgroup best-effort failed: {e}");
    }

    Ok(())
}

// ─── Non-macro SSH commands ────────────────────────────────────────

#[tauri::command]
pub async fn server_get_available_versions() -> Result<Vec<String>, String> {
    ssh::server_get_available_versions().await
}

#[tauri::command]
pub fn forget_ssh_host_key(host: String, port: u16) {
    ssh::forget_known_host(&host, port);
}

// ─── SSH Credential Storage (keyring + JSON metadata) ────────────

use base64::Engine;
use keyring::Entry;

const KEYRING_SERVICE: &str = "TrustTunnel";

fn ssh_creds_path() -> std::path::PathBuf {
    ssh::portable_data_dir().join("ssh_credentials.json")
}

/// Stable keyring entry name for an SSH (host, port, user) triple.
///
/// SEC-04 (09-RESEARCH-security.md §5): the previous shape `ssh-{host}:{port}-{user}`
/// was AMBIGUOUS because its `-` and `:` separators ALSO occur inside the field
/// values themselves — IPv6 hosts carry `:` and hyphenated logins carry `-`. Two
/// distinct triples could therefore serialize to the same string (e.g.
/// `("a","22-x","b")` and `("a","22","x-b")` both → `ssh-a:22-x-b`), so one
/// server's stored SSH password could be served for a different server
/// (T-09-SC-3, Information Disclosure). The fix uses a `|`-delimited, field-tagged
/// shape: `|` is in NEITHER the host whitelist (`validate_ssh_host`:
/// `[a-zA-Z0-9.-:[]]`) NOR the user whitelist (`validate_ssh_user`:
/// `[a-zA-Z0-9._$-]`), so it can never appear inside a real field — the mapping
/// from (host,port,user) → key is now injective (mirror of the CR-04 delimiter
/// discipline). NOTE: changing the shape makes pre-existing keyring entries under
/// the OLD key unreadable — the user is re-prompted ONCE for the password, which
/// is then written under the new key (recoverable; documented in 09-18-SUMMARY).
/// We deliberately add NO old-key fallback (accepting the one-time re-prompt is
/// simpler than carrying legacy-key migration logic). The separate SSH-KEY keyring
/// service is keyed by a single bare-host field and is unaffected.
fn keyring_key(host: &str, port: &str, user: &str) -> String {
    format!("ssh|h={host}|p={port}|u={user}")
}

// ─── Per-host credential store (v2) ──────────────────────────────
//
// 06-19 / D-15 / C-23: the JSON metadata store is now keyed per host:port:user.
// Previously `ssh_credentials.json` held a SINGLE `{host,port,user,keyPath}`
// object, so saving credentials for server B clobbered server A's record. On a
// machine that has touched multiple servers the Control Panel / wizard could
// then install/connect/auto-connect against the WRONG server (C-23, HIGH).
//
// v2 shape:
//   { "version": 2,
//     "last_active": "<id>" | null,
//     "records": { "<id>": { "host", "port", "user", "keyPath" } } }
// where `<id>` = record_id(host,port,user) and uses the SAME identity shape as
// `keyring_key` so the JSON record id and the per-host keyring entry stay aligned.
// The password is NEVER stored on disk — the Windows keyring (DPAPI) remains the
// only at-rest secret store (D-29 / T-06-19-2).

/// Stable per-record identity. MUST mirror `keyring_key`'s identity shape so the
/// JSON record id and the keyring entry refer to the same host:port:user.
fn record_id(host: &str, port: &str, user: &str) -> String {
    keyring_key(host, port, user)
}

/// Read and parse the v2 store at `path`. Migrates a legacy v1 single-object
/// file (top-level `host`, no `version`/`records`) into a v2 records map first.
/// Returns an empty v2 store if the file is missing or unparseable.
fn read_store_at(path: &std::path::Path) -> serde_json::Map<String, serde_json::Value> {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return empty_store(),
    };
    let parsed: serde_json::Map<String, serde_json::Value> = match serde_json::from_str(&content) {
        Ok(m) => m,
        Err(_) => return empty_store(),
    };
    // Already v2?
    if parsed.contains_key("records") || parsed.contains_key("version") {
        return parsed;
    }
    // Legacy v1 single-object file — migrate it (lossless, one-shot).
    migrate_legacy_store(path, parsed)
}

fn empty_store() -> serde_json::Map<String, serde_json::Value> {
    let mut m = serde_json::Map::new();
    m.insert("version".into(), serde_json::Value::from(2));
    m.insert("last_active".into(), serde_json::Value::Null);
    m.insert("records".into(), serde_json::Value::Object(serde_json::Map::new()));
    m
}

/// Serialize-or-error write. Carries the WR-06 fix forward: on a serialization
/// error we return Err and do NOT clobber the file with an empty string.
fn write_store_at(
    path: &std::path::Path,
    store: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    let s = serde_json::to_string_pretty(&serde_json::Value::Object(store.clone()))
        .map_err(|e| format!("Failed to serialize credentials: {e}"))?;
    std::fs::write(path, s).map_err(|e| format!("Failed to save credentials: {e}"))
}

/// Lift a legacy v1 single-object `{host,port,user,keyPath[,password]}` into a v2
/// records map. Any stranded `password` (`b64:`-prefixed or plaintext) is moved
/// into the keyring and DROPPED before the v2 file is written — no secret on disk.
fn migrate_legacy_store(
    path: &std::path::Path,
    mut legacy: serde_json::Map<String, serde_json::Value>,
) -> serde_json::Map<String, serde_json::Value> {
    let host = legacy.get("host").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let port = legacy.get("port").and_then(|v| v.as_str()).unwrap_or("22").to_string();
    let user = legacy.get("user").and_then(|v| v.as_str()).unwrap_or("root").to_string();
    let key_path = legacy
        .get("keyPath")
        .cloned()
        .unwrap_or(serde_json::Value::String(String::new()));

    // Lift any at-rest password into the keyring, then drop it (no secret on disk).
    if let Some(pwd_val) = legacy.remove("password") {
        if let Some(pwd_str) = pwd_val.as_str() {
            if !pwd_str.is_empty() {
                let decoded = decode_legacy_password(pwd_str);
                let _ = keyring_save(&host, &port, &user, &decoded);
            }
        }
    }

    let mut store = empty_store();
    // An empty legacy file (no host) yields an empty v2 store.
    if !host.is_empty() {
        let id = record_id(&host, &port, &user);
        let mut record = serde_json::Map::new();
        record.insert("host".into(), serde_json::Value::String(host));
        record.insert("port".into(), serde_json::Value::String(port));
        record.insert("user".into(), serde_json::Value::String(user));
        record.insert("keyPath".into(), key_path);
        if let Some(records) = store.get_mut("records").and_then(|v| v.as_object_mut()) {
            records.insert(id.clone(), serde_json::Value::Object(record));
        }
        store.insert("last_active".into(), serde_json::Value::String(id));
    }

    // Best-effort rewrite to the v2 shape (drops the stranded password). On a
    // serialization failure we leave the legacy file alone; the next read retries.
    let _ = write_store_at(path, &store);
    store
}

/// Decode a legacy stored password: `b64:`-prefixed → base64-decoded, else plaintext.
fn decode_legacy_password(pwd_str: &str) -> String {
    if let Some(b64_payload) = pwd_str.strip_prefix("b64:") {
        base64::engine::general_purpose::STANDARD
            .decode(b64_payload)
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .unwrap_or_else(|| pwd_str.to_string())
    } else {
        pwd_str.to_string()
    }
}

/// Build the combined frontend-facing bundle (host/port/user/password/keyPath)
/// for a single v2 record, pulling the password from that record's keyring entry.
fn record_to_bundle(record: &serde_json::Value) -> Option<serde_json::Value> {
    let host = record.get("host").and_then(|v| v.as_str())?.to_string();
    let port = record.get("port").and_then(|v| v.as_str()).unwrap_or("22").to_string();
    let user = record.get("user").and_then(|v| v.as_str()).unwrap_or("root").to_string();
    let key_path = record
        .get("keyPath")
        .cloned()
        .unwrap_or(serde_json::Value::String(String::new()));
    let password = keyring_load(&host, &port, &user).ok().flatten().unwrap_or_default();

    let mut result = serde_json::Map::new();
    result.insert("host".into(), serde_json::Value::String(host));
    result.insert("port".into(), serde_json::Value::String(port));
    result.insert("user".into(), serde_json::Value::String(user));
    result.insert("password".into(), serde_json::Value::String(password));
    result.insert("keyPath".into(), key_path);
    Some(serde_json::Value::Object(result))
}

/// Upsert a record into the store at `path` and mark it `last_active`. Other
/// records are untouched (per-host isolation — T-06-19-4). Password goes to the
/// keyring (when non-empty); only metadata is written to disk.
fn save_creds_at(
    path: &std::path::Path,
    host: &str,
    port: &str,
    user: &str,
    password: &str,
    key_path: Option<String>,
) -> Result<(), String> {
    if !password.is_empty() {
        keyring_save(host, port, user, password)?;
    }
    let mut store = read_store_at(path);
    let id = record_id(host, port, user);
    let mut record = serde_json::Map::new();
    record.insert("host".into(), serde_json::Value::String(host.to_string()));
    record.insert("port".into(), serde_json::Value::String(port.to_string()));
    record.insert("user".into(), serde_json::Value::String(user.to_string()));
    record.insert(
        "keyPath".into(),
        serde_json::Value::String(key_path.unwrap_or_default()),
    );
    if let Some(records) = store.get_mut("records").and_then(|v| v.as_object_mut()) {
        records.insert(id.clone(), serde_json::Value::Object(record));
    }
    store.insert("last_active".into(), serde_json::Value::String(id));
    write_store_at(path, &store)
}

/// Load the `last_active` record's bundle from the store at `path`.
fn load_active_at(path: &std::path::Path) -> Option<serde_json::Value> {
    let store = read_store_at(path);
    let id = store.get("last_active").and_then(|v| v.as_str())?;
    let record = store.get("records").and_then(|v| v.as_object())?.get(id)?;
    record_to_bundle(record)
}

/// Load a specific host's record bundle from the store at `path`.
fn load_for_at(
    path: &std::path::Path,
    host: &str,
    port: &str,
    user: &str,
) -> Option<serde_json::Value> {
    let store = read_store_at(path);
    let id = record_id(host, port, user);
    let record = store.get("records").and_then(|v| v.as_object())?.get(&id)?;
    record_to_bundle(record)
}

/// Clear the active record (+ its keyring entry) from the store at `path`,
/// leaving other hosts' records intact. The file is removed only when the store
/// becomes empty (T-06-19-4: no global clobber).
fn clear_active_at(path: &std::path::Path) {
    let mut store = read_store_at(path);
    let active_id = store.get("last_active").and_then(|v| v.as_str()).map(|s| s.to_string());
    let Some(id) = active_id else {
        let _ = std::fs::remove_file(path);
        return;
    };
    // Pull host/port/user from the record to clear its keyring entry.
    if let Some(record) = store.get("records").and_then(|v| v.as_object()).and_then(|r| r.get(&id)) {
        let host = record.get("host").and_then(|v| v.as_str()).unwrap_or_default();
        let port = record.get("port").and_then(|v| v.as_str()).unwrap_or("22");
        let user = record.get("user").and_then(|v| v.as_str()).unwrap_or("root");
        let _ = keyring_clear(host, port, user);
    }
    let remaining = if let Some(records) = store.get_mut("records").and_then(|v| v.as_object_mut()) {
        records.remove(&id);
        records.len()
    } else {
        0
    };
    if remaining == 0 {
        // Nothing left — remove the file entirely.
        let _ = std::fs::remove_file(path);
        return;
    }
    // Point last_active at an arbitrary surviving record.
    let next = store
        .get("records")
        .and_then(|v| v.as_object())
        .and_then(|r| r.keys().next().cloned());
    store.insert(
        "last_active".into(),
        next.map(serde_json::Value::String).unwrap_or(serde_json::Value::Null),
    );
    let _ = write_store_at(path, &store);
}

/// Clear a SPECIFIC host:port:user record (+ its keyring entry) from the store
/// at `path`, leaving every other record — including `last_active` when it is a
/// different record — intact (WR-04). The file is removed only when the store
/// becomes empty. No-op when the target record does not exist.
fn clear_for_at(path: &std::path::Path, host: &str, port: &str, user: &str) {
    let id = record_id(host, port, user);
    let mut store = read_store_at(path);
    // Nothing to do if the target record is absent.
    let present = store
        .get("records")
        .and_then(|v| v.as_object())
        .is_some_and(|r| r.contains_key(&id));
    if !present {
        return;
    }
    // Drop the keyring entry for the targeted identity (best-effort).
    let _ = keyring_clear(host, port, user);
    let remaining = if let Some(records) = store.get_mut("records").and_then(|v| v.as_object_mut()) {
        records.remove(&id);
        records.len()
    } else {
        0
    };
    if remaining == 0 {
        let _ = std::fs::remove_file(path);
        return;
    }
    // If last_active pointed at the cleared record, re-point it at a survivor;
    // otherwise leave it untouched (we only re-keyed an inactive old-port entry).
    let active_is_cleared = store
        .get("last_active")
        .and_then(|v| v.as_str())
        .is_some_and(|a| a == id);
    if active_is_cleared {
        let next = store
            .get("records")
            .and_then(|v| v.as_object())
            .and_then(|r| r.keys().next().cloned());
        store.insert(
            "last_active".into(),
            next.map(serde_json::Value::String).unwrap_or(serde_json::Value::Null),
        );
    }
    let _ = write_store_at(path, &store);
}

fn keyring_save(host: &str, port: &str, user: &str, password: &str) -> Result<(), String> {
    let key = keyring_key(host, port, user);
    let entry = Entry::new(KEYRING_SERVICE, &key).map_err(|e| format!("Keyring error: {e}"))?;
    entry.set_password(password).map_err(|e| format!("Cannot store password: {e}"))?;
    Ok(())
}

fn keyring_load(host: &str, port: &str, user: &str) -> Result<Option<String>, String> {
    let key = keyring_key(host, port, user);
    let entry = Entry::new(KEYRING_SERVICE, &key).map_err(|e| format!("Keyring error: {e}"))?;
    match entry.get_password() {
        Ok(pw) => Ok(Some(pw)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Cannot load password: {e}")),
    }
}

fn keyring_clear(host: &str, port: &str, user: &str) -> Result<(), String> {
    let key = keyring_key(host, port, user);
    let entry = Entry::new(KEYRING_SERVICE, &key).map_err(|e| format!("Keyring error: {e}"))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Cannot clear password: {e}")),
    }
}

#[tauri::command]
pub fn save_ssh_credentials(
    host: String,
    port: String,
    user: String,
    password: String,
    key_path: Option<String>,
) -> Result<(), String> {
    // Per-host upsert: writing server B never clobbers server A's record
    // (06-19 / D-15 / T-06-19-4). Password goes to the keyring; only metadata
    // is written to disk (D-29 / T-06-19-2). Note: no secret is ever logged.
    save_creds_at(&ssh_creds_path(), &host, &port, &user, &password, key_path)
}

#[tauri::command]
pub fn load_ssh_credentials() -> Option<serde_json::Value> {
    // Back-compat no-arg read: returns the last-active record's bundle.
    // Reading the store migrates a legacy v1 single-object file on first touch.
    load_active_at(&ssh_creds_path())
}

/// Host-keyed read (06-19 / D-15 / C-23): return the EXACT target's bundle so a
/// caller that knows its host:port:user never receives a different server's
/// last-saved credentials. Returns None when no record exists for the target.
#[tauri::command]
pub fn load_ssh_credentials_for(host: String, port: String, user: String) -> Option<serde_json::Value> {
    load_for_at(&ssh_creds_path(), &host, &port, &user)
}

#[tauri::command]
pub fn clear_ssh_credentials() {
    // Clears only the active record (+ its keyring entry); other hosts' records
    // survive. The file is removed only when the store becomes empty.
    clear_active_at(&ssh_creds_path());
}

/// Clear a SPECIFIC host:port:user record (+ its keyring entry) (WR-04). Used
/// when the SSH port changes: the orchestrator saves the NEW host:port:user
/// record and then clears the OLD one so the per-host store does not accumulate
/// orphaned old-port records / keyring entries. No-op when the record is absent.
#[tauri::command]
pub fn clear_ssh_credentials_for(host: String, port: String, user: String) {
    clear_for_at(&ssh_creds_path(), &host, &port, &user);
}

#[tauri::command]
pub fn check_process_conflict() -> Option<String> {
    ssh::check_process_conflict()
}

#[tauri::command]
pub fn kill_existing_process() -> Result<(), String> {
    ssh::kill_existing_process()
}

// ─── Phase 16 — SSH-key feature commands (D-1.1..D-2.3) ──────────
//
// Two-tier shape:
//   1. SSH-using commands (ssh_pool_command!) — pool ensures `CHANNEL_OPEN_GATE`
//      semaphore + retry. host_arg duplicates SshParams.host because the
//      orchestrator function `generate_and_deploy` нужен host для keyring
//      target name (frontend передаёт тот же host обоим путям).
//   2. Local-only commands (manual #[tauri::command]) — DPAPI / fs ops без SSH.

// security_generate_ssh_key — generate Ed25519 + persist в keyring + upload pub.
// Returns: { fingerprint, publicKey, generated }
ssh_pool_command!(
    security_generate_ssh_key,
    ssh::ssh_key_generate_and_deploy,
    host_arg: String
);

// security_get_ssh_key_status — check keyring entry + authorized_keys + sshd_config state.
// Returns: { generated, authorized_on_server, pubkey_fingerprint, password_auth_disabled }
ssh_pool_command!(
    security_get_ssh_key_status,
    ssh::ssh_key_get_status,
    host_arg: String
);

/// security_export_ssh_key_backup — read keyring → write PEM to user-selected dest_path.
/// Per D-2.1 forced backup export flow. NO SSH required (local-only operation).
#[tauri::command]
pub async fn security_export_ssh_key_backup(host: String, dest_path: String) -> Result<(), String> {
    let pem = ssh::ssh_key_keyring_load_pem(&host)?
        .ok_or_else(|| "KEY_NOT_FOUND".to_string())?;

    // Write PEM bytes to user-chosen path (LF line endings preserved)
    std::fs::write(&dest_path, pem.as_bytes())
        .map_err(|e| format!("KEY_BACKUP_WRITE_FAILED|{e}"))?;

    Ok(())
}

/// security_import_ssh_key — validate user-provided .pem + persist в keyring.
/// Per D-2.3 recovery flow (SshConnectForm "Загрузить SSH-ключ" button).
/// NO SSH required.
#[tauri::command]
pub async fn security_import_ssh_key(host: String, pem_path: String) -> Result<(), String> {
    let pem = std::fs::read_to_string(&pem_path)
        .map_err(|e| format!("KEY_IMPORT_READ_FAILED|{e}"))?;
    ssh::ssh_key_import_pem(&host, &pem)
}

/// load_ssh_key_for_host — read keyring entry → return plaintext PEM in-memory.
/// Frontend uses this to pass keyData to connect_ssh (per D-1.4 — frontend
/// does NOT persist plaintext to disk, just hold in JS memory briefly).
#[tauri::command]
pub async fn load_ssh_key_for_host(host: String) -> Result<String, String> {
    ssh::ssh_key_keyring_load_pem(&host)?.ok_or_else(|| "KEY_NOT_FOUND".to_string())
}

/// P UAT 2026-05-04 — extract OpenSSH public key from keyring's stored
/// private PEM. Used для recovery UX: пользователь копирует pubkey текст
/// и manually добавляет в `~/.ssh/authorized_keys` через VPS web console
/// если pubkey upload silently failed на server-side.
///
/// Returns Err("KEY_NOT_FOUND") если keyring entry missing.
/// Returns Err("PUBKEY_DERIVE_FAILED|...") если PEM corrupted.
#[tauri::command]
pub async fn security_get_pubkey_for_recovery(host: String) -> Result<String, String> {
    crate::ssh::server::server_ssh_key::keyring_extract_pubkey(&host)?
        .ok_or_else(|| "KEY_NOT_FOUND".to_string())
}

// ─── Phase 16 — Disable PasswordAuth, Certbot Timer (D-2.2 + D-5.3) ─

/// security_disable_password_auth — sshd_config edit + restart с rollback.
///
/// MANUAL command (NOT macro) because needs `pool.invalidate()` after success
/// — sshd restart kills existing pool handles. Mirrors `security_change_ssh_port` pattern.
#[tauri::command]
pub async fn security_disable_password_auth(
    app: tauri::AppHandle,
    pool: tauri::State<'_, crate::ssh::SshPool>,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
    key_data: Option<String>,
) -> Result<(), String> {
    let params = ssh::SshParams {
        host,
        port,
        ssh_user: user,
        ssh_password: password,
        key_path,
        key_data,
        // Internal (non-wizard) caller — keep the legacy try-key-then-password
        // sequence; the D-06 single-method choice only flows from the wizard.
        auth_method: None,
    };
    let handle = pool.acquire(&params, Some(app.clone())).await?;
    ssh::disable_password_auth(&app, &handle).await?;
    // sshd restarted — all pool handles stale, force re-acquire on next call.
    drop(handle);
    pool.invalidate().await;
    Ok(())
}

/// security_enable_password_auth — sshd_config edit + restart с rollback.
///
/// P0-3 #E rollback companion для disable_password_auth. MANUAL command (NOT macro)
/// because needs `pool.invalidate()` after success — sshd restart kills existing
/// pool handles.
#[tauri::command]
pub async fn security_enable_password_auth(
    app: tauri::AppHandle,
    pool: tauri::State<'_, crate::ssh::SshPool>,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
    key_data: Option<String>,
) -> Result<(), String> {
    let params = ssh::SshParams {
        host,
        port,
        ssh_user: user,
        ssh_password: password,
        key_path,
        key_data,
        // Internal (non-wizard) caller — keep the legacy try-key-then-password
        // sequence; the D-06 single-method choice only flows from the wizard.
        auth_method: None,
    };
    let handle = pool.acquire(&params, Some(app.clone())).await?;
    ssh::enable_password_auth(&app, &handle).await?;
    // sshd restarted — all pool handles stale, force re-acquire on next call.
    drop(handle);
    pool.invalidate().await;
    Ok(())
}

// server_get_certbot_timer_status — read systemctl + cron file state (D-5.3).
ssh_pool_command!(server_get_certbot_timer_status, ssh::get_certbot_timer_status);

// server_enable_certbot_timer — systemctl enable --now + fallback к cron file.
ssh_pool_command!(server_enable_certbot_timer, ssh::enable_certbot_timer);

// P UAT 2026-05-04 — verify auto-renewal works (certbot renew --dry-run, no rate limit hit).
ssh_pool_command!(server_verify_certbot_renewal, ssh::verify_certbot_renewal);

// ─── Phase 14.1 — advanced user config commands ──────────────────

ssh_pool_command!(
    server_rotate_user_password,
    ssh::server_rotate_user_password,
    vpn_username: String,
    new_password: String
);

// Audit CQ-4 (ln-624): 12 individual extras → single typed `req: AddUserRequest`.
// The struct lives in `ssh::server::server_install` and is re-exported through
// `ssh::mod.rs`. Frontend sends `{ ...sshParams, req: { camelCaseFields... } }`.
ssh_pool_command!(
    server_add_user_advanced,
    ssh::server_add_user_advanced,
    req: ssh::AddUserRequest
);

ssh_pool_command!(
    server_update_user_config,
    ssh::server_update_user_config,
    username: String,
    cidr: Option<String>,
    anti_dpi: bool,
    regenerate_prefix: bool
);

ssh_pool_command!(
    server_regenerate_client_prefix,
    ssh::server_regenerate_client_prefix,
    vpn_username: String,
    prefix_length: u32,
    prefix_percent: u32
);

ssh_pool_command!(
    server_fetch_endpoint_cert,
    ssh::server_fetch_endpoint_cert,
    hostname: String,
    cert_port: u16,
    // FIX-OO-13: optional TLS SNI distinct from the TCP destination.
    // Frontend passes `customSni` here when the user opted into an
    // anti-DPI setup; omitted/empty means "use hostname for both".
    sni_host: Option<String>
);

ssh_pool_command!(
    server_export_config_deeplink_advanced,
    ssh::export_config_deeplink_advanced,
    client_name: String,
    custom_sni: Option<String>,
    name: Option<String>,
    upstream_protocol: Option<String>,
    anti_dpi: bool,
    skip_verification: bool,
    // CR-01: Base64-encoded DER bytes (string).
    pin_certificate_der: Option<String>,
    dns_upstreams: Vec<String>
);

ssh_pool_command!(
    server_get_user_config,
    ssh::server_get_user_config,
    vpn_username: String
);

// M-01 — Custom SNI autocomplete: feed the Add/Edit modal with the server's
// actual allowed_sni whitelist so the user doesn't have to guess what
// hosts.toml accepts before the FIX-OO-14 rollback trips.
ssh_pool_command!(
    server_get_allowed_sni_list,
    ssh::get_allowed_sni_list
);

// FIX-NN — server-side TLV persistence (/opt/trusttunnel/users-advanced.toml)
// The upstream protocol doesn't store display_name / SNI / skip_verify /
// upstream_protocol / pin_cert / dns_upstreams, so we keep them in our own
// sidecar file. Edit / FileText reopen / Download .toml all read back from it.

ssh_pool_command!(
    server_get_user_advanced,
    ssh::users_advanced::get_user_advanced,
    username: String
);

// A: batch read of users-advanced.toml for the Users tab list view
// (renders display_name next to the username, one SSH roundtrip for all).
ssh_pool_command!(
    server_list_user_advanced,
    ssh::users_advanced::list_user_advanced
);

// M-11: sweep orphan entries from users-advanced.toml. Pro calls this from
// UsersSection when the tab is activated — hygiene, no functional effect.
ssh_pool_command!(
    server_reconcile_users_advanced,
    ssh::users_advanced::reconcile_users_advanced
);

ssh_pool_command!(
    server_set_user_advanced,
    ssh::users_advanced::upsert_user_advanced,
    params: ssh::UserAdvanced
);

ssh_pool_command!(
    server_delete_user_advanced,
    ssh::users_advanced::delete_user_advanced,
    username: String
);

// ─── Per-host credential store tests (06-19 / D-15 / C-23) ───────
//
// These exercise the path-based store helpers directly with a temp file, so they
// never touch the real portable data dir. The keyring (Windows DPAPI) is not
// available headlessly, so the security-load-bearing assertions are on the
// ON-DISK JSON (no `password` field, per-host isolation, lossless migration) and
// on store routing (records map / last_active). The keyring round-trip itself is
// covered by manual multi-server UAT (see plan <verification>).
#[cfg(test)]
mod cred_store_tests {
    use super::*;
    use std::path::PathBuf;

    /// Unique temp credential-store path per test (no external tempfile dep).
    fn temp_store(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let mut p = std::env::temp_dir();
        p.push(format!("tt_creds_test_{tag}_{nanos}_{:?}.json", std::thread::current().id()));
        let _ = std::fs::remove_file(&p);
        p
    }

    fn records_count(path: &std::path::Path) -> usize {
        let store = read_store_at(path);
        store.get("records").and_then(|v| v.as_object()).map(|r| r.len()).unwrap_or(0)
    }

    fn disk_json(path: &std::path::Path) -> String {
        std::fs::read_to_string(path).unwrap_or_default()
    }

    #[test]
    fn saving_b_does_not_clobber_a() {
        let path = temp_store("coexist");
        // No password → keyring is never touched; store records still coexist.
        save_creds_at(&path, "10.0.0.1", "22", "root", "", Some("".into())).unwrap();
        save_creds_at(&path, "10.0.0.2", "22", "deploy", "", Some("/k.pem".into())).unwrap();

        assert_eq!(records_count(&path), 2, "both host records must coexist");

        let a = load_for_at(&path, "10.0.0.1", "22", "root").expect("A record present");
        assert_eq!(a.get("host").and_then(|v| v.as_str()), Some("10.0.0.1"));
        assert_eq!(a.get("user").and_then(|v| v.as_str()), Some("root"));

        let b = load_for_at(&path, "10.0.0.2", "22", "deploy").expect("B record present");
        assert_eq!(b.get("user").and_then(|v| v.as_str()), Some("deploy"));
        assert_eq!(b.get("keyPath").and_then(|v| v.as_str()), Some("/k.pem"));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn load_for_returns_target_or_none() {
        let path = temp_store("loadfor");
        save_creds_at(&path, "10.0.0.1", "22", "root", "", None).unwrap();
        save_creds_at(&path, "10.0.0.2", "22", "deploy", "", None).unwrap();

        assert!(load_for_at(&path, "10.0.0.1", "22", "root").is_some());
        assert!(load_for_at(&path, "10.0.0.2", "22", "deploy").is_some());
        assert!(
            load_for_at(&path, "9.9.9.9", "22", "nobody").is_none(),
            "unknown target must return None"
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn legacy_v1_object_migrates_to_v2_with_last_active() {
        let path = temp_store("migrate");
        // Write a legacy v1 single-object file (no version/records).
        let legacy = serde_json::json!({
            "host": "203.0.113.5",
            "port": "2222",
            "user": "admin",
            "keyPath": "/home/admin/key.pem"
        });
        std::fs::write(&path, serde_json::to_string_pretty(&legacy).unwrap()).unwrap();

        // Reading migrates it.
        let store = read_store_at(&path);
        assert_eq!(store.get("version").and_then(|v| v.as_u64()), Some(2));
        let id = record_id("203.0.113.5", "2222", "admin");
        assert_eq!(
            store.get("last_active").and_then(|v| v.as_str()),
            Some(id.as_str()),
            "last_active points at the migrated record"
        );
        let rec = store
            .get("records")
            .and_then(|v| v.as_object())
            .and_then(|r| r.get(&id))
            .expect("migrated record present");
        assert_eq!(rec.get("keyPath").and_then(|v| v.as_str()), Some("/home/admin/key.pem"));

        // No-arg load returns the migrated record (back-compat).
        let active = load_active_at(&path).expect("active bundle present");
        assert_eq!(active.get("host").and_then(|v| v.as_str()), Some("203.0.113.5"));
        assert_eq!(active.get("user").and_then(|v| v.as_str()), Some("admin"));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn legacy_password_is_dropped_from_disk_on_migration() {
        let path = temp_store("migrate_pwd");
        // Legacy file carrying a stranded plaintext password.
        let legacy = serde_json::json!({
            "host": "198.51.100.7",
            "port": "22",
            "user": "root",
            "keyPath": "",
            "password": "super-secret-plaintext"
        });
        std::fs::write(&path, serde_json::to_string_pretty(&legacy).unwrap()).unwrap();

        // Migration runs on read (keyring_save may fail headlessly — that's fine,
        // the security claim is that the password is NOT on disk afterwards).
        let _ = read_store_at(&path);

        let on_disk = disk_json(&path);
        assert!(
            !on_disk.contains("password"),
            "rewritten v2 store must contain NO password field"
        );
        assert!(
            !on_disk.contains("super-secret-plaintext"),
            "the secret value must never appear on disk"
        );
        // The record itself survived (lossless metadata migration).
        assert!(on_disk.contains("198.51.100.7"));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn legacy_b64_password_is_dropped_from_disk() {
        let path = temp_store("migrate_b64");
        let encoded = base64::engine::general_purpose::STANDARD.encode("b64-secret");
        let legacy = serde_json::json!({
            "host": "198.51.100.8",
            "port": "22",
            "user": "root",
            "keyPath": "",
            "password": format!("b64:{encoded}")
        });
        std::fs::write(&path, serde_json::to_string_pretty(&legacy).unwrap()).unwrap();

        let _ = read_store_at(&path);

        let on_disk = disk_json(&path);
        assert!(!on_disk.contains("password"), "no password field on disk");
        assert!(!on_disk.contains(&encoded), "encoded secret must not be on disk");

        // decode_legacy_password correctly decodes the b64 form (unit check).
        assert_eq!(decode_legacy_password(&format!("b64:{encoded}")), "b64-secret");

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn save_never_writes_password_to_disk() {
        let path = temp_store("nopwd");
        // Even when a non-empty password is supplied, the on-disk JSON must not
        // contain it (keyring is the only at-rest secret store). keyring_save may
        // fail headlessly; metadata write still proceeds.
        let _ = save_creds_at(&path, "10.0.0.9", "22", "root", "topsecretpw", None);
        let on_disk = disk_json(&path);
        assert!(!on_disk.contains("topsecretpw"), "password must not be on disk");
        assert!(!on_disk.contains("\"password\""), "no password field on disk");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn clear_active_removes_only_active_record() {
        let path = temp_store("clear");
        save_creds_at(&path, "10.0.0.1", "22", "root", "", None).unwrap();
        save_creds_at(&path, "10.0.0.2", "22", "deploy", "", None).unwrap();
        // last_active is now B (last saved).
        assert_eq!(records_count(&path), 2);

        clear_active_at(&path);
        // B removed, A survives.
        assert_eq!(records_count(&path), 1, "only the active record is cleared");
        assert!(load_for_at(&path, "10.0.0.1", "22", "root").is_some(), "A survives");
        assert!(load_for_at(&path, "10.0.0.2", "22", "deploy").is_none(), "B cleared");

        // Clearing the last record removes the file entirely.
        clear_active_at(&path);
        assert!(!path.exists(), "file removed when store becomes empty");

        let _ = std::fs::remove_file(&path);
    }

    // WR-04 regression: changing the SSH port re-keys the per-host record
    // (host:port:user). Saving under the NEW port must not leave the OLD-port
    // record orphaned — `clear_for_at(old)` removes exactly that record (+ its
    // keyring entry) while leaving every other host's record intact.
    #[test]
    fn clear_for_removes_only_the_targeted_record() {
        let path = temp_store("clear_for");
        // Old-port record for host X, plus an unrelated host Y.
        save_creds_at(&path, "10.0.0.1", "22", "root", "", None).unwrap();
        save_creds_at(&path, "10.0.0.9", "22", "deploy", "", None).unwrap();
        assert_eq!(records_count(&path), 2);

        // Simulate the port change: save the NEW-port record, then clear the OLD.
        save_creds_at(&path, "10.0.0.1", "2222", "root", "", None).unwrap();
        assert_eq!(records_count(&path), 3, "new-port record was added");
        clear_for_at(&path, "10.0.0.1", "22", "root");

        // The orphaned old-port record is gone…
        assert!(
            load_for_at(&path, "10.0.0.1", "22", "root").is_none(),
            "old-port record cleared"
        );
        // …the new-port record survives…
        assert!(
            load_for_at(&path, "10.0.0.1", "2222", "root").is_some(),
            "new-port record survives"
        );
        // …and the unrelated host is untouched.
        assert!(
            load_for_at(&path, "10.0.0.9", "22", "deploy").is_some(),
            "unrelated host untouched"
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn clear_for_keeps_last_active_when_it_is_not_the_cleared_record() {
        let path = temp_store("clear_for_active");
        save_creds_at(&path, "10.0.0.1", "22", "root", "", None).unwrap();
        // last_active points at the new-port record (last saved).
        save_creds_at(&path, "10.0.0.1", "2222", "root", "", None).unwrap();
        let active_before = read_store_at(&path)
            .get("last_active")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        clear_for_at(&path, "10.0.0.1", "22", "root");

        let active_after = read_store_at(&path)
            .get("last_active")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        assert_eq!(active_before, active_after, "active record pointer preserved");

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn record_id_matches_keyring_key() {
        // The JSON record id and the keyring entry MUST share identity.
        assert_eq!(
            record_id("h", "22", "u"),
            keyring_key("h", "22", "u"),
            "record_id and keyring_key must stay aligned"
        );
    }

    // ─── SEC-04: keyring_key disambiguation ───────────────────────────
    //
    // The OLD key shape `ssh-{host}:{port}-{user}` is AMBIGUOUS because `-` and
    // `:` both appear INSIDE the field values themselves (IPv6 hosts carry `:`,
    // hyphenated logins carry `-`). Two distinct (host,port,user) triples could
    // therefore serialize to the same string and have one server's SSH password
    // served for another (T-09-SC-3, Information Disclosure). The fix uses `|`
    // plus field tags — `|` is in NEITHER the host whitelist (`validate_ssh_host`:
    // `[a-zA-Z0-9.-:[]]`) NOR the user whitelist (`validate_ssh_user`:
    // `[a-zA-Z0-9._$-]`), so it can never appear in a real field and the mapping
    // from (host,port,user) → key becomes injective.

    #[test]
    fn keyring_key_disambiguates_hyphen_bearing_fields() {
        // Old-shape collision via the `-{user}` hyphen separator: both
        // ("a","22-x","b") and ("a","22","x-b") serialized to `ssh-a:22-x-b`.
        // The new shape keeps each field tagged + `|`-delimited, so they differ.
        assert_ne!(
            keyring_key("a", "22-x", "b"),
            keyring_key("a", "22", "x-b"),
            "hyphen-bearing port/user triples must not collide"
        );
    }

    #[test]
    fn keyring_key_disambiguates_colon_bearing_fields() {
        // Old shape collision via the IPv6 colon: `ssh-fe80::1:22-u` == `ssh-fe80::1:22-u`.
        // ("fe80::1","22","u") and ("fe80",":1:22","u") MUST map to distinct keys.
        assert_ne!(
            keyring_key("fe80::1", "22", "u"),
            keyring_key("fe80", ":1:22", "u"),
            "colon-bearing (IPv6) host/port triples must not collide"
        );
    }
}
