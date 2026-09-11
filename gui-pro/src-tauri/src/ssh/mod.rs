pub mod deploy;
pub mod pool;
pub mod sanitize;
pub mod server;
pub mod process;

use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use russh::client;
use russh::ChannelMsg;
use serde::Deserialize;
use tauri::Emitter;
use tokio::sync::{oneshot, Semaphore};

// Re-export everything that lib.rs uses
pub use deploy::{deploy_server, diagnose_server};
pub use server::{
    check_server_installation, uninstall_server, UninstallSelection, fetch_server_config,
    add_server_user, server_restart_service, server_stop_service,
    server_start_service, server_reboot, server_get_logs, server_remove_user,
    server_get_available_versions, server_upgrade, server_get_stats,
    server_get_uptime,
    get_server_config, get_cert_info, renew_cert, export_config_deeplink,
    update_config_feature,
    get_security_status, install_fail2ban, uninstall_fail2ban,
    start_fail2ban, stop_fail2ban, start_firewall, stop_firewall,
    fail2ban_unban, fail2ban_ban, fail2ban_set_jail_config, fail2ban_tail_log,
    install_firewall, uninstall_firewall, firewall_add_rule, firewall_delete_rule,
    firewall_set_logging, firewall_tail_log, firewall_set_http_port,
    // Phase 16 — disable PasswordAuthentication + certbot.timer (D-2.2 + D-5.3)
    disable_password_auth,
    // Phase 16 P0-3 #E — re-enable PasswordAuthentication (rollback companion)
    enable_password_auth,
    get_certbot_timer_status, enable_certbot_timer, verify_certbot_renewal,
    NewFirewallRule, JailConfigUpdate,
    mtproto_install, mtproto_get_status, mtproto_uninstall,
    // UAT 2026-05-21 — pooled toggle verbs for the new Start/Stop buttons.
    mtproto_start, mtproto_stop,
    // UAT 2026-05-20 — re-export MtProtoStatus so the manual #[tauri::command]
    // for `mtproto_install` in commands/ssh_commands.rs can name its return type.
    MtProtoStatus,
    // MtProtoInstallStep is internal-only (emitted via app.emit, not used in signatures)
    detect_bbr_status, enable_bbr, disable_bbr,
    // Phase 14.1 — advanced user config
    server_rotate_user_password, server_add_user_advanced, AddUserRequest,
    server_update_user_config, server_regenerate_client_prefix,
    server_fetch_endpoint_cert, server_get_user_config,
    export_config_deeplink_advanced,
    // M-01 — Custom SNI autocomplete
    get_allowed_sni_list, AllowedSniHost,
    UserRule, EndpointCertInfo,
    // FIX-NN — server-side TLV persistence
    users_advanced,
    UserAdvanced,
    // Phase 15 — vpn.toml bundle reader + raw write (Plan 01). The per-field typed
    // setters (update_listen_address / _log_level / _allow_private / _auth_status /
    // _ping_path / _speedtest_path) were REMOVED — superseded by the generic
    // save_config_file path, zero frontend callers remained.
    get_config_bundle, write_vpn_toml_raw,
    // Phase 15 — hosts.toml allowed_sni mutation (Plan 02, REQ-15.A)
    update_hosts_allowed_sni,
    // Phase 15.1 — generic per-file config save (REQ-15.0 + 15.7 + 15.8)
    save_config_file,
    // Phase 17 — Server Benchmark Check.Place (simplified: no parse_signal/BenchmarkProgress)
    run_benchmark, BenchmarkResult,
    // Phase 18 — sidecar update flow (Plan 18-05, REQ-18-UPDATE-FLOW-03..07)
    update_sidecar, update_sidecar_cancel, UpdateStep, BackupStatus,
};
// Phase 16 — SSH-key feature (D-1.1..D-2.3, REQ-16-SSH-KEY-*).
// Re-exported under namespaced names so commands::ssh_commands может вызывать
// `ssh::ssh_key_*` без prefix collision с existing `keyring_save/load/clear`
// password helpers (различные KEYRING_SERVICE namespaces).
pub use server::server_ssh_key::{
    generate_and_deploy as ssh_key_generate_and_deploy,
    get_ssh_key_status as ssh_key_get_status,
    import_pem_and_persist as ssh_key_import_pem,
    keyring_clear_pem as ssh_key_keyring_clear_pem,
    keyring_load_pem as ssh_key_keyring_load_pem,
    keyring_save_pem as ssh_key_keyring_save_pem,
    validate_pem_format as ssh_key_validate_pem,
};
pub use pool::SshPool;
pub use process::{check_process_conflict, kill_existing_process};

// ── Server path constants ──
pub const ENDPOINT_DIR: &str = "/opt/trusttunnel";
pub const ENDPOINT_BINARY: &str = "/opt/trusttunnel/trusttunnel_endpoint";
pub const ENDPOINT_CONFIG: &str = "/opt/trusttunnel/vpn.toml";
pub const ENDPOINT_SERVICE: &str = "trusttunnel_endpoint";

// ─── SSH connection parameters ─────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct SshParams {
    pub host: String,
    pub port: u16,
    pub ssh_user: String,
    pub ssh_password: String,
    pub key_path: Option<String>,
    /// PEM-encoded private key content (alternative to key_path).
    #[serde(default)]
    pub key_data: Option<String>,
    /// EXPLICIT single auth choice from the wizard ("password" | "key"), D-06.
    /// When `Some`, `ssh_connect` attempts ONLY that method — sending BOTH a
    /// password and a key was the root cause of "key rejected even though the
    /// password works" (the backend silently preferred the key). `#[serde(default)]`
    /// keeps every existing internal caller (which never sets it) backward-compatible:
    /// `None` ⇒ the legacy try-key-then-password sequence (Codex #2 / Pitfall 2).
    #[serde(default)]
    pub auth_method: Option<String>,
}

impl SshParams {
    #[allow(dead_code)]
    pub async fn connect(&self) -> Result<client::Handle<SshHandler>, String> {
        ssh_connect(&self.host, self.port, &self.ssh_user, &self.ssh_password, self.key_path.as_deref(), self.key_data.as_deref(), self.auth_method.as_deref(), None).await
    }

    pub async fn connect_with_app(&self, app: tauri::AppHandle) -> Result<client::Handle<SshHandler>, String> {
        ssh_connect(&self.host, self.port, &self.ssh_user, &self.ssh_password, self.key_path.as_deref(), self.key_data.as_deref(), self.auth_method.as_deref(), Some(app)).await
    }
}

// ─── Single-auth-method decision (D-06 root fix) ───
//
// The PURE decision of which auth method `ssh_connect` should attempt, factored
// out so the D-06 fix is unit-testable WITHOUT a live SSH server (the live
// `authenticate_*` calls need a server; the DECISION does not). russh 0.46
// returns only `Result<bool>` — there is NO server method list — so D-07 steering
// downstream is a heuristic keyed on WHICH method we attempted, never a read of a
// permitted-method list (RESEARCH Priority Finding / Pitfall 3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthAttempt {
    /// Attempt publickey ONLY (from key_path or key_data) — never fall through.
    KeyOnly,
    /// Attempt password ONLY — never try the key.
    PasswordOnly,
    /// Legacy back-compat: try key (path/data) then password in sequence.
    /// Used by every internal (non-wizard) caller that passes no auth_method.
    LegacySequence,
}

/// Pure decision helper: given the explicit `auth_method` (if any) and which
/// credentials are present, decide what `ssh_connect` attempts. The wizard always
/// passes `Some("password")` / `Some("key")` so exactly one method crosses the
/// boundary (D-06); internal callers pass `None` and keep the legacy sequence.
pub fn auth_plan(auth_method: Option<&str>, _has_key: bool, _has_password: bool) -> AuthAttempt {
    match auth_method {
        Some("key") => AuthAttempt::KeyOnly,
        Some("password") => AuthAttempt::PasswordOnly,
        _ => AuthAttempt::LegacySequence,
    }
}

// ─── The application's data root ──────────────────────────────────────────────
//
// WHERE THE DATA LIVES
//   `user_data_dir()` resolves to `%LOCALAPPDATA%\TrustTunnel Client Pro` — the per-user folder
//   named after the product. Every runtime artifact lives there: the client `.toml` configs,
//   `configs.json`, `ssh_credentials.json`, `known_hosts.json`, the routing rules, the geodata,
//   the logs and the WebView2 profile.
//
// THE ROOT IS NAMED, NOT DERIVED — AND THAT IS A CONFIDENTIALITY REQUIREMENT
//   The folder is spelled out: not built from `CARGO_PKG_NAME`, and above all not taken from the
//   executable's own location. `resolve_data_root` is still HANDED the executable and
//   deliberately IGNORES it (see its doc comment below for why the parameter survives).
//
//   The reason is an ACL, measured rather than assumed:
//
//       C:\Program Files
//         S-1-5-32-545 (BUILTIN\Users) | ReadAndExecute, Synchronize | Allow | inherit=None
//         S-1-5-32-545 (BUILTIN\Users) | 0xA0000000 (GENERIC_READ|GENERIC_EXECUTE)
//                                      | Allow | inherit=ContainerInherit, ObjectInherit
//                                              propagate=InheritOnly
//       %LOCALAPPDATA%
//         no S-1-5-32-545 ACE at all
//
//   Phase 32 moved the INSTALL into `Program Files` (`installMode: perMachine`, D-03). The second
//   ACE above is inherit-only over BOTH child containers and child objects, so a data root
//   derived from the executable now falls inside that inheritance — and the plaintext
//   `ssh_credentials.json` would be readable by every account on the machine. A rule that follows
//   the binary cannot be used once the binary lives somewhere the data must not.
//
//   The users' files did not have to move for this, which is the whole reason it was affordable:
//   the pre-32 install directory and the data root are THE SAME PATH, so the binaries left the
//   folder and the data stayed exactly where it was (D-05).
//
// WHY IT IS *NOT* A SEPARATE `%LOCALAPPDATA%\TrustTunnel\ClientPro`
//   Phase 30.1 plan 08 moved it there. The move was REVERTED on 2026-08-28. Two independent
//   reasons, and the first alone is sufficient:
//
//   1. THE DECISION, and it is final. The folder a user finds under `%LOCALAPPDATA%`
//      must carry the product's own name — «TrustTunnel Client Pro», one folder — not an
//      invented vendor\edition pair. That is a product call, not an engineering trade. Do not
//      reintroduce the split, and do not keep half of it "just in case".
//
//   2. THE MOVE SHIPPED A REGRESSION on a real Windows install. `configs.json` stores each server
//      as an ABSOLUTE path. The first-launch migration copied that file as an opaque blob
//      without rewriting the paths inside it, so all five entries still pointed at the old
//      root. The path-confinement guard — which follows THIS helper by construction, see
//      `user_data_dir` below — then refused every one of them and «Подключить» did nothing, in
//      silence. The same migration also copied the `.toml` files, which the folder-as-truth
//      reconciler adopted as brand-new servers: ten manifest rows for five real servers, of
//      which the UI showed the dead twin. Diagnosed in full, 33 verified findings, in
//      `.planning/phases/30.1-*/30.1-REGRESSION.md`.
//
//      THE STANDING RULE THAT REGRESSION LEFT BEHIND, and it outlived the revert: any change to
//      this helper's answer must bring the DATA with it and REWRITE the absolute paths inside
//      `configs.json` rather than copy the file. Phase 32 escaped that cost only because its old
//      and new answers name the same directory — it was a rule change, not a migration. A future
//      change without that property inherits the entire defect, so it is recorded here rather
//      than rediscovered in production.

