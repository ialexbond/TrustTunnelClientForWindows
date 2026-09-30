//! Graceful stop of the C++ core through its own Ctrl+C handler (G-03.1-10).
//!
//! The core (`trusttunnel_client.exe`) is a console program. On Windows it installs
//! `signal(SIGINT, …)` (`setup_sighandler` in `trusttunnel/src/trusttunnel_client.cpp`): a Ctrl+C
//! wakes its main loop, which runs `client->disconnect()` — the core removes its own WinTUN
//! adapter, routes and killswitch filters — and returns 0. That is the only clean stop it has.
//!
//! Before this module the app asked for a stop with `taskkill /PID <pid>` (no `/F`). taskkill
//! without `/F` posts WM_CLOSE to the target's windows; the core is spawned with CREATE_NO_WINDOW
//! and has none, so taskkill refused every time (`requested=false` in app.log) and the app
//! hard-killed the core 1.5 s later. A hard kill leaves the adapter for Windows to remove on its
//! own, with a delay, and a connect inside that delay hit the WinTUN adapter failure (a 15 s hang,
//! then ERROR_FILE_NOT_FOUND). The old code comment already admitted the graceful leg "cannot be
//! proven here"; the tests below prove the new one on real processes.
//!
//! A Ctrl+C reaches a console process only through its own console, and it reaches EVERY process
//! attached to that console. So the app never attaches itself: it starts a one-shot helper — its own
//! executable with `HELPER_ARG` — which attaches to the core's console, sets its own "ignore
//! Ctrl+C" flag, raises CTRL_C_EVENT and exits. Attaching the app itself was tried first and
//! rejected: a handler registered with `SetConsoleCtrlHandler` did not protect the sender (the tests
//! caught it ending with STATUS_CONTROL_C_EXIT), and the ignore flag that does protect it is
//! process-wide and inherited by child processes — in the app it would race with core spawns and
//! with the asynchronous delivery of the app's own copy of the event (code review WR-01..WR-04).
//! In a helper that lives for one call none of that exists.
//!
//! The core inherits its parent's ignore flag at creation. `prepare_spawn` clears it in the app
//! before every core spawn, so the core handles Ctrl+C even when a launcher started the app with
//! Ctrl+C disabled. The app never attaches to a console, so the cleared flag exposes nothing.

use std::process::Command;
use std::time::{Duration, Instant};

/// First argument that turns the app's executable into the one-shot Ctrl+C helper. `main()`
/// checks it before anything else (`helper_exit_code_from_args`).
pub const HELPER_ARG: &str = "--tt-send-ctrl-c";

/// Helper exit codes. Anything else (e.g. 0xC000013A) means the helper itself was ended.
const HELPER_OK: i32 = 0;
const HELPER_ATTACH_FAILED: i32 = 2;
const HELPER_GENERATE_FAILED: i32 = 3;
const HELPER_BAD_ARGS: i32 = 4;

/// How long the app waits for the helper. It normally exits within tens of milliseconds.
const HELPER_TIMEOUT: Duration = Duration::from_secs(3);

/// Why a Ctrl+C could not be delivered. Only numbers (D-29).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CtrlCError {
    /// The helper could not be started.
    Spawn,
    /// The helper did not finish within `HELPER_TIMEOUT` and was killed.
    Timeout,
    /// The helper finished with this exit code: 2 = the target is gone or has no console,
    /// 3 = raising the event failed, anything else = the helper itself was ended.
    Helper(i32),
    /// Not supported on this platform.
    #[cfg_attr(windows, allow(dead_code))]
    Unsupported,
}

impl std::fmt::Display for CtrlCError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CtrlCError::Spawn => write!(f, "helper not started"),
            CtrlCError::Timeout => write!(f, "helper timed out"),
            CtrlCError::Helper(code) => write!(f, "helper exit code {code}"),
            CtrlCError::Unsupported => write!(f, "not supported on this platform"),
        }
    }
}

/// Called first thing in `main()`. `Some(exit code)` when this process was started as the helper
/// (`<exe> --tt-send-ctrl-c <pid>`); `None` for every normal launch, which then proceeds untouched.
pub fn helper_exit_code_from_args(args: impl IntoIterator<Item = String>) -> Option<i32> {
    let mut args = args.into_iter().skip(1);
    if args.next().as_deref() != Some(HELPER_ARG) {
        return None;
    }
    let Some(pid) = args.next().and_then(|s| s.parse::<u32>().ok()) else {
        return Some(HELPER_BAD_ARGS);
    };
    Some(raise_ctrl_c_in_console_of(pid))
}

