//! Product-owned protection survives both GUI and core process termination.
//! Only an explicit disconnect may release it; automatic cleanup never does.

use std::collections::HashMap;
use std::future::Future;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::Ordering;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde::Deserialize;
use tauri::{Emitter, Manager};
use tokio::io::AsyncReadExt;
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
    Resolve(String),
}

trait GuardExecutor: Send + Sync {
    fn query(&self, command: GuardCommand) -> GuardFuture<'_, String>;
}

struct NativeExecutor {
    binary: PathBuf,
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
            let help = request == GuardCommand::Help;
            let mut command = tokio::process::Command::new(&self.binary);
            match request {
                GuardCommand::Help => {
                    command.arg("--help");
                }
                GuardCommand::Version => {
                    command.arg("--network-guard-version");
                }
                GuardCommand::Status => {
                    command.arg("--network-guard-status");
                }
                GuardCommand::Arm(path) => {
                    command.arg("--network-guard-arm").arg(path);
                }
                GuardCommand::Release => {
                    command.arg("--network-guard-release");
                }
                GuardCommand::Resolve(host) => {
                    command.arg("--network-guard-resolve").arg(host);
                }
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
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ResolvedHost {
    version: u8,
    addresses: Vec<IpAddr>,
}

fn parse_state(text: &str) -> Result<bool, &'static str> {
    let reply: GuardState = serde_json::from_str(text).map_err(|_| FAILED)?;
    (reply.version == 1).then_some(reply.armed).ok_or(FAILED)
}

fn parse_addresses(text: &str) -> Result<Vec<IpAddr>, &'static str> {
    let reply: ResolvedHost = serde_json::from_str(text).map_err(|_| BOOTSTRAP_FAILED)?;
    if reply.version != 1 || reply.addresses.is_empty() || reply.addresses.len() > MAX_ADDRESSES {
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
        "--network-guard-arm",
        "--network-guard-release",
        "--network-guard-resolve",
    ] {
        if !help_has_flag(&help, flag) {
            return Err(FAILED);
        }
    }
    let version = session.query(GuardCommand::Version).await?;
    require_current(current)?;
    if version.trim() != "1" {
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
pub async fn network_guard_status() -> Result<bool, String> {
    if !cfg!(windows) {
        return Ok(false);
    }
    let session = GuardSession::begin(
        Arc::new(NativeExecutor {
            binary: core_binary().map_err(str::to_owned)?,
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
    let armed = session
        .query(GuardCommand::Arm(config_path.to_owned()))
        .await
        .and_then(|text| parse_state(&text));
    // Any uncertain transaction keeps the recovery surface conservative. No failure path releases protection.
    emit(true);
    if armed != Ok(true) {
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
    let result = session
        .query(GuardCommand::Release)
        .await
        .and_then(|text| parse_state(&text));
    if result != Ok(false) {
        emit(true);
        return Err(FAILED);
    }
    emit(false);
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

    const HELP: &str = "--network-guard-version --network-guard-status --network-guard-arm=CONFIG --network-guard-release --network-guard-resolve=HOST";
    const ARMED: &str = r#"{"version":1,"armed":true}"#;
    const UNARMED: &str = r#"{"version":1,"armed":false}"#;
    const RESOLVED: &str = r#"{"version":1,"addresses":["192.0.2.1","2001:db8::1"]}"#;
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
            step(GuardCommand::Version, "1"),
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
            r#"{"version":2,"armed":false}"#,
            r#"{"version":1,"armed":false,"error":"partial"}"#,
        ] {
            assert!(parse_state(text).is_err());
        }
        assert_eq!(parse_state(ARMED), Ok(true));
        assert_eq!(parse_state(UNARMED), Ok(false));
        for text in [
            r#"{"version":1,"addresses":[]}"#,
            r#"{"version":1,"addresses":["example.com"]}"#,
        ] {
            assert!(parse_addresses(text).is_err());
        }
        let too_many =
            serde_json::json!({ "version": 1, "addresses": vec!["192.0.2.1"; MAX_ADDRESSES + 1] });
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
            step(GuardCommand::Version, "2"),
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
                arm.response = Err(FAILED);
            }
            if failure == "arm-false" {
                arm.response = Ok(UNARMED);
            }
            steps.push(arm);
            if failure.starts_with("dns-") {
                let mut dns = step(
                    GuardCommand::Resolve("vpn.example.com".into()),
                    r#"{"version":1,"addresses":[]}"#,
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
            assert_eq!(*emitted.lock().unwrap(), [true]);
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
            assert_eq!(*emitted.lock().unwrap(), [true]);
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
}