// RECORDED LIMITATION — WHOSE local-app-data location? (32-FIX-03)
//
// The rule below says «the product folder under the per-user application-data location». It does
// not say WHICH user, and on one configuration that is not the person using the app.
//
// The manifest is `requireAdministrator` (`trusttunnel.exe.manifest`, embedded by `build.rs`).
// Under OVER-THE-SHOULDER UAC on a standard-user machine — the person at the keyboard is not an
// administrator and somebody else supplies the credentials — Windows runs this process as the
// SUPPLYING ADMINISTRATOR, with that administrator's profile and environment. So `LOCALAPPDATA`
// names the administrator's folder, `data_adoption.rs`'s HKCU lookup reads the administrator's
// hive, and `task_scheduler::current_user_id` (32-FIX-01) reads the administrator's SID off the
// process token. Three answers, one substituted identity.
//
// BEFORE PHASE 32 THIS COULD NOT HAPPEN: the data root was one fixed absolute path, identical for
// every account. The relocation is what introduced the question.
//
// IT IS INVISIBLE ON A MACHINE WHERE THE USER IS A LOCAL ADMINISTRATOR — split-token elevation
// keeps the same SID, the same `%LOCALAPPDATA%` and the same `HKCU` — which is why no gate here
// catches it and why it is written down instead. Blast radius, named rather than gestured at:
//   1. the user's servers, passwords and settings live in the administrator's profile;
//   2. a DIFFERENT elevating administrator next time is a different root — «my servers vanished»;
//   3. the logon task fires at the administrator's logon, so the switch promises a startup that
//      will not happen — the exact defect this phase existed to fix, in the one case it cannot
//      see;
//   4. first-launch adoption repeats per elevating administrator (its marker is per-profile too).
//
// WHY THIS IS RECORDED AND NOT «FIXED». Every way to identify the real interactive user from an
// elevated process is the heuristic `32-CONTEXT.md` D-08 rejected — and D-08's ground, «a
// heuristic adjacent to a data-destroying step is not a fix», is STRONGER here, not weaker: the
// data root sits next to `data_adoption`, which copies and rolls back the credential store, and a
// wrong answer is not «slightly off», it is that same «my servers vanished». D-08 was about the
// INSTALLER, and its answer was D-07 — adoption inside the app, «the only mechanism that runs as
// the real user BY CONSTRUCTION». Over-the-shoulder elevation is the single case where that «by
// construction» is false. The discovery is therefore not that the heuristic became acceptable; it
// is that D-07's premise is narrower than it was written.
//
// WHAT WOULD ACTUALLY CLOSE IT (backlog, not here): drop `requireAdministrator` from the manifest
// and elevate only the operations that need it, so the process always runs as the real user and
// the question disappears instead of being guessed at. That is real work — the VPN core spawn,
// the WinTUN adapter and the route edits all depend on those rights today.
//
// Full record, with the ACL measurements: `memory/security-posture.md`, «повышение через плечо».
// Made diagnosable rather than merely written down: `diagnostics.rs::data_root_report` prints the
// process account beside the resolved root.

/// The folder the user's data lives in, under the local-app-data location.
///
/// Spelled out rather than derived from `CARGO_PKG_NAME` (`trusttunnel`) or from the executable's
/// file name, because it must match the NSIS `PRODUCTNAME` define — `tauri.conf.json`'s
/// `productName`, "TrustTunnel Client Pro" — which is what the pre-32 install directory was named
/// and therefore where existing users' files already are. A derived name that differed by one
/// character would present as an empty server list with every `.toml` still on disk.
///
/// Stable because the application version is frozen and the product name with it. Light's mirror
/// will carry "TrustTunnel Client Light" here; the two editions must never share a data root.
pub(crate) const PRODUCT_DATA_FOLDER: &str = "TrustTunnel Client Pro";

/// Where the data root was resolved FROM. Reported by diagnostics so the answer a running app is
/// actually using is nameable rather than inferred.
///
/// The variant IS the diagnostic. That is why phase 32 added a new one rather than reusing
/// `ExecutableDir` for the new source: a machine that answered from the local-app-data location
/// and a machine that answered from beside the executable are in genuinely different states, and
/// a diagnostics bundle that spelled both the same way could not tell them apart.
///
/// **There is exactly one production variant, and that is the point** (32-FIX-03). A failed
/// lookup no longer has an origin because it no longer has a path — see [`DataRootRefusal`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DataRootOrigin {
    /// `%LOCALAPPDATA%\TrustTunnel Client Pro` — the expected answer on every install.
    LocalAppData,
    //
    // `WorkingDirFallback` USED TO LIVE HERE and was DELETED by 32-FIX-03, deliberately, rather
    // than left as a variant nothing constructs. It named «the process working directory, because
    // the local-app-data location could not be resolved» — a state that can no longer exist,
    // because that answer is now a [`DataRootRefusal`] instead of a path. The variant is gone so
    // the degraded root is unrepresentable by TYPE rather than forbidden by comment: a future
    // edit cannot re-introduce the fallback without also re-introducing a name for it, and the
    // absence of the name is where the reader asks why.
    //
    /// A test override. Only reachable under `cfg(test)`.
    #[cfg(test)]
    TestOverride,
}

/// Why the data root could not be resolved — the one answer that must NEVER be a path.
///
/// A failure gets its own vocabulary rather than a degraded path, for the reason the phase-32
/// adversarial probe measured rather than guessed: with `LOCALAPPDATA` and `USERPROFILE` unset,
/// the rule answered a RELATIVE `"."`, and this phase's own logon Scheduled Task sets the process
/// working directory to the INSTALL directory. So on that branch the app wrote the plaintext
/// credential store, the known hosts and the routing rules into `Program Files` — where, by the
/// ACL measured in the module comment above, every account on the machine can read them. The
/// path-confinement guard canonicalized the same relative root and followed the data there, so it
/// defended the wrong directory instead of catching the move.
///
/// That is precisely the trade `30.1-*/deferred-items.md` § item 6 forbids: «relocating the
/// install without also moving the data converts a local-elevation fix into a credential-
/// disclosure regression». This phase performed the relocation; the degraded branch quietly
/// undid it. Refusing is strictly better than starting: an application that does not start is a
/// visible, reversible failure, and silently writing secrets into a world-readable directory is
/// neither.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DataRootRefusal {
    /// Neither `LOCALAPPDATA` nor `USERPROFILE` named a location at all.
    LocalAppDataUnresolvable,
    /// One of them answered, but with something that is not an ABSOLUTE path.
    ///
    /// A separate arm because it is a separate hazard and the `None` check alone does not cover
    /// it. The variables are inherited and whatever launched this process chooses them, so
    /// `LOCALAPPDATA=.`, `LOCALAPPDATA=\Users\bob\AppData\Local` (rooted, but on whichever drive
    /// happens to be current) and `LOCALAPPDATA=C:AppData` (drive-relative, resolved against the
    /// current directory on C:) all reach the same destination as the `None` branch — a data root
    /// that moves with the working directory — while passing an `is_some()` test.
    LocalAppDataNotAbsolute,
}

/// What the user is told when the data root cannot be resolved.
///
/// A pure function, compiled in both builds, so the one message a user will ever see for this
/// failure is assertable — [`refuse_to_start`] itself ends the process and cannot be unit-tested.
///
/// **D-29.** It carries no path and no file name: not the credential store's, not the data root's
/// (there is none — that is the failure), not the working directory it would otherwise have
/// degraded to. The cause is named by ENVIRONMENT VARIABLE NAME, which is public knowledge and
/// cannot echo anything the user typed.
pub(crate) fn refusal_message(why: DataRootRefusal) -> String {
    let cause = match why {
        DataRootRefusal::LocalAppDataUnresolvable => {
            "Windows не сообщил, где находится личная папка пользователя — переменные \
             LOCALAPPDATA и USERPROFILE пусты."
        }
        DataRootRefusal::LocalAppDataNotAbsolute => {
            "Windows сообщил расположение личной папки пользователя не полным путём — \
             переменные LOCALAPPDATA и USERPROFILE указывают не на абсолютный путь."
        }
    };
    format!(
        "Не удалось определить папку для данных программы.\n\n{cause}\n\nПрограмма не будет \
         запущена. Иначе она сохранила бы ваши серверы, пароли и настройки рядом с собой — в \
         папке, которую могут прочитать все учётные записи этого компьютера."
    )
}