/// Runs only inside the helper process.
#[cfg(windows)]
fn raise_ctrl_c_in_console_of(pid: u32) -> i32 {
    use windows_sys::Win32::System::Console::{
        AttachConsole, FreeConsole, GenerateConsoleCtrlEvent, SetConsoleCtrlHandler, CTRL_C_EVENT,
    };
    // SAFETY: documented Win32 console calls in a process that exits right after them.
    unsafe {
        // The release helper is a GUI process without a console; a console-subsystem helper (the
        // tests) must leave its own before it can attach to the target's.
        FreeConsole();
        if AttachConsole(pid) == 0 {
            return HELPER_ATTACH_FAILED;
        }
        // The event reaches every process on this console, this helper included: ignore it here.
        SetConsoleCtrlHandler(None, 1);
        // Group 0 = every process on this console: the core and this helper.
        if GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0) == 0 {
            return HELPER_GENERATE_FAILED;
        }
        HELPER_OK
    }
}

#[cfg(not(windows))]
fn raise_ctrl_c_in_console_of(_pid: u32) -> i32 {
    HELPER_GENERATE_FAILED
}

/// Call before every core spawn: clear the app's "ignore Ctrl+C" flag so the core inherits
/// "Ctrl+C enabled". The app never attaches to a console, so it can never receive the event.
pub fn prepare_spawn() {
    #[cfg(windows)]
    // SAFETY: `SetConsoleCtrlHandler(NULL, FALSE)` only clears this process's ignore flag.
    unsafe {
        windows_sys::Win32::System::Console::SetConsoleCtrlHandler(None, 0);
    }
}

/// Deliver a Ctrl+C to the console process `pid` through the helper — the core then stops through
/// its own handler. Blocks until the helper has finished (normally tens of milliseconds, at most
/// `HELPER_TIMEOUT`); the caller then waits for the core to exit.
pub fn send_ctrl_c(pid: u32) -> Result<(), CtrlCError> {
    #[cfg(windows)]
    {
        let exe = std::env::current_exe().map_err(|_| CtrlCError::Spawn)?;
        let mut helper = Command::new(exe);
        helper.arg(HELPER_ARG).arg(pid.to_string());
        send_ctrl_c_via(helper)
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        Err(CtrlCError::Unsupported)
    }
}

