//! Windows Task Scheduler 2.0, through the component-object interface.
//!
//! ## Why this module exists (owner forensics 2026-08-28, release blocker 5)
//!
//! Autostart used to be a `HKCU\...\CurrentVersion\Run` value. This application's manifest
//! requests `requireAdministrator` (embedded by `build.rs`), and Windows runs `Run` entries at
//! logon under the user's FILTERED token, raising no consent prompt during that pass — so an entry
//! demanding elevation is skipped silently, on every logon, forever. Four independent layers agreed
//! autostart worked (the `Run` value present, the startup-approval companion reading enabled,
//! `app_settings.json` carrying the choice, Task Manager showing «Включено») while no application
//! ever started at logon. A logon task registered «with highest privileges» is the only mechanism
//! compatible with that manifest.
//!
//! ## Why the interface and not the command-line tool
//!
//! A command-line scheduler tool cannot tell whether a task is ENABLED without parsing console
//! output, and reading console output on this platform is a standing project prohibition: Windows
//! hands console text back in the OEM code page and LOCALIZES it (plan 32-03 was bitten by exactly
//! this — the default-value row prints as «(по умолчанию)» here, two words, so any parse keyed on
//! column position grabs the wrong token and then fails safe into looking correct). The enabled bit
//! is the whole point of the mechanism change, so it must come from the interface.
//!
//! A third-party wrapper crate around this interface is NOT approved and must not be re-proposed:
//! it would pin a third major version of the same vendor crate, and its support for the three
//! properties this feature needs is unverified.

#![cfg(windows)]

use std::path::Path;

use windows::core::{Interface, BSTR, PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, LocalFree, ERROR_SUCCESS, HLOCAL, VARIANT_FALSE, VARIANT_TRUE,
};
use windows::Win32::Security::Authorization::{
    ConvertSidToStringSidW, GetNamedSecurityInfoW, SE_FILE_OBJECT,
};
use windows::Win32::Security::{
    GetAce, GetTokenInformation, LookupAccountSidW, TokenUser, ACCESS_ALLOWED_ACE, ACE_HEADER, ACL,
    DACL_SECURITY_INFORMATION, INHERIT_ONLY_ACE, PSID, TOKEN_USER,
};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
use windows::Win32::System::Services::{
    CloseServiceHandle, OpenSCManagerW, OpenServiceW, QueryServiceStatus, SC_MANAGER_CONNECT,
    SERVICE_QUERY_STATUS, SERVICE_RUNNING, SERVICE_START_PENDING, SERVICE_STATUS,
};
use windows::Win32::System::SystemServices::ACCESS_ALLOWED_ACE_TYPE;
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows::Win32::System::TaskScheduler::{
    IExecAction, ILogonTrigger, IRegisteredTask, ITaskFolder, ITaskService, TaskScheduler,
    TASK_ACTION_EXEC, TASK_CREATE_OR_UPDATE, TASK_LOGON_INTERACTIVE_TOKEN, TASK_RUNLEVEL_HIGHEST,
    TASK_TRIGGER_LOGON,
};
use windows::Win32::System::Variant::VARIANT;

use crate::logging::log_app;
use crate::processes::win_icon::ComApartment;

/// The scheduler folder every per-user autostart registration lives in.
///
/// **Why a folder and not one name.** The install is per-machine, so one task name would be one
/// registration shared by everybody on the machine: the last person to touch the switch would
/// own it and everyone else would read ON while nothing started at their logon — «the switch
/// claims a startup that will not happen», the defect this whole feature exists to end. So the
/// name is scoped by the user's SID, and a folder is what lets the uninstaller still remove ALL
/// of them with one statement (`schtasks /Delete /TN "…\*"`), which no prefix could do.
///
/// Exported so the uninstaller's agreement is COMPOSED from this constant rather than retyped —
/// a hand-typed literal at the other end would make the contract test agree with itself instead
/// of with the application.
pub(crate) const AUTOSTART_TASK_FOLDER: &str = "TrustTunnel Client Pro";

/// The single machine-wide task the builds before this remediation registered, in the
/// scheduler's ROOT folder.
///
/// Kept only so it can be REMOVED — by the uninstaller and, on every launch, by the application
/// itself. A machine that carries one has a highest-privileges logon task outside
/// [`AUTOSTART_TASK_FOLDER`], and leaving it there would mean an orphan pointing at a deleted
/// executable on exactly the machines that tested the feature before it was fixed. Nothing
/// registers this name any more; if anything ever does again, that is the bug.
pub(crate) const LEGACY_AUTOSTART_TASK_NAME: &str = "TrustTunnel Client Pro Autostart";

/// The task name for the user with this SID, inside [`AUTOSTART_TASK_FOLDER`].
///
/// A SID string is digits and hyphens only, so it can never contain one of the characters the
/// scheduler forbids in a name (`\ / : * ? " < > |`).
pub(crate) fn autostart_task_name_for(sid: &str) -> String {
    format!("Autostart {sid}")
}

/// The full scheduler path of a registration — folder included.
///
/// The ONE place that knows the layout. It is what the uninstaller's wildcard has to cover, and
/// what the registration writes to the log, so the string a support bundle shows is the string
/// somebody can paste into Task Scheduler and the string the contract test reasons about — all
/// composed here rather than assembled three times.
pub(crate) fn autostart_task_path(task_name: &str) -> String {
    format!("\\{AUTOSTART_TASK_FOLDER}\\{task_name}")
}

/// The task name for the user this process is running as.
///
/// `Err` when the identity cannot be read — the same refusal as [`register_logon_task`]'s, for
/// the same reason: a registration that cannot say WHOSE it is must not happen.
pub(crate) fn autostart_task_name() -> Result<String, String> {
    Ok(autostart_task_name_for(&current_user_id()?.sid))
}

/// The ISO-8601 duration the platform reads as «run indefinitely».
///
/// Set EXPLICITLY, because the platform default terminates a long-running task after some days —
/// and a VPN client left connected is exactly that. It is set and then read back off the
/// registered task, because «we asked for it» and «the task carries it» are different facts.
pub(crate) const RUN_INDEFINITELY: &str = "PT0S";

/// The scheduler's root folder, spelled the way the interface wants it.
const ROOT_FOLDER: &str = "\\";

/// Format a COM failure with its code IN HEX, so an HRESULT is greppable against Microsoft's
/// tables — the same discipline `processes.rs` follows for `CoInitializeEx`. The human-readable
/// half comes from the operating system and is therefore localized; it is written to the log and
/// shown to the user, and is never parsed by anything.
fn com_err(context: &str, e: windows::core::Error) -> String {
    format!("{context}: {} ({:#010x})", e.message(), e.code().0)
}

/// Open an apartment, connect to the scheduler service, take its root folder, and hand both to
/// the caller — then release all three in the right order on the way out, including on an early
/// `?` return inside the closure.
///
/// Every operation in this module goes through here, because the three acquisitions must always
/// happen together and a call site that forgets one fails in a way that looks like «the task is
/// not there».
///
/// **Why the apartment is per-call here** — the reason differs from the one written at
/// `processes.rs`, and copying that one across would have been false. This module runs on the
/// application's setup path and on the Settings command path, both of which are ordinary
/// application threads rather than tokio blocking workers. The apartment is per-call because
/// apartments are per-THREAD and this module cannot know which thread Tauri hands it: a single
/// initialisation at startup would be an apartment on some other thread, which is no apartment at
/// all here. The guard is reused from `processes.rs` rather than redefined, because the
/// distinction between a success code that owns an apartment reference and the changed-mode code
/// that does not is subtle and already solved correctly once.
fn with_scheduler<T>(
    what: &str,
    f: impl FnOnce(&ITaskService, &ITaskFolder) -> windows::core::Result<T>,
) -> Result<T, String> {
    // Held for the whole function; dropped LAST, after every COM object below has been released.
    let _apartment = ComApartment::init()?;

    // SAFETY: every call below is a plain COM invocation on an interface pointer this block owns.
    // The interfaces are RAII by construction in the `windows` crate, so they are released when
    // this block ends — which is before `_apartment` runs `CoUninitialize`. Cleanup is by drop
    // rather than a linear path precisely because the `?` operator makes an early return trivially
    // easy to leak from.
    unsafe {
        let service: ITaskService = CoCreateInstance(&TaskScheduler, None, CLSCTX_ALL)
            .map_err(|e| com_err("CoCreateInstance(TaskScheduler)", e))?;

        // Four empty VARIANTs = «this machine, the current user, no password».
        let empty = VARIANT::default();
        service
            .Connect(&empty, &empty, &empty, &empty)
            .map_err(|e| com_err("ITaskService::Connect", e))?;

        let root = service
            .GetFolder(&BSTR::from(ROOT_FOLDER))
            .map_err(|e| com_err("ITaskService::GetFolder", e))?;

        f(&service, &root).map_err(|e| com_err(what, e))
    }
}

/// Resolve [`AUTOSTART_TASK_FOLDER`], creating it when the caller is about to register.
///
/// A read (`task_exists`, `task_is_enabled`, a delete) passes `create = false`: the folder's
/// ABSENCE is a legitimate answer there — nobody on this machine has ever enabled autostart —
/// and creating a folder as a side effect of asking a question would be its own small lie.
///
/// # Safety
/// `root` must be a live `ITaskFolder` for the scheduler's root.
unsafe fn autostart_folder(
    root: &ITaskFolder,
    create: bool,
) -> windows::core::Result<ITaskFolder> {
    unsafe {
        let path = BSTR::from(format!("\\{AUTOSTART_TASK_FOLDER}"));
        match root.GetFolder(&path) {
            Ok(folder) => Ok(folder),
            Err(absent) if create => {
                // An empty SDDL variant means «inherit from the parent», which is what the root
                // folder's own protection already gives us.
                let empty = VARIANT::default();
                // A racing process may have created it between the two calls, so a failed
                // create falls back to reading rather than to reporting the create's error.
                match root.CreateFolder(&path, &empty) {
                    Ok(folder) => Ok(folder),
                    Err(_) => root.GetFolder(&path).map_err(|_| absent),
                }
            }
            Err(absent) => Err(absent),
        }
    }
}

/// Read the execution time limit off an already-registered task handle.
///
/// Shared by the registration read-back and by [`read_execution_time_limit`] so that «what the
/// task carries» is obtained exactly one way.
///
/// # Safety
/// `task` must be a live `IRegisteredTask`.
unsafe fn limit_of(task: &IRegisteredTask) -> windows::core::Result<String> {
    let mut limit = BSTR::new();
    task.Definition()?.Settings()?.ExecutionTimeLimit(&mut limit)?;
    Ok(limit.to_string())
}