/// Refuse to start, having told the user why, because there is nowhere safe to keep the data.
///
/// **Why refusing beats every alternative.** Continuing would write the plaintext credential
/// store into the process working directory, which under this phase's own logon Scheduled Task is
/// the install directory under `Program Files`. Degrading to some other absolute fallback would
/// be the same silent substitution wearing a tidier hat — the user's servers would appear to have
/// vanished, with no error anywhere, which is the exact failure mode the `DataRootOrigin`
/// diagnostics were added to make explicable.
///
/// The message goes to a native message box rather than to `app.log`, and that is forced rather
/// than chosen: the log file itself lives under the data root, so at this point there is nowhere
/// to write it. `MessageBoxW` costs no new dependency — `windows-sys` already carries
/// `Win32_UI_WindowsAndMessaging` for the icon extraction in `processes.rs`.
///
/// Unreachable in a test build (`cfg(not(test))`), which is deliberate: a unit test that reached
/// it would take the whole test binary down with it.
#[cfg(not(test))]
fn refuse_to_start(why: DataRootRefusal) -> ! {
    let text = refusal_message(why);
    eprintln!("[data-root] {text}");

    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            MessageBoxW, MB_ICONERROR, MB_OK, MB_SETFOREGROUND,
        };
        let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
        let body = wide(&text);
        let caption = wide("TrustTunnel Client Pro");
        MessageBoxW(
            std::ptr::null_mut(),
            body.as_ptr(),
            caption.as_ptr(),
            MB_OK | MB_ICONERROR | MB_SETFOREGROUND,
        );
    }

    std::process::exit(1);
}

/// The local-app-data location for the CURRENT user, or `None` if the environment will not say.
///
/// `USERPROFILE\AppData\Local` is tried second because `LOCALAPPDATA` is absent in a few real
/// contexts — a service account's minimal environment, some CI containers — while `USERPROFILE`
/// survives them. Both are read rather than resolved through `SHGetKnownFolderPath` because this
/// stays a pure-enough rule with no FFI, and because the two answers agree on every desktop
/// Windows install; the degraded origin below covers the case where neither answers.
fn local_app_data_dir() -> Option<std::path::PathBuf> {
    if let Some(v) = std::env::var_os("LOCALAPPDATA") {
        if !v.is_empty() {
            return Some(std::path::PathBuf::from(v));
        }
    }
    std::env::var_os("USERPROFILE")
        .filter(|v| !v.is_empty())
        .map(|v| std::path::PathBuf::from(v).join("AppData").join("Local"))
}

/// The rule itself, with the one lookup that can fail hoisted into the caller's hands.
///
/// Separated from [`resolve_data_root`] so the REFUSING branches are assertable WITHOUT mutating
/// the process environment: forcing `LOCALAPPDATA` to be absent would mean `std::env::set_var`,
/// which races every other test in the binary and is `unsafe` from Rust 2024 for that exact
/// reason. Handing this function its input directly states the same fact with no shared state —
/// and, for this module above all, resolves no real data root while doing so.
///
/// **Every `Ok` answer is an ABSOLUTE path, and that is the contract 32-FIX-03 added.** The rule
/// used to hand back `"."` when the environment said nothing; under this phase's logon Scheduled
/// Task the process working directory is the install directory, so that answer wrote the
/// plaintext credential store into `Program Files`. Both refusal arms exist because both reach
/// that destination — one by saying nothing, one by saying something relative.
fn data_root_from(
    local_app_data: Option<std::path::PathBuf>,
) -> Result<(std::path::PathBuf, DataRootOrigin), DataRootRefusal> {
    let dir = local_app_data.ok_or(DataRootRefusal::LocalAppDataUnresolvable)?;

    // The second arm, and it is not the same check twice. `Path::is_absolute` on Windows requires
    // BOTH a prefix and a root, so it rejects the three shapes an `is_some()` test waves through:
    // a plainly relative value, a rooted-but-driveless `\Users\...` (which lands on whichever
    // drive is current) and a drive-relative `C:AppData` (which lands on the current directory of
    // C:). All three move with the working directory exactly as `"."` did.
    if !dir.is_absolute() {
        return Err(DataRootRefusal::LocalAppDataNotAbsolute);
    }

    Ok((dir.join(PRODUCT_DATA_FOLDER), DataRootOrigin::LocalAppData))
}

/// The resolution rule: where does the user's data go?
///
/// **The data root is NAMED, not derived.** It is `%LOCALAPPDATA%\TrustTunnel Client Pro`, and
/// the executable's own location has no say in it. Before phase 32 this function answered the
/// executable's parent directory, which was the same folder — the install itself lived under
/// `%LOCALAPPDATA%`. The install moves to Program Files with `installMode: perMachine`, and that
/// directory's ACL grants `BUILTIN\Users` read by inheritance over both child containers and
/// child objects (measured; see the module comment above). A data root left beside the executable
/// there would put the plaintext `ssh_credentials.json` where every account on the machine can
/// read it. Hence the rule changes in the same commit as the install-mode flip, never separately.
///
/// **The user's files do not move.** The pre-32 install directory and the new data root are the
/// same path — `%LOCALAPPDATA%\TrustTunnel Client Pro` — so on an existing machine the binaries
/// leave the folder and the data stays exactly where it is. That identity is D-05 and it is what
/// makes this a rule change rather than a migration.
///
/// Split out from [`user_data_dir_with_origin`] for one reason — the production branch of that
/// function is `cfg(not(test))`, so a unit test cannot reach it. This helper is compiled in
/// both builds, so the rule is directly assertable instead of being taken on trust. It does
/// no filesystem I/O; creating the directory is the caller's job.
///
/// `pub(crate)` for one further reason: `lifecycle.rs` asserts that the data root and the pid
/// directory are NOT the same place, which is the invariant refusing the pre-32 identity. That
/// assertion has to be able to call this from outside the module.
///
/// **The parameter is retained although the answer no longer depends on it.** It is what lets
/// that invariant test say «given THIS executable, the data root is not its directory» — a
/// function that did not accept an executable could not express the negative at all, and the
/// negative is the whole point. It also keeps every call site compiling unchanged.
pub(crate) fn resolve_data_root(
    _exe: Option<std::path::PathBuf>,
) -> Result<(std::path::PathBuf, DataRootOrigin), DataRootRefusal> {
    data_root_from(local_app_data_dir())
}

/// Resolve the data root and report which source answered.
///
/// Kept separate from [`user_data_dir`] so diagnostics can report a degraded origin without
/// re-deriving it.
pub fn user_data_dir_with_origin() -> (std::path::PathBuf, DataRootOrigin) {
    #[cfg(test)]
    {
        // Test isolation, and the reason it is `cfg(test)`-gated rather than a plain env read:
        // an environment variable that redirects where the app keeps its SSH credentials is an
        // injection surface, and this binary runs elevated (`requireAdministrator`). Gating it
        // to the test build removes the question entirely — the production binary contains no
        // such branch.
        //
        // The DEFAULT under test is a per-process temp directory, not whatever the production
        // rule would answer. Under `cargo test --lib` the executable is the test binary, so the
        // production rule points at `target/debug/deps` — shared by every test in the run, and
        // the same directory on a second concurrent `cargo test`. Tests that write configs and
        // credential files would collide there; worse, a test binary ever run from an INSTALL
        // directory would write into the user's live data. The sandbox removes both.
        if let Ok(o) = std::env::var("TT_DATA_DIR_OVERRIDE") {
            if !o.is_empty() {
                return (ensure_dir(std::path::PathBuf::from(o)), DataRootOrigin::TestOverride);
            }
        }
        let sandbox = std::env::temp_dir().join(format!("tt-test-data-{}", std::process::id()));
        (ensure_dir(sandbox), DataRootOrigin::TestOverride)
    }

    #[cfg(not(test))]
    {
        // The executable is still handed in although the rule no longer reads it — see
        // `resolve_data_root`'s doc comment for why the parameter is kept. Passing what
        // production actually has keeps this call identical in shape to the one the tests
        // exercise, so there is no untested spelling of the production path.
        //
        // The refusal is REACHED HERE and nowhere else, which is what makes it the whole
        // application's answer rather than one call site's: every artifact goes through
        // `user_data_dir()`, and `main()`'s FIRST statement is `init_data_root_early()`, whose
        // first act is to call it. So the refusal happens before Tauri, before WebView2, before
        // logging — before anything has written a byte.
        match resolve_data_root(std::env::current_exe().ok()) {
            Ok((root, origin)) => (ensure_dir(root), origin),
            Err(why) => refuse_to_start(why),
        }
    }
}

/// Create the root if it is missing and hand back the same path either way.
///
/// Best-effort on purpose: a caller that genuinely needs the directory (every writer) reports
/// its own error with far better context than a path helper could. What this buys is that the
/// directory EXISTS by the time the first writer runs — `save_sidecar_pid` uses a bare
/// `fs::write`, and `std::fs::canonicalize` (which every path-confinement root goes through)
/// fails outright on a missing directory, which would silently widen the guard to its
/// un-canonicalized fallback.
fn ensure_dir(p: std::path::PathBuf) -> std::path::PathBuf {
    let _ = std::fs::create_dir_all(&p);
    p
}

/// The application's data root. Every artifact the app writes at runtime lives here.
///
/// This is the single funnel: ~40 call sites and, critically, EVERY path-confinement root
/// (`commands/paths.rs`, `commands/config.rs`) derives from it, so the guards follow the data
/// automatically. That coupling is load-bearing IN BOTH DIRECTIONS, which is the lesson plan
/// 08 paid for: a guard left pointing at the old root refuses every config the app just wrote,
/// and DATA left pointing at the old root is refused by a guard that correctly moved. Whenever
/// this helper's answer changes, the data must be brought with it.
///
/// Phase 32 is the case where that cost nothing: the answer changed from «the executable's own
/// directory» to «`%LOCALAPPDATA%\TrustTunnel Client Pro`», and on every existing machine those
/// are the SAME path — the install lived there. The rule moved; the files did not (D-05).
///
/// **Do not add a second accessor beside this one**, not even "just for the migration". The
/// funnel is what makes the guards follow the data by construction; a parallel lookup is how
/// half the crate ends up pointing at the old root with nothing to catch it.
///
/// The read-only shipped resources (the sidecar binary, `wintun.dll`, the vcruntime DLLs) are
/// resolved separately even though they land in the same place today; see
/// `commands/vpn.rs::own_sidecar_path`, which resolves them from the executable directly
/// because it must stay byte-identical to what the spawner computes.
pub fn user_data_dir() -> std::path::PathBuf {
    user_data_dir_with_origin().0
}

// ── TOFU Host Key Verification ───────────────────
static PENDING_HOST_VERIFY: StdMutex<Option<oneshot::Sender<bool>>> = StdMutex::new(None);

#[derive(Clone, serde::Serialize)]
struct HostKeyVerifyPayload {
    host: String,
    fingerprint: String,
}

