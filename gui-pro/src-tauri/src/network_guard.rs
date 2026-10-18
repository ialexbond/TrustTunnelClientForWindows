//! GUI-owned protection survives a core crash while the GUI is running.
//! A strict Windows kill-on-close job ends the resident guardian when the GUI exits or crashes.

use std::collections::HashMap;
use std::future::Future;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde::Deserialize;
use tauri::{Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{Mutex, OwnedMutexGuard};

use crate::commands::AppState;

pub const FAILED: &str = "network-guard-failed";
pub const ACTIVE: &str = "network-guard-active";
pub const BOOTSTRAP_FAILED: &str = "network-guard-bootstrap-failed";
const SUPERSEDED: &str = "connect-superseded";
const OUTPUT_LIMIT: u64 = 64 * 1024;
const HELPER_TIMEOUT: Duration = Duration::from_secs(8);
const BOOTSTRAP_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_ADDRESSES: usize = 64;

type GuardFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, &'static str>> + Send + 'a>>;

pub fn spawn_failure_reason(value: &str) -> Option<&'static str> {
    match value {
        FAILED => Some(FAILED),
        ACTIVE => Some(ACTIVE),
        BOOTSTRAP_FAILED => Some(BOOTSTRAP_FAILED),
        _ => None,
    }
}

fn operation_gate() -> Arc<Mutex<()>> {
    static OPERATIONS: OnceLock<Arc<Mutex<()>>> = OnceLock::new();
    OPERATIONS.get_or_init(|| Arc::new(Mutex::new(()))).clone()
}

struct OperationLease {
    _guard: OwnedMutexGuard<()>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum GuardCommand {
    Help,
    Version,
    Status,
    Arm(PathBuf),
    Release,
    LegacyRelease,
    Resolve(String),
}

trait GuardExecutor: Send + Sync {
    fn query(&self, command: GuardCommand) -> GuardFuture<'_, String>;
}

struct NativeExecutor {
    binary: PathBuf,
    app: Option<tauri::AppHandle>,
}

struct HelperOutput {
    bytes: Vec<u8>,
    success: bool,
    code: Option<i32>,
}

trait HelperProcess: Send {
    fn output(&mut self) -> GuardFuture<'_, HelperOutput>;
    fn terminate_and_reap(&mut self) -> GuardFuture<'_, ()>;
}

struct NativeProcess(tokio::process::Child);

impl HelperProcess for NativeProcess {
    fn output(&mut self) -> GuardFuture<'_, HelperOutput> {
        Box::pin(async {
            let stdout = self.0.stdout.take().ok_or(FAILED)?;
            let mut bytes = Vec::new();
            stdout
                .take(OUTPUT_LIMIT + 1)
                .read_to_end(&mut bytes)
                .await
                .map_err(|_| FAILED)?;
            if bytes.len() as u64 > OUTPUT_LIMIT {
                return Err(FAILED);
            }
            let status = self.0.wait().await.map_err(|_| FAILED)?;
            Ok(HelperOutput {
                bytes,
                success: status.success(),
                code: status.code(),
            })
        })
    }

    fn terminate_and_reap(&mut self) -> GuardFuture<'_, ()> {
        Box::pin(async {
            // Even when termination reports that the process already exited, wait confirms
            // that its handle has been reaped before any competing release can take the lease.
            let _ = self.0.start_kill();
            self.0.wait().await.map(|_| ()).map_err(|_| FAILED)
        })
    }
}

async fn bounded_output(
    mut process: impl HelperProcess,
    help: bool,
    timeout: Duration,
) -> Result<String, &'static str> {
    let output = match tokio::time::timeout(timeout, process.output()).await {
        Ok(Ok(output)) if output.bytes.len() as u64 <= OUTPUT_LIMIT => output,
        _ => {
            // Do not unlock uncertain operating-system mutations. The query task retains its
            // operation lease even if its caller was cancelled; only a confirmed reap releases it.
            while process.terminate_and_reap().await.is_err() {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            return Err(FAILED);
        }
    };
    if !(output.success || help && output.code == Some(1)) {
        return Err(FAILED);
    }
    String::from_utf8(output.bytes).map_err(|_| FAILED)
}

impl GuardExecutor for NativeExecutor {
    fn query(&self, request: GuardCommand) -> GuardFuture<'_, String> {
        Box::pin(async move {
            if matches!(
                request,
                GuardCommand::Status | GuardCommand::Arm(_) | GuardCommand::Release
            ) {
                return resident_query(&self.binary, self.app.as_ref(), request).await;
            }
            let help = request == GuardCommand::Help;
            let mut command = tokio::process::Command::new(&self.binary);
            match request {
                GuardCommand::Help => {
                    command.arg("--help");
                }
                GuardCommand::Version => {
                    command.arg("--network-guard-version");
                }
                // This command only removes the old persistent namespace during authorized migration.
                GuardCommand::LegacyRelease => {
                    command.arg("--network-guard-release");
                }
                GuardCommand::Resolve(host) => {
                    command.arg("--network-guard-resolve").arg(host);
                }
                _ => return Err(FAILED),
            }
            command
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .kill_on_drop(true);
            #[cfg(windows)]
            command.creation_flags(0x0800_0000);
            let child = command.spawn().map_err(|_| FAILED)?;
            bounded_output(NativeProcess(child), help, HELPER_TIMEOUT).await
        })
    }
}

struct ResidentHelper {
    id: u64,
    armed: bool,
    child: tokio::process::Child,
    input: tokio::process::ChildStdin,
    output: BufReader<tokio::process::ChildStdout>,
    _job: crate::job_object::OwnedJobHandle,
}

#[derive(Default)]
struct ResidentState {
    helper: Option<ResidentHelper>,
    failed: Option<u64>,
}

fn resident_state() -> &'static Mutex<ResidentState> {
    static STATE: OnceLock<Mutex<ResidentState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(ResidentState::default()))
}

fn unarmed_reply() -> String {
    r#"{"version":2,"armed":false}"#.to_owned()
}

async fn read_resident_line(
    reader: &mut (impl tokio::io::AsyncRead + Unpin),
) -> Result<String, &'static str> {
    let mut bytes = Vec::new();
    for _ in 0..=OUTPUT_LIMIT {
        match reader.read_u8().await.map_err(|_| FAILED)? {
            b'\n' => return String::from_utf8(bytes).map_err(|_| FAILED),
            byte => bytes.push(byte),
        }
    }
    Err(FAILED)
}

fn resident_command(request: &GuardCommand) -> Result<String, &'static str> {
    match request {
        GuardCommand::Status => Ok("S\n".to_owned()),
        GuardCommand::Release => Ok("R\n".to_owned()),
        GuardCommand::Arm(path) => {
            let path = path.to_str().ok_or(FAILED)?;
            if path.is_empty() || path.len() > 32768 || path.chars().any(char::is_control) {
                return Err(FAILED);
            }
            Ok(format!("A {path}\n"))
        }
        _ => Err(FAILED),
    }
}