/// Run a prepared helper command and interpret its exit code. Separate so the tests can start the
/// same helper function from the test binary (the release helper is `trusttunnel.exe`, which needs
/// administrator rights to start).
#[cfg_attr(not(windows), allow(dead_code))]
fn send_ctrl_c_via(mut helper: Command) -> Result<(), CtrlCError> {
    use std::process::Stdio;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // No window for a console-subsystem helper (the tests); a GUI one has none anyway.
        helper.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = helper
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| CtrlCError::Spawn)?;
    let deadline = Instant::now() + HELPER_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return match status.code() {
                    Some(HELPER_OK) => Ok(()),
                    Some(code) => Err(CtrlCError::Helper(code)),
                    None => Err(CtrlCError::Helper(-1)),
                };
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(CtrlCError::Timeout);
            }
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::{Child, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};

    /// The spawn flag the shell plugin uses for the core (tauri-plugin-shell `Command::new`).
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CHILD_MARKER_ENV: &str = "TT_CTRL_C_TEST_CHILD_MARKER";
    const CHILD_TEST: &str = "console_ctrl::tests::ctrl_c_test_child";
    const HELPER_PID_ENV: &str = "TT_CTRL_C_TEST_HELPER_PID";
    const HELPER_TEST: &str = "console_ctrl::tests::ctrl_c_test_helper";
    const APP_MARKER_ENV: &str = "TT_CTRL_C_TEST_APP_MARKER";
    const APP_TEST: &str = "console_ctrl::tests::ctrl_c_test_gui_app";
    /// Path of the console test binary, handed to the GUI copy so its stand-ins stay console
    /// processes like the core.
    const CONSOLE_EXE_ENV: &str = "TT_CTRL_C_TEST_CONSOLE_EXE";
    const SIGINT: i32 = 2;

    extern "C" {
        // The C runtime `signal`, the same call the core makes in `setup_sighandler`.
        fn signal(sig: i32, handler: extern "C" fn(i32)) -> usize;
    }

    static CHILD_GOT_SIGINT: AtomicBool = AtomicBool::new(false);

    extern "C" fn child_on_sigint(_sig: i32) {
        CHILD_GOT_SIGINT.store(true, Ordering::SeqCst);
    }

    /// Stand-in for the core, started by the tests below as a separate process of this test
    /// binary: it installs a SIGINT handler exactly like `trusttunnel_client.cpp`, reports that it
    /// is ready, and on Ctrl+C records it and exits with 0 — the core's clean-stop exit code. It
    /// touches nothing but its own marker file in the temp folder.
    #[test]
    #[ignore = "helper process for the console_ctrl tests; does nothing unless they start it"]
    fn ctrl_c_test_child() {
        let Ok(marker) = std::env::var(CHILD_MARKER_ENV) else {
            return;
        };
        // SAFETY: registers a handler that only stores to an atomic.
        unsafe {
            signal(SIGINT, child_on_sigint);
        }
        std::fs::write(&marker, "ready").unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        while !CHILD_GOT_SIGINT.load(Ordering::SeqCst) {
            if Instant::now() > deadline {
                std::process::exit(3); // never signalled: end on our own, never linger
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        std::fs::write(&marker, "stopped-by-ctrl-c").unwrap();
        std::process::exit(0);
    }

    /// The helper, run from the test binary through the SAME function `main()` calls in the app.
    #[test]
    #[ignore = "helper process for the console_ctrl tests; does nothing unless they start it"]
    fn ctrl_c_test_helper() {
        let Ok(pid) = std::env::var(HELPER_PID_ENV) else {
            return;
        };
        let args = ["exe".to_string(), HELPER_ARG.to_string(), pid];
        let code = helper_exit_code_from_args(args).expect("helper arguments");
        std::process::exit(code);
    }

    /// The helper command for the tests: this binary (or its GUI copy, when running inside one).
    fn test_helper(pid: u32) -> Command {
        let mut cmd = Command::new(std::env::current_exe().unwrap());
        cmd.args([HELPER_TEST, "--exact", "--ignored", "--test-threads=1"])
            .env(HELPER_PID_ENV, pid.to_string());
        cmd
    }

    fn marker_path(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("tt-ctrl-c-{tag}-{}.txt", std::process::id()))
    }

    fn console_test_exe() -> PathBuf {
        std::env::var_os(CONSOLE_EXE_ENV)
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::current_exe().unwrap())
    }

    /// Start the stand-in the way the app starts the core: `prepare_spawn`, then a windowless
    /// console process with piped stdin.
    fn spawn_stand_in(marker: &Path) -> Child {
        let _ = std::fs::remove_file(marker);
        prepare_spawn();
        let child = Command::new(console_test_exe())
            .args([CHILD_TEST, "--exact", "--ignored", "--test-threads=1"])
            .env(CHILD_MARKER_ENV, marker)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .expect("start the stand-in process");
        let deadline = Instant::now() + Duration::from_secs(20);
        while std::fs::read_to_string(marker).map(|s| s != "ready").unwrap_or(true) {
            assert!(Instant::now() < deadline, "the stand-in never reported ready");
            std::thread::sleep(Duration::from_millis(20));
        }
        child
    }

    fn wait_exit(child: &mut Child, limit: Duration) -> Option<std::process::ExitStatus> {
        let deadline = Instant::now() + limit;
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                return Some(status);
            }
            if Instant::now() > deadline {
                return None;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// One disconnect: spawn a stand-in, stop it with Ctrl+C through the helper, return the
    /// delivery result, the stand-in's exit code (None = it did not stop within 5 s and was
    /// killed) and its marker text.
    fn stop_one_stand_in(tag: &str) -> (Result<(), CtrlCError>, Option<i32>, String) {
        let marker = marker_path(tag);
        let mut child = spawn_stand_in(&marker);
        let sent = send_ctrl_c_via(test_helper(child.id()));
        let status = wait_exit(&mut child, Duration::from_secs(5));
        if status.is_none() {
            let _ = child.kill();
            let _ = child.wait();
        }
        let note = std::fs::read_to_string(&marker).unwrap_or_default();
        let _ = std::fs::remove_file(&marker);
        (sent, status.and_then(|s| s.code()), note)
    }

    #[test]
    fn ctrl_c_stops_a_windowless_console_process_through_its_own_handler() {
        let (sent, code, note) = stop_one_stand_in("graceful");
        assert_eq!(sent, Ok(()), "the helper did not deliver the Ctrl+C");
        assert_eq!(code, Some(0), "clean exit through the SIGINT handler, not a kill");
        assert_eq!(note, "stopped-by-ctrl-c");
    }

    #[test]
    fn stop_connect_stop_in_quick_succession_each_stops_cleanly() {
        // Disconnect → immediate connect → disconnect, three times: every new stand-in is spawned
        // right after the previous stop (prepare_spawn keeps Ctrl+C enabled for it), and every
        // stop is clean.
        for round in 0..3 {
            let (sent, code, _) = stop_one_stand_in(&format!("round{round}"));
            assert_eq!(sent, Ok(()), "round {round}: not delivered");
            assert_eq!(code, Some(0), "round {round}: not a clean Ctrl+C exit");
        }
    }

    /// Runs inside a copy of this test binary marked as a GUI program, like `trusttunnel.exe`: it
    /// plays the app (spawns stand-ins, stops them) and, through `test_helper`, also starts GUI
    /// helpers — exactly the production arrangement.
    #[test]
    #[ignore = "helper process for the console_ctrl tests; does nothing unless they start it"]
    fn ctrl_c_test_gui_app() {
        let Ok(marker) = std::env::var(APP_MARKER_ENV) else {
            return;
        };
        let mut report = Vec::new();
        for round in 0..2 {
            let (sent, code, _) = stop_one_stand_in(&format!("gui-round{round}"));
            report.push(format!("{sent:?}/{code:?}"));
        }
        std::thread::sleep(Duration::from_millis(500));
        std::fs::write(&marker, format!("alive {}", report.join(" "))).unwrap();
        std::process::exit(0);
    }

    #[test]
    fn a_gui_app_and_gui_helper_like_trusttunnel_exe_stop_the_core_and_survive() {
        let exe = std::env::current_exe().unwrap();
        let gui = exe.with_file_name(format!("tt-ctrl-c-gui-app-{}.exe", std::process::id()));
        let mut bytes = std::fs::read(&exe).unwrap();
        // PE header: e_lfanew at 0x3C; the optional header's Subsystem field sits 68 bytes into
        // it (PE32 and PE32+ alike), after the 4-byte signature and the 20-byte file header.
        let pe = u32::from_le_bytes(bytes[0x3C..0x40].try_into().unwrap()) as usize;
        assert_eq!(&bytes[pe..pe + 4], b"PE\0\0");
        let subsystem = pe + 4 + 20 + 68;
        assert_eq!(u16::from_le_bytes([bytes[subsystem], bytes[subsystem + 1]]), 3, "console test binary");
        bytes[subsystem..subsystem + 2].copy_from_slice(&2u16.to_le_bytes()); // IMAGE_SUBSYSTEM_WINDOWS_GUI
        std::fs::write(&gui, &bytes).unwrap();
        // Removed on every exit of this test, a failed assertion or expect included.
        struct RemoveOnDrop(PathBuf);
        impl Drop for RemoveOnDrop {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
            }
        }
        let _gui_copy = RemoveOnDrop(gui.clone());

        let marker = marker_path("gui-app");
        let _ = std::fs::remove_file(&marker);
        let mut app = Command::new(&gui)
            .args([APP_TEST, "--exact", "--ignored", "--test-threads=1"])
            .env(APP_MARKER_ENV, &marker)
            .env(CONSOLE_EXE_ENV, &exe)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("start the GUI app stand-in");
        let status = wait_exit(&mut app, Duration::from_secs(60));
        if status.is_none() {
            let _ = app.kill();
            let _ = app.wait();
        }
        let note = std::fs::read_to_string(&marker).unwrap_or_default();
        let _ = std::fs::remove_file(&marker);
        assert_eq!(status.and_then(|s| s.code()), Some(0), "the GUI app did not finish cleanly");
        assert_eq!(note, "alive Ok(())/Some(0) Ok(())/Some(0)", "both stand-ins must stop cleanly");
    }

    #[test]
    fn taskkill_without_force_never_reaches_a_windowless_console_process() {
        // The old stop request (3.0.0 – 3.1.0 candidates): kept as a test so the reason for the
        // G-03.1-10 failure stays visible. taskkill without /F posts WM_CLOSE and the stand-in,
        // like the core, has no window — the request is refused and the process keeps running.
        let marker = marker_path("taskkill");
        let mut child = spawn_stand_in(&marker);
        let requested = Command::new("taskkill")
            .args(["/PID", &child.id().to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        let status = wait_exit(&mut child, Duration::from_millis(1500));
        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_file(&marker);
        assert!(!requested, "taskkill without /F unexpectedly accepted the request");
        assert!(status.is_none(), "the process stopped without a Ctrl+C: {status:?}");
    }

    #[test]
    fn ctrl_c_to_a_missing_process_reports_the_attach_failure() {
        // PIDs are multiples of 4 and this one is never assigned.
        assert_eq!(
            send_ctrl_c_via(test_helper(0xFFFF_FFF0)),
            Err(CtrlCError::Helper(HELPER_ATTACH_FAILED))
        );
    }

    #[test]
    fn normal_launches_are_never_taken_for_the_helper() {
        let launch = |args: &[&str]| {
            helper_exit_code_from_args(args.iter().map(|s| s.to_string()).collect::<Vec<_>>())
        };
        assert_eq!(launch(&["trusttunnel.exe"]), None);
        assert_eq!(launch(&["trusttunnel.exe", "--minimized"]), None);
        assert_eq!(launch(&["trusttunnel.exe", "--autostart", HELPER_ARG]), None);
        assert_eq!(launch(&["trusttunnel.exe", HELPER_ARG]), Some(HELPER_BAD_ARGS));
        assert_eq!(launch(&["trusttunnel.exe", HELPER_ARG, "abc"]), Some(HELPER_BAD_ARGS));
    }
}