// ─── Event Payloads ────────────────────────────────

// #22 (06-uat) per-run generation stamp. The deploy-step / deploy-log events carry
// NO information about WHICH install run produced them, so the frontend listener could
// not distinguish a late/buffered event from a just-cancelled run from a fresh run's
// own event. After cancel→re-install that bled the old run's step rows into the new
// run's progress map (two yellow steps at once, a stale green/skipped row). The fix
// stamps every deploy event with the CURRENT run's opId; the frontend captures the
// opId it passed to deploy_server / fetch_server_config and drops any event whose opId
// does not match — so cross-run bleed is structurally impossible.
//
// CURRENT_DEPLOY_OP_ID holds the opId of the run that is allowed to emit right now.
// deploy_server / fetch_server_config STORE their op_id here at entry (before the first
// emit_step), and emit_step / emit_log READ it when building the payload. This is safe
// against a stale-run overwrite because the frontend is single-flight (the no-overlap
// guard in handleDeploy means only one deploy command runs at a time) AND cancel awaits
// uninstall_server, which kills the old deploy's server-side process group BEFORE the
// new run starts — so the old emitter is dead before the new run sets this value. A
// value of 0 means "unstamped" (no deploy run has set it, or a legacy caller that did
// not pass an opId); the frontend treats 0 as "accept" so existing flows are unchanged.
pub static CURRENT_DEPLOY_OP_ID: AtomicU64 = AtomicU64::new(0);