/// The security principal a logon task belongs to.
///
/// Two spellings of one identity, because each is needed somewhere the other will not do:
/// `account` is what the trigger is bound to and what a human reads in Task Scheduler, `sid` is
/// what the task NAME is scoped by — a renamed account keeps its SID, and two accounts can
/// never share one.
#[derive(Debug)]
pub(crate) struct UserIdentity {
    /// The canonical `S-1-…` form, straight off the process token.
    pub(crate) sid: String,
    /// `DOMAIN\user` when the authority resolves it, otherwise the SID again — both are
    /// accepted by `ILogonTrigger::SetUserId`, so the fallback still BINDS the trigger.
    pub(crate) account: String,
}

/// Ask the local authority for the `DOMAIN\user` spelling of a SID.
///
/// Best-effort by design: a failure here is not a reason to refuse a registration, because the
/// SID string that already succeeded is itself a valid `SetUserId` argument. Only the SID being
/// unobtainable is fatal, and that is handled by the caller.
///
/// # Safety
/// `sid` must point at a valid security identifier that outlives this call.
unsafe fn account_name_of(sid: PSID) -> Option<String> {
    unsafe {
        let mut name_len = 0u32;
        let mut domain_len = 0u32;
        let mut kind = windows::Win32::Security::SID_NAME_USE::default();

        // The sizing call is EXPECTED to fail with ERROR_INSUFFICIENT_BUFFER; only the two
        // lengths it writes are of interest.
        let _ = LookupAccountSidW(
            PCWSTR::null(),
            sid,
            None,
            &mut name_len,
            None,
            &mut domain_len,
            &mut kind,
        );
        if name_len == 0 {
            return None;
        }

        let mut name = vec![0u16; name_len as usize];
        let mut domain = vec![0u16; domain_len.max(1) as usize];
        LookupAccountSidW(
            PCWSTR::null(),
            sid,
            Some(PWSTR(name.as_mut_ptr())),
            &mut name_len,
            Some(PWSTR(domain.as_mut_ptr())),
            &mut domain_len,
            &mut kind,
        )
        .ok()?;

        let user = String::from_utf16_lossy(&name[..name_len as usize]);
        let authority = String::from_utf16_lossy(&domain[..domain_len as usize]);
        if user.is_empty() {
            return None;
        }
        Some(if authority.is_empty() {
            user
        } else {
            format!("{authority}\\{user}")
        })
    }
}

/// The account whose logon fires the trigger — read from the PROCESS TOKEN.
///
/// **Not from `USERNAME`, and the difference is not academic.** That variable is inherited and
/// whatever launched this process chooses it; it is also simply absent in some launch contexts
/// (a stripped environment block, a minimal service environment). Worse in this application
/// specifically: the manifest requests `requireAdministrator`, so under over-the-shoulder UAC
/// the process runs as the ELEVATING ADMINISTRATOR and the environment names that account rather
/// than the person who pressed the switch. The task would then be bound to, and triggered by,
/// the administrator's logon — and the user's autostart would silently never fire, which is the
/// exact class of bug (four layers agreeing while nothing starts) this module was written to end.
///
/// `GetTokenInformation(TokenUser)` answers about the principal the task will ACTUALLY be bound
/// to, and it cannot be forged from outside the process.
///
/// **This returns a `Result`, never an `Option` that a caller may shrug off.** An identity that
/// cannot be determined must REFUSE the registration: an `ILogonTrigger` with no user bound to
/// it fires at every user's logon while the action runs as the registering account, with highest
/// privileges — the shared-machine hazard the paragraph above is about.
pub(crate) fn current_user_id() -> Result<UserIdentity, String> {
    // SAFETY: the token handle is opened here, used only inside this block, and closed on every
    // path including the error ones — the result is bound before the close so the `?` operators
    // inside `identity_of_token` cannot skip it.
    unsafe {
        let mut token = windows::Win32::Foundation::HANDLE::default();
        OpenProcessToken(
            GetCurrentProcess(),
            windows::Win32::Security::TOKEN_QUERY,
            &mut token,
        )
        .map_err(|e| com_err("OpenProcessToken", e))?;

        let identity = identity_of_token(token);
        let _ = CloseHandle(token);
        identity
    }
}

/// The `TokenUser` half of [`current_user_id`], split out so the token handle above has exactly
/// one open and one close with no early return between them.
///
/// # Safety
/// `token` must be a live token handle opened with `TOKEN_QUERY`.
unsafe fn identity_of_token(
    token: windows::Win32::Foundation::HANDLE,
) -> Result<UserIdentity, String> {
    unsafe {
        let mut needed = 0u32;
        // Sizing call: expected to fail with ERROR_INSUFFICIENT_BUFFER, only `needed` matters.
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut needed);
        if needed == 0 {
            return Err("GetTokenInformation(TokenUser) reported a zero-length answer".to_string());
        }

        let mut buffer = vec![0u8; needed as usize];
        GetTokenInformation(
            token,
            TokenUser,
            Some(buffer.as_mut_ptr() as *mut core::ffi::c_void),
            needed,
            &mut needed,
        )
        .map_err(|e| com_err("GetTokenInformation(TokenUser)", e))?;

        let user = &*(buffer.as_ptr() as *const TOKEN_USER);
        let sid = sid_to_string(user.User.Sid)
            .ok_or_else(|| "the process token's user SID could not be rendered".to_string())?;
        let account = account_name_of(user.User.Sid).unwrap_or_else(|| sid.clone());
        Ok(UserIdentity { sid, account })
    }
}

// ── The install-directory gate (CR-01, D-10 item 2) ─────────────────────────────────────────
//
// WHY THIS IS CHECKED AT REGISTRATION AND NOT ASSUMED FROM CONFIGURATION. A task at
// TASK_RUNLEVEL_HIGHEST runs the file it names with a FULL administrator token at every
// interactive logon and raises no consent prompt — removing that prompt is the entire point of
// the run level. So if a standard account can replace that file, the pair is a local-elevation
// path: write the file, wait for a logon, run as administrator. `30.1-*/deferred-items.md`
// § D-03 item 5 makes it a hard PRECONDITION on this feature: «a logon task registered with
// highest privileges and pointed at an executable a standard user can overwrite IS the local
// elevation path the relocation exists to close», and would be «strictly worse than the current
// bug», where the dead `Run` value elevated nobody.
//
// The per-machine relocation moved the DEFAULT install location to `Program Files`. It did not
// close the hole, and configuration cannot: the installer's directory page is present and NSIS
// honours `/D=` (`data_adoption.rs:11-12` records exactly that, and the whole adoption module
// exists to serve people who used it). Measured on a real Windows install by SID: a folder created
// directly under `C:\` inherits Modify for Authenticated Users, while `C:\Program Files` does
// not — so a per-machine install into `C:\TrustTunnel Client Pro` produces a user-writable
// executable run with an administrator token at every logon. The property therefore has to be
// read off the PATH THE TASK IS POINTED AT, on the machine, at the moment of registration.
//
// NO CONSOLE TOOL. `icacls` would answer this question and its output is unreadable here by
// standing project rule — Windows returns it in the OEM code page AND localizes it, so any
// parse keyed on a word or a column grabs the wrong token and then fails safe into looking
// correct. The DACL is read through the interface for the same reason the enabled bit is.

/// The principals whose write access to the install directory is NOT an elevation path.
///
/// A WHITELIST, never a blacklist — the same rule the SSH input validators live by. The failure
/// being guarded is a principal nobody thought of holding Modify; an exclusion list only ever
/// catches the exclusions somebody already wrote down.
///
/// * `S-1-5-32-544` — `BUILTIN\Administrators`. Already able to replace the file by other means.
/// * `S-1-5-18` — `NT AUTHORITY\SYSTEM`. Same.
/// * `S-1-5-80-956008885-…` — `NT SERVICE\TrustedInstaller`, which owns everything under
///   `%SystemRoot%` and `Program Files` on a stock install. The SID is a fixed constant.
/// * `S-1-3-0` — `CREATOR OWNER`. Never an effective principal on an object: it is a template
///   the kernel substitutes at creation time. Listed so a non-inheritable spelling of it on some
///   machine cannot read as an unknown account.
const TRUSTED_WRITER_SIDS: [&str; 4] = [
    "S-1-5-32-544",
    "S-1-5-18",
    "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
    "S-1-3-0",
];

/// The access-mask bits that let a principal put a DIFFERENT executable at this path.
///
/// Deliberately narrower than «any write»: `FILE_WRITE_EA` (0x0010) and `FILE_WRITE_ATTRIBUTES`
/// (0x0100) are excluded because neither can change what the file CONTAINS, and including them
/// would make the gate refuse installs it has no business refusing.
///
/// `FILE_DELETE_CHILD` is the one that is easy to miss and is included on purpose: on a
/// DIRECTORY it lets a principal delete the executable and drop their own in its place without
/// ever holding a write right on the file itself.
const WRITE_LIKE_ACCESS: u32 = 0x0000_0002   // FILE_WRITE_DATA   / FILE_ADD_FILE
    | 0x0000_0004                            // FILE_APPEND_DATA  / FILE_ADD_SUBDIRECTORY
    | 0x0000_0040                            // FILE_DELETE_CHILD (directories)
    | 0x0001_0000                            // DELETE
    | 0x0004_0000                            // WRITE_DAC
    | 0x0008_0000                            // WRITE_OWNER
    | 0x1000_0000                            // GENERIC_ALL
    | 0x4000_0000; // GENERIC_WRITE

/// Render a SID as its `S-1-…` string, or `None` if the platform refuses to.
///
/// # Safety
/// `sid` must point at a valid security identifier that outlives this call.
unsafe fn sid_to_string(sid: PSID) -> Option<String> {
    let mut raw = PWSTR::null();
    unsafe {
        ConvertSidToStringSidW(sid, &mut raw).ok()?;
        if raw.is_null() {
            return None;
        }
        let text = raw.to_string().ok();
        // The platform allocated it with LocalAlloc and says so; freeing is ours.
        LocalFree(Some(HLOCAL(raw.0 as *mut core::ffi::c_void)));
        text
    }
}