impl ResidentHelper {
    async fn start(binary: &Path) -> Result<Self, &'static str> {
        static NEXT_ID: AtomicU64 = AtomicU64::new(1);
        let mut command = tokio::process::Command::new(binary);
        command
            .arg("--network-guard-session")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        let mut child = command.spawn().map_err(|_| FAILED)?;
        let job = child.id().ok_or(FAILED).and_then(|pid| {
            crate::job_object::assign_to_kill_on_close_job(pid).map_err(|_| FAILED)
        });
        let job = match job {
            Ok(job) => job,
            Err(_) => {
                let mut process = NativeProcess(child);
                while process.terminate_and_reap().await.is_err() {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                return Err(FAILED);
            }
        };
        // The helper is unarmed until A. Job assignment is mandatory before a command can be sent.
        let streams = (child.stdin.take(), child.stdout.take());
        let (Some(input), Some(output)) = streams else {
            drop(job);
            let mut process = NativeProcess(child);
            while process.terminate_and_reap().await.is_err() {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            return Err(FAILED);
        };
        let mut helper = Self {
            id: NEXT_ID.fetch_add(1, Ordering::SeqCst),
            armed: false,
            child,
            input,
            output: BufReader::new(output),
            _job: job,
        };
        let ready =
            tokio::time::timeout(HELPER_TIMEOUT, read_resident_line(&mut helper.output)).await;
        if !matches!(ready, Ok(Ok(ref reply)) if parse_state(reply) == Ok(false)) {
            helper.terminate().await;
            return Err(FAILED);
        }
        Ok(helper)
    }

    async fn exchange(&mut self, command: &str) -> Result<String, &'static str> {
        let reply = exchange_resident(&mut self.input, &mut self.output, command).await?;
        self.armed = parse_report(&reply)?.armed;
        Ok(reply)
    }

    async fn terminate(self) {
        let Self {
            child,
            input,
            output,
            _job,
            ..
        } = self;
        drop(input);
        drop(output);
        drop(_job);
        let mut process = NativeProcess(child);
        while process.terminate_and_reap().await.is_err() {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}

async fn exchange_resident(
    input: &mut (impl tokio::io::AsyncWrite + Unpin),
    output: &mut (impl tokio::io::AsyncRead + Unpin),
    command: &str,
) -> Result<String, &'static str> {
    tokio::time::timeout(HELPER_TIMEOUT, async {
        input
            .write_all(command.as_bytes())
            .await
            .map_err(|_| FAILED)?;
        input.flush().await.map_err(|_| FAILED)?;
        let reply = read_resident_line(output).await?;
        parse_report(&reply)?;
        Ok(reply)
    })
    .await
    .map_err(|_| FAILED)?
}

async fn resident_query(
    binary: &Path,
    app: Option<&tauri::AppHandle>,
    request: GuardCommand,
) -> Result<String, &'static str> {
    let command = resident_command(&request)?;
    let mut state = resident_state().lock().await;
    if state.helper.is_none() {
        if request == GuardCommand::Release {
            state.failed = None;
            return Ok(unarmed_reply());
        }
        if state.failed.is_some() {
            return Err(FAILED);
        }
        if request == GuardCommand::Status {
            return Ok(unarmed_reply());
        }
        let helper = ResidentHelper::start(binary).await?;
        let id = helper.id;
        state.helper = Some(helper);
        if let Some(app) = app {
            start_heartbeat(app.clone(), id);
        }
    }
    let helper = state.helper.as_mut().ok_or(FAILED)?;
    let result = helper.exchange(&command).await;
    if result.is_ok() {
        return result;
    }
    let helper = state.helper.take().ok_or(FAILED)?;
    let id = helper.id;
    let armed = helper.armed;
    helper.terminate().await;
    let (reply, notify) = finish_resident_failure(&mut state, id, armed, Some(&request));
    drop(state);
    if let Some(app) = app.filter(|_| notify) {
        emit_helper_failure(app, id).await;
    }
    reply
}

fn finish_resident_failure(
    state: &mut ResidentState,
    id: u64,
    armed: bool,
    request: Option<&GuardCommand>,
) -> (Result<String, &'static str>, bool) {
    // Losing an idle, already released helper must not cancel an unrelated KS-off connection.
    // A missing A reply is uncertain even when the previous confirmed state was unarmed.
    if armed || matches!(request, Some(GuardCommand::Arm(_))) {
        state.failed = Some(id);
        (Err(FAILED), true)
    } else {
        state.failed = None;
        (Ok(unarmed_reply()), false)
    }
}

async fn emit_helper_failure(app: &tauri::AppHandle, session_id: u64) {
    let resident = resident_state().lock().await;
    if resident.failed != Some(session_id) || resident.helper.is_some() {
        return;
    }
    emit(app, false);
    if let Some(state) = app.try_state::<AppState>() {
        let generation = state.connection_generation.load(Ordering::SeqCst);
        let _ = app.emit(
            "network-guard-helper-failed",
            serde_json::json!({ "generation": generation, "session_id": session_id }),
        );
    }
}

fn start_heartbeat(app: tauri::AppHandle, session_id: u64) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let mut state = resident_state().lock().await;
            let Some(helper) = state
                .helper
                .as_mut()
                .filter(|helper| helper.id == session_id)
            else {
                return;
            };
            if matches!(helper.child.try_wait(), Ok(None)) {
                continue;
            }
            let Some(helper) = state.helper.take() else {
                return;
            };
            let armed = helper.armed;
            helper.terminate().await;
            let (_, notify) = finish_resident_failure(&mut state, session_id, armed, None);
            drop(state);
            if notify {
                emit_helper_failure(&app, session_id).await;
            }
            return;
        }
    });
}

pub async fn failure_is_current(session_id: u64) -> bool {
    let state = resident_state().lock().await;
    state.failed == Some(session_id) && state.helper.is_none()
}

struct GuardSession {
    executor: Arc<dyn GuardExecutor>,
    operation: Arc<OperationLease>,
}

impl GuardSession {
    async fn begin(executor: Arc<dyn GuardExecutor>, gate: Arc<Mutex<()>>) -> Self {
        Self {
            executor,
            operation: Arc::new(OperationLease {
                _guard: gate.lock_owned().await,
            }),
        }
    }