/// Set the active deploy generation so subsequent emit_step / emit_log events are
/// stamped with this run's opId. Called once at the top of deploy_server /
/// fetch_server_config, before any event is emitted.
pub(crate) fn set_deploy_op_id(op_id: u64) {
    CURRENT_DEPLOY_OP_ID.store(op_id, Ordering::SeqCst);
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployStepPayload {
    pub step: String,
    pub status: String,
    pub message: String,
    // #22: the run generation this event belongs to (0 = unstamped; see CURRENT_DEPLOY_OP_ID).
    pub op_id: u64,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployLogPayload {
    pub message: String,
    pub level: String,
    // #22: the run generation this event belongs to (0 = unstamped; see CURRENT_DEPLOY_OP_ID).
    pub op_id: u64,
}

// ─── Endpoint Settings (from GUI wizard) ───────────

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointSettings {
    pub listen_address: String,
    pub vpn_username: String,
    pub vpn_password: String,
    pub cert_type: String,
    pub domain: String,
    // DC-01: the `client_name` field was REMOVED — nothing read it. The client config
    // filename is derived from `vpn_username` via client_config_filename(&vpn_username).
    // Serde has no deny_unknown_fields, so a frontend still sending `clientName` is
    // harmlessly ignored.
    #[serde(default)]
    pub email: String,
    // 06-uat install-wizard slimming: the ICMP and IPv6 toggles were HIDDEN in the
    // wizard (rarely useful for a non-technical operator) but their feature stays ON.
    // Their `icmp_enable` / `ipv6_available` EndpointSettings fields were REMOVED — the
    // safe ON defaults are now hard-coded as the constants ICMP_ENABLE_DEFAULT /
    // IPV6_AVAILABLE_DEFAULT in deploy.rs's build_intended_vpn_toml + build_configure_commands,
    // so the written vpn.toml ([icmp] section + ipv6_available = true) is unchanged. The
    // Metrics (Prometheus), SOCKS5 upstream and Allow-private-network settings were
    // REMOVED from the wizard entirely (UI + state + validators + their fields here);
    // allow_private_network_connections is now hard-coded `false` in build_intended_vpn_toml.
    #[serde(default)]
    pub cert_chain_path: String,
    #[serde(default)]
    pub cert_key_path: String,
    // D-10 (06-09): the auth-failure code chooser (top-level, default 407), value-constrained by
    // the EXISTING sanitize::validate_auth_status_code (no duplicate validator). Schema-exact per
    // CONFIGURATION.md at the pinned tag — v1.1.0 since SRV-01, where the accepted set is
    // 403|404|405|407 (upstream widened it in v1.0.41). The install wizard still offers only
    // 407/405: widening the validator matched it to the endpoint, it did not add a setting.
    #[serde(default = "default_407")]
    pub auth_failure_status_code: u16,
    // CAMOUFLAGE REMOVED: the reverse-proxy / camouflage fields (reverse_proxy_enable,
    // reverse_proxy_auto, reverse_proxy_address, reverse_proxy_path_mask,
    // reverse_proxy_h3_compat) were removed along with the rest of the camouflage feature,
    // dropped against the then-pinned v1.0.33 — see the CAMOUFLAGE REMOVED record at the top of
    // `ssh/deploy.rs` for what the v1.1.0 pin does and does not change. build_intended_vpn_toml no longer
    // emits a `[reverse_proxy]` section. Serde has no deny_unknown_fields, so a frontend
    // still sending the old `reverseProxy*` keys is harmlessly ignored.
    // Best-effort GeoIP country code (serde camelCase → JS key `countryCode`) used ONLY
    // to brand the LOCAL client-config filename `[<CC>_]TrustTunnel_<login>.toml` in
    // deploy_export_config, matching the Save-As dialog default. Optional/unvalidated
    // here on purpose: client_config_filename only accepts an exactly-two-ASCII-letter
    // value and ignores anything else, so a junk/None value never reaches the path.
    #[serde(default)]
    pub country_code: Option<String>,
    // WIZARD-06 / D-01: install-time server-hardening toggles, default ON. These are the
    // recommended secure baseline (ufw + fail2ban), so a legacy/omitting payload must STILL
    // provision them — hence `#[serde(default = "default_true")]`, not bare `#[serde(default)]`
    // (which would default a missing key to `false` and silently skip hardening).
    //
    // SAFETY-01 rationale (RESEARCH Pitfall 2): these are `bool` — they cannot carry shell
    // metacharacters and only GATE a call, so they add NO new SSH-reaching string surface and
    // need NO new `sanitize.rs` validator. The only string reaching the firewall command is
    // `params.port: u16`, already typed and validated at the `ssh_connect` chokepoint.
    #[serde(default = "default_true")]
    pub enable_firewall: bool,
    #[serde(default = "default_true")]
    pub enable_fail2ban: bool,
}

fn default_407() -> u16 { 407 }
fn default_true() -> bool { true }

// ─── Known Hosts (TOFU) ───────────────────────────

fn known_hosts_path() -> std::path::PathBuf {
    user_data_dir().join("known_hosts.json")
}

fn load_known_hosts() -> std::collections::HashMap<String, String> {
    std::fs::read_to_string(known_hosts_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_known_hosts(hosts: &std::collections::HashMap<String, String>) {
    if let Ok(json) = serde_json::to_string_pretty(hosts) {
        let _ = std::fs::write(known_hosts_path(), json);
    }
}

pub fn forget_known_host(host: &str, port: u16) {
    let key = format!("{host}:{port}");
    let mut hosts = load_known_hosts();
    if hosts.remove(&key).is_some() {
        save_known_hosts(&hosts);
    }
}

/// Whether a STORED host fingerprint differs from the LIVE one presented by the
/// server (D-09, Gemini #11). Pure fn so the changed-key decision is unit-testable
/// under `cargo test --lib` without a live SSH session. A differing fingerprint means
/// the server's host key changed (reinstall — or, in the worst case, a MITM), which
/// `check_server_key` records on the SshHandler flag so `ssh_connect` can surface
/// `SSH_HOST_KEY_CHANGED` distinctly from an unknown (never-seen) key.
pub(crate) fn fingerprints_differ(stored: &str, live: &str) -> bool {
    stored != live
}

#[tauri::command]
pub fn confirm_host_key(accepted: bool) {
    // WR-05 fix: tolerate poisoned Mutex. If a prior thread panicked while
    // holding this lock, `.unwrap()` would panic again (process crash triggered
    // by frontend IPC input). Recover the inner value as other call sites do
    // (see lib.rs:225, logging.rs:156, commands/activity_log.rs:66).
    let mut pending = PENDING_HOST_VERIFY.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(tx) = pending.take() {
        let _ = tx.send(accepted);
    }
}

// ─── SSH Handler ───────────────────────────────────

pub struct SshHandler {
    host_key: String,
    app: Option<tauri::AppHandle>,
    // D-09 / Gemini #11: `check_server_key` is a russh trait method that can only
    // return a bool — when it detects a CHANGED host key it returns Ok(false) but the
    // "why" never reaches `ssh_connect`. This shared flag carries that signal out: the
    // changed-key arm sets it true before returning Ok(false), and `ssh_connect` reads
    // it AFTER the connection aborts to map the failure to SSH_HOST_KEY_CHANGED
    // (authoritative — does NOT depend on the unreliable russh 0.46 error string,
    // RESEARCH Pitfall 5). An Arc<AtomicBool> so it survives the move into russh and is
    // readable from the connecting task after the handler is consumed.
    host_key_changed: Arc<AtomicBool>,
}

// russh 0.60 switched `client::Handler` to native `async fn` (RPITIT, returning
// `impl Future + Send`) — it is no longer an `#[async_trait]` trait. Applying the
// async_trait attribute here boxes the future and produces a lifetime/signature
// mismatch against the trait (E0195). We implement the method as a plain `async fn`.
impl client::Handler for SshHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        // russh 0.60 merged russh-keys into `russh::keys` and the host-key param is now
        // the re-exported ssh-key `PublicKey` (was `&russh_keys::key::PublicKey` in 0.46).
        server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        // ssh-key's `fingerprint` takes a HashAlg and returns a `Fingerprint` (was a bare
        // `String` in russh-keys 0.46). Mirror server_ssh_key.rs:51 exactly: SHA-256.
        let fingerprint = server_public_key
            .fingerprint(russh::keys::ssh_key::HashAlg::Sha256)
            .to_string();
        let mut hosts = load_known_hosts();

        match hosts.get(&self.host_key) {
            None => {
                if let Some(ref app) = self.app {
                    // Create oneshot channel for user response
                    let (tx, rx) = oneshot::channel();
                    {
                        // WR-05 fix: tolerate poisoned Mutex (see confirm_host_key).
                        let mut pending = PENDING_HOST_VERIFY.lock().unwrap_or_else(|e| e.into_inner());
                        *pending = Some(tx);
                    }

                    // Emit event to frontend
                    app.emit("ssh-host-key-verify", HostKeyVerifyPayload {
                        host: self.host_key.clone(),
                        fingerprint: fingerprint.clone(),
                    }).ok();

                    // Wait for user response with 60-second timeout
                    let accepted = tokio::time::timeout(
                        std::time::Duration::from_secs(60),
                        rx,
                    ).await
                        .unwrap_or(Ok(false))   // timeout -> reject
                        .unwrap_or(false);       // channel dropped -> reject

                    if accepted {
                        hosts.insert(self.host_key.clone(), fingerprint);
                        save_known_hosts(&hosts);
                    }
                    Ok(accepted)
                } else {
                    // No AppHandle (e.g. test context) — auto-accept
                    eprintln!("[SSH] New host {}: fingerprint {fingerprint} (auto-accepted, no UI)", self.host_key);
                    hosts.insert(self.host_key.clone(), fingerprint);
                    save_known_hosts(&hosts);
                    Ok(true)
                }
            }
            Some(stored) if stored == &fingerprint => {
                eprintln!("[SSH] Host {} fingerprint verified", self.host_key);
                Ok(true)
            }
            // A stored fingerprint that DIFFERS from the live one → CHANGED host key
            // (the equal case is handled above). fingerprints_differ is the pure,
            // unit-tested predicate (D-09 / Gemini #11).
            Some(stored) if fingerprints_differ(stored, &fingerprint) => {
                eprintln!(
                    "[SSH] WARNING: Host key for {} has CHANGED!\n  Expected: {stored}\n  Got:      {fingerprint}\n  \
                     Connection rejected. If the server was reinstalled, trust the new key via the recovery screen.",
                    self.host_key
                );
                // D-09 / Gemini #11: record the CHANGED-key signal so ssh_connect can
                // surface SSH_HOST_KEY_CHANGED after the connection aborts. We return
                // Ok(false) (reject) — trust is NEVER granted silently here; it happens
                // only via the explicit RecoveryStep "trust the new key" action
                // (round-2 finding B: the old auto-forget is removed).
                self.host_key_changed.store(true, Ordering::SeqCst);
                Ok(false)
            }
            // Logically unreachable (the two guards above partition the Some space on
            // equality), but the compiler cannot prove guard exhaustiveness — a safe
            // reject keeps the match total without ever silently accepting a key.
            Some(_) => Ok(false),
        }
    }
}

// ─── Shared SSH helpers ──────────────────────────────

/// Detect whether the SSH session is root. Returns "" if root, "sudo " otherwise.
pub async fn detect_sudo(
    handle: &client::Handle<SshHandler>,
    app: &tauri::AppHandle,
) -> &'static str {
    let (whoami, _) = exec_command(handle, app, "whoami")
        .await
        .unwrap_or_default();
    if whoami.trim() == "root" { "" } else { "sudo " }
}

/// Build a complete client TOML config wrapping an endpoint section.
/// `source_comment` is embedded in the file header (e.g. "Setup Wizard", "server 1.2.3.4").
/// Applies anti_dpi=true normalization automatically.
pub fn build_client_config(endpoint_section: &str, source_comment: &str) -> String {
    let config = format!(
        r#"# TrustTunnel Client Configuration
# {source_comment}

loglevel = "info"
vpn_mode = "general"
killswitch_enabled = true
killswitch_allow_ports = [67, 68]
post_quantum_group_enabled = true

[endpoint]
{endpoint_section}

[listener.tun]
mtu_size = 1280
change_system_dns = true
included_routes = ["0.0.0.0/0"]
excluded_routes = []
"#
    );
    config.replace("anti_dpi = false", "anti_dpi = true")
}

// ─── Helpers ───────────────────────────────────────

pub(crate) fn emit_step(app: &tauri::AppHandle, step: &str, status: &str, message: &str) {
    eprintln!("[deploy] step={step} status={status} msg={message}");
    // #22: stamp the event with the active run generation so the frontend can drop a
    // late/stale event from a previous (cancelled) run instead of bleeding it into a
    // fresh run's progress map.
    let op_id = CURRENT_DEPLOY_OP_ID.load(Ordering::SeqCst);
    app.emit(
        "deploy-step",
        DeployStepPayload {
            step: step.into(),
            status: status.into(),
            message: message.into(),
            op_id,
        },
    )
    .ok();
}

/// Sink-formatting seam for the deploy-log channel (S-3 / SAFETY-02 / D-29).
///
/// This is the single point that produces the FINAL strings handed to BOTH
/// deploy-log sinks. It returns the two shapes the sinks actually consume:
///
/// - `.0` = the `eprintln!` stderr line, `[deploy-log] [{level}] {message}`
///   (prefix preserved byte-identical so nothing that scrapes stderr changes
///   shape).
/// - `.1` = the bare message that goes into the `deploy-log` Tauri event
///   payload's `message` field (the frontend renders this verbatim and parses
///   `\b(\d+)\s*%`; it must stay prefix-free, so we keep it bare).
///
/// `emit_log` routes both sinks through this seam so the redaction below cannot
/// be bypassed on one of the two paths.
///
/// `diagnose_server` / `get_server_config` stream the output of
/// `cat .../vpn.toml` (which contains `password = "…"` lines) through `emit_log`
/// line by line. Before this seam sanitized, the raw line reached stderr and the
/// frontend event unredacted. We apply `crate::logging::sanitize` here — the SAME
/// redaction the activity-log file-writer (`commands::activity_log`) uses — so the
/// secret never crosses the host log boundary on either sink. sanitize() is a
/// no-op on lines that are not `key = value`-shaped, so non-secret log lines are
/// unchanged.
///
/// Returns `(stderr_line, event_message)`.
fn format_deploy_log_line(level: &str, message: &str) -> (String, String) {
    let safe = crate::logging::sanitize(message);
    let stderr_line = format!("[deploy-log] [{level}] {safe}");
    (stderr_line, safe)
}

pub(crate) fn emit_log(app: &tauri::AppHandle, level: &str, message: &str) {
    if message.trim().is_empty() {
        return;
    }
    // Both sinks consume the seam's sanitized output so the redaction is
    // identical and cannot be bypassed on one path (S-3 / SAFETY-02).
    let (stderr_line, event_message) = format_deploy_log_line(level, message);
    eprintln!("{stderr_line}");
    // #22: stamp the log event with the active run generation (same rationale as emit_step).
    let op_id = CURRENT_DEPLOY_OP_ID.load(Ordering::SeqCst);
    app.emit(
        "deploy-log",
        DeployLogPayload {
            // Bare sanitized message — frontend renders this verbatim and parses
            // it for percent; the stderr prefix must NOT leak into the UI.
            message: event_message,
            level: level.into(),
            op_id,
        },
    )
    .ok();
}

// ─── SSH Connection ────────────────────────────────

// Adding the D-06 `auth_method` param pushed this past clippy's 7-arg threshold.
// These are flat connection inputs mirroring the SSH handshake (host/port/user/
// password/key_path/key_data/auth_method/app); bundling them into a struct buys
// nothing here, so we silence the lint for this one function (matches the
// module-wide allow on ssh_commands.rs).
#[allow(clippy::too_many_arguments)]
pub async fn ssh_connect(
    host: &str,
    port: u16,
    ssh_user: &str,
    ssh_password: &str,
    key_path: Option<&str>,
    key_data: Option<&str>,
    auth_method: Option<&str>,
    app: Option<tauri::AppHandle>,
) -> Result<client::Handle<SshHandler>, String> {
    // SAFETY-01 (S-04) — validate the operator-typed connect inputs at the IPC
    // boundary BEFORE they are used. `host` reaches a remote shell command later
    // (the `-a {addr}` export, deploy.rs) and `ssh_user` crosses into russh's native
    // userauth + the pool cache key; whitelist-validate both here so a metacharacter
    // payload (`host;rm -rf /`) is refused at the single connect chokepoint rather
    // than relying on each downstream call site to re-validate. `auth_method` is
    // constrained to the explicit enum here (finding H) — `None` is allowed (the
    // legacy/internal Option<String> back-compat path, round-3 LOW E).
    sanitize::validate_ssh_host(host).map_err(|e| format!("SSH_INVALID_HOST|{e}"))?;
    sanitize::validate_ssh_user(ssh_user).map_err(|e| format!("SSH_INVALID_USER|{e}"))?;
    sanitize::validate_auth_method(auth_method).map_err(|e| format!("SSH_INVALID_AUTH_METHOD|{e}"))?;

    let config = Arc::new(client::Config {
        inactivity_timeout: Some(std::time::Duration::from_secs(300)),
        ..Default::default()
    });

    // D-09 / Gemini #11: share a host_key_changed flag with the handler so we can read
    // it AFTER the connection aborts and surface SSH_HOST_KEY_CHANGED authoritatively
    // (the russh error string does not cleanly separate changed-vs-unknown keys —
    // RESEARCH Pitfall 5). The Arc lets the flag outlive the handler's move into russh.
    let host_key_changed = Arc::new(AtomicBool::new(false));
    let connect_fut = client::connect(config, (host, port), SshHandler {
        host_key: format!("{host}:{port}"),
        app,
        host_key_changed: host_key_changed.clone(),
    });
    let mut handle = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        connect_fut,
    )
    .await
    .map_err(|_| format!("SSH_TIMEOUT|{host}:{port}"))?
    .map_err(|e| {
        // AUTHORITATIVE changed-key signal (Gemini #11): if check_server_key recorded a
        // CHANGED host key, the connection aborts here — read the flag first and map to
        // SSH_HOST_KEY_CHANGED regardless of what the russh error string says. The
        // UnknownKey string match below stays only as a best-effort fallback.
        if host_key_changed.load(Ordering::SeqCst) {
            return "SSH_HOST_KEY_CHANGED".to_string();
        }
        let msg = e.to_string();
        let lower = msg.to_lowercase();
        if msg.contains("UnknownKey") || msg.contains("unknown key") {
            "SSH_HOST_KEY_CHANGED".to_string()
        } else if lower.contains("failed to lookup address")
            || lower.contains("dns error")
            || lower.contains("name or service not known")
            || lower.contains("no such host is known")
        {
            format!("SSH_DNS_FAILED|{host}")
        } else if lower.contains("network is unreachable")
            || lower.contains("enetunreach")
        {
            format!("SSH_NETWORK_UNREACHABLE|{host}")
        } else if lower.contains("connection refused")
            || lower.contains("econnrefused")
            || lower.contains("actively refused")
        {
            format!("SSH_CONNECTION_REFUSED|{host}|{port}")
        } else if lower.contains("handshake")
            || lower.contains("key exchange")
            || lower.contains("kex")
            || lower.contains("negotiate")
        {
            format!("SSH_TLS_HANDSHAKE_FAILED|{host}")
        } else {
            format!("SSH_CONNECT_FAILED|{e}")
        }
    })?;

    // D-06: send ONLY the chosen auth method. Sending both a password AND a key
    // (the legacy sequence below) was the root cause of "key rejected even though
    // the password works" — the backend tried the key first and reported its
    // rejection. The wizard now passes an explicit `auth_method`; internal callers
    // pass None and keep the legacy sequence (back-compat). russh 0.46 returns only
    // `Ok(bool)` from `authenticate_*`, so D-07 steering downstream is a HEURISTIC
    // on which method we attempted, never a read of a server method list (Pitfall 3).
    let has_key = key_path.map(|k| !k.is_empty()).unwrap_or(false)
        || key_data.map(|k| !k.is_empty()).unwrap_or(false);
    let has_password = !ssh_password.is_empty();
    let plan = auth_plan(auth_method, has_key, has_password);

    // D-08: a missing key file / undecodable pasted key returns an ACTIONABLE
    // re-enter signal (`SSH_KEY_REENTER_REQUIRED`) instead of the opaque
    // `SSH_KEY_LOAD_FAILED` dead end. Never interpolate the key material itself into
    // the error (D-29/D-10) — only a stable code (the path/`pasted` tag is safe).
    async fn try_key_auth(
        handle: &mut client::Handle<SshHandler>,
        ssh_user: &str,
        key_path: Option<&str>,
        key_data: Option<&str>,
    ) -> Result<Option<bool>, String> {
        if let Some(kp) = key_path {
            if !kp.is_empty() {
                let key = russh::keys::load_secret_key(kp, None)
                    .map_err(|_| "SSH_KEY_REENTER_REQUIRED|file".to_string())?;
                // russh 0.60: authenticate_publickey takes a `PrivateKeyWithHashAlg`
                // (None hash-alg works for Ed25519; RSA would need Sha256/Sha512) and
                // returns an `AuthResult` enum instead of a bare `bool`. We map
                // Success → true so the downstream Some(true)/Some(false) arms (and
                // their exact error codes) stay byte-for-byte unchanged.
                let result = handle
                    .authenticate_publickey(
                        ssh_user,
                        russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key), None),
                    )
                    .await
                    .map_err(|e| format!("SSH_KEY_AUTH_ERROR|{e}"))?;
                let ok = matches!(result, russh::client::AuthResult::Success);
                return Ok(Some(ok));
            }
        }
        if let Some(kd) = key_data {
            if !kd.is_empty() {
                let key = russh::keys::decode_secret_key(kd, None)
                    .map_err(|_| "SSH_KEY_REENTER_REQUIRED|pasted".to_string())?;
                let result = handle
                    .authenticate_publickey(
                        ssh_user,
                        russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key), None),
                    )
                    .await
                    .map_err(|e| format!("SSH_KEY_AUTH_ERROR|{e}"))?;
                let ok = matches!(result, russh::client::AuthResult::Success);
                return Ok(Some(ok));
            }
        }
        Ok(None) // no key material present
    }

    match plan {
        AuthAttempt::KeyOnly => {
            // Explicit "key" choice: attempt ONLY publickey, NEVER fall through to
            // password. Absent/undecodable key ⇒ re-enter (D-08), not a password try.
            match try_key_auth(&mut handle, ssh_user, key_path, key_data).await? {
                Some(true) => Ok(handle),
                Some(false) => Err("SSH_KEY_REJECTED".into()),
                // The user chose "key" but no usable key material reached us — ask
                // them to re-select/re-paste rather than silently using a password.
                None => Err("SSH_KEY_REENTER_REQUIRED|missing".into()),
            }
        }
        AuthAttempt::PasswordOnly => {
            // Explicit "password" choice: attempt ONLY the password, NEVER the key.
            // russh 0.60: authenticate_password returns `AuthResult` not `bool`.
            let result = handle
                .authenticate_password(ssh_user, ssh_password)
                .await
                .map_err(|e| format!("SSH_AUTH_ERROR|{e}"))?;
            if !matches!(result, russh::client::AuthResult::Success) {
                // DISTINCT from SSH_KEY_REJECTED so D-07 can steer toward the key.
                return Err("SSH_PASSWORD_REJECTED".into());
            }
            Ok(handle)
        }
        AuthAttempt::LegacySequence => {
            // Back-compat for internal (non-wizard) callers: key (path/data) then
            // password in sequence. Preserved verbatim so existing flows are unchanged.
            match try_key_auth(&mut handle, ssh_user, key_path, key_data).await? {
                Some(true) => return Ok(handle),
                Some(false) => return Err("SSH_KEY_REJECTED".into()),
                None => { /* no key material — fall through to password */ }
            }
            // russh 0.60: authenticate_password returns `AuthResult` not `bool`.
            let result = handle
                .authenticate_password(ssh_user, ssh_password)
                .await
                .map_err(|e| format!("SSH_AUTH_ERROR|{e}"))?;
            if !matches!(result, russh::client::AuthResult::Success) {
                return Err("SSH_AUTH_FAILED".into());
            }
            Ok(handle)
        }
    }
}

