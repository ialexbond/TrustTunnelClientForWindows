//! Windows Job Object helper — the OS-level guarantee that the spawned VPN
//! sidecar can NEVER outlive the parent app (D-06 / STATUS-04 criterion 1).
//!
//! We create an unnamed Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
//! and assign the sidecar's PID to it. The semantics of that flag are: when the
//! LAST open handle to the job is closed, the OS terminates every process that
//! is still a member of the job. Because the only handle lives inside our
//! process, the OS closes it whenever the parent dies for ANY reason — a
//! graceful quit, a tray quit, a `panic!`, or a hard crash that never reaches
//! `RunEvent::Exit`. A user-space watchdog cannot cover the crash case (it dies
//! with the crash, leaving the orphan); only this kernel primitive can.
//! `[CITED: learn.microsoft.com/.../procthread/job-objects]`
//!
//! ## Why raw FFI via `windows-sys` (not the `windows` crate, not `win32job`)
//! The project deliberately avoids the high-level `windows` crate (see the note
//! in `Cargo.toml` and `tray.rs::apply_win11_rounded_corners`) to dodge HWND
//! type-mismatches with the version Tauri bundles. `win32job` would pull
//! `windows ^0.61` transitively, so it is rejected. `windows-sys` is the raw
//! Microsoft binding crate, already transitive in `Cargo.lock` (zero new
//! download), and Job Objects use no HWND — so the avoidance rationale does not
//! apply here. This mirrors the established `tray.rs` FFI precedent.
//!
//! ## RAII ownership (`OwnedJobHandle`)
//! The job handle is lifecycle-critical: closing it is the deliberate kill, and
//! a double-close / leak / early-drop would be a correctness bug (Codex MEDIUM).
//! Rather than pass a raw `isize` around with a manual `CloseHandle` at some
//! call site, we wrap the handle in `OwnedJobHandle`, whose `Drop` calls
//! `CloseHandle` exactly once. The value is constructed ONLY on full success, so
//! there is a single source of truth for the close. The caller keeps it alive
//! for the connection's lifetime (stored in `SidecarChild`); dropping the
//! `SidecarChild` closes the job and arms the kill.

/// RAII wrapper around a Windows Job Object HANDLE.
///
/// `raw` is the OS HANDLE as an `isize` (Win32 `HANDLE` is a pointer-sized
/// value; `0` / null means "no handle"). The non-Windows twin always holds `0`
/// and its `Drop` is a no-op, so the same type compiles on every platform and
/// the cfg-gated call sites do not need their own platform branches.
///
/// Kept alive == `KILL_ON_JOB_CLOSE` stays armed. Dropped == the OS closes the
/// last handle and terminates the job's members.
pub struct OwnedJobHandle {
    raw: isize,
}

impl OwnedJobHandle {
    /// The "no job" sentinel. Used by the non-Windows no-op twin and as the
    /// `Default`, so a degraded-mode `job: None` and a no-op build behave the
    /// same: nothing to close.
    #[allow(dead_code)] // referenced only by the non-windows twin on some targets
    const NULL: isize = 0;
}

impl Default for OwnedJobHandle {
    fn default() -> Self {
        OwnedJobHandle { raw: OwnedJobHandle::NULL }
    }
}

#[cfg(target_os = "windows")]
impl Drop for OwnedJobHandle {
    fn drop(&mut self) {
        // Close exactly once, and only if we actually own a handle. Closing the
        // last job handle is what arms KILL_ON_JOB_CLOSE — so this Drop IS the
        // kill. Constructing `OwnedJobHandle` only on full success guarantees no
        // double-close: there is no other place that closes this handle.
        if self.raw != 0 {
            use windows_sys::Win32::Foundation::CloseHandle;
            // SAFETY: `self.raw` is a valid job HANDLE returned by
            // `CreateJobObjectW` and never closed elsewhere; we close it once.
            unsafe {
                CloseHandle(self.raw as _);
            }
            self.raw = 0;
        }
    }
}

/// Non-Windows twin: no handle, no-op `Drop`. Mirrors the `tray.rs`
/// `#[cfg(not(target_os = "windows"))]` pattern so the rest of the code is
/// platform-agnostic.
#[cfg(not(target_os = "windows"))]
impl Drop for OwnedJobHandle {
    fn drop(&mut self) {}
}