    async fn query(&self, command: GuardCommand) -> Result<String, &'static str> {
        let executor = self.executor.clone();
        let lease = self.operation.clone();
        // A dropped caller detaches, rather than aborts, this task. The task holds the lease
        // through helper termination/reaping, so a late arm can never follow an explicit release.
        tokio::spawn(async move {
            let _lease = lease;
            executor.query(command).await
        })
        .await
        .map_err(|_| FAILED)?
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GuardState {
    version: u8,
    armed: bool,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ResolvedHost {
    version: u8,
    addresses: Vec<IpAddr>,
}

fn parse_report(text: &str) -> Result<GuardState, &'static str> {
    let reply: GuardState = serde_json::from_str(text).map_err(|_| FAILED)?;
    if reply.version != 2 {
        return Err(FAILED);
    }
    Ok(reply)
}

fn parse_state(text: &str) -> Result<bool, &'static str> {
    let reply = parse_report(text)?;
    if reply.error.is_some() {
        return Err(FAILED);
    }
    Ok(reply.armed)
}

fn parse_addresses(text: &str) -> Result<Vec<IpAddr>, &'static str> {
    let reply: ResolvedHost = serde_json::from_str(text).map_err(|_| BOOTSTRAP_FAILED)?;
    if reply.version != 2 || reply.addresses.is_empty() || reply.addresses.len() > MAX_ADDRESSES {
        return Err(BOOTSTRAP_FAILED);
    }
    Ok(reply.addresses)
}

fn core_binary() -> Result<PathBuf, &'static str> {
    std::env::current_exe()
        .map(|path| {
            path.with_file_name(if cfg!(windows) {
                "trusttunnel_client.exe"
            } else {
                "trusttunnel_client"
            })
        })
        .map_err(|_| FAILED)
}

fn require_current(current: &impl Fn() -> bool) -> Result<(), &'static str> {
    current().then_some(()).ok_or(SUPERSEDED)
}

fn help_has_flag(help: &str, flag: &str) -> bool {
    help.split_whitespace().any(|word| {
        word.trim_matches(',')
            .split_once('=')
            .map_or(word.trim_matches(','), |parts| parts.0)
            == flag
    })
}

async fn verify(session: &GuardSession, current: &impl Fn() -> bool) -> Result<(), &'static str> {
    require_current(current)?;
    // Old cores may start their default configuration on an unknown flag.
    let help = session.query(GuardCommand::Help).await?;
    require_current(current)?;
    for flag in [
        "--network-guard-version",
        "--network-guard-status",
        "--network-guard-session",
        "--gui-session",
        "--network-guard-release",
        "--network-guard-resolve",
    ] {
        if !help_has_flag(&help, flag) {
            return Err(FAILED);
        }
    }
    let version = session.query(GuardCommand::Version).await?;
    require_current(current)?;
    if version.trim() != "2" {
        return Err(FAILED);
    }
    Ok(())
}

fn emit(app: &tauri::AppHandle, armed: bool) {
    let _ = app.emit(
        "network-guard-changed",
        serde_json::json!({ "armed": armed }),
    );
}

#[tauri::command]
pub async fn network_guard_status(app: tauri::AppHandle) -> Result<bool, String> {
    if !cfg!(windows) {
        return Ok(false);
    }
    let session = GuardSession::begin(
        Arc::new(NativeExecutor {
            binary: core_binary().map_err(str::to_owned)?,
            app: Some(app.clone()),
        }),
        operation_gate(),
    )
    .await;
    verify(&session, &|| true).await.map_err(str::to_owned)?;
    parse_state(
        &session
            .query(GuardCommand::Status)
            .await
            .map_err(str::to_owned)?,
    )
    .map_err(str::to_owned)
}

/// Remove old persistent protection before auto-connect. The current resident namespace is never released here.
pub async fn migrate_legacy_on_startup(app: &tauri::AppHandle) -> Result<(), &'static str> {
    if !cfg!(windows) {
        return Ok(());
    }
    let session = GuardSession::begin(
        Arc::new(NativeExecutor {
            binary: core_binary()?,
            app: Some(app.clone()),
        }),
        operation_gate(),
    )
    .await;
    migrate_with(&session).await
}

async fn migrate_with(session: &GuardSession) -> Result<(), &'static str> {
    verify(session, &|| true).await?;
    let reply = session.query(GuardCommand::LegacyRelease).await?;
    parse_report(&reply).and_then(|state| {
        if state.error.is_none() {
            Ok(())
        } else {
            Err(FAILED)
        }
    })
}

pub struct RuntimeConfig {
    path: PathBuf,
}

impl Drop for RuntimeConfig {
    fn drop(&mut self) {
        // SidecarChild keeps the credential-bearing copy alive until the child exits.
        let _ = std::fs::remove_file(&self.path);
    }
}

pub struct PreparedSpawn {
    _operation: Arc<OperationLease>,
    runtime: Option<RuntimeConfig>,
}

impl PreparedSpawn {
    pub fn config_path<'a>(&'a self, original: &'a Path) -> &'a Path {
        self.runtime
            .as_ref()
            .map(|file| file.path.as_path())
            .unwrap_or(original)
    }
    pub fn take_runtime(&mut self) -> Option<RuntimeConfig> {
        self.runtime.take()
    }
}

fn spawn_is_current(app: &tauri::AppHandle, generation: u64) -> bool {
    app.try_state::<AppState>().is_some_and(|state| {
        state.connection_generation.load(Ordering::SeqCst) == generation
            && !state.user_disconnect_requested.load(Ordering::SeqCst)
    })
}

fn protection_decision(requested: bool, retained: bool) -> Result<bool, &'static str> {
    match (requested, retained) {
        (false, true) => Err(ACTIVE),
        (false, false) => Ok(false),
        (true, _) => Ok(true),
    }
}

fn split_address(value: &str) -> Result<(String, u16, Option<IpAddr>), &'static str> {
    if let Ok(address) = value.parse::<SocketAddr>() {
        if address.port() == 0 {
            return Err(BOOTSTRAP_FAILED);
        }
        return Ok((address.ip().to_string(), address.port(), Some(address.ip())));
    }
    let (host, port) = value.rsplit_once(':').ok_or(BOOTSTRAP_FAILED)?;
    let port = port.parse::<u16>().map_err(|_| BOOTSTRAP_FAILED)?;
    if host.is_empty()
        || host.starts_with('-')
        || host.len() > 253
        || port == 0
        || host.chars().any(|ch| {
            ch.is_whitespace() || ch.is_control() || matches!(ch, '/' | '\\' | '[' | ']' | ':')
        })
    {
        return Err(BOOTSTRAP_FAILED);
    }
    Ok((host.to_owned(), port, None))
}