// ─── Command Execution ─────────────────────────────

/// Global limiter на одновременные channel_open. sshd default MaxSessions=10 —
/// без ограничения ~10 параллельных panel-mount команд упирались в этот
/// лимит и получали `Error::ChannelOpenFailure(ConnectFailed)`, даже при
/// успешной установленной SSH-сессии (например `users.displayname_fetch_failed`
/// и `overview.security.failed` через 400ms после panel.load.completed при
/// первой авторизации в новый сервер, см. D-bug-ssh-pool-stampede).
///
/// Permit=5 оставляет 5 слотов в запас для keepalive heartbeats + ad-hoc
/// команд (kill-sidecar, cancel operations). Semaphore гарантирует что
/// стампиду 10+ команд physically не перегружают sshd — retry остаётся
/// как mitigation для реальных transient failures (network hiccup, forking
/// latency при cold sshd).
static CHANNEL_OPEN_GATE: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(5));

/// Open a session channel with a global concurrency gate + transient-failure retries.
///
/// Panel mount fires ~10 parallel pooled SSH commands on the shared handle
/// (OverviewSection: stats + uptime + security, UsersSection: displayname,
/// ServerSettings + SecurityTab each re-load security via useSecurityState,
/// Utilities: BBR + MTProto). When sshd can't keep up (small VPS, default
/// MaxSessions=10, fork latency) it replies SSH_MSG_CHANNEL_OPEN_FAILURE
/// with reason=ConnectFailed or ResourceShortage — russh surfaces these as
/// `Error::ChannelOpenFailure(_)`.
///
/// Two-layer defence:
///   1. **Gate (Semaphore):** физически ограничивает parallel channel_open до
///      5. Остальные команды ждут permit. Никогда не перегружаем sshd.
///   2. **Retry with jittered backoff:** для случаев когда sshd всё-равно
///      вернул transient failure (gate не защищает от sshd-side race).
///      6 attempts × (50/100/200/400/800 ms + 0-99ms jitter) = up to ~1.8s
///      total retry window — достаточно для cold fork latency recovery.
pub(crate) async fn open_session_with_retry(
    handle: &client::Handle<SshHandler>,
) -> Result<russh::Channel<russh::client::Msg>, russh::Error> {
    const MAX_ATTEMPTS: u32 = 6; // 1 initial try + 5 retries

    // Acquire permit ДО попытки. Если gate закрыт — ждём пока освободится
    // слот. Permit дропается при return (через RAII) => следующая команда
    // сможет войти.
    let _permit = CHANNEL_OPEN_GATE.acquire().await
        .expect("CHANNEL_OPEN_GATE never closed");

    let mut attempt: u32 = 0;
    loop {
        match handle.channel_open_session().await {
            Ok(ch) => return Ok(ch),
            Err(e) => {
                let transient = matches!(&e, russh::Error::ChannelOpenFailure(_));
                attempt += 1;
                if !transient || attempt >= MAX_ATTEMPTS {
                    return Err(e);
                }
                // Exponential backoff 50/100/200/400/800 ms + 0-99ms jitter
                // so parallel retries fan out instead of thundering together.
                let base_ms: u64 = 50u64 * (1u64 << (attempt - 1));
                let jitter_ms: u64 = rand::random::<u64>() % 100;
                let delay_ms = base_ms + jitter_ms;
                eprintln!(
                    "[SSH] channel_open_session transient fail ({e}); retry {attempt}/{} in {delay_ms}ms",
                    MAX_ATTEMPTS - 1
                );
                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
            }
        }
    }
}

pub(crate) async fn exec_command(
    handle: &client::Handle<SshHandler>,
    app: &tauri::AppHandle,
    command: &str,
) -> Result<(String, i32), String> {
    let mut channel = open_session_with_retry(handle)
        .await
        .map_err(|e| format!("SSH_CHANNEL_FAILED|{e}"))?;

    channel
        .exec(true, command.as_bytes())
        .await
        .map_err(|e| format!("SSH_EXEC_FAILED|{e}"))?;

    let mut stdout = String::new();
    let mut exit_code: i32 = -1;

    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { ref data } => {
                let text = String::from_utf8_lossy(data);
                for line in text.lines() {
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        emit_log(app, "info", trimmed);
                    }
                }
                stdout.push_str(&text);
            }
            ChannelMsg::ExtendedData { ref data, .. } => {
                let text = String::from_utf8_lossy(data);
                for line in text.lines() {
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        emit_log(app, "warn", trimmed);
                    }
                }
                stdout.push_str(&text);
            }
            ChannelMsg::ExitStatus { exit_status } => {
                exit_code = exit_status as i32;
            }
            _ => {}
        }
    }

    Ok((stdout, exit_code))
}