/// Spell a path the way the security APIs want it.
///
/// `canonicalize` resolves `..`, junctions and 8.3 short names — which matters, because a
/// lexical comparison against a short-name spelling is the mistake WR-09 records in the NSIS
/// hook. It returns the VERBATIM form (`\\?\C:\…`), and that prefix is stripped here: the
/// path is going to a Win32 entry point, not to the object manager.
fn path_for_security_query(path: &Path) -> Result<String, String> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|e| format!("«{}» could not be resolved: {e}", path.display()))?;
    let text = canonical.to_string_lossy().into_owned();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return Ok(format!(r"\\{rest}"));
    }
    Ok(text.strip_prefix(r"\\?\").unwrap_or(&text).to_string())
}

/// Every principal outside [`TRUSTED_WRITER_SIDS`] that this object's DACL lets replace it.
///
/// An empty vector means «nobody unprivileged can touch it». An `Err` means the question could
/// not be answered, and the caller must treat that as a refusal — a gate that opens when it
/// cannot see is the vacuous shape this whole remediation exists to remove.
fn non_admin_writers(path: &Path) -> Result<Vec<String>, String> {
    let target = path_for_security_query(path)?;
    let wide: Vec<u16> = target.encode_utf16().chain(std::iter::once(0)).collect();

    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut descriptor = windows::Win32::Security::PSECURITY_DESCRIPTOR::default();

    // SAFETY: `wide` is a NUL-terminated UTF-16 buffer that outlives the call. The descriptor
    // and the DACL inside it are allocated by the platform and owned by us from a successful
    // return onward; every path below reaches the single `LocalFree`, including the early
    // returns inside the closure, because the closure's value is bound before the free.
    unsafe {
        let rc = GetNamedSecurityInfoW(
            PCWSTR(wide.as_ptr()),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(&mut dacl),
            None,
            &mut descriptor,
        );
        if rc != ERROR_SUCCESS {
            return Err(format!(
                "the security descriptor of «{target}» could not be read (Win32 error {:#010x})",
                rc.0
            ));
        }

        let answer = (|| {
            if dacl.is_null() {
                // A NULL DACL is not «no permissions». It grants EVERYONE full access, and it
                // reads as an empty ACE list — the one input that would sail through the loop
                // below untouched. Named explicitly so it can never be silently permissive.
                return vec!["(the object has no DACL, which grants everyone full access)".into()];
            }
            let mut writers: Vec<String> = Vec::new();
            for index in 0..u32::from((*dacl).AceCount) {
                let mut ace: *mut core::ffi::c_void = std::ptr::null_mut();
                if GetAce(dacl, index, &mut ace).is_err() || ace.is_null() {
                    writers.push("(an ACE that could not be read)".into());
                    continue;
                }
                let header = &*(ace as *const ACE_HEADER);
                // Denials are ignored deliberately: ignoring them can only make the gate
                // stricter, and reasoning about deny-before-allow ordering here would be a
                // second, subtler place to get the security answer wrong.
                if u32::from(header.AceType) != ACCESS_ALLOWED_ACE_TYPE {
                    continue;
                }
                // INHERIT_ONLY ACEs do not apply to THIS object — they are a template for its
                // children. Skipping them is what keeps `Program Files` from failing the gate:
                // it carries an inherit-only CREATOR OWNER full-control entry.
                if u32::from(header.AceFlags) & INHERIT_ONLY_ACE.0 != 0 {
                    continue;
                }
                let allowed = ace as *const ACCESS_ALLOWED_ACE;
                if (*allowed).Mask & WRITE_LIKE_ACCESS == 0 {
                    continue;
                }
                // `addr_of!` rather than `&(*allowed).SidStart`: the SID runs PAST that u32, so
                // a reference to the field alone would misdescribe what is being pointed at.
                let sid = PSID(std::ptr::addr_of!((*allowed).SidStart) as *mut core::ffi::c_void);
                match sid_to_string(sid) {
                    Some(text) => {
                        if !TRUSTED_WRITER_SIDS
                            .iter()
                            .any(|trusted| trusted.eq_ignore_ascii_case(&text))
                        {
                            writers.push(text);
                        }
                    }
                    None => writers.push("(a principal whose SID could not be rendered)".into()),
                }
            }
            writers
        })();

        LocalFree(Some(HLOCAL(descriptor.0)));
        Ok(answer)
    }
}

/// Refuse a highest-privileges registration whose target an unprivileged account can replace.
///
/// BOTH refusals lead with a STABLE CODE — `AUTOSTART_REFUSED_REPLACEABLE:` /
/// `AUTOSTART_REFUSED_ACL_UNKNOWN:` — and the code is the whole reason they are shaped this way.
/// The owner installed the program into a root-level folder on 2026-09-09, could not turn autostart
/// back on, and was told «Не удалось сохранить настройку. Попробуйте ещё раз» — advice that can
/// never work, because a folder's permissions do not change between attempts. The sentences below
/// already carry both cause and remedy, but they are English prose written for app.log, and the
/// project rule (T-28-20) is that the backend's own words never reach the screen. A code carries
/// the MEANING across that boundary while the words stay here: the frontend maps it to a localized
/// sentence of its own (`AUTOSTART_FAILURE_I18N`), exactly as the VPN error codes are mapped in
/// `vpnEventHelpers.ts`. Renaming a code silently breaks that mapping, so each side asserts the
/// pair in a test.
///
/// BOTH the executable and its containing directory are inspected. The directory is not
/// redundant: a principal holding `FILE_DELETE_CHILD` there can delete our file and write their
/// own with a fresh, permissive DACL, never having held a right on the original at all.
///
/// The message is returned rather than logged here on purpose — both callers in `autostart.rs`
/// already write it to app.log verbatim, and a second line would only make a support bundle
/// harder to read.
fn refuse_if_the_target_is_replaceable(exe: &Path) -> Result<(), String> {
    let directory = exe
        .parent()
        .ok_or_else(|| format!("autostart refused: «{}» has no directory", exe.display()))?;

    for (what, path) in [("its directory", directory), ("the file itself", exe)] {
        let writers = non_admin_writers(path).map_err(|e| {
            format!(
                "AUTOSTART_REFUSED_ACL_UNKNOWN: whether «{}» can be replaced by an unprivileged account could \
                 not be determined, and a highest-privileges logon task may not be registered on \
                 an unanswered question (CR-01). {e}",
                path.display()
            )
        })?;
        if !writers.is_empty() {
            return Err(format!(
                "AUTOSTART_REFUSED_REPLACEABLE: «{}» is writable by an account that is not an administrator \
                 ({what}: {}). A logon task with highest privileges pointed at a file anyone can \
                 replace is a local-elevation path — the very one the per-machine relocation \
                 exists to close (D-10 item 2). Reinstall into «Program Files» to enable \
                 «Запуск вместе с Windows».",
                path.display(),
                writers.join(", ")
            ));
        }
    }
    Ok(())
}

/// Register (or update) the logon task, then read its execution time limit back off the
/// registered task and return what it actually says.
pub(crate) fn register_logon_task(task_name: &str, exe: &Path) -> Result<String, String> {
    // FIRST, and before the scheduler is touched at all. A refusal that happened after the
    // registration would be indistinguishable from the machine declining the write, and the
    // contract this feature was handed says a refused registration RECORDS NOTHING — the caller
    // returns early, `set_autostart_choice` is never reached, and the switch honestly reads OFF
    // on the next visit rather than claiming a startup that is also a security hole.
    refuse_if_the_target_is_replaceable(exe)?;

    // REFUSED, never degraded. The previous shape returned `Ok` with the trigger left unbound
    // when the identity could not be determined, and an unbound logon trigger fires at EVERY
    // user's logon while the action runs as the registering account with highest privileges.
    // Binding to the wrong person is a bug; binding to nobody is a hazard, so the `?` here is
    // the whole fix and the type is what keeps it (CR-03).
    let identity = current_user_id().map_err(|e| {
        format!(
            "autostart refused: the account to bind the logon trigger to could not be determined \
             ({e}). An unbound logon trigger fires at every user's logon and would run this \
             application with highest privileges for someone who never asked for it (CR-03)."
        )
    })?;

    let exe_str = exe.to_string_lossy().into_owned();
    let work_dir = exe.parent().map(|p| p.to_string_lossy().into_owned());

    let reported = with_scheduler("RegisterTaskDefinition", |service, root| unsafe {
        let def = service.NewTask(0)?;

        let info = def.RegistrationInfo()?;
        info.SetAuthor(&BSTR::from("TrustTunnel Client Pro"))?;
        info.SetDescription(&BSTR::from(
            "Запускает TrustTunnel Client Pro при входе пользователя в Windows.",
        ))?;

        // «Run with highest privileges». This is the whole point: the executable's manifest
        // requests requireAdministrator, and only a task registered at this run level can start
        // it at logon without a consent prompt nobody is there to answer.
        let principal = def.Principal()?;
        principal.SetId(&BSTR::from("Author"))?;
        principal.SetLogonType(TASK_LOGON_INTERACTIVE_TOKEN)?;
        principal.SetRunLevel(TASK_RUNLEVEL_HIGHEST)?;

        let settings = def.Settings()?;
        settings.SetEnabled(VARIANT_TRUE)?;
        // Set EXPLICITLY — the platform default stops a task after some days and a VPN client
        // left connected is exactly that.
        settings.SetExecutionTimeLimit(&BSTR::from(RUN_INDEFINITELY))?;
        // Both of these default to «yes, refuse / stop on battery», which on a laptop would mean
        // the switch reads ON and the application still does not start — the identical class of
        // silent lie this whole module exists to end.
        settings.SetDisallowStartIfOnBatteries(VARIANT_FALSE)?;
        settings.SetStopIfGoingOnBatteries(VARIANT_FALSE)?;

        let trigger = def.Triggers()?.Create(TASK_TRIGGER_LOGON)?;
        let logon: ILogonTrigger = trigger.cast()?;
        logon.SetId(&BSTR::from("LogonTrigger"))?;
        logon.SetUserId(&BSTR::from(identity.account.as_str()))?;

        let action = def.Actions()?.Create(TASK_ACTION_EXEC)?;
        let exec: IExecAction = action.cast()?;
        exec.SetPath(&BSTR::from(exe_str.as_str()))?;
        if let Some(dir) = work_dir.as_deref() {
            exec.SetWorkingDirectory(&BSTR::from(dir))?;
        }

        let empty = VARIANT::default();
        // Into the PER-USER folder, created on demand. The scheduler's root is deliberately not
        // used any more: one task there is one registration for the whole machine.
        let folder = autostart_folder(root, true)?;
        let registered = folder.RegisterTaskDefinition(
            &BSTR::from(task_name),
            &def,
            TASK_CREATE_OR_UPDATE.0,
            &empty,
            &empty,
            TASK_LOGON_INTERACTIVE_TOKEN,
            &empty,
        )?;

        // «We asked for it» and «the task carries it» are different facts. Read the second one.
        limit_of(&registered)
    })?;

    // The bound principal is NAMED here, and that is part of the CR-03 fix rather than
    // decoration: before it, nothing anywhere — not the log, not the switch, not Task Manager —
    // told a correctly bound task apart from one left firing at everybody's logon. Both
    // spellings are written because the account name is what a human recognises and the SID is
    // what survives a rename. Neither is a secret; no password ever reaches this channel (D-29).
    log_app(
        "info",
        &format!(
            "[task_scheduler] «{}» registered (highest privileges, logon trigger bound to {} / {}); ExecutionTimeLimit reads back as «{reported}»",
            autostart_task_path(task_name),
            identity.account,
            identity.sid
        ),
    );
    Ok(reported)
}

/// Read the execution time limit off a registered task. Absence of the task is an error here —
/// the caller asked about a specific task and there is nothing to report.
///
/// Kept `pub(crate)` and exercised by this module's tests: it is the independent read that proves
/// the limit is a property of the REGISTERED TASK rather than of the value registration happened
/// to return. Without it, a registration that reported the right string while writing the wrong
/// one would look correct.
#[allow(dead_code)]
pub(crate) fn read_execution_time_limit(task_name: &str) -> Result<String, String> {
    with_scheduler("ITaskFolder::GetTask", |_service, root| unsafe {
        let task = autostart_folder(root, false)?.GetTask(&BSTR::from(task_name))?;
        limit_of(&task)
    })
}

/// Does the task exist at all, regardless of whether it is enabled?
///
/// `GetTask` reports absence as an Err rather than as an empty option, so the mapping to a plain
/// bool is deliberate and happens here, once.
pub(crate) fn task_exists(task_name: &str) -> bool {
    with_scheduler("ITaskFolder::GetTask", |_service, root| unsafe {
        autostart_folder(root, false)?
            .GetTask(&BSTR::from(task_name))
            .map(|_| ())
    })
    .is_ok()
}

/// The two HRESULTs that mean «there is no such thing», as opposed to «I could not go and look».
///
/// `ITaskFolder::GetTask` answers `HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)` for a task that is
/// not registered, and `GetFolder` answers the `ERROR_PATH_NOT_FOUND` form for a folder nobody on
/// this machine has ever caused to be created. Both are legitimate ANSWERS. Everything else —
/// `E_ACCESSDENIED`, a scheduler service stopped by policy, a failed apartment — is a failure to
/// ASK, and folding the two together is what let a read report a confident «off» about a task it
/// never reached.
const HRESULT_FILE_NOT_FOUND: i32 = 0x8007_0002u32 as i32;
const HRESULT_PATH_NOT_FOUND: i32 = 0x8007_0003u32 as i32;

/// Is this COM error the scheduler saying «not there», rather than «I could not answer»?
///
/// Kept as its own function so the distinction is testable without a scheduler: the arm that
/// matters is the NEGATIVE one — an access-denied must not be mistaken for an absence, because
/// that is the mistake that reads as OFF.
fn is_absent(e: &windows::core::Error) -> bool {
    matches!(e.code().0, HRESULT_FILE_NOT_FOUND | HRESULT_PATH_NOT_FOUND)
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// G-32-15 — ask WINDOWS whether the scheduler is there, instead of guessing from an HRESULT
//
// Measured 2026-09-09: with the «Планировщик задач» service stopped through the registry,
// rebooted, opened Настройки and pressed «Запускать вместе с системой» six times in 33 seconds.
// Every press produced «Не удалось сохранить настройку. Попробуйте ещё раз» — advice that cannot
// possibly work, because pressing a switch again does not start a stopped service. He asked for
// the obvious thing, and for the guarantee that comes with it: «Возможно ли определить, что именно
// планировщик недоступен, чтобы не было такого, что какая-то левая ошибка отвечает нам, что
// планировщик не активен?»
//
// So the answer is taken from the SERVICE CONTROL MANAGER, which is the authority, and the two
// HRESULTs that machine and the RPC layer produce are demoted to a fallback used only when the SCM
// itself cannot be reached. Guessing from an HRESULT alone would have been the «левая ошибка»
// he named: `0x80070003` is ALSO what a genuinely missing task folder answers on a perfectly
// healthy machine, so a rule keyed on it would tell a whole class of users to go and start a
// service that was running all along.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/// The Task Scheduler's Windows service, by its SERVICE KEY name.
///
/// Windows shows this service as «Планировщик задач» in the Russian services list and as «Task
/// Scheduler» in the English one. Neither display name is usable here — a display name is
/// localized, and this lookup must work identically on every install — so the key name is what
/// `OpenServiceW` is given. It is the same three syllables on every Windows since NT.
const SCHEDULER_SERVICE_KEY: &str = "Schedule";

/// The stable code a scheduler-unavailable refusal leads with.
///
/// Third of its family, after `AUTOSTART_REFUSED_REPLACEABLE` and `AUTOSTART_REFUSED_ACL_UNKNOWN`,
/// and it exists for the same reason: the sentence below is English prose written for app.log, and
/// the project rule (T-28-20) is that the backend's own words never reach the screen. The CODE
/// carries the meaning across that boundary; `AUTOSTART_FAILURE_I18N` in `GeneralSection.tsx` maps
/// it to a Russian sentence naming the service. Renaming it here without renaming it there
/// silently returns the owner to «Попробуйте ещё раз», so both sides assert the pair in a test.
const AUTOSTART_REFUSED_SCHEDULER_UNAVAILABLE: &str = "AUTOSTART_REFUSED_SCHEDULER_UNAVAILABLE";

/// What the Service Control Manager says about the Task Scheduler service.
///
/// Three states rather than a bool, and `Unknown` is the one that earns the type: an SCM that
/// could not be opened is not evidence that the service is down, and reporting it as such would
/// manufacture the very mis-attribution the owner asked to be protected from.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SchedulerService {
    /// The SCM reports it RUNNING. A failure now is about something else.
    Running,
    /// The SCM reports it stopped, stopping, paused, or otherwise unable to serve.
    NotRunning,
    /// The SCM could not be asked, or the service is mid-start and has not settled.
    Unknown,
}

/// Ask the SCM for the Task Scheduler service's current state.
///
/// Read-only and unprivileged: `SC_MANAGER_CONNECT` + `SERVICE_QUERY_STATUS` is the least this can
/// ask for, and an ordinary account holds both — so this never becomes a check that only works
/// when elevated, which would be a check that silently stops working for the people who need it.
///
/// **`SERVICE_START_PENDING` is `Unknown`, not `NotRunning`.** A service coming up cannot answer a
/// COM call yet, but it is also not something the user should be told to go and start; by the time
/// they read the sentence it may well be serving. Every other non-running state — stopped, pausing,
/// stopping — is a definite `NotRunning`, because none of them can take a registration.
fn query_scheduler_service() -> SchedulerService {
    // SAFETY: every handle opened below is closed on every path out, including the early returns.
    // `QueryServiceStatus` writes into a stack `SERVICE_STATUS` this frame owns.
    unsafe {
        let Ok(manager) = OpenSCManagerW(PCWSTR::null(), PCWSTR::null(), SC_MANAGER_CONNECT) else {
            return SchedulerService::Unknown;
        };

        let name: Vec<u16> = SCHEDULER_SERVICE_KEY
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();

        let answer = match OpenServiceW(manager, PCWSTR(name.as_ptr()), SERVICE_QUERY_STATUS) {
            Ok(service) => {
                let mut status = SERVICE_STATUS::default();
                let answer = match QueryServiceStatus(service, &mut status) {
                    Ok(()) if status.dwCurrentState == SERVICE_RUNNING => SchedulerService::Running,
                    Ok(()) if status.dwCurrentState == SERVICE_START_PENDING => {
                        SchedulerService::Unknown
                    }
                    Ok(()) => SchedulerService::NotRunning,
                    Err(_) => SchedulerService::Unknown,
                };
                let _ = CloseServiceHandle(service);
                answer
            }
            Err(_) => SchedulerService::Unknown,
        };

        let _ = CloseServiceHandle(manager);
        answer
    }
}

/// Is an «absent» HRESULT an ANSWER, or a failure to ask dressed as one?
///
/// **This is the G-32-15 read-path repair, and it is a defect of the G-32-13 family.**
/// [`is_absent`] maps `0x80070003` to «there is no such folder» — a legitimate, confident answer
/// that makes [`task_is_enabled`] return `Ok(false)` and the Settings row draw a plain, operable
/// OFF. On a real Windows install that same HRESULT came from the SERVICE BEING STOPPED, so the row
/// stated a setting was off about a registration it had never reached. His logon task was in fact
/// registered and enabled the whole time — the state after he restarted the service proves it.
///
/// An absence is only an answer if something was there to give it. When the SCM says the service
/// is down, the error propagates instead, `get_autostart` returns `Err`, and the row goes dim and
/// says so — which is what UAT test 7 has always contracted for.
///
/// `Unknown` deliberately keeps the old behaviour: without a definite «the service is down» there
/// is no ground to overturn a plain answer, and turning every unverifiable absence into «unknown»
/// would put a dim, disabled row in front of every user who has simply never used autostart.
pub(crate) fn absence_is_an_answer(service: SchedulerService) -> bool {
    !matches!(service, SchedulerService::NotRunning)
}

/// The two HRESULTs that mean «the scheduler was not reachable», as the SECONDARY signal.
///
/// Consulted only when the SCM could not be asked at all. `0x80070003` is what a real Windows install
/// actually returned; `0x800706ba` (RPC_S_SERVER_UNAVAILABLE) is the other form the same condition
/// takes when the COM layer notices first. They are matched inside a string [`com_err`] formatted,
/// so a test pins the two together — a change to that formatting would otherwise disarm this
/// silently.
fn mentions_an_unreachable_scheduler(msg: &str) -> bool {
    const UNREACHABLE_HRESULTS: [&str; 2] = ["0x80070003", "0x800706ba"];
    let lower = msg.to_ascii_lowercase();
    UNREACHABLE_HRESULTS.iter().any(|code| lower.contains(code))
}

/// Give a scheduler failure its stable code when — and only when — the service is really down.
///
/// Pure, and split from [`query_scheduler_service`] on purpose: the service's state cannot be
/// faked in a unit test (stopping the machine's real scheduler to run a test suite is not
/// something a test suite may do), so the DECISION is separated from the QUERY and the decision is
/// what the tests assert. A rule that could only be exercised on a machine with the scheduler
/// stopped is a rule that is never exercised.
///
/// A message that already leads with a code passes through untouched. The ACL gate refuses BEFORE
/// the scheduler is touched, so its verdict cannot be about the service — and a machine that has
/// both a replaceable target and a stopped scheduler must still be told the thing it can act on.
fn classify_scheduler_failure(msg: String, service: SchedulerService) -> String {
    if msg.starts_with("AUTOSTART_REFUSED_") {
        return msg;
    }

    let unavailable = match service {
        SchedulerService::NotRunning => true,
        SchedulerService::Unknown => mentions_an_unreachable_scheduler(&msg),
        // The guarantee, in one arm: with the service CONFIRMED running, nothing is
        // blamed on it. A wrong explanation is worse than a generic one, because a person acts on
        // it — he would go and look at a service that was working all along.
        SchedulerService::Running => false,
    };

    if !unavailable {
        return msg;
    }

    // The original failure survives INSIDE the classified message. The code adds a meaning; it
    // does not replace the evidence a support bundle needs.
    format!(
        "{AUTOSTART_REFUSED_SCHEDULER_UNAVAILABLE}: the Windows Task Scheduler service \
         («{SCHEDULER_SERVICE_KEY}») is not running, so no logon task can be registered, read or \
         removed until it is started. {msg}"
    )
}

/// [`classify_scheduler_failure`] with the SCM asked for the caller.
///
/// **Called only AFTER a failure, never before one**, and that is a deliberate decision rather
/// than an accident of where it sits. Three reasons. On the success path the answer is already
/// known by construction — the scheduler answered, so it is running — and paying for it would put
/// a synchronous system call on the Settings tab's five-second refresh for a question nobody
/// asked. Asking first would also be a check-then-act: the state could change between the query
/// and the operation, and the query that matters is the one about the failure that actually
/// happened. And on a healthy machine it then costs exactly nothing, because it never runs.
pub(crate) fn explain_scheduler_failure(msg: String) -> String {
    classify_scheduler_failure(msg, query_scheduler_service())
}

/// Is the task's enabled bit set? A task that does not exist is not enabled.
///
/// **This is THE conjunction** and the reason the mechanism changed at all:
///   (1) the task EXISTS in the folder — `GetTask` errors if it does not;
///   (2) the task is ENABLED — one switched off in Task Manager must read OFF here, because the
///       switch must never claim a startup that will not happen.
/// A command-line scheduler tool can answer (1) but not (2) without parsing console output, which
/// is a standing prohibition on this platform.
///
/// **THREE ANSWERS, NOT TWO, AND THAT IS THE 2026-09-06 REPAIR.** The conjunction above was
/// already right and the read still lied, in the other direction: the body ended `.unwrap_or(false)`,
/// so a stopped Task Scheduler service, a refused apartment or a failed `CoCreateInstance` all
/// came back as «not enabled» — the switch reading OFF while the registered task still starts the
/// application at every logon. That is this mechanism's own defect class, pointed the other way,
/// and it is worse than the original in one respect: a user who reads OFF may switch it on again,
/// or conclude the setting is broken and stop trusting it.
///   `Ok(true)`   the task exists AND its enabled bit is set — the conjunction, unchanged;
///   `Ok(false)`  the task is absent, or present and disabled — a plain, confident answer;
///   `Err(_)`     the scheduler could not be asked at all.
///
/// **Absence stays a plain answer and does NOT become an error**, which is the property the
/// absent-task test has always guarded: a read that threw on «no task» would be interpreted as
/// «unknown» by every careless caller, and rendered ON. The conjunction is stated positively —
/// `Some(true)` — precisely so that «not there» and «there but off» collapse into the same `false`
/// on purpose, while the third answer cannot be collapsed into anything.
pub(crate) fn task_is_enabled(task_name: &str) -> Result<bool, String> {
    with_scheduler("IRegisteredTask::Enabled", |_service, root| unsafe {
        // `None` is «there is no such task», reached from either lookup: no folder means no task
        // in it. Only a NON-absence error propagates, and it propagates as an error.
        //
        // G-32-15: and an «absent» HRESULT only counts as an absence if the service was there to
        // give it — see [`absence_is_an_answer`]. The SCM is asked ONLY on this branch, which is
        // precisely the branch about to make a confident claim it may not be entitled to. It costs
        // nothing on the common path, where the folder is found and the answer never arises.
        let folder = match autostart_folder(root, false) {
            Ok(folder) => folder,
            Err(e) if is_absent(&e) && absence_is_an_answer(query_scheduler_service()) => {
                return Ok(None)
            }
            Err(e) => return Err(e),
        };
        match folder.GetTask(&BSTR::from(task_name)) {
            Ok(task) => Ok(Some(task.Enabled()?.as_bool())),
            Err(e) if is_absent(&e) && absence_is_an_answer(query_scheduler_service()) => Ok(None),
            Err(e) => Err(e),
        }
    })
    .map(|state| matches!(state, Some(true)))
    // The error keeps its stable code so the Settings row can name the cause in its own words
    // rather than only going dim with a generic sentence. Same mechanism as the write path; no
    // second one was invented for the read.
    .map_err(explain_scheduler_failure)
}

/// Delete the task. Removing a task that is already absent is a SUCCESS — absent IS the
/// requested state.
///
/// The shape is lifted from the autostart disable arm, which had already learned this for a
/// registry value an installer had wiped: only a task that is VERIFIABLY still present after a
/// failed delete is a failure.
pub(crate) fn delete_task(task_name: &str) -> Result<(), String> {
    match with_scheduler("ITaskFolder::DeleteTask", |_service, root| unsafe {
        autostart_folder(root, false)?.DeleteTask(&BSTR::from(task_name), 0)
    }) {
        Ok(()) => Ok(()),
        Err(e) => {
            if task_exists(task_name) {
                log_app("warn", &format!("[task_scheduler] delete failed: {e}"));
                Err(e)
            } else {
                Ok(())
            }
        }
    }
}

/// Remove the one machine-wide task the builds before this remediation registered.
///
/// It lives in the scheduler's ROOT, outside [`AUTOSTART_TASK_FOLDER`], so neither the per-user
/// delete nor the uninstaller's folder sweep can see it. A machine that carries one carries a
/// highest-privileges logon task that no switch in this application governs any more — so it is
/// removed on every launch, unconditionally, by the same rule
/// [`crate::autostart::clear_dead_autostart_registry`] follows: a cheap «does it exist?» gate is
/// exactly why legacy installs never receive fixes, and removing something already absent is a
/// success.
///
/// Returns whether something was actually removed, so the log can say which happened.
pub(crate) fn remove_legacy_root_task() -> Result<bool, String> {
    let present_before = root_task_exists(LEGACY_AUTOSTART_TASK_NAME);
    match with_scheduler("ITaskFolder::DeleteTask", |_service, root| unsafe {
        root.DeleteTask(&BSTR::from(LEGACY_AUTOSTART_TASK_NAME), 0)
    }) {
        Ok(()) => Ok(present_before),
        Err(e) => {
            if root_task_exists(LEGACY_AUTOSTART_TASK_NAME) {
                Err(e)
            } else {
                Ok(false)
            }
        }
    }
}

/// Does a task by this name exist in the scheduler's ROOT folder?
///
/// Separate from [`task_exists`] on purpose: that one asks about the per-user folder, and the
/// only thing left in the root is the legacy registration being swept away above.
fn root_task_exists(task_name: &str) -> bool {
    with_scheduler("ITaskFolder::GetTask", |_service, root| unsafe {
        root.GetTask(&BSTR::from(task_name)).map(|_| ())
    })
    .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deletes its task on drop, so a panicking assertion cannot leave a real scheduled task
    /// behind on the machine that ran the suite.
    struct ScopedTask(&'static str);

    impl Drop for ScopedTask {
        fn drop(&mut self) {
            let _ = delete_task(self.0);
        }
    }

    // Every task these tests touch carries a «(self-test …)» suffix, so a task left behind by a
    // hard-killed run is attributable at a glance and can never collide with the production name
    // a real user's autostart depends on. One name per test, because the suite runs in parallel.
    const T_ROUNDTRIP: &str = "TrustTunnel Client Pro Autostart (self-test roundtrip)";
    const T_LIMIT: &str = "TrustTunnel Client Pro Autostart (self-test time limit)";
    const T_LIMIT_ABSENT: &str = "TrustTunnel Client Pro Autostart (self-test time limit absent)";
    const T_ABSENT: &str = "TrustTunnel Client Pro Autostart (self-test absent)";
    const T_ABSENT_CONTROL: &str = "TrustTunnel Client Pro Autostart (self-test absent control)";
    const T_DELETE: &str = "TrustTunnel Client Pro Autostart (self-test delete)";
    const T_REFUSED: &str = "TrustTunnel Client Pro Autostart (self-test refused target)";
    const T_PROTECTED: &str = "TrustTunnel Client Pro Autostart (self-test protected target)";
    const T_CENSUS: &str = "TrustTunnel Client Pro Autostart (self-test census)";

    /// `E_ACCESSDENIED`, as it appears inside the strings [`com_err`] formats.
    const E_ACCESSDENIED_HEX: &str = "0x80070005";

    /// The tests whose DISCRIMINATING assertions live behind a successful registration.
    ///
    /// Held as data so the census below can name them, and so a fifth cannot join them silently:
    /// adding one without adding it here leaves the census under-reporting, which is the bug this
    /// whole block exists to end.
    const WRITE_HALF_ARMS: [&str; 4] = [
        "a_registered_task_reads_back_as_existing_and_enabled",
        "a_task_that_was_never_registered_reads_as_absent_and_not_enabled",
        "deleting_a_task_that_is_already_absent_is_a_success",
        "the_registered_task_is_allowed_to_run_indefinitely",
    ];

    /// How many arms have reported themselves unmeasured on this run.
    static UNMEASURED: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

    /// Say something a reader of an ORDINARY `cargo test` run can actually see.
    ///
    /// **`eprintln!` cannot do this, and that was the defect (WR-05).** libtest installs an output
    /// capture on the `print!`/`eprint!` macro path and DISCARDS it for a test that passes, so the
    /// skip notice was invisible in precisely the situation it exists for. Measured on this
    /// machine before the fix: `cargo test --lib task_scheduler` printed the notice 0 times, the
    /// same command with `--nocapture` printed it 4 times. Writing to the stderr HANDLE goes round
    /// the capture, because the capture is on the macro and not on the file descriptor.
    fn say_out_loud(line: &str) {
        use std::io::Write;
        let mut err = std::io::stderr().lock();
        let _ = writeln!(err, "{line}");
        let _ = err.flush();
    }

    /// Register a task, or report — VISIBLY and COUNTED — that this machine refuses the write.
    ///
    /// Whether the scheduler's root folder accepts a registration without elevation is a property
    /// of the MACHINE, not of this code, so it is measured at run time rather than assumed. The
    /// skip is deliberately narrow: only an access-denied result skips, and only the tests that
    /// must write are affected. It is not `#[ignore]` precisely because `#[ignore]` would also
    /// disable these tests on the elevated runner, where they are the mechanism's only real
    /// coverage.
    ///
    /// The notice NAMES THE TEST and carries a running count, so a reader sees how many arms of
    /// the write half went unmeasured rather than merely that something was skipped. The phase's
    /// cited green run reported «4 passed» over four tests whose discriminating assertions had all
    /// been skipped in silence; a bare `return` is what made that possible.
    fn register_or_skip(test: &str, name: &str, exe: &std::path::Path) -> Option<String> {
        match register_logon_task(name, exe) {
            Ok(limit) => Some(limit),
            Err(e) if e.contains(E_ACCESSDENIED_HEX) => {
                let n = UNMEASURED.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                say_out_loud(&format!(
                    "NOT MEASURED ({n}/{total}) task_scheduler::{test} — registering a task was \
                     refused with {E_ACCESSDENIED_HEX}, so this process is not elevated and the \
                     WRITE half of the contract was not exercised. The test still reports PASS; \
                     what it proved is only the read half. Run the suite elevated to measure the \
                     rest. Full error: {e}",
                    total = WRITE_HALF_ARMS.len()
                ));
                None
            }
            Err(e) => panic!(
                "registration must either succeed or be refused with {E_ACCESSDENIED_HEX}, got: {e}"
            ),
        }
    }

    /// The target every registering test points at.
    ///
    /// **It is deliberately NOT the test binary any more.** `cargo test` builds into
    /// `target/debug/deps`, a directory the building account holds Modify on — so the CR-01
    /// gate refuses it, correctly and by design. Using it here would have made the suite fail
    /// for the very reason the gate exists, which is the fix working, not a defect. These tests
    /// are about the task's LIFECYCLE (registered → exists → enabled → deleted); what the task
    /// would run is irrelevant to them, so they name a file in a protected root and let
    /// [`a_target_a_standard_account_can_replace_is_refused_before_the_scheduler_is_touched`]
    /// own the writable case.
    fn protected_target() -> std::path::PathBuf {
        let root = std::env::var("SystemRoot").expect("SystemRoot is set on every Windows install");
        let exe = std::path::PathBuf::from(root).join("explorer.exe");
        assert!(
            exe.is_file(),
            "the registration target must exist: {}",
            exe.display()
        );
        exe
    }

    /// THE CENSUS. Whatever else this suite reports, it states out loud whether the WRITE half of
    /// the contract was exercised on this machine, and names the arms that depend on it.
    ///
    /// **Why this is not a failing test (WR-05 offered that option).** `cargo test --lib` is this
    /// project's routine backend gate; a test that reddens on every unelevated run is a test that
    /// gets `#[ignore]`d within a week, and then the write half is unmeasured AND unreported. The
    /// honest middle is the one `nsis:check` rules 3 and 4 already model: pass, and say plainly
    /// that the pass asserts nothing about the subject it could not reach.
    ///
    /// It probes by ATTEMPTING A REGISTRATION rather than by reading the process token, because
    /// the question is «can this process register a task?» and elevation is only the usual reason
    /// the answer is no — a policy can refuse an elevated process too. `ScopedTask` removes
    /// whatever it created, and on an unelevated host it creates nothing.
    #[test]
    fn the_write_half_of_the_task_contract_reports_whether_it_was_measured() {
        let _cleanup = ScopedTask(T_CENSUS);
        let measured = match register_logon_task(T_CENSUS, &protected_target()) {
            Ok(_) => true,
            Err(e) if e.contains(E_ACCESSDENIED_HEX) => false,
            Err(e) => panic!(
                "the probe must either succeed or be refused with {E_ACCESSDENIED_HEX}, got: {e}"
            ),
        };
        say_out_loud(&format!(
            "== task_scheduler: the WRITE half of the contract is {verdict} on this machine. \
             {n} arm(s) of this suite have their discriminating assertions behind a successful \
             registration: {arms}. {tail}",
            verdict = if measured { "MEASURED" } else { "NOT MEASURED" },
            n = WRITE_HALF_ARMS.len(),
            arms = WRITE_HALF_ARMS.join(", "),
            tail = if measured {
                "They were exercised."
            } else {
                "They reported PASS having exercised only the read half. Run the suite elevated."
            }
        ));
    }

    /// The distinction the whole three-answer read rests on, tested without a scheduler.
    ///
    /// It runs on any machine, elevated or not, which matters here more than usual: the arms that
    /// need a registration are skipped on an unelevated runner, and this one cannot be — it is the
    /// arm that says an ACCESS-DENIED is not an absence. Getting that wrong is precisely how a
    /// read the operating system refused came back as a confident «off».
    #[test]
    fn a_refusal_is_never_mistaken_for_an_absent_task() {
        use windows::core::{Error, HRESULT};
        let of = |code: u32| Error::from_hresult(HRESULT(code as i32));

        // The two real absences: no such task, and no such folder.
        assert!(
            is_absent(&of(0x8007_0002)),
            "ERROR_FILE_NOT_FOUND is the scheduler saying the task is not registered"
        );
        assert!(
            is_absent(&of(0x8007_0003)),
            "ERROR_PATH_NOT_FOUND is the scheduler saying nobody on this machine has ever created \
             the folder — no folder means no task in it"
        );

        // Everything the read must NOT swallow. Each of these once came back as «not enabled».
        for (code, what) in [
            (0x8007_0005u32, "E_ACCESSDENIED — the OS refused the read"),
            (0x8007_0424, "ERROR_SERVICE_DOES_NOT_EXIST — the scheduler service is not there"),
            (0x8007_042C, "ERROR_SERVICE_DEPENDENCY_FAIL — it could not start"),
            (0x8000_4005, "E_FAIL — an unclassified COM failure"),
            (0x8000_401A, "CO_E_RUNAS_LOGON_FAILURE — the activation failed"),
        ] {
            assert!(
                !is_absent(&of(code)),
                "{what} is a failure to ASK, not an answer. Reported as an absence it becomes a \
                 switch reading OFF while the registered task still starts the app at logon"
            );
        }
    }

    /// The mechanism's core promise: what we registered is there, and it is switched on.
    ///
    /// The absence assertion BEFORE registering is load-bearing, not tidiness: it is what makes
    /// the registration's effect observable. A reader hardwired to `true` fails on the first
    /// assertion; one hardwired to `false` fails on the last two.
    #[test]
    fn a_registered_task_reads_back_as_existing_and_enabled() {
        let name = T_ROUNDTRIP;
        let _cleanup = ScopedTask(name);

        assert!(
            !task_exists(name),
            "precondition: this test's own task must not already exist"
        );

        if register_or_skip(WRITE_HALF_ARMS[0], name, &protected_target()).is_none() {
            return;
        }

        assert!(task_exists(name), "the task we just registered must exist");
        assert_eq!(
            task_is_enabled(name),
            Ok(true),
            "a freshly registered task must read as enabled"
        );
    }

    /// Absence must be a plain answer, not an error the caller has to interpret — a read that
    /// threw on «no task» would be read as «unknown» and rendered as ON by any careless caller.
    /// That is why the read has three outcomes rather than two: `Err` is reserved for «the
    /// scheduler could not be asked», and this test is what keeps absence out of it.
    ///
    /// The registered CONTROL in the second half is what stops this test from being vacuous. In
    /// its original form it asserted only that two functions returned `false`, which the
    /// unimplemented stubs also did — so it passed before a single line of the mechanism existed
    /// and could never have failed. It guards the exact property this phase exists to fix, and a
    /// test that cannot fail is not a specification. The pair is now discriminating in both
    /// directions: a read hardwired to `false` fails on the control, one hardwired to `true`
    /// fails on the absent name.
    #[test]
    fn a_task_that_was_never_registered_reads_as_absent_and_not_enabled() {
        assert!(!task_exists(T_ABSENT), "an unregistered task must not exist");
        assert_eq!(
            task_is_enabled(T_ABSENT),
            Ok(false),
            "an unregistered task must read as a plain, confident «not enabled» — `Ok(false)`, \
             never `Err`. Absence is an ANSWER; only «the scheduler could not be asked» is an \
             error, and a read that threw on «no task» would be interpreted as unknown and \
             rendered ON by any careless caller"
        );

        let control = T_ABSENT_CONTROL;
        let _cleanup = ScopedTask(control);
        if register_or_skip(WRITE_HALF_ARMS[1], control, &protected_target()).is_none() {
            return;
        }

        assert!(
            task_exists(control),
            "the control task must exist — otherwise the assertions above prove only that the \
             reader always answers «no»"
        );
        assert_eq!(
            task_is_enabled(control),
            Ok(true),
            "the control task must read as enabled — same reason"
        );
    }

    /// «Absent IS the requested state» — the same rule the autostart disable arm already lived by
    /// for a registry value that had already been wiped.
    ///
    /// Deleting a task that never existed is asserted FIRST (it needs no write permission), and
    /// then the claim is proved in the context that actually matters: a delete that demonstrably
    /// removed something, repeated, still succeeds. Without the middle steps a `delete_task` that
    /// simply returned `Ok(())` and did nothing would satisfy this test.
    #[test]
    fn deleting_a_task_that_is_already_absent_is_a_success() {
        let name = T_DELETE;
        let _cleanup = ScopedTask(name);

        delete_task(name).expect("deleting a task that never existed must succeed");

        if register_or_skip(WRITE_HALF_ARMS[2], name, &protected_target()).is_none() {
            return;
        }

        assert!(
            task_exists(name),
            "the control task must be present before the first delete"
        );
        delete_task(name).expect("deleting a present task must succeed");
        assert!(
            !task_exists(name),
            "the first delete must actually have removed the task"
        );
        delete_task(name).expect("deleting the same, now-absent task must succeed too");
        assert!(!task_exists(name), "and it must still be gone afterwards");
    }

    /// The platform default terminates long-running tasks. A VPN session left connected for days
    /// is exactly that, so the limit is set explicitly AND read back off the registered task.
    ///
    /// The last assertion is the discriminating one: a reader that returned the constant
    /// `RUN_INDEFINITELY` without consulting the scheduler would satisfy everything above it.
    #[test]
    fn the_registered_task_is_allowed_to_run_indefinitely() {
        let name = T_LIMIT;
        let _cleanup = ScopedTask(name);

        let Some(reported) = register_or_skip(WRITE_HALF_ARMS[3], name, &protected_target()) else {
            return;
        };

        assert_eq!(
            reported, RUN_INDEFINITELY,
            "registration must report the limit it read back off the task"
        );
        assert_eq!(
            read_execution_time_limit(name).expect("the registered task must be readable"),
            RUN_INDEFINITELY,
            "the registered task must carry the run-indefinitely limit"
        );
        assert!(
            read_execution_time_limit(T_LIMIT_ABSENT).is_err(),
            "reading a task that was never registered must fail rather than report a limit — \
             otherwise the assertions above prove nothing about WHERE the limit came from"
        );
    }

    // ── The install-directory gate (CR-01, D-10 item 2) ──────────────────────────────────────
    //
    // These two arms are a PAIR and neither is evidence without the other. The first says the
    // gate refuses a replaceable target; the second says it is not simply refusing everything.
    // Both are fully measurable on an UNELEVATED runner, which is deliberate: the phase's cited
    // 1159 green tests measured none of the registration mechanism because every write arm in
    // this module returns early without elevation, and a gate proved only by a test that skips
    // is a gate proved by nothing.

    /// **A highest-privileges logon task may not be pointed at a file an unprivileged account can
    /// replace.**
    ///
    /// `TASK_RUNLEVEL_HIGHEST` + `TASK_LOGON_INTERACTIVE_TOKEN` means the named file is executed
    /// with a FULL administrator token at the next interactive logon, with no consent prompt —
    /// the prompt is precisely what the run level removes. If a standard account can overwrite
    /// that file, the pair is a local-elevation path: write, wait for a logon, run as
    /// administrator. `30.1-*/deferred-items.md` § D-03 item 5 states it as a hard precondition
    /// on this feature shipping at all, and `32-CONTEXT.md` D-10 item 2 repeats it verbatim.
    ///
    /// The relocation moved the DEFAULT install location to `Program Files`; it did not close
    /// the hole, because the installer's directory page is present and NSIS honours `/D=`
    /// (`data_adoption.rs:11-12` records exactly that, and the whole adoption module exists to
    /// serve the population that used it). So the property has to be checked against the path
    /// the task is actually pointed at, at registration time, on the machine — not inferred from
    /// a configured default.
    ///
    /// **The second assertion is the load-bearing one.** Without it this test passes on every
    /// unelevated runner for a reason that has nothing to do with the hole: the scheduler
    /// refuses the write with `E_ACCESSDENIED` and any «it returned an error» check goes green.
    #[test]
    fn a_target_a_standard_account_can_replace_is_refused_before_the_scheduler_is_touched() {
        // Under the user's own profile, so the account running this test holds Modify on it.
        // Named per-process AND per-thread because the suite runs in parallel.
        let dir = std::env::temp_dir().join(format!(
            "trusttunnel-autostart-acl-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).expect("a directory under %TEMP% must be creatable");
        let exe = dir.join("trusttunnel.exe");
        std::fs::write(&exe, b"not an executable - only a target path").expect("the file writes");

        let _cleanup = ScopedTask(T_REFUSED);
        let outcome = register_logon_task(T_REFUSED, &exe);
        let _ = std::fs::remove_dir_all(&dir);

        let err = outcome.expect_err(
            "registering a highest-privileges logon task pointed at a user-writable executable \
             must be REFUSED — anyone who can write that file gets it run with a full \
             administrator token at the next logon, with no prompt (CR-01, D-10 item 2)",
        );
        assert!(
            err.starts_with("AUTOSTART_REFUSED_REPLACEABLE:"),
            "the refusal must be ours, and it must LEAD with the stable code the Settings screen              maps to a sentence a person can act on (AUTOSTART_FAILURE_I18N in              GeneralSection.tsx). Before 2026-09-09 this text began «autostart refused», the              frontend could not tell one refusal from another, and the owner — who had installed              into a root-level folder — was told «Не удалось сохранить настройку. Попробуйте ещё              раз», advice that cannot work. Renaming this code without renaming it there silently              restores that. Got: {err}"
        );
        assert!(
            err.contains("Program Files"),
            "the log line must still carry the remedy in full, for the support bundle: {err}"
        );
        assert!(
            !err.contains(E_ACCESSDENIED_HEX),
            "the refusal must come from OUR gate, before the scheduler is touched. An \
             {E_ACCESSDENIED_HEX} here means the registration was attempted and the machine \
             declined the write, which would make this test pass on every unelevated runner \
             while the gate did not exist at all. Got: {err}"
        );
    }

    /// The control: the gate is not simply refusing everything.
    ///
    /// `%SystemRoot%\explorer.exe` is on every Windows install and its directory grants no
    /// non-administrative principal any right to replace what is in it. Both arms below assert
    /// — an elevated runner proves the registration completes, an unelevated one proves the
    /// attempt REACHED the scheduler — so this is measured on every machine rather than skipped
    /// on most of them.
    #[test]
    fn a_target_in_a_protected_system_directory_gets_past_the_gate() {
        let root = std::env::var("SystemRoot").expect("SystemRoot is set on every Windows install");
        let exe = std::path::PathBuf::from(root).join("explorer.exe");
        assert!(
            exe.is_file(),
            "the control target must exist: {}",
            exe.display()
        );

        let _cleanup = ScopedTask(T_PROTECTED);
        match register_logon_task(T_PROTECTED, &exe) {
            Ok(_) => {}
            Err(e) => assert!(
                e.contains(E_ACCESSDENIED_HEX),
                "a target in a protected root must get past the gate and reach the scheduler; \
                 the only failure allowed here is the machine declining the write to an \
                 unelevated process. Got: {e}"
            ),
        }
    }

    // ── Who the logon trigger binds to (CR-03) ───────────────────────────────────────────────
    //
    // An ILogonTrigger with no user bound to it fires at EVERY user's logon while the action
    // still runs as the account that registered the task. The function's own doc has said so
    // since 32-05 — and the code then implemented exactly that as its fallback, returning Ok
    // with no warning anywhere. These three arms are what stop the fallback from existing.

    /// **The identity comes from the process token, not from the environment.**
    ///
    /// A `DOMAIN\user` string can be assembled from anything. A security identifier cannot: it
    /// comes from the token or from the local security authority, and nothing a parent process
    /// puts in an environment block produces one. So «the answer carries an `S-1-…`» is a
    /// property only the token route can satisfy.
    ///
    /// Rendered through `{:?}` deliberately, so the arm is about WHAT IS ANSWERED and survives
    /// the return type changing shape underneath it.
    #[test]
    fn the_identity_the_trigger_binds_to_comes_from_the_process_token() {
        let rendered = format!("{:?}", current_user_id());
        assert!(
            rendered.contains("S-1-"),
            "the account the logon trigger is bound to must be resolved from the process token, \
             which is the only source that can produce a security identifier. Got: {rendered}"
        );
    }

    /// **A forged `USERNAME` must not change who the task is bound to.**
    ///
    /// `USERNAME` is inherited, and whatever launched this process chooses it. Worse in this
    /// application specifically: the manifest requests `requireAdministrator`, so under
    /// over-the-shoulder UAC the process runs as the ELEVATING ADMINISTRATOR and the environment
    /// names that account — not the person who pressed the switch. Their autostart would then be
    /// bound to somebody else's logon and would silently never fire, which is the exact class of
    /// bug (four layers agreeing while nothing starts) this module was written to end.
    ///
    /// The variable is restored before the assertion runs, so a failing assertion cannot leave
    /// the process environment altered for whatever runs next.
    #[test]
    fn a_forged_username_does_not_change_who_the_trigger_binds_to() {
        const FORGED: &str = "tt-forged-account-31337";
        let saved = std::env::var("USERNAME").ok();
        std::env::set_var("USERNAME", FORGED);
        let rendered = format!("{:?}", current_user_id());
        match saved {
            Some(original) => std::env::set_var("USERNAME", original),
            None => std::env::remove_var("USERNAME"),
        }

        assert!(
            !rendered.contains(FORGED),
            "the environment named «{FORGED}» and the answer followed it. Under UAC that string \
             is the elevating administrator, not the person at the keyboard. Got: {rendered}"
        );
    }

    /// **Binding the trigger to a user is not optional, structurally.**
    ///
    /// The defect was not a wrong value; it was a `SetUserId` sitting inside `if let Some(..)`,
    /// so a lookup that answered `None` skipped the binding entirely and the registration still
    /// returned `Ok`. Nothing downstream could tell a bound task from an unbound one — not the
    /// log, not the switch, not Task Manager. A type can express «this cannot be skipped» and
    /// this arm asserts the source keeps expressing it.
    ///
    /// The needle is assembled with `concat!` so this test's own text does not contain the
    /// string it searches for — otherwise the arm would find itself and pass on its own body.
    #[test]
    fn binding_the_trigger_to_a_user_is_not_conditional() {
        const SELF_SOURCE: &str = include_str!("task_scheduler.rs");
        const NEEDLE: &str = concat!("logon.Set", "UserId(");

        let lines: Vec<&str> = SELF_SOURCE.lines().collect();
        let sites: Vec<usize> = lines
            .iter()
            .enumerate()
            .filter(|(_, line)| line.contains(NEEDLE))
            .map(|(index, _)| index)
            .collect();

        assert_eq!(
            sites.len(),
            1,
            "there must be exactly one place that binds the trigger to a user, found {}",
            sites.len()
        );

        let site = sites[0];
        let previous = lines[..site]
            .iter()
            .rev()
            .map(|line| line.trim())
            .find(|line| !line.is_empty() && !line.starts_with("//"))
            .expect("the binding is not the first statement in the file");

        assert!(
            !previous.contains("if ") && !previous.contains("match "),
            "the trigger binding is guarded by «{previous}». A skipped binding leaves an UNBOUND \
             logon trigger, which fires at EVERY user's logon and runs this application with \
             highest privileges — the shared-machine hazard this module's own comment forbids. \
             The identity must be refused, never degraded (CR-03)."
        );
    }

    // ── One registration per user, not one per machine (the finding CR-01's sibling) ─────────
    //
    // The install is now per-MACHINE and the task name was one global constant, so two people on
    // one machine shared a single registration: whoever touched the switch last owned it, and
    // everybody else read ON while nothing started at their logon. That is exactly «the switch
    // claims a startup that will not happen» — the defect this entire phase existed to fix,
    // recreated by the relocation that was supposed to be its precondition.

    /// **Two users must never be able to overwrite each other's choice.**
    ///
    /// The SID is what scopes it, not the account name: an account can be renamed and its SID
    /// does not change, and two accounts can never share one.
    #[test]
    fn two_users_never_share_one_registration() {
        let first =
            autostart_task_path(&autostart_task_name_for("S-1-5-21-1111111111-1111111111-1001"));
        let second =
            autostart_task_path(&autostart_task_name_for("S-1-5-21-1111111111-1111111111-1002"));

        assert_ne!(
            first, second,
            "two users on one per-machine install must get two registrations; one shared name \
             means the last person to touch the switch owns it and everyone else reads ON while \
             nothing starts at their logon"
        );
        assert!(
            first.ends_with("1001") && second.ends_with("1002"),
            "the registration must be scoped by the user's own SID, got «{first}» and «{second}»"
        );
    }

    /// **Every per-user registration must sit where the uninstaller's sweep can reach it.**
    ///
    /// The teardown deletes a folder's worth of tasks with one wildcard, and a wildcard reaches
    /// exactly one level. A name that escaped the folder — or that nested a level deeper —
    /// would survive an uninstall as a highest-privileges logon task pointing at a deleted
    /// executable, which is the orphan `installer-hooks.nsh` § 4 exists to prevent.
    #[test]
    fn every_registration_lives_where_the_uninstaller_sweeps() {
        let path =
            autostart_task_path(&autostart_task_name_for("S-1-5-21-1111111111-1111111111-1001"));
        let prefix = format!("\\{AUTOSTART_TASK_FOLDER}\\");

        assert!(
            path.starts_with(&prefix),
            "«{path}» is not inside «{prefix}», so the uninstaller's folder sweep cannot see it"
        );
        assert_eq!(
            path[prefix.len()..].matches('\\').count(),
            0,
            "«{path}» nests below «{prefix}»; a schtasks wildcard reaches one level only, so the \
             registration would survive the uninstall"
        );
    }

    /// The registration this machine's current user gets is named after that user.
    ///
    /// Ties the pure naming arms above to the live identity, so a naming scheme that is
    /// per-user in principle but wired to something else in practice cannot pass.
    #[test]
    fn this_users_registration_is_named_after_this_user() {
        let identity = current_user_id().expect("the process token names its user");
        let name = autostart_task_name().expect("so the task name can be derived from it");

        assert!(
            name.contains(&identity.sid),
            "«{name}» does not carry this user's SID «{}»",
            identity.sid
        );
    }

    /// A failure must carry its code in HEX so it is greppable against the vendor's tables — the
    /// same discipline the process module's apartment guard already follows.
    ///
    /// «Contains the two characters 0x» was too weak: the unimplemented stub's own placeholder
    /// text would have satisfied a slightly unluckier version of that check, and any prose
    /// mentioning a hex prefix satisfies it today. A full eight-digit HRESULT is required.
    #[test]
    fn a_failure_carries_the_code_in_hexadecimal() {
        let err = read_execution_time_limit(T_LIMIT_ABSENT)
            .expect_err("reading a task that does not exist must fail");

        assert!(
            !err.contains("not implemented"),
            "the failure must come from the scheduler, not from a placeholder body: {err}"
        );

        // Taken from the RIGHT: the operating system's own message sits in front of the code and
        // is localized, so it must never be what this assertion inspects.
        let tail = err.rsplit("0x").next().unwrap_or_default();
        assert!(
            tail.len() >= 8 && tail.chars().take(8).all(|c| c.is_ascii_hexdigit()),
            "the failure must carry a full eight-digit hexadecimal HRESULT, got: {err}"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // G-32-15 — a stopped «Планировщик задач» service must be NAMED, and must not read as OFF
    //
    // Measured 2026-09-09: the Task Scheduler service stopped, rebooted, and pressing the
    // autostart switch six times in 33 seconds against «Не удалось сохранить настройку. Попробуйте
    // ещё раз» — advice that cannot work, because pressing a switch again does not start a stopped
    // service. His app.log carries `0x80070003` (ERROR_PATH_NOT_FOUND) for every attempt.
    //
    // The decisions below are PURE FUNCTIONS OF A SERVICE STATE, and that is the whole point of
    // their shape: the state itself comes from the SCM at run time and cannot be faked in a test
    // (stopping the machine's real scheduler to run a unit test is not a thing a test suite may
    // do), so the DECISION is separated from the QUERY and only the decision is asserted here. A
    // test that could only run on a machine with the scheduler stopped is a test that never runs.
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// A raw scheduler failure, in exactly the shape [`com_err`] produces.
    const RAW_PATH_NOT_FOUND: &str =
        "RegisterTaskDefinition: The system cannot find the path specified. (0x80070003)";

    #[test]
    fn an_absent_hresult_is_not_an_answer_while_the_scheduler_service_is_stopped() {
        // THE G-32-13-FAMILY DEFECT, and the half UAT test 7 was actually about. `is_absent`
        // treats 0x80070003 as «there is no such folder» — a legitimate, confident answer that
        // makes `task_is_enabled` return `Ok(false)` and the row draw a plain OFF. On the
        // machine that same HRESULT came from the service being STOPPED, so the row claimed a
        // setting was off while a registered logon task may well have been sitting there. An
        // absence is only an ANSWER if something was there to give it.
        assert!(
            !absence_is_an_answer(SchedulerService::NotRunning),
            "with the scheduler service stopped, an «absent» HRESULT is a failure to ASK and must \
             propagate as an error so the row goes dim — never as a confident OFF"
        );
    }

    #[test]
    fn an_absent_hresult_stays_a_plain_answer_on_a_healthy_machine() {
        // The control, and it guards a contract older than this fix: a task nobody ever registered
        // must read as a plain `Ok(false)`, NOT as «unknown». Turning every absence into an error
        // would put every user who has never touched autostart in front of a dim, disabled row.
        for state in [SchedulerService::Running, SchedulerService::Unknown] {
            assert!(
                absence_is_an_answer(state),
                "an absence must remain a plain answer when the service is {state:?} — a machine \
                 whose scheduler is running and simply has no such task is the ordinary case"
            );
        }
    }

    #[test]
    fn a_failure_while_the_service_is_stopped_leads_with_the_scheduler_code() {
        let classified =
            classify_scheduler_failure(RAW_PATH_NOT_FOUND.to_string(), SchedulerService::NotRunning);

        assert!(
            classified.starts_with("AUTOSTART_REFUSED_SCHEDULER_UNAVAILABLE:"),
            "the refusal must LEAD with the stable code the Settings screen maps to its own \
             sentence (AUTOSTART_FAILURE_I18N in GeneralSection.tsx). Renaming this code without \
             renaming it there silently returns the owner to «Попробуйте ещё раз». Got: {classified}"
        );
        assert!(
            classified.contains("0x80070003"),
            "the original failure must survive INSIDE the classified message, for the support \
             bundle — the code adds a meaning, it does not replace the evidence: {classified}"
        );
    }

    #[test]
    fn a_failure_while_the_service_is_running_is_never_blamed_on_the_scheduler() {
        // The owner asked for exactly this guarantee, verbatim: «чтобы не было такого, что какая-то
        // левая ошибка отвечает нам, что планировщик не активен». A wrong explanation is worse than
        // a generic one, because a person acts on it — he would go and look at a service that was
        // running all along.
        let classified =
            classify_scheduler_failure(RAW_PATH_NOT_FOUND.to_string(), SchedulerService::Running);

        assert_eq!(
            classified, RAW_PATH_NOT_FOUND,
            "with the service confirmed RUNNING, an unrelated failure must pass through untouched \
             and fall back to the generic sentence — never be attributed to the scheduler"
        );
    }

    #[test]
    fn the_hresult_is_only_a_secondary_signal_used_when_the_service_cannot_be_asked() {
        // Secondary, and deliberately so: the authoritative answer is the SCM's. These two
        // HRESULTs are consulted ONLY when the SCM itself could not be reached, which is the one
        // situation where there is nothing better to go on.
        let unavailable = classify_scheduler_failure(
            "ITaskService::Connect: The RPC server is unavailable. (0x800706ba)".to_string(),
            SchedulerService::Unknown,
        );
        assert!(
            unavailable.starts_with("AUTOSTART_REFUSED_SCHEDULER_UNAVAILABLE:"),
            "an RPC-server-unavailable with no SCM answer available is the scheduler being \
             unreachable: {unavailable}"
        );

        let unrelated = classify_scheduler_failure(
            "ITaskFolder::GetTask: Access is denied. (0x80070005)".to_string(),
            SchedulerService::Unknown,
        );
        assert_eq!(
            unrelated, "ITaskFolder::GetTask: Access is denied. (0x80070005)",
            "an access-denied is not the scheduler being absent, and must not be dressed up as one"
        );
    }

    #[test]
    fn a_refusal_that_already_carries_a_code_is_never_reclassified() {
        // The ACL gate refuses BEFORE the scheduler is touched, so its verdict cannot be about the
        // service — and a machine that has both a replaceable target and a stopped scheduler must
        // still be told the thing it can act on first.
        let acl = "AUTOSTART_REFUSED_REPLACEABLE: «C:\\app\\trusttunnel.exe» is writable …";
        assert_eq!(
            classify_scheduler_failure(acl.to_string(), SchedulerService::NotRunning),
            acl,
            "a refusal that already leads with a code must pass through untouched — re-coding it \
             would replace a remedy the user can act on with one they cannot"
        );
    }

    #[test]
    fn the_secondary_signal_matches_the_shape_com_err_actually_writes() {
        // The two halves are tied together on purpose. The secondary signal looks for the HRESULT
        // inside a string this module formatted, so a change to `com_err`'s hex formatting would
        // silently disarm it. This test fails if the two ever drift apart.
        let formatted = com_err(
            "ITaskService::Connect",
            windows::core::Error::from_hresult(windows::core::HRESULT(HRESULT_PATH_NOT_FOUND)),
        );
        assert!(
            formatted.contains("0x80070003"),
            "com_err must render the HRESULT in the lowercase eight-digit form the secondary \
             signal greps for, got: {formatted}"
        );
        assert!(
            classify_scheduler_failure(formatted.clone(), SchedulerService::Unknown)
                .starts_with("AUTOSTART_REFUSED_SCHEDULER_UNAVAILABLE:"),
            "a string com_err actually produced must be recognised by the secondary signal: \
             {formatted}"
        );
    }

    /// What the SCM says on THIS machine, said out loud.
    ///
    /// Not an assertion that the service is running — a developer machine may legitimately have it
    /// stopped, and a test that failed for that would be testing the machine. What IS asserted is
    /// that the query REACHES the SCM and returns a definite answer rather than `Unknown`: an
    /// authoritative check that can never answer is the same as no check at all, and this phase has
    /// already caught seven checks that could never fail.
    #[test]
    fn the_scheduler_service_can_actually_be_asked_on_this_machine() {
        let state = query_scheduler_service();

        // What the query COSTS, said out loud, because the decision to run it on the read path was
        // argued on this number rather than on a feeling. It sits on the Settings tab's five-second
        // refresh — but only on the branch that is about to claim a confident OFF — so «is it cheap
        // next to the COM round-trip that just failed?» is a question with an answer, and this is it.
        const RUNS: u32 = 100;
        let started = std::time::Instant::now();
        for _ in 0..RUNS {
            let _ = query_scheduler_service();
        }
        let each = started.elapsed() / RUNS;

        say_out_loud(&format!(
            "MEASURED task_scheduler::the_scheduler_service_can_actually_be_asked_on_this_machine \
             — the SCM reports the «Schedule» service as {state:?}; {RUNS} queries averaged \
             {each:?} each"
        ));
        assert_ne!(
            state,
            SchedulerService::Unknown,
            "the SCM must be reachable for a read-only status query from an ordinary account — an \
             authoritative check that always answers «Unknown» would silently degrade to the \
             HRESULT guess it exists to replace"
        );
    }
}