fn replace_addresses(
    text: &str,
    resolved: &HashMap<String, Vec<IpAddr>>,
) -> Result<Option<String>, &'static str> {
    let mut document = text.parse::<toml_edit::DocumentMut>().map_err(|_| FAILED)?;
    let endpoint = document
        .get_mut("endpoint")
        .and_then(toml_edit::Item::as_table_like_mut)
        .ok_or(BOOTSTRAP_FAILED)?;
    let addresses = endpoint
        .get("addresses")
        .and_then(toml_edit::Item::as_array)
        .ok_or(BOOTSTRAP_FAILED)?;
    let mut replacement = toml_edit::Array::new();
    let mut changed = false;
    for value in addresses {
        let original = value.as_str().ok_or(BOOTSTRAP_FAILED)?;
        let (host, port, numeric) = split_address(original)?;
        if numeric.is_some() {
            replacement.push(original);
        } else {
            changed = true;
            for address in resolved
                .get(&host)
                .filter(|values| !values.is_empty())
                .ok_or(BOOTSTRAP_FAILED)?
            {
                replacement.push(SocketAddr::new(*address, port).to_string());
            }
        }
        if replacement.len() > MAX_ADDRESSES {
            return Err(BOOTSTRAP_FAILED);
        }
    }
    if changed {
        endpoint.insert("addresses", toml_edit::value(replacement));
        Ok(Some(document.to_string()))
    } else {
        Ok(None)
    }
}

async fn prepare_with(
    session: &GuardSession,
    config_path: &Path,
    text: &str,
    current: &impl Fn() -> bool,
    emit: &impl Fn(bool),
    write_runtime: &impl Fn(&str) -> Result<RuntimeConfig, &'static str>,
) -> Result<Option<RuntimeConfig>, &'static str> {
    require_current(current)?;
    verify(session, current).await?;
    let config: toml::Value = text.parse().map_err(|_| FAILED)?;
    let requested = config
        .get("killswitch_enabled")
        .and_then(toml::Value::as_bool)
        .unwrap_or(false);
    let retained = parse_state(&session.query(GuardCommand::Status).await?)?;
    require_current(current)?;
    if !protection_decision(requested, retained)? {
        return Ok(None);
    }
    let reply = session
        .query(GuardCommand::Arm(config_path.to_owned()))
        .await?;
    let armed = parse_report(&reply)?;
    emit(armed.armed);
    if armed.error.is_some() || !armed.armed {
        return Err(FAILED);
    }
    require_current(current)?;
    let addresses = config
        .get("endpoint")
        .and_then(|item| item.get("addresses"))
        .and_then(toml::Value::as_array)
        .ok_or(BOOTSTRAP_FAILED)?;
    if addresses.is_empty() || addresses.len() > MAX_ADDRESSES {
        return Err(BOOTSTRAP_FAILED);
    }
    let deadline = tokio::time::Instant::now() + BOOTSTRAP_TIMEOUT;
    let mut resolved = HashMap::new();
    for value in addresses {
        require_current(current)?;
        if tokio::time::Instant::now() >= deadline {
            return Err(BOOTSTRAP_FAILED);
        }
        let (host, _, numeric) = split_address(value.as_str().ok_or(BOOTSTRAP_FAILED)?)?;
        if numeric.is_none() && !resolved.contains_key(&host) {
            let result = tokio::time::timeout_at(
                deadline,
                session.query(GuardCommand::Resolve(host.clone())),
            )
            .await
            .map_err(|_| BOOTSTRAP_FAILED)?
            .map_err(|_| BOOTSTRAP_FAILED)?;
            require_current(current)?;
            resolved.insert(host, parse_addresses(&result)?);
        }
    }
    let runtime = replace_addresses(text, &resolved)?
        .map(|text| write_runtime(&text))
        .transpose()?;
    require_current(current)?;
    Ok(runtime)
}

pub async fn prepare_spawn(
    app: &tauri::AppHandle,
    binary: &Path,
    config_path: &Path,
    generation: u64,
) -> Result<PreparedSpawn, &'static str> {
    let session = GuardSession::begin(
        Arc::new(NativeExecutor {
            binary: binary.to_owned(),
            app: Some(app.clone()),
        }),
        operation_gate(),
    )
    .await;
    let current = || spawn_is_current(app, generation);
    require_current(&current)?;
    let runtime = if cfg!(windows) {
        let text = std::fs::read_to_string(config_path).map_err(|_| FAILED)?;
        prepare_with(
            &session,
            config_path,
            &text,
            &current,
            &|armed| emit(app, armed),
            &|text| {
                let directory = crate::net_egress::runtime_dir();
                std::fs::create_dir_all(&directory).map_err(|_| FAILED)?;
                let runtime = RuntimeConfig {
                    path: directory.join(format!(
                        "connect_override-guard-{}.toml",
                        uuid::Uuid::new_v4()
                    )),
                };
                crate::commands::manifest::write_bytes_atomic(&runtime.path, text.as_bytes())
                    .map_err(|_| FAILED)?;
                Ok(runtime)
            },
        )
        .await?
    } else {
        None
    };
    Ok(PreparedSpawn {
        _operation: session.operation,
        runtime,
    })
}

fn release_is_current(state: &AppState, generation: u64) -> bool {
    state.connection_generation.load(Ordering::SeqCst) == generation
        && state.user_disconnect_requested.load(Ordering::SeqCst)
        && state
            .sidecar_child
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .is_none()
}

async fn release_with(
    session: &GuardSession,
    current: &impl Fn() -> bool,
    emit: &impl Fn(bool),
) -> Result<bool, &'static str> {
    if !current() {
        return Ok(false);
    }
    if let Err(error) = verify(session, current).await {
        return if error == SUPERSEDED {
            Ok(false)
        } else {
            Err(error)
        };
    }
    // A partial or unreadable prior transaction still needs an explicit cleanup attempt.
    let retained = session
        .query(GuardCommand::Status)
        .await
        .and_then(|text| parse_state(&text))
        .unwrap_or(true);
    if !current() {
        return Ok(false);
    }
    let result = session.query(GuardCommand::Release).await?;
    let reply = parse_report(&result)?;
    emit(reply.armed);
    if reply.error.is_some() || reply.armed {
        return Err(FAILED);
    }

    Ok(retained)
}