/// Like [`exec_command`], but NEVER echoes the command's stdout/stderr to the log
/// channel (C-01 / D-INV-2 / D-29). Use this for reads of files that carry a secret
/// — e.g. `/etc/telemt/telemt.toml`, whose `[access.users] trusttunnel = "<hex>"`
/// line is the MTProto proxy secret. Plain `exec_command` line-echoes every stdout
/// line through `emit_log` (→ stderr + `deploy-log` event + app.log); for a
/// secret-bearing read that echo is a leak, even though `logging::sanitize` now
/// redacts the known key shapes as belt-and-suspenders. The transport path is
/// identical to `exec_command`; only the per-line `emit_log` is dropped.
pub(crate) async fn exec_command_quiet(
    handle: &client::Handle<SshHandler>,
    command: &str,
) -> Result<(String, i32), String> {
    let mut channel = open_session_with_retry(handle)
        .await
        .map_err(|e| format!("SSH_CHANNEL_FAILED|{e}"))?;

    channel
        .exec(true, command.as_bytes())
        .await
        .map_err(|e| format!("SSH_EXEC_FAILED|{e}"))?;

    let mut stdout = String::new();
    let mut exit_code: i32 = -1;

    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { ref data } | ChannelMsg::ExtendedData { ref data, .. } => {
                // NO emit_log here — the whole point of the quiet variant.
                stdout.push_str(&String::from_utf8_lossy(data));
            }
            ChannelMsg::ExitStatus { exit_status } => {
                exit_code = exit_status as i32;
            }
            _ => {}
        }
    }

    Ok((stdout, exit_code))
}

/// True when the active deploy generation no longer matches `expected` — the run was
/// cancelled (`cancel_deploy` bumps `CURRENT_DEPLOY_OP_ID`) or superseded by a newer
/// deploy. `expected == 0` means "no run captured" → never superseded (so non-deploy
/// callers and legacy unstamped flows are unaffected).
pub(crate) fn deploy_superseded(expected: u64) -> bool {
    expected != 0 && CURRENT_DEPLOY_OP_ID.load(Ordering::SeqCst) != expected
}