/// Create a `KILL_ON_JOB_CLOSE` Job Object and assign `pid` to it, returning the
/// owning handle to keep alive for the connection (Windows implementation).
///
/// On EVERY failure path we close any handle already opened BEFORE returning a
/// FIXED `Err(...)` naming the failed Win32 call — no secret, no PID, just the
/// call name (D-09). Because `OwnedJobHandle` is built only on full success, the
/// early-exit paths cannot leak and there is no double-close.
///
/// The returned `Err` is the explicit DEGRADED-MODE signal: the caller logs a
/// fixed phrase and CONTINUES connecting with `job: None`. Assign can legitimately
/// fail when the parent is already inside a job (debugger / CI / some launchers),
/// and that must never block the user from connecting — the PID-file fallback
/// still covers cleanup (Codex MEDIUM, D-06).
#[cfg(target_os = "windows")]
pub fn assign_to_kill_on_close_job(pid: u32) -> Result<OwnedJobHandle, String> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    // SAFETY: all calls below are FFI into well-documented Win32 APIs. Each
    // returned handle is checked for null before use, and every early return
    // closes handles already opened so nothing leaks.
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return Err("CreateJobObjectW failed".to_string());
        }

        // Zero the extended-limit struct, then set ONLY the kill-on-close flag.
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let set_ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if set_ok == 0 {
            CloseHandle(job);
            return Err("SetInformationJobObject failed".to_string());
        }

        // Open the sidecar process. PROCESS_SET_QUOTA + PROCESS_TERMINATE are
        // the rights AssignProcessToJobObject requires.
        let proc = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
        if proc.is_null() {
            CloseHandle(job);
            return Err("OpenProcess failed".to_string());
        }

        let assigned = AssignProcessToJobObject(job, proc);
        // We no longer need the process handle once assignment is attempted —
        // close it regardless of success so it never leaks.
        CloseHandle(proc);
        if assigned == 0 {
            CloseHandle(job);
            return Err("AssignProcessToJobObject failed".to_string());
        }

        // Full success — hand the job HANDLE to the RAII wrapper. From here on,
        // the ONLY way the handle is closed is OwnedJobHandle::drop (single
        // source — no double-close).
        Ok(OwnedJobHandle { raw: job as isize })
    }
}

/// Non-Windows twin — no Job Objects on non-Windows targets, so this is a no-op
/// that always succeeds with the null handle (mirrors `tray.rs`). Lets the
/// spawn path call the same function name on every platform.
#[cfg(not(target_os = "windows"))]
pub fn assign_to_kill_on_close_job(_pid: u32) -> Result<OwnedJobHandle, String> {
    Ok(OwnedJobHandle::default())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The LimitFlags value we set must be EXACTLY kill-on-close — not a wider
    /// or different set of limits. Asserting the constant guards against a
    /// copy-paste of the wrong flag (which would silently NOT arm the OS kill).
    #[cfg(target_os = "windows")]
    #[test]
    fn limit_flag_is_exactly_kill_on_job_close() {
        use windows_sys::Win32::System::JobObjects::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // KILL_ON_JOB_CLOSE is documented as 0x00002000. If the resolved
        // windows-sys version ever changed the constant, this would catch it.
        assert_eq!(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 0x0000_2000);
    }

    /// The no-op twin (and the Default) must return Ok with a null handle so a
    /// non-Windows build — or a degraded `Default` path — never panics and never
    /// owns a real handle.
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn non_windows_twin_returns_ok() {
        let handle = assign_to_kill_on_close_job(1234).expect("no-op twin must succeed");
        assert_eq!(handle.raw, OwnedJobHandle::NULL);
    }

    /// Default is the null handle — dropping it must be a safe no-op (no
    /// CloseHandle on a real handle). This exercises the "nothing to close"
    /// branch of Drop on Windows and the no-op Drop elsewhere.
    #[test]
    fn default_handle_is_null_and_drops_cleanly() {
        let handle = OwnedJobHandle::default();
        assert_eq!(handle.raw, 0);
        // Explicit drop — must not panic / must not CloseHandle(0).
        drop(handle);
    }

    /// Degraded-mode contract: the helper returns a `Result`, and `sidecar.rs`'s spawn path
    /// maps an `Err` to "LOG the failed call name, then continue with `job: None`" — never
    /// panic, never abort the connect (D-06). The load-bearing half is the LOG: the error
    /// string has to survive the mapping, and it has to be a bare Win32 call name so the
    /// degraded-mode line carries no PID and no secret (D-09).
    ///
    /// The earlier version of this test threw the error away (`Ok => Some, Err(_) => None`),
    /// which asserted only that `Err(_).ok()` is `None` — a property of `std`, not of this
    /// module, and it silently dropped exactly the value production depends on.
    #[test]
    fn err_maps_to_log_and_continue_not_panic() {
        // Simulate the helper failing (as it would when the parent is already in
        // a job under a debugger/CI).
        let simulated: Result<OwnedJobHandle, String> =
            Err("AssignProcessToJobObject failed".to_string());
        // Mirror the spawn path: the Err arm KEEPS the call name for the log line.
        let (job, logged): (Option<OwnedJobHandle>, Option<String>) = match simulated {
            Ok(h) => (Some(h), None),
            Err(call) => (None, Some(call)),
        };
        assert!(job.is_none(), "a failed assign must degrade to `job: None`, not abort");
        let logged = logged.expect("the degraded path must hand the call name to the log");
        assert!(
            !logged.chars().any(|c| c.is_ascii_digit()),
            "D-09: the degraded-mode log line must be a bare call name — no PID, no secret: {logged}"
        );
        // Dropping the degraded fallback must be a safe no-op (nothing to CloseHandle).
        drop(job);
    }
}