pub async fn release_after_disconnect(
    app: &tauri::AppHandle,
    state: &AppState,
    generation: u64,
) -> Result<bool, &'static str> {
    let session = GuardSession::begin(
        Arc::new(NativeExecutor {
            binary: core_binary()?,
            app: Some(app.clone()),
        }),
        operation_gate(),
    )
    .await;
    if !cfg!(windows) {
        return Ok(false);
    }
    release_with(
        &session,
        &|| release_is_current(state, generation),
        &|armed| emit(app, armed),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::atomic::AtomicBool;
    use std::sync::Mutex as StdMutex;
    use tokio::sync::Notify;

    const HELP: &str = "--network-guard-version --network-guard-status --network-guard-session --gui-session --network-guard-release --network-guard-resolve=HOST";
    const ARMED: &str = r#"{"version":2,"armed":true}"#;
    const UNARMED: &str = r#"{"version":2,"armed":false}"#;
    const RESOLVED: &str = r#"{"version":2,"addresses":["192.0.2.1","2001:db8::1"]}"#;
    const CONFIG: &str = "killswitch_enabled = true\n[endpoint]\nhostname = \"identity.example.com\"\ncustom_sni = \"sni.example.com\"\nusername = \"example\"\npassword = \"fixture\"\naddresses = [\"vpn.example.com:443\", \"192.0.2.2:8443\"]\n[listener.tun]\nmtu_size = 1280\nincluded_routes = [\"10.0.0.0/8\"]\nexcluded_routes = [\"10.1.0.0/16\"]\n";

    #[derive(Default)]
    struct Pause {
        entered: Notify,
        resume: Notify,
    }

    struct Step {
        command: GuardCommand,
        response: Result<&'static str, &'static str>,
        pause: Option<Arc<Pause>>,
        effect: Option<bool>,
    }

    fn step(command: GuardCommand, response: &'static str) -> Step {
        Step {
            command,
            response: Ok(response),
            pause: None,
            effect: None,
        }
    }

    struct FakeExecutor {
        steps: StdMutex<VecDeque<Step>>,
        calls: StdMutex<Vec<GuardCommand>>,
        armed: AtomicBool,
    }

    impl FakeExecutor {
        fn new(steps: Vec<Step>) -> Arc<Self> {
            Arc::new(Self {
                steps: StdMutex::new(steps.into()),
                calls: StdMutex::new(Vec::new()),
                armed: AtomicBool::new(false),
            })
        }
        fn calls(&self) -> Vec<GuardCommand> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl GuardExecutor for FakeExecutor {
        fn query(&self, command: GuardCommand) -> GuardFuture<'_, String> {
            let step = self
                .steps
                .lock()
                .unwrap()
                .pop_front()
                .expect("unexpected helper invocation");
            assert_eq!(step.command, command);
            self.calls.lock().unwrap().push(command);
            Box::pin(async move {
                if let Some(pause) = step.pause {
                    pause.entered.notify_one();
                    pause.resume.notified().await;
                }
                if let Some(armed) = step.effect {
                    self.armed.store(armed, Ordering::SeqCst);
                }
                step.response.map(str::to_owned)
            })
        }
    }

    fn verified_status(armed: bool) -> Vec<Step> {
        vec![
            step(GuardCommand::Help, HELP),
            step(GuardCommand::Version, "2"),
            step(GuardCommand::Status, if armed { ARMED } else { UNARMED }),
        ]
    }
    fn arm_step() -> Step {
        let mut step = step(GuardCommand::Arm(PathBuf::from("fixture.toml")), ARMED);
        step.effect = Some(true);
        step
    }
    fn release_steps() -> Vec<Step> {
        let mut steps = verified_status(true);
        let mut release = step(GuardCommand::Release, UNARMED);
        release.effect = Some(false);
        steps.push(release);
        steps
    }
    fn no_runtime(_: &str) -> Result<RuntimeConfig, &'static str> {
        panic!("no runtime copy expected")
    }
    fn fixture_runtime(text: &str) -> Result<RuntimeConfig, &'static str> {
        let path = std::env::temp_dir().join(format!(
            "trusttunnel-guard-test-{}.toml",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, text).map_err(|_| FAILED)?;
        Ok(RuntimeConfig { path })
    }

    #[test]
    fn reason_codes_remain_fixed_and_unknown_failures_do_not_become_guard_codes() {
        for code in [FAILED, ACTIVE, BOOTSTRAP_FAILED] {
            assert_eq!(spawn_failure_reason(code), Some(code));
        }
        assert_eq!(spawn_failure_reason("private error"), None);
    }

    #[test]
    fn strict_json_never_treats_partial_or_future_state_as_unprotected() {
        for text in [
            "{}",
            "null",
            r#"{"version":3,"armed":false}"#,
            r#"{"version":2,"armed":false,"error":"partial"}"#,
        ] {
            assert!(parse_state(text).is_err());
        }
        assert_eq!(parse_state(ARMED), Ok(true));
        assert_eq!(parse_state(UNARMED), Ok(false));
        for text in [
            r#"{"version":2,"addresses":[]}"#,
            r#"{"version":2,"addresses":["example.com"]}"#,
        ] {
            assert!(parse_addresses(text).is_err());
        }
        let too_many =
            serde_json::json!({ "version": 2, "addresses": vec!["192.0.2.1"; MAX_ADDRESSES + 1] });
        assert!(parse_addresses(&too_many.to_string()).is_err());
    }

    #[test]
    fn help_matches_complete_flags_with_values_and_never_prefixes() {
        assert!(help_has_flag(
            "--network-guard-arm=CONFIG,",
            "--network-guard-arm"
        ));
        assert!(help_has_flag(
            "--network-guard-arm CONFIG",
            "--network-guard-arm"
        ));
        assert!(!help_has_flag(
            "--network-guard-arm-unsafe=CONFIG",
            "--network-guard-arm"
        ));
        assert!(!help_has_flag(
            "example--network-guard-arm",
            "--network-guard-arm"
        ));
    }

    #[tokio::test]
    async fn an_old_core_receives_only_safe_help() {
        let executor = FakeExecutor::new(vec![step(GuardCommand::Help, "--help --version")]);
        let session = GuardSession::begin(executor.clone(), Arc::new(Mutex::new(()))).await;
        assert_eq!(verify(&session, &|| true).await, Err(FAILED));
        assert_eq!(executor.calls(), [GuardCommand::Help]);
    }

    #[tokio::test]
    async fn wrong_capability_version_never_reaches_status_or_arm() {
        let executor = FakeExecutor::new(vec![
            step(GuardCommand::Help, HELP),
            step(GuardCommand::Version, "3"),
        ]);
        let session = GuardSession::begin(executor.clone(), Arc::new(Mutex::new(()))).await;
        assert_eq!(verify(&session, &|| true).await, Err(FAILED));
        assert_eq!(executor.calls().len(), 2);
    }

    #[tokio::test]
    async fn retained_protection_rejects_killswitch_off_without_arm_or_release() {
        for retained in [false, true] {
            let executor = FakeExecutor::new(verified_status(retained));
            let session = GuardSession::begin(executor.clone(), Arc::new(Mutex::new(()))).await;
            let config = CONFIG.replace("killswitch_enabled = true", "killswitch_enabled = false");
            let result = prepare_with(
                &session,
                Path::new("fixture.toml"),
                &config,
                &|| true,
                &|_| panic!("no protection mutation"),
                &no_runtime,
            )
            .await;
            if retained {
                assert!(matches!(result, Err(ACTIVE)));
            } else {
                assert!(matches!(result, Ok(None)));
            }
            assert!(!executor
                .calls()
                .iter()
                .any(|command| matches!(command, GuardCommand::Arm(_) | GuardCommand::Release)));
        }
    }

    #[tokio::test]
    async fn uncertain_partial_arm_and_bootstrap_failures_never_release_or_spawn() {
        for failure in ["partial-arm", "arm-false", "dns-error", "dns-empty"] {
            let mut steps = verified_status(false);
            let mut arm = arm_step();
            if failure == "partial-arm" {
                arm.response = Ok(r#"{"version":2,"armed":true,"error":"partial"}"#);
            }
            if failure == "arm-false" {
                arm.response = Ok(UNARMED);
            }
            steps.push(arm);
            if failure.starts_with("dns-") {
                let mut dns = step(
                    GuardCommand::Resolve("vpn.example.com".into()),
                    r#"{"version":2,"addresses":[]}"#,
                );
                if failure == "dns-error" {
                    dns.response = Err(FAILED);
                }
                steps.push(dns);
            }
            let executor = FakeExecutor::new(steps);
            let session = GuardSession::begin(executor.clone(), Arc::new(Mutex::new(()))).await;
            let emitted = StdMutex::new(Vec::new());
            let result = prepare_with(
                &session,
                Path::new("fixture.toml"),
                CONFIG,
                &|| true,
                &|value| emitted.lock().unwrap().push(value),
                &no_runtime,
            )
            .await;
            assert!(result.is_err(), "{failure}");
            assert_eq!(*emitted.lock().unwrap(), [failure != "arm-false"]);
            assert!(executor.armed.load(Ordering::SeqCst));
            assert!(!executor.calls().contains(&GuardCommand::Release));
        }
    }

    #[tokio::test]
    async fn numeric_runtime_copy_preserves_identity_credentials_scopes_and_ownership() {
        let mut steps = verified_status(false);
        steps.push(arm_step());
        steps.push(step(
            GuardCommand::Resolve("vpn.example.com".into()),
            RESOLVED,
        ));
        let executor = FakeExecutor::new(steps);
        let gate = Arc::new(Mutex::new(()));
        let session = GuardSession::begin(executor, gate.clone()).await;
        let runtime = prepare_with(
            &session,
            Path::new("fixture.toml"),
            CONFIG,
            &|| true,
            &|_| {},
            &fixture_runtime,
        )
        .await
        .unwrap()
        .unwrap();
        let path = runtime.path.clone();
        let copy = std::fs::read_to_string(&path).unwrap();
        let before: toml::Value = CONFIG.parse().unwrap();
        let mut after: toml::Value = copy.parse().unwrap();
        after["endpoint"]["addresses"] = before["endpoint"]["addresses"].clone();
        assert_eq!(before, after);
        assert!(copy.contains("[2001:db8::1]:443"));
        let mut prepared = PreparedSpawn {
            _operation: session.operation.clone(),
            runtime: Some(runtime),
        };
        drop(session);
        assert!(
            gate.try_lock().is_err(),
            "spawn boundary must still own the operation lease"
        );
        let child_runtime = prepared.take_runtime();
        drop(prepared);
        assert!(
            path.exists(),
            "the running child must retain its credentials"
        );
        assert!(gate.try_lock().is_ok());
        drop(child_runtime);
        assert!(
            !path.exists(),
            "child exit must remove the runtime credentials"
        );
    }

    #[tokio::test]
    async fn failed_spawn_and_failed_runtime_write_remove_their_files_without_unlocking_protection()
    {
        let runtime = fixture_runtime("fixture").unwrap();
        let path = runtime.path.clone();
        let session =
            GuardSession::begin(FakeExecutor::new(vec![]), Arc::new(Mutex::new(()))).await;
        let prepared = PreparedSpawn {
            _operation: session.operation,
            runtime: Some(runtime),
        };
        drop(prepared);
        assert!(!path.exists());

        let mut steps = verified_status(false);
        steps.push(arm_step());
        steps.push(step(
            GuardCommand::Resolve("vpn.example.com".into()),
            RESOLVED,
        ));
        let executor = FakeExecutor::new(steps);
        let session = GuardSession::begin(executor.clone(), Arc::new(Mutex::new(()))).await;
        assert!(matches!(
            prepare_with(
                &session,
                Path::new("fixture.toml"),
                CONFIG,
                &|| true,
                &|_| {},
                &|_| Err(FAILED)
            )
            .await,
            Err(FAILED)
        ));
        assert!(executor.armed.load(Ordering::SeqCst));
        assert!(!executor.calls().contains(&GuardCommand::Release));
    }

    #[test]
    fn numeric_endpoints_do_not_need_dns_or_a_runtime_copy() {
        let text = "[endpoint]\naddresses=[\"192.0.2.1:443\",\"[2001:db8::1]:8443\"]\n";
        assert_eq!(replace_addresses(text, &HashMap::new()), Ok(None));
        for invalid in ["host:0", "host\nname:443", "2001:db8::1:443", "[bad]:443"] {
            assert!(split_address(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn inline_endpoint_bootstrap_preserves_valid_imported_settings() {
        let original = "# imported config\nkillswitch_enabled = true\nendpoint = { hostname = \"identity.example.com\", custom_sni = \"sni.example.com\", username = \"example\", password = \"fixture\", addresses = [\"vpn.example.com:8443\"] }\n[listener.tun]\nmtu_size = 1280\nincluded_routes = [\"2001:db8::/32\"]\nexcluded_routes = [\"2001:db8:1::/48\"]\n";
        let resolved = HashMap::from([(
            "vpn.example.com".to_owned(),
            vec!["2001:db8::1".parse().unwrap()],
        )]);
        let copy = replace_addresses(original, &resolved).unwrap().unwrap();
        let before: toml::Value = original.parse().unwrap();
        let mut after: toml::Value = copy.parse().unwrap();
        assert_eq!(
            after["endpoint"]["addresses"][0].as_str(),
            Some("[2001:db8::1]:8443")
        );
        after["endpoint"]["addresses"] = before["endpoint"]["addresses"].clone();
        assert_eq!(before, after);
        assert!(copy.starts_with("# imported config"));
    }

    #[tokio::test]
    async fn disconnect_during_help_arm_or_resolve_cannot_be_followed_by_a_late_arm() {
        for stage in ["help", "arm", "resolve"] {
            let pause = Arc::new(Pause::default());
            let mut steps = if stage == "help" {
                vec![]
            } else {
                verified_status(false)
            };
            let mut paused = if stage == "help" {
                step(GuardCommand::Help, HELP)
            } else if stage == "arm" {
                arm_step()
            } else {
                steps.push(arm_step());
                step(GuardCommand::Resolve("vpn.example.com".into()), RESOLVED)
            };
            paused.pause = Some(pause.clone());
            steps.push(paused);
            steps.extend(release_steps());
            let executor = FakeExecutor::new(steps);
            let gate = Arc::new(Mutex::new(()));
            let current = Arc::new(AtomicBool::new(true));
            let pending_executor = executor.clone();
            let pending_gate = gate.clone();
            let pending_current = current.clone();
            let prepare = tokio::spawn(async move {
                let session = GuardSession::begin(pending_executor, pending_gate).await;
                prepare_with(
                    &session,
                    Path::new("fixture.toml"),
                    CONFIG,
                    &|| pending_current.load(Ordering::SeqCst),
                    &|_| {},
                    &no_runtime,
                )
                .await
                .map(|_| ())
            });
            pause.entered.notified().await;
            current.store(false, Ordering::SeqCst);
            assert!(gate.try_lock().is_err());
            let release_executor = executor.clone();
            let release_gate = gate.clone();
            let release = tokio::spawn(async move {
                let session = GuardSession::begin(release_executor, release_gate).await;
                release_with(&session, &|| true, &|_| {}).await
            });
            pause.resume.notify_one();
            assert_eq!(prepare.await.unwrap(), Err(SUPERSEDED), "{stage}");
            assert_eq!(release.await.unwrap(), Ok(true));
            assert!(!executor.armed.load(Ordering::SeqCst));
            assert_eq!(executor.calls().last(), Some(&GuardCommand::Release));
        }
    }

    #[tokio::test]
    async fn cancelling_the_caller_still_retains_the_operation_until_its_arm_helper_finishes() {
        let pause = Arc::new(Pause::default());
        let mut steps = verified_status(false);
        let mut arm = arm_step();
        arm.pause = Some(pause.clone());
        steps.push(arm);
        steps.extend(release_steps());
        let executor = FakeExecutor::new(steps);
        let gate = Arc::new(Mutex::new(()));
        let pending_executor = executor.clone();
        let pending_gate = gate.clone();
        let prepare = tokio::spawn(async move {
            let session = GuardSession::begin(pending_executor, pending_gate).await;
            let _ = prepare_with(
                &session,
                Path::new("fixture.toml"),
                CONFIG,
                &|| true,
                &|_| {},
                &no_runtime,
            )
            .await;
        });
        pause.entered.notified().await;
        prepare.abort();
        assert!(prepare.await.unwrap_err().is_cancelled());
        assert!(
            gate.try_lock().is_err(),
            "the detached arm helper still owns the lease"
        );
        let release_executor = executor.clone();
        let release_gate = gate.clone();
        let release = tokio::spawn(async move {
            let session = GuardSession::begin(release_executor, release_gate).await;
            release_with(&session, &|| true, &|_| {}).await
        });
        pause.resume.notify_one();
        assert_eq!(release.await.unwrap(), Ok(true));
        assert!(!executor.armed.load(Ordering::SeqCst));
        assert_eq!(executor.calls().last(), Some(&GuardCommand::Release));
    }

    #[tokio::test]
    async fn stale_release_during_capability_check_never_clears_a_new_generation() {
        let pause = Arc::new(Pause::default());
        let mut help = step(GuardCommand::Help, HELP);
        help.pause = Some(pause.clone());
        let executor = FakeExecutor::new(vec![help]);
        let current = Arc::new(AtomicBool::new(true));
        let pending_current = current.clone();
        let pending_executor = executor.clone();
        let release = tokio::spawn(async move {
            let session = GuardSession::begin(pending_executor, Arc::new(Mutex::new(()))).await;
            release_with(
                &session,
                &|| pending_current.load(Ordering::SeqCst),
                &|_| panic!("no stale mutation"),
            )
            .await
        });
        pause.entered.notified().await;
        current.store(false, Ordering::SeqCst);
        pause.resume.notify_one();
        assert_eq!(release.await.unwrap(), Ok(false));
        assert_eq!(executor.calls(), [GuardCommand::Help]);
    }

    #[tokio::test]
    async fn release_reports_real_teardown_and_allows_cleanup_of_unknown_partial_state() {
        for (prior, expected) in [
            (Ok(ARMED), true),
            (Ok(UNARMED), false),
            (Err(FAILED), true),
            (Ok("partial"), true),
        ] {
            let mut steps = verified_status(false);
            steps.last_mut().unwrap().response = prior;
            steps.push(step(GuardCommand::Release, UNARMED));
            let executor = FakeExecutor::new(steps);
            let session = GuardSession::begin(executor, Arc::new(Mutex::new(()))).await;
            let emitted = StdMutex::new(Vec::new());
            assert_eq!(
                release_with(&session, &|| true, &|armed| emitted
                    .lock()
                    .unwrap()
                    .push(armed))
                .await,
                Ok(expected)
            );
            assert_eq!(*emitted.lock().unwrap(), [false]);
        }
    }

    #[tokio::test]
    async fn a_failed_or_uncertain_release_never_reports_unprotected() {
        for response in [Err(FAILED), Ok(ARMED), Ok("invalid JSON")] {
            let mut steps = verified_status(true);
            let mut release = step(GuardCommand::Release, UNARMED);
            release.response = response;
            steps.push(release);
            let executor = FakeExecutor::new(steps);
            let session = GuardSession::begin(executor, Arc::new(Mutex::new(()))).await;
            let emitted = StdMutex::new(Vec::new());
            assert_eq!(
                release_with(&session, &|| true, &|armed| emitted
                    .lock()
                    .unwrap()
                    .push(armed))
                .await,
                Err(FAILED)
            );
            let emitted = emitted.lock().unwrap();
            if response == Ok(ARMED) {
                assert_eq!(*emitted, [true]);
            } else {
                assert!(emitted.is_empty());
            }
        }
    }

    struct FakeProcess {
        reaping: Arc<Pause>,
        completed: Arc<AtomicBool>,
    }
    impl HelperProcess for FakeProcess {
        fn output(&mut self) -> GuardFuture<'_, HelperOutput> {
            Box::pin(std::future::pending())
        }
        fn terminate_and_reap(&mut self) -> GuardFuture<'_, ()> {
            Box::pin(async {
                self.reaping.entered.notify_one();
                self.reaping.resume.notified().await;
                self.completed.store(true, Ordering::SeqCst);
                Ok(())
            })
        }
    }

    #[tokio::test]
    async fn timeout_waits_for_confirmed_reaping_before_returning_failure() {
        let reaping = Arc::new(Pause::default());
        let completed = Arc::new(AtomicBool::new(false));
        let task_reaping = reaping.clone();
        let task_completed = completed.clone();
        let task = tokio::spawn(async move {
            bounded_output(
                FakeProcess {
                    reaping: task_reaping,
                    completed: task_completed,
                },
                false,
                Duration::from_millis(1),
            )
            .await
        });
        reaping.entered.notified().await;
        assert!(!task.is_finished());
        assert!(!completed.load(Ordering::SeqCst));
        reaping.resume.notify_one();
        assert_eq!(task.await.unwrap(), Err(FAILED));
        assert!(completed.load(Ordering::SeqCst));
    }

    #[test]
    fn resident_commands_keep_utf8_and_reject_line_injection() {
        assert_eq!(resident_command(&GuardCommand::Status), Ok("S\n".into()));
        assert_eq!(resident_command(&GuardCommand::Release), Ok("R\n".into()));
        assert_eq!(
            resident_command(&GuardCommand::Arm(PathBuf::from(
                "C:/fixture with spaces/имя.toml"
            ))),
            Ok("A C:/fixture with spaces/имя.toml\n".into())
        );
        for path in ["", "fixture\nR", "fixture\rA second", "fixture\0.toml"] {
            assert!(resident_command(&GuardCommand::Arm(PathBuf::from(path))).is_err());
        }
        assert!(resident_command(&GuardCommand::LegacyRelease).is_err());
    }

    #[tokio::test]
    async fn resident_frames_require_a_newline_and_enforce_the_output_bound() {
        let mut valid = b"{\"version\":2,\"armed\":false}\n".as_slice();
        assert_eq!(read_resident_line(&mut valid).await.unwrap(), UNARMED);
        let mut incomplete = b"{\"version\":2,\"armed\":false}".as_slice();
        assert!(read_resident_line(&mut incomplete).await.is_err());
        let oversized = vec![b'x'; OUTPUT_LIMIT as usize + 1];
        assert!(read_resident_line(&mut oversized.as_slice()).await.is_err());
    }

    #[tokio::test]
    async fn resident_transport_reuses_one_channel_and_never_releases_between_rearms() {
        let (client, server) = tokio::io::duplex(1024);
        let (mut input, mut output) = tokio::io::split(server);
        let peer = tokio::spawn(async move {
            let mut commands = Vec::new();
            for reply in [ARMED, ARMED, ARMED, UNARMED, ARMED] {
                commands.push(read_resident_line(&mut input).await.unwrap());
                output
                    .write_all(format!("{reply}\n").as_bytes())
                    .await
                    .unwrap();
            }
            assert!(
                read_resident_line(&mut input).await.is_err(),
                "GUI EOF ends the session"
            );
            commands
        });
        let (mut output, mut input) = tokio::io::split(client);
        for command in [
            "A first.toml\n",
            "A second.toml\n",
            "S\n",
            "R\n",
            "A third.toml\n",
        ] {
            assert!(exchange_resident(&mut input, &mut output, command)
                .await
                .is_ok());
        }
        drop(input);
        drop(output);
        assert_eq!(
            peer.await.unwrap(),
            ["A first.toml", "A second.toml", "S", "R", "A third.toml"]
        );
    }

    #[tokio::test]
    async fn startup_migration_only_uses_verified_legacy_cleanup_and_never_arms() {
        let executor = FakeExecutor::new(vec![
            step(GuardCommand::Help, HELP),
            step(GuardCommand::Version, "2"),
            step(GuardCommand::LegacyRelease, UNARMED),
        ]);
        let session = GuardSession::begin(executor.clone(), Arc::new(Mutex::new(()))).await;
        assert_eq!(migrate_with(&session).await, Ok(()));
        assert_eq!(
            executor.calls(),
            [
                GuardCommand::Help,
                GuardCommand::Version,
                GuardCommand::LegacyRelease
            ]
        );
    }

    #[tokio::test]
    async fn persistent_only_core_is_rejected_before_any_mutating_command() {
        let executor = FakeExecutor::new(vec![step(GuardCommand::Help, "--network-guard-version --network-guard-status --network-guard-arm --network-guard-release --network-guard-resolve")]);
        let session = GuardSession::begin(executor.clone(), Arc::new(Mutex::new(()))).await;
        assert_eq!(verify(&session, &|| true).await, Err(FAILED));
        assert_eq!(executor.calls(), [GuardCommand::Help]);
    }

    #[test]
    fn an_already_unarmed_helper_death_never_requests_connection_teardown() {
        for request in [
            None,
            Some(GuardCommand::Status),
            Some(GuardCommand::Release),
        ] {
            let mut state = ResidentState::default();
            let (reply, notify_failure) =
                finish_resident_failure(&mut state, 42, false, request.as_ref());
            assert_eq!(reply.and_then(|text| parse_state(&text)), Ok(false));
            assert!(
                !notify_failure,
                "an idle guardian cannot fail an unrelated KS-off connection"
            );
            assert!(
                state.failed.is_none(),
                "the next protected connection may start a fresh guardian"
            );
        }
    }

    #[test]
    fn armed_death_and_an_unanswered_arm_both_require_generation_safe_failure_handling() {
        for (armed, request) in [
            (true, None),
            (
                false,
                Some(GuardCommand::Arm(PathBuf::from("fixture.toml"))),
            ),
        ] {
            let mut state = ResidentState::default();
            let (reply, notify_failure) =
                finish_resident_failure(&mut state, 43, armed, request.as_ref());
            assert_eq!(reply, Err(FAILED));
            assert!(notify_failure);
            assert_eq!(state.failed, Some(43));
        }
    }

    #[cfg(windows)]
    #[test]
    fn kernel_job_target_fixture() {
        if std::env::var_os("TT_GUARD_JOB_TARGET_FIXTURE").is_some() {
            loop {
                std::thread::park_timeout(Duration::from_secs(60));
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn kernel_job_owner_fixture() {
        if std::env::var_os("TT_GUARD_JOB_OWNER_FIXTURE").is_none() {
            return;
        }
        use std::io::Write;
        use std::os::windows::process::CommandExt;
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "network_guard::tests::kernel_job_target_fixture",
                "--nocapture",
            ])
            .env("TT_GUARD_JOB_TARGET_FIXTURE", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x0800_0000)
            .spawn()
            .unwrap();
        let job = crate::job_object::assign_to_kill_on_close_job(child.id());
        let _job = match job {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("{error}");
            }
        };
        println!("GUARD_FIXTURE_CHILD={}", child.id());
        std::io::stdout().flush().unwrap();
        loop {
            std::thread::park_timeout(Duration::from_secs(60));
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn gui_crash_closes_the_kernel_job_even_without_rust_destructors() {
        let mut owner = tokio::process::Command::new(std::env::current_exe().unwrap());
        owner
            .args([
                "--exact",
                "network_guard::tests::kernel_job_owner_fixture",
                "--nocapture",
            ])
            .env("TT_GUARD_JOB_OWNER_FIXTURE", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(0x0800_0000)
            .kill_on_drop(true);
        let mut owner = owner.spawn().unwrap();
        let mut output = BufReader::new(owner.stdout.take().unwrap());
        let child = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let line = read_resident_line(&mut output).await.unwrap();
                if let Some((_, pid)) = line.split_once("GUARD_FIXTURE_CHILD=") {
                    break pid.trim().parse::<u32>().unwrap();
                }
            }
        })
        .await
        .expect("fixture must publish its owned child PID");
        assert!(crate::sidecar::process_is_alive(child));
        // TerminateProcess skips Rust Drop in the fixture owner. Only Windows closes its job handle.
        owner.kill().await.unwrap();
        for _ in 0..100 {
            if !crate::sidecar::process_is_alive(child) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("the owned helper survived its GUI owner");
    }
}