/// Like [`exec_command`], but ABORTS the moment the active deploy generation changes.
///
/// 06-uat cancel→reinstall blocker: plain `exec_command` blocks on `channel.wait()`
/// with no cancellation branch, so a cancelled `deploy_server` kept running its long
/// server-side stages (apt / install.sh / certbot). Its `configure` then raced the
/// cancel's `uninstall_server` rollback (`rm -rf /opt/trusttunnel` mid-configure) and
/// a fresh install piled on top → "наслоение процессов". This variant polls
/// `CURRENT_DEPLOY_OP_ID` every 250 ms via `tokio::select!`; on a generation change it
/// drops the channel (russh closes it on drop) and returns `SSH_DEPLOY_CANCELLED` so
/// the local future unwinds immediately — freeing the backend single-flight guard. The
/// remote process tree is killed separately by `uninstall_server`'s
/// `build_stop_in_progress` (the negative-PGID kill). Used only by the long deploy
/// stages; the short probes keep plain `exec_command`.
pub(crate) async fn exec_command_cancellable(
    handle: &client::Handle<SshHandler>,
    app: &tauri::AppHandle,
    command: &str,
) -> Result<(String, i32), String> {
    // Capture the generation this exec belongs to (the run's op_id, set by
    // set_deploy_op_id at deploy_server entry). 0 = unstamped → not cancellable.
    let expected = CURRENT_DEPLOY_OP_ID.load(Ordering::SeqCst);

    let mut channel = open_session_with_retry(handle)
        .await
        .map_err(|e| format!("SSH_CHANNEL_FAILED|{e}"))?;

    channel
        .exec(true, command.as_bytes())
        .await
        .map_err(|e| format!("SSH_EXEC_FAILED|{e}"))?;

    let mut stdout = String::new();
    let mut exit_code: i32 = -1;

    // A short cancellation poll. The first tick fires immediately, so consume it before
    // the loop — otherwise we would spuriously check before any work has begun.
    let mut poll = tokio::time::interval(std::time::Duration::from_millis(250));
    poll.tick().await;

    loop {
        tokio::select! {
            maybe_msg = channel.wait() => {
                match maybe_msg {
                    Some(ChannelMsg::Data { ref data }) => {
                        let text = String::from_utf8_lossy(data);
                        for line in text.lines() {
                            let trimmed = line.trim();
                            if !trimmed.is_empty() { emit_log(app, "info", trimmed); }
                        }
                        stdout.push_str(&text);
                    }
                    Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                        let text = String::from_utf8_lossy(data);
                        for line in text.lines() {
                            let trimmed = line.trim();
                            if !trimmed.is_empty() { emit_log(app, "warn", trimmed); }
                        }
                        stdout.push_str(&text);
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => { exit_code = exit_status as i32; }
                    Some(_) => {}
                    None => break,
                }
            }
            _ = poll.tick() => {
                if deploy_superseded(expected) {
                    // Cancelled / superseded — returning drops `channel`, which russh
                    // closes; the local future stops here. The server-side process is
                    // reaped by uninstall_server's PID-group kill.
                    return Err("SSH_DEPLOY_CANCELLED|superseded".to_string());
                }
            }
        }
    }

    Ok((stdout, exit_code))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── D-05 (phase 32): the data root is NAMED, not derived from the executable ──

    /// The rule this phase installs, in one line: the data root is
    /// `%LOCALAPPDATA%\TrustTunnel Client Pro`, and the executable's own location has no say in
    /// it.
    ///
    /// Until phase 32 the two were the same folder, and that was safe only because the install
    /// itself lived under `%LOCALAPPDATA%`. The install now moves to Program Files
    /// (`installMode: perMachine`), whose ACL grants `BUILTIN\Users` read by inheritance over
    /// both child containers AND child objects — measured, see the module comment. A data root
    /// left beside the executable there would put `ssh_credentials.json`, in plaintext, in a
    /// directory every account on the machine can read. That is why the rule is named rather
    /// than derived, and why it must change in the SAME commit as the install-mode flip.
    ///
    /// The subject is the pure rule rather than `user_data_dir()` itself, because the production
    /// branch of the resolver is `cfg(not(test))` and a unit test cannot reach it. The executable
    /// handed in is a SYNTHETIC path under Program Files on purpose: that is the input which used
    /// to decide the answer, so an answer that ignores it is the entire point of the test.
    #[test]
    fn the_data_root_is_named_and_does_not_follow_the_executable() {
        let exe =
            std::path::Path::new("C:\\Program Files\\TrustTunnel Client Pro\\trusttunnel.exe");
        let (root, origin) = resolve_data_root(Some(exe.to_path_buf()))
            .expect("a Windows test host always has an absolute local-app-data location");

        let want = local_app_data_dir()
            .expect("a Windows test host always has a local-app-data location")
            .join(PRODUCT_DATA_FOLDER);
        assert_eq!(
            root, want,
            "the data root must be the named per-user folder, not something derived at runtime"
        );
        assert_eq!(
            origin,
            DataRootOrigin::LocalAppData,
            "the origin IS the diagnostic — the normal answer must be nameable as such"
        );
        assert_ne!(
            root,
            exe.parent().unwrap(),
            "the data root must never be the executable's own directory again: under Program \
             Files that folder is world-readable and it holds the plaintext credential store"
        );
    }

    /// **A data root that would be RELATIVE is refused, never answered.**
    ///
    /// This is the phase-32 adversarial probe's critical finding, as a contract. The rule used to
    /// answer `"."` when the environment said nothing, and this phase's own logon Scheduled Task
    /// sets the process working directory to the INSTALL directory — so that branch wrote the
    /// plaintext credential store into `Program Files`, which the measured ACL in the module
    /// comment says every account on the machine can read. The path-confinement guard
    /// canonicalized the same relative root and followed the data there rather than catching it.
    ///
    /// Asserted against the inner rule rather than `resolve_data_root`, because forcing the
    /// environment lookup to fail would mean mutating `LOCALAPPDATA` for the whole test process —
    /// a cross-test race, and `std::env::set_var` is `unsafe` from Rust 2024 for exactly that
    /// reason. Handing the inner rule its input directly states the same fact with no shared
    /// state, and — the point of this workstream's safety rule — resolves no real data root.
    ///
    /// The four non-absolute spellings are not padding. Each reaches the same destination as the
    /// `None` branch while passing an `is_some()` test, so a fix that only checked for `None`
    /// would leave the hole open to anything that controls the inherited environment.
    #[test]
    fn a_data_root_that_would_be_relative_is_refused_rather_than_answered() {
        let got = data_root_from(None);
        assert_eq!(
            got,
            Err(DataRootRefusal::LocalAppDataUnresolvable),
            "an unresolvable local-app-data location must REFUSE; answering a relative root puts \
             the plaintext credential store in the process working directory, which under this \
             phase's logon task is the install directory. Got: {got:?}"
        );

        for spelling in [
            ".",                            // the literal working directory
            "AppData\\Local",               // plainly relative
            "\\Users\\bob\\AppData\\Local", // rooted, but on whichever drive is current
            "C:AppData\\Local",             // drive-relative: the current dir ON C:
        ] {
            let got = data_root_from(Some(std::path::PathBuf::from(spelling)));
            assert_eq!(
                got,
                Err(DataRootRefusal::LocalAppDataNotAbsolute),
                "«{spelling}» is not an absolute path, so a data root built on it moves with the \
                 working directory — it must be refused, not joined. Got: {got:?}"
            );
        }

        // The positive control. Without it every assertion above would still pass if the rule
        // simply refused everything, which would be a different bug wearing this fix's clothes.
        let (root, origin) = data_root_from(Some(std::path::PathBuf::from("C:\\Users\\bob\\AppData\\Local")))
            .expect("an absolute local-app-data location must still resolve");
        assert!(
            root.is_absolute(),
            "the resolved data root must itself be absolute: {}",
            root.display()
        );
        assert_eq!(origin, DataRootOrigin::LocalAppData);
    }

    /// The one sentence a user will ever see for this failure carries no path (D-29).
    ///
    /// `refuse_to_start` ends the process and cannot be unit-tested, so the message it shows is
    /// factored out and asserted here instead. The bound is deliberately coarse — no backslash,
    /// no drive-letter colon — because the failure being guarded is a future edit that helpfully
    /// formats «the folder we tried» into the text, and the folder in question is the one that
    /// holds `ssh_credentials.json`.
    #[test]
    fn the_refusal_message_names_the_cause_and_no_path() {
        for why in [
            DataRootRefusal::LocalAppDataUnresolvable,
            DataRootRefusal::LocalAppDataNotAbsolute,
        ] {
            let msg = refusal_message(why);
            assert!(
                !msg.contains('\\') && !msg.contains(":\\") && !msg.contains('/'),
                "the refusal must not carry a path: {msg}"
            );
            assert!(
                msg.contains("LOCALAPPDATA") && msg.contains("USERPROFILE"),
                "the refusal must name the cause the user can act on: {msg}"
            );
            assert!(
                msg.contains("не будет запущена"),
                "the refusal must say the program will not start, not merely that something \
                 went wrong: {msg}"
            );
        }
    }

    /// The root must EXIST by the time a caller uses it. `save_sidecar_pid` writes with a bare
    /// `fs::write` (no `create_dir_all`), and every path-confinement root goes through
    /// `std::fs::canonicalize`, which fails outright on a missing directory and silently widens
    /// the guard to its un-canonicalized fallback.
    #[test]
    fn the_data_root_exists_after_resolution() {
        let root = user_data_dir();
        assert!(root.is_dir(), "the data root must exist and be a directory: {}", root.display());
    }

    /// Pro and Light still never share a data root — but what separates them has CHANGED, and
    /// that is why this test had to be re-derived rather than left alone.
    ///
    /// It used to be the install directory: each edition installed somewhere else, so each
    /// resolved its own root, and handing the rule two different executables proved it. The rule
    /// no longer reads the executable, so that proof would now be a green tick over nothing —
    /// both calls would return this build's own folder and the assertion would pass for a reason
    /// that has nothing to do with what it claims.
    ///
    /// The separation is now the product folder name compiled into each edition. So that is what
    /// is pinned, plus the fact that no executable path can talk this build into Light's folder.
    ///
    /// This is the property `lifecycle::SIDECAR_PID_BASENAME` (D-07) was the belt-and-braces
    /// half of — one edition's stale-cleanup must never be able to kill the other edition's live
    /// VPN. The per-edition basename stays regardless; this pins the root half.
    #[test]
    fn the_two_editions_do_not_share_a_data_root() {
        // The exact-list pin, and NOTHING derived from it (WR-04). A follow-up
        // `assert_ne!(PRODUCT_DATA_FOLDER, "TrustTunnel Client Light")` used to sit here, and it
        // could not fail: once the line above holds, that one compares two distinct string
        // literals. Worse, it read as the test's whole point while asserting nothing — any edit
        // that would have violated it reddens the pin first, so it never ran on a failing tree.
        // An exact-list pin plus a property derived from that same list tests one thing, not two.
        // The property is carried below, where it is genuinely reachable.
        assert_eq!(PRODUCT_DATA_FOLDER, "TrustTunnel Client Pro");

        // THE REACHABLE HALF. The rule is handed the OTHER edition's executable on purpose. This
        // fails the moment anybody re-derives the data root from the executable's own directory —
        // which is what it did before phase 32, and is the shared-root hazard the deleted line was
        // gesturing at: one edition's cleanup reaching the other's live VPN state.
        let (root, _) = resolve_data_root(Some(std::path::PathBuf::from(
            "C:\\Program Files\\TrustTunnel Client Light\\trusttunnel.exe",
        )))
        .expect("a Windows test host always has an absolute local-app-data location");
        assert!(
            root.ends_with(PRODUCT_DATA_FOLDER),
            "no executable path may talk this build into the other edition's data root: {}",
            root.display()
        );
    }

    // ── host-key-changed detection (D-09, Gemini #11) ──

    /// A DIFFERENT stored vs live fingerprint is a CHANGED host key (the reinstalled-
    /// server / MITM case) — fingerprints_differ returns true, which check_server_key
    /// uses to set the host_key_changed flag so ssh_connect surfaces
    /// SSH_HOST_KEY_CHANGED.
    #[test]
    fn host_key_changed_when_fingerprints_differ() {
        assert!(fingerprints_differ("SHA256:aaa", "SHA256:bbb"));
    }

    /// The SAME stored vs live fingerprint is NOT a change — an unchanged key must
    /// never be mis-flagged as changed (it would falsely route into the recovery
    /// trust-new-key path).
    #[test]
    fn host_key_unchanged_when_fingerprints_match() {
        assert!(!fingerprints_differ("SHA256:aaa", "SHA256:aaa"));
    }

    /// 06-uat cancel→reinstall: `deploy_superseded` drives `exec_command_cancellable`'s
    /// abort. A run is superseded when the active generation changed from the one the
    /// exec captured (cancel_deploy bumps it / a newer deploy sets its own). An
    /// `expected == 0` (unstamped) exec is NEVER superseded so non-deploy callers and
    /// legacy flows are unaffected.
    #[test]
    fn deploy_superseded_tracks_generation_changes() {
        set_deploy_op_id(7);
        assert!(!deploy_superseded(7), "matching generation is not superseded");
        assert!(deploy_superseded(6), "an older captured generation is superseded");
        // cancel_deploy bumps the active generation → the in-flight exec (captured 7) aborts.
        CURRENT_DEPLOY_OP_ID.fetch_add(1, Ordering::SeqCst);
        assert!(deploy_superseded(7), "after a cancel bump, the captured run is superseded");
        // expected == 0 is the unstamped sentinel — never cancellable.
        assert!(!deploy_superseded(0), "unstamped (0) exec is never superseded");
    }

    /// S-3 / SAFETY-02 / D-29 regression: a `password = "…"` line streamed from
    /// `cat vpn.toml` through `emit_log` must NOT carry the secret into either
    /// deploy-log sink. We assert on the REAL sink output — the exact `(stderr,
    /// event)` strings produced by `format_deploy_log_line`, the single seam both
    /// `eprintln!` and the event emit consume — not on `sanitize()` in isolation,
    /// so a future change that bypasses the seam fails this test.
    #[test]
    fn deploy_log_seam_redacts_password_before_both_sinks() {
        let secret = "S3cr3t";
        let message = format!("password = \"{secret}\"");

        let (stderr_line, event_message) = format_deploy_log_line("info", &message);

        assert!(
            !stderr_line.contains(secret),
            "stderr sink leaked the password: {stderr_line}"
        );
        assert!(
            !event_message.contains(secret),
            "deploy-log event sink leaked the password: {event_message}"
        );
    }

    /// The seam must not mangle ordinary (non-secret) log lines — sanitize is a
    /// no-op on lines that are not `key = value`-shaped, and the stderr prefix
    /// stays byte-identical so nothing scraping stderr/percent-parsing changes.
    #[test]
    fn deploy_log_seam_preserves_plain_lines() {
        let (stderr_line, event_message) =
            format_deploy_log_line("info", "Installing systemd unit 60%");

        assert_eq!(stderr_line, "[deploy-log] [info] Installing systemd unit 60%");
        assert_eq!(event_message, "Installing systemd unit 60%");
    }

    // ── WIZARD-06 / D-01: enable_firewall / enable_fail2ban serde defaults ──

    /// D-01: a deploy payload that OMITS the two hardening keys must still default
    /// them to ON — a legacy wizard (pre-WIZARD-06) that never sends them must STILL
    /// provision ufw + fail2ban, not silently skip them. A payload that explicitly
    /// sends `false` must be honoured (operator opted out). This pins the
    /// `#[serde(default = "default_true")]` contract: missing → true, false → false.
    #[test]
    fn endpoint_settings_security_defaults() {
        // Minimal payload OMITTING enable_firewall / enable_fail2ban → both default ON.
        let omitted = r#"{
            "listenAddress": "0.0.0.0:443",
            "vpnUsername": "user",
            "vpnPassword": "secret",
            "certType": "letsencrypt",
            "domain": "vpn.example.com"
        }"#;
        let s: EndpointSettings = serde_json::from_str(omitted).expect("omitted payload deserializes");
        assert!(s.enable_firewall, "omitted enable_firewall must default to true (D-01)");
        assert!(s.enable_fail2ban, "omitted enable_fail2ban must default to true (D-01)");

        // Payload that explicitly opts OUT → both false (operator's choice honoured).
        let disabled = r#"{
            "listenAddress": "0.0.0.0:443",
            "vpnUsername": "user",
            "vpnPassword": "secret",
            "certType": "selfsigned",
            "domain": "",
            "enableFirewall": false,
            "enableFail2ban": false
        }"#;
        let s: EndpointSettings = serde_json::from_str(disabled).expect("disabled payload deserializes");
        assert!(!s.enable_firewall, "explicit enableFirewall=false must be honoured");
        assert!(!s.enable_fail2ban, "explicit enableFail2ban=false must be honoured");
    }

    // ── single-auth-method decision (D-06 — the auth-bleed root fix) ──

    /// D-06: an explicit "password" choice attempts ONLY the password — even if a
    /// key is ALSO present (the wizard's pre-fix bleed: both fields populated). This
    /// is the exact "key rejected even though the password works" scenario: with the
    /// fix, the key is never tried.
    #[test]
    fn auth_plan_password_attempts_password_only_even_with_key_present() {
        assert_eq!(
            auth_plan(Some("password"), /*has_key=*/ true, /*has_password=*/ true),
            AuthAttempt::PasswordOnly
        );
    }

    /// D-06: an explicit "key" choice attempts ONLY the key — even if a password is
    /// ALSO present. The backend never falls through to the password.
    #[test]
    fn auth_plan_key_attempts_key_only_even_with_password_present() {
        assert_eq!(
            auth_plan(Some("key"), /*has_key=*/ true, /*has_password=*/ true),
            AuthAttempt::KeyOnly
        );
    }

    /// Back-compat: an internal caller passing no auth_method keeps the legacy
    /// try-key-then-password sequence (so existing non-wizard flows are unchanged).
    #[test]
    fn auth_plan_none_is_legacy_sequence() {
        assert_eq!(
            auth_plan(None, true, true),
            AuthAttempt::LegacySequence
        );
        // An unrecognized value is treated conservatively as legacy, not a panic.
        assert_eq!(
            auth_plan(Some("bogus"), true, true),
            AuthAttempt::LegacySequence
        );
    }
}
