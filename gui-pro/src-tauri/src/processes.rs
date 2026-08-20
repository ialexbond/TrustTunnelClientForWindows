//! Running-process enumeration and application-icon extraction.
//!
//! Three Tauri commands live here and they are deliberately SEPARATE:
//!   * `list_running_processes` — the fast name-only snapshot the picker opens on. It must stay
//!     cheap, so it never touches an icon.
//!   * `get_process_icons` — the icon pipeline (D-01). Icons cost a shell round-trip per `.exe`,
//!     so they ride their own command and are fetched after the list is already on screen (D-02).
//!   * `get_process_icon_for_path` — the one narrow exception below.
//!
//! ## Why the batch icon command takes NAMES and never a path
//! A command shaped `get_process_icon(path)` would hand the webview an arbitrary-file icon-read
//! primitive over the whole filesystem: anything the untrusted side can name, it can request. So
//! that command accepts process NAMES, takes its OWN fresh snapshot, and derives each image path
//! backend-side.
//!
//! ## Why there is nonetheless one path-accepting command
//! A program the user picked off the disk through the OS file dialog (D-04) is usually not running,
//! so the name-based route can never resolve its icon — there is no process to open.
//! `get_process_icon_for_path` is the separate, explicitly-named surface for that single case.
//!
//! The file dialog is where the path COMES FROM. It is not a boundary this module can verify: the
//! command receives a bare string over the IPC bridge with nothing tying it to a dialog result, so
//! anything that can reach the bridge can call it with a string of its own choosing. The only thing
//! that actually narrows this surface is `is_local_exe_path`, which runs before any filesystem
//! access and admits nothing but a plain local-drive path to an `.exe`. That guard — not the
//! dialog — is why the capability is acceptable, and the batch command stays strictly name-only so
//! the two surfaces remain separately auditable.
//!
//! ## Why no path is ever logged
//! A resolved image path embeds the Windows username (`C:\Users\<name>\…`). The existing
//! enumerator already logs a COUNT rather than names; the icon pipeline follows that precedent
//! (memory/security-posture.md, the no-secrets-in-a-log-channel invariant).
//!
//! ## Where the diagnostics go
//! Through `log_app`, into app.log, like the rest of the app's Rust diagnostics. `eprintln!` was
//! the original choice here and it was a dead end: a `windows_subsystem = "windows"` build has no
//! attached stderr, so in a production install those lines went nowhere at all — including the
//! "icons resolved N of M" line, which is the only signal that the icon pipeline is failing
//! systematically. Counts and outcomes only; no path, no process name.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::logging::log_app;

/// One running program, as `list_running_processes` reports it.
///
/// NAME ONLY. This used to carry a `path: Option<String>` that every code path set to `None` — no
/// producer ever filled it — while the frontend picker already searched it and rendered it as a
/// second line under each row. Dead data reading as live is bad enough; this particular field was
/// worse, because a full image path is `C:\Users\<name>\…` and the module header above spends a
/// paragraph on keeping the Windows user name off every channel. One populated value and the leak
/// would have shipped through JSX that was already written. Removed on both sides of the bridge.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessInfo {
    pub name: String,
}

/// One row of the icon batch. `icon` carries a `data:image/png;base64,…` URL, or `None` when the
/// icon could not be resolved for ANY reason — which is exactly the D-03 signal the frontend
/// renders as a neutral Lucide glyph. A per-process failure is normal (elevated, protected or
/// already-exited processes have no readable image), never an error for the batch.
#[derive(Debug, Clone, Serialize)]
pub struct ProcessIcon {
    pub name: String,
    pub icon: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Pure steps.
//
// These are written and unit-tested BEFORE any Win32 glue exists, following the pure/OS-bound
// split `app_settings.rs` uses. The pixel path is the part that fails silently — an upside-down,
// colour-swapped or fully transparent icon still "works" — so it is the part that must be
// provable without a live desktop. Everything below is ordinary data manipulation with no OS call
// in it, which is what makes the `#[cfg(test)] mod tests` at the bottom of this file possible.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/// Snapshot entries that name no user-mode image: the kernel pseudo-processes and the memory
/// manager. They can never yield a path or an icon, so they are dropped during enumeration rather
/// than failing later in the icon pipeline.
fn is_pseudo_process(lowercased: &str) -> bool {
    matches!(
        lowercased,
        "[system process]" | "system" | "idle" | "registry" | "secure system" | "memory compression"
    )
}

/// Fold a raw `(image file name, PID)` snapshot stream into the deduped name→FIRST-PID map.
///
/// The enumeration deliberately dedups by NAME — the picker lists programs, not instances, and a
/// browser with twelve renderer children must appear once. What changed for the icon work is that
/// the PID is now KEPT instead of discarded: `PROCESSENTRY32W.szExeFile` carries only a bare file
/// name, never a directory, so the PID is the only handle back to a real image path.
///
/// First PID wins, not last: it is the earliest-started instance of that program, which for a
/// multi-process app is the parent — the one most likely to still be alive by the time the icon
/// batch runs.
fn collect_process_pids<I: IntoIterator<Item = (String, u32)>>(entries: I) -> BTreeMap<String, u32> {
    let mut by_name = BTreeMap::new();
    for (raw_name, pid) in entries {
        let name = raw_name.to_lowercase();
        if name.is_empty() || is_pseudo_process(&name) {
            continue;
        }
        by_name.entry(name).or_insert(pid);
    }
    by_name
}

/// Swap the blue and red channels of a 32-bit pixel buffer in place.
///
/// GDI hands back BGRA; PNG wants RGBA. Skipping this produces a perfectly shaped icon in the
/// wrong palette — Chrome's logo comes out with its blue and orange traded, which is easy to miss
/// on a 24 px row.
fn bgra_to_rgba(pixels: &mut [u8]) {
    for px in pixels.chunks_exact_mut(4) {
        px.swap(0, 2);
    }
}

/// Row stride, in bytes, of a 1-bit-per-pixel DIB. DIB rows are DWORD-aligned, so a 32×32 mask
/// still occupies 4 bytes per row rather than the 4 bits the pixels need.
fn mask_row_stride(width: usize) -> usize {
    width.div_ceil(32) * 4
}

/// Derive the alpha channel of `pixels` from a 1-bpp AND mask.
///
/// In the AND mask a SET bit means "transparent here", so it maps to alpha 0 and a clear bit maps
/// to fully opaque. Out-of-range indices are skipped rather than panicking: the mask and the
/// colour bitmap come from two separate OS calls and a mismatch must degrade to a slightly wrong
/// icon, never to a crash inside a blocking worker.
fn alpha_from_mask(pixels: &mut [u8], mask: &[u8], width: usize, height: usize) {
    let stride = mask_row_stride(width);
    for y in 0..height {
        for x in 0..width {
            let Some(&bits) = mask.get(y * stride + x / 8) else {
                continue;
            };
            let transparent = bits & (0x80u8 >> (x % 8)) != 0;
            if let Some(alpha) = pixels.get_mut((y * width + x) * 4 + 3) {
                *alpha = if transparent { 0 } else { 255 };
            }
        }
    }
}

/// Apply the legacy-icon mask fallback, but ONLY when the colour bitmap carries no alpha at all.
///
/// Legacy icons keep their transparency in the separate 1-bpp mask and come back from `GetDIBits`
/// with every alpha byte zero — encoded as-is they produce a fully transparent PNG, which on
/// screen is indistinguishable from the fallback having fired. Modern 32-bpp icons, by contrast,
/// arrive with straight (non-premultiplied) alpha that is already correct; touching those would
/// corrupt them, which is why this is a guarded fallback and not an unconditional pass.
fn apply_alpha_fallback(pixels: &mut [u8], mask: &[u8], width: usize, height: usize) {
    if pixels.chunks_exact(4).all(|px| px[3] == 0) {
        alpha_from_mask(pixels, mask, width, height);
    }
}

/// Characters a path component may be built from.
///
/// A genuine whitelist, per the project's standing rule (memory/security-posture.md: char-whitelist
/// ВСЕГДА, blacklist нельзя). `is_alphanumeric` is the UNICODE predicate on purpose — this app's
/// users are Russian-speaking and `C:\Users\Иван\…` is an ordinary profile path, so an ASCII-only
/// rule would refuse real installations. Everything beyond letters and digits is enumerated by
/// hand: these are the punctuation marks that occur in real program paths («Program Files (x86)»,
/// «Adobe Photoshop 2024», «foo-bar_baz»). Anything not on this list — `:` outside the drive
/// prefix, `<>"|?*`, control characters, the whole device/stream syntax — is simply not admitted,
/// so nothing has to be enumerated as forbidden.
///
/// Refusing a legal-but-exotic path costs the user nothing worse than a generic glyph in place of a
/// real icon: the command returns `Err`, the frontend caches the failure and renders the neutral
/// fallback (D-03). That is the correct trade against widening the accepted set.
fn is_allowed_path_char(c: char) -> bool {
    c.is_alphanumeric()
        || matches!(
            c,
            ' ' | '.'
                | '-'
                | '_'
                | '('
                | ')'
                | '['
                | ']'
                | '{'
                | '}'
                | '+'
                | ','
                | ';'
                | '='
                | '\''
                | '!'
                | '#'
                | '$'
                | '%'
                | '&'
                | '@'
                | '^'
                | '~'
                | '`'
        )
}

/// Longest path this command will look at. Windows' extended limit is 32 767 wide chars; staying
/// under it means `wide_nul` can never be asked to build a buffer the OS would reject anyway.
const MAX_PATH_CHARS: usize = 32_000;

/// The allow-rule for the ONE command in this module that accepts a caller-supplied path.
///
/// It answers a single question: does this string name a plain executable FILE ON A LOCAL DRIVE of
/// this machine? Everything else is refused. Written as an allow-rule, not a deny-list of forbidden
/// shapes — a deny-list is a list somebody must keep complete forever, and the project's standing
/// rule is whitelist, never blacklist (memory/security-posture.md).
///
/// Four independent axes have to hold, and the earlier version constrained only the last one:
///
/// 1. NAMESPACE. The path must start `X:\` or `X:/` — a plain local drive. Every other namespace is
///    outside the accepted shape rather than on a list of known-bad ones. This is the axis that
///    matters most, because `SHGetFileInfoW` TOUCHES THE FILESYSTEM: a UNC path (`\\host\s\a.exe`)
///    makes Windows open an SMB session to `host` and negotiate NTLM with the logged-in user's
///    credentials, the WebDAV spelling (`\\host@SSL\DavWWWRoot\a.exe`) does the same over HTTPS to
///    an attacker-chosen server, and `\\.\pipe\x.exe` / `\\?\…` are not ordinary files at all.
///    Requiring a drive prefix refuses all four without naming any of them. It also removes the
///    availability problem that came with them: an unreachable share blocks the shell call for tens
///    of seconds with no timeout, on the same blocking pool the VPN connectivity probes use.
/// 2. CHARACTERS. Every character after the drive prefix is either a separator or on the whitelist
///    above. This is what makes the rule a whitelist in the project's sense rather than a suffix
///    test with exceptions bolted on.
/// 3. COMPONENTS. No empty component (a doubled separator), no `.` or `..` (a non-canonical path
///    resolves to something other than what was inspected), and no component with a trailing dot or
///    space. That last one is the same class of bug as the NUL rule: Win32 SILENTLY STRIPS trailing
///    dots and spaces from a component, so `secrets.txt.exe ` and `secrets.txt.exe.` are inspected
///    as one string and opened as another. Refusing them keeps the string this function judged and
///    the string the OS acts on the same string.
/// 4. EXTENSION. The final component is `<something>.exe`, compared without regard to letter case.
///    A bare `.exe` with no stem, a doubled extension such as `app.exe.txt` where `.exe` is present
///    but not final, and a trailing separator (a directory) are all refused here.
///
/// The interior-NUL rule sits above all four, for the same reason it always did: the path is handed
/// to Win32 as a NUL-terminated wide string, so `evil.dll\0harmless.exe` would satisfy a naive
/// suffix check and then be read by the OS as `evil.dll`.
///
/// What this does NOT decide is whether a drive letter names local storage — `Z:` can be a mapped
/// network drive, which is an SMB fetch wearing a local shape. That question needs the OS, so it is
/// answered by `GetDriveTypeW` in the command itself, next to the call it protects.
fn is_local_exe_path(path: &str) -> bool {
    if path.is_empty() || path.len() > MAX_PATH_CHARS || path.contains('\u{0}') {
        return false;
    }

    // Axis 1 — namespace. `X:` plus a separator, and nothing else, is the accepted opening.
    let mut chars = path.chars();
    let drive = chars.next().unwrap_or('\u{0}');
    if !drive.is_ascii_alphabetic() || chars.next() != Some(':') {
        return false;
    }
    match chars.next() {
        Some('\\') | Some('/') => {}
        _ => return false,
    }
    let rest = &path[3..];

    // Axes 2 and 3 — characters and components, checked together while walking the components.
    let mut last_component = "";
    let mut component_count = 0usize;
    for component in rest.split(['\\', '/']) {
        if component.is_empty() || component == "." || component == ".." {
            return false;
        }
        if component.ends_with('.') || component.ends_with(' ') {
            return false;
        }
        if !component.chars().all(is_allowed_path_char) {
            return false;
        }
        last_component = component;
        component_count += 1;
    }
    if component_count == 0 {
        return false;
    }

    // Axis 4 — extension. `.exe` alone has an empty stem, so requiring a longer name rejects it.
    last_component.len() > ".exe".len() && last_component.to_ascii_lowercase().ends_with(".exe")
}

/// Most names one `get_process_icons` call will accept.
///
/// Twice the frontend's `ICON_BATCH_SIZE` (32), so a legitimate batch can never trip it while a
/// bogus one is refused before any work starts. The cap is here, not only in the frontend, because
/// a backend command must not rely on its caller for its bounds — the same principle this module's
/// header argues for the path parameter. Without it,
/// `invoke("get_process_icons", { names: Array(100_000).fill("chrome.exe") })` ran 100 000
/// `OpenProcess` + `SHGetFileInfoW` + `GetDIBits` + PNG-encode cycles on one blocking-pool thread
/// and then serialized 100 000 copies of the same data URL back across the bridge.
pub(crate) const MAX_ICON_BATCH: usize = 64;

/// The DISTINCT names in a requested batch, lowercased, in first-seen order.
///
/// The snapshot keys are lowercased and the shell lookup is per image path, so two spellings of one
/// program are one question. Resolving it once is what stops a batch of repeats from paying for
/// each repeat — `collapse_icon_results` still emits one row per REQUESTED name afterwards, so the
/// caller's contract is unchanged.
fn distinct_lowercased(names: &[String]) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();
    let mut distinct = Vec::new();
    for name in names {
        let key = name.to_lowercase();
        if seen.insert(key.clone()) {
            distinct.push(key);
        }
    }
    distinct
}

/// Line up per-name results with the names that were requested.
///
/// One entry per requested name, in request order, with `icon: None` wherever the resolution
/// failed. The frontend keys its cache by the name it asked for, so a batch that silently dropped
/// its failures would leave those rows fetching forever. A name missing from `resolved` degrades
/// the same way: it reads as unresolved, not as absent.
///
/// `resolved` is keyed by the LOWERCASED name because that is the unit of work — one answer serves
/// every spelling of the same program in the same batch.
fn collapse_icon_results(
    names: &[String],
    resolved: &std::collections::BTreeMap<String, Result<String, String>>,
) -> Vec<ProcessIcon> {
    names
        .iter()
        .map(|name| ProcessIcon {
            name: name.clone(),
            icon: resolved
                .get(&name.to_lowercase())
                .and_then(|result| result.as_ref().ok())
                .cloned(),
        })
        .collect()
}

/// Encode an RGBA8 buffer as a `data:image/png;base64,…` URL.
///
/// PNG rather than raw pixels + a frontend `<canvas>`: the `png` crate is already resolved in
/// `Cargo.lock`, so this costs no new download, and it keeps the per-row render path a plain
/// `<img src>` instead of imperative canvas work on every list row.
fn encode_png_data_url(rgba: &[u8], width: u32, height: u32) -> Result<String, String> {
    use base64::Engine;

    let mut png_bytes: Vec<u8> = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png_bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|e| format!("png header failed: {e}"))?;
        writer
            .write_image_data(rgba)
            .map_err(|e| format!("png encode failed: {e}"))?;
    }

    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&png_bytes)
    ))
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// OS-bound leg.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/// Take a fresh process snapshot and return the deduped name→first-PID map.
///
/// Shared by BOTH commands on purpose. `get_process_icons` must derive its own paths rather than
/// trust anything the webview sends, so it needs its own snapshot; sharing the walk keeps the
/// skip-list and the dedup rule in exactly one place.
#[cfg(windows)]
fn snapshot_process_pids() -> Result<BTreeMap<String, u32>, String> {
    use std::ffi::OsString;
    use std::mem;
    use std::os::windows::ffi::OsStringExt;

    // Toolhelp constants and the PROCESSENTRY32W layout, declared by hand. This block predates the
    // windows-sys dependency and is left exactly as it was: the icon pipeline below uses the typed
    // windows-sys bindings instead, so nothing new is added here.
    const TH32CS_SNAPPROCESS: u32 = 0x00000002;
    const INVALID_HANDLE_VALUE: isize = -1;
    const MAX_PATH: usize = 260;

    #[repr(C)]
    #[allow(non_snake_case)]
    struct PROCESSENTRY32W {
        dwSize: u32,
        cntUsage: u32,
        th32ProcessID: u32,
        th32DefaultHeapID: usize,
        th32ModuleID: u32,
        cntThreads: u32,
        th32ParentProcessID: u32,
        pcPriClassBase: i32,
        dwFlags: u32,
        szExeFile: [u16; MAX_PATH],
    }

    extern "system" {
        fn CreateToolhelp32Snapshot(dwFlags: u32, th32ProcessID: u32) -> isize;
        fn Process32FirstW(hSnapshot: isize, lppe: *mut PROCESSENTRY32W) -> i32;
        fn Process32NextW(hSnapshot: isize, lppe: *mut PROCESSENTRY32W) -> i32;
        fn CloseHandle(hObject: isize) -> i32;
    }

    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err("Failed to create process snapshot".into());
        }

        let mut entry: PROCESSENTRY32W = mem::zeroed();
        entry.dwSize = mem::size_of::<PROCESSENTRY32W>() as u32;

        let mut raw: Vec<(String, u32)> = Vec::new();

        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                let len = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(MAX_PATH);
                let name = OsString::from_wide(&entry.szExeFile[..len])
                    .to_string_lossy()
                    .to_string();
                raw.push((name, entry.th32ProcessID));

                entry = mem::zeroed();
                entry.dwSize = mem::size_of::<PROCESSENTRY32W>() as u32;
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }

        CloseHandle(snapshot);

        Ok(collect_process_pids(raw))
    }
}

/// List unique running processes on Windows using CreateToolhelp32Snapshot.
///
/// Name-only by design: the picker must open instantly, so this resolves no image paths and
/// extracts no icons. Icons arrive separately through `get_process_icons` once the list is already
/// visible (D-02).
///
/// `async fn` + `spawn_blocking`, matching the two icon commands. Tauri runs a NON-async command on
/// the main thread, so the whole `CreateToolhelp32Snapshot` walk of every process on the machine
/// used to happen there and the UI was unresponsive for its duration — the frozen frame the user
/// got after clicking «Добавить процесс». "Name-only so it stays cheap" is a claim about the work
/// this does, not a licence to do that work where it can stop the window drawing.
#[cfg(windows)]
#[tauri::command]
pub async fn list_running_processes() -> Result<Vec<ProcessInfo>, String> {
    tokio::task::spawn_blocking(|| {
        let by_name = snapshot_process_pids()?;

        let processes: Vec<ProcessInfo> = by_name
            .keys()
            .map(|name| ProcessInfo { name: name.clone() })
            .collect();

        log_app(
            "INFO",
            &format!("[processes] Found {} unique processes", processes.len()),
        );
        Ok(processes)
    })
    .await
    .map_err(|e| format!("process enumeration worker panicked: {e}"))?
}

#[cfg(not(windows))]
#[tauri::command]
pub async fn list_running_processes() -> Result<Vec<ProcessInfo>, String> {
    Ok(Vec::new())
}

/// The Win32 icon pipeline: PID → image path → shell icon → RGBA pixels.
///
/// Every OS handle in here is owned by a tiny RAII guard rather than released on a linear cleanup
/// path. The `?` operator makes an early return on a mid-function failure trivially easy to write
/// and just as easy to leak from, and in an app that sits in the tray for days a leaked HICON or
/// HBITMAP is a slow GDI drain (the default per-process quota is 10 000 objects) that eventually
/// stops the UI drawing altogether.
#[cfg(windows)]
mod win_icon {
    use core::ffi::c_void;
    use std::ptr::{null, null_mut};

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Graphics::Gdi::{
        DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP, HDC, RGBQUAD,
    };
    use windows_sys::Win32::Storage::FileSystem::GetDriveTypeW;
    use windows_sys::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
    use windows_sys::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

    /// `QueryFullProcessImageNameW` accepts long paths, so the buffer is sized for one rather than
    /// for MAX_PATH. Allocated once per batch and reused across every name in it.
    pub(super) const PATH_BUF_CHARS: usize = 32_768;

    /// Widest icon we will decode. `SHGFI_LARGEICON` is 32×32 at 100% DPI and at most 256×256 on
    /// exotic shells; the cap exists so a bogus `GetObjectW` result cannot make us allocate a
    /// multi-gigabyte pixel buffer inside a blocking worker.
    const MAX_ICON_EDGE: usize = 512;

    /// `RPC_E_CHANGED_MODE` (0x80010106) — the thread already lives in a different apartment.
    /// Not a failure for our purposes: the shell call works either way.
    const RPC_E_CHANGED_MODE: i32 = -2_147_417_850;

    /// The COM apartment for one blocking-worker call.
    ///
    /// `SHGetFileInfoW` requires COM to be initialized ON THE CALLING THREAD. Apartments are
    /// per-thread and tokio's blocking pool hands out fresh threads, so initializing once at
    /// startup would work by accident on a reused thread and silently return zero icons on a new
    /// one. `CoUninitialize` is called only when we actually initialized, because a
    /// `RPC_E_CHANGED_MODE` result means someone else owns the apartment.
    pub(super) struct ComApartment {
        initialized: bool,
    }

    impl ComApartment {
        pub(super) fn init() -> Result<Self, String> {
            // SAFETY: a plain apartment init on the current thread with no reserved argument.
            let hr = unsafe { CoInitializeEx(null(), COINIT_APARTMENTTHREADED as u32) };
            if hr < 0 && hr != RPC_E_CHANGED_MODE {
                return Err(format!("CoInitializeEx failed: {hr:#010x}"));
            }
            // S_OK and S_FALSE both take ownership of an apartment reference and both require a
            // matching CoUninitialize; RPC_E_CHANGED_MODE does not.
            Ok(ComApartment {
                initialized: hr >= 0,
            })
        }
    }

    impl Drop for ComApartment {
        fn drop(&mut self) {
            if self.initialized {
                // SAFETY: balances the CoInitializeEx that returned a success HRESULT above.
                unsafe { CoUninitialize() };
            }
        }
    }

    /// RAII owner of an `OpenProcess` HANDLE.
    struct OwnedProcess(HANDLE);

    impl Drop for OwnedProcess {
        fn drop(&mut self) {
            // SAFETY: a handle returned by OpenProcess, closed exactly once — the value is
            // constructed only after a null check and never duplicated.
            unsafe { CloseHandle(self.0) };
        }
    }

    /// RAII owner of the HICON `SHGetFileInfoW` copies into `SHFILEINFOW.hIcon`. Microsoft's own
    /// remarks put the release duty on the caller.
    struct OwnedIcon(HICON);

    impl Drop for OwnedIcon {
        fn drop(&mut self) {
            // SAFETY: an icon handle produced by SHGetFileInfoW, destroyed exactly once.
            unsafe { DestroyIcon(self.0) };
        }
    }

    /// RAII owner of one of the two bitmaps `GetIconInfo` creates. Both must be deleted; a
    /// monochrome icon legitimately has a null colour bitmap, hence the null guard.
    struct OwnedBitmap(HBITMAP);

    impl Drop for OwnedBitmap {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: a bitmap created by GetIconInfo, deleted exactly once.
                unsafe { DeleteObject(self.0) };
            }
        }
    }

    /// RAII owner of the screen DC borrowed for `GetDIBits`.
    struct ScreenDc(HDC);

    impl Drop for ScreenDc {
        fn drop(&mut self) {
            // SAFETY: released against the same null HWND it was acquired from.
            unsafe { ReleaseDC(null_mut(), self.0) };
        }
    }

    /// `BITMAPINFO` carries room for a single palette entry, but a 1-bpp DIB needs two. Declaring
    /// the header and its two-entry table together and casting gives `GetDIBits` a correctly sized
    /// structure to write into instead of letting it run past the end of a `BITMAPINFO`.
    #[repr(C)]
    struct BitmapInfo1Bpp {
        header: BITMAPINFOHEADER,
        colors: [RGBQUAD; 2],
    }

    /// Resolve a PID to its full image path as a NUL-terminated wide string.
    ///
    /// `PROCESS_QUERY_LIMITED_INFORMATION` is the lowest right that answers this question — the
    /// older `GetModuleFileNameExW` route additionally needs `PROCESS_VM_READ`, a strictly higher
    /// bar that also breaks across 32/64-bit boundaries. Elevated, protected and already-exited
    /// processes still fail here with access denied, which is the intended D-03 fallback trigger.
    fn image_path_for_pid(pid: u32, buf: &mut [u16]) -> Result<Vec<u16>, String> {
        // SAFETY: a query-only open of a PID from our own snapshot; the returned handle is checked
        // for null and immediately given to an RAII owner.
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            return Err("OpenProcess denied".into());
        }
        let process = OwnedProcess(handle);

        let mut len = buf.len() as u32;
        // SAFETY: `buf` is a live slice of `len` u16s and `len` is both the in and out size.
        let ok = unsafe {
            QueryFullProcessImageNameW(process.0, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len)
        };
        if ok == 0 || len == 0 {
            return Err("QueryFullProcessImageNameW failed".into());
        }

        let mut wide = buf[..len as usize].to_vec();
        wide.push(0);
        Ok(wide)
    }

    /// Extract the shell icon for one image path and return it as a PNG data URL.
    ///
    /// `SHGetFileInfoW` rather than `ExtractIconExW`: it returns the SHELL icon, honouring
    /// associations and third-party icon handlers, which is what makes the list read like the
    /// Windows apps list instead of like a raw resource dump. The cost is the COM requirement the
    /// caller satisfies with `ComApartment`.
    pub(super) fn icon_data_url_for_path(wide_path: &[u16]) -> Result<String, String> {
        // SAFETY: an all-zero SHFILEINFOW is a valid starting state; the size argument matches.
        let mut info: SHFILEINFOW = unsafe { std::mem::zeroed() };
        let ok = unsafe {
            SHGetFileInfoW(
                wide_path.as_ptr(),
                0,
                &mut info,
                std::mem::size_of::<SHFILEINFOW>() as u32,
                SHGFI_ICON | SHGFI_LARGEICON,
            )
        };
        if ok == 0 || info.hIcon.is_null() {
            return Err("SHGetFileInfoW returned no icon".into());
        }
        let icon = OwnedIcon(info.hIcon);

        // SAFETY: `icon` is a live HICON; GetIconInfo fills the zeroed ICONINFO with two bitmaps
        // whose ownership transfers to us and is taken over by OwnedBitmap on the next two lines.
        let mut icon_info: ICONINFO = unsafe { std::mem::zeroed() };
        if unsafe { GetIconInfo(icon.0, &mut icon_info) } == 0 {
            return Err("GetIconInfo failed".into());
        }
        let color = OwnedBitmap(icon_info.hbmColor);
        let mask = OwnedBitmap(icon_info.hbmMask);
        if color.0.is_null() {
            return Err("icon carries no colour bitmap".into());
        }

        // SAFETY: `color` is a live HBITMAP and the size argument matches the BITMAP out-param.
        let mut bm: BITMAP = unsafe { std::mem::zeroed() };
        let got = unsafe {
            GetObjectW(
                color.0,
                std::mem::size_of::<BITMAP>() as i32,
                &mut bm as *mut BITMAP as *mut c_void,
            )
        };
        if got == 0 {
            return Err("GetObjectW failed".into());
        }

        let width = bm.bmWidth.max(0) as usize;
        let height = bm.bmHeight.max(0) as usize;
        if width == 0 || height == 0 || width > MAX_ICON_EDGE || height > MAX_ICON_EDGE {
            return Err("icon bitmap has an unusable size".into());
        }

        // SAFETY: a null HWND asks for the screen DC; released by ScreenDc's Drop.
        let dc = unsafe { GetDC(null_mut()) };
        if dc.is_null() {
            return Err("GetDC failed".into());
        }
        let dc = ScreenDc(dc);

        let mut pixels = vec![0u8; width * height * 4];
        // biHeight is NEGATIVE on purpose: a positive value returns a bottom-up DIB and the icon
        // renders vertically mirrored — the classic first-attempt bug, and one that is symmetric
        // enough on many icons to survive a quick glance.
        let mut bi: BITMAPINFO = unsafe { std::mem::zeroed() };
        bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bi.bmiHeader.biWidth = width as i32;
        bi.bmiHeader.biHeight = -(height as i32);
        bi.bmiHeader.biPlanes = 1;
        bi.bmiHeader.biBitCount = 32;
        bi.bmiHeader.biCompression = BI_RGB;

        // SAFETY: the destination buffer is exactly width*height*4 bytes, matching the 32-bpp
        // header above, and `color` is not selected into any DC.
        let scanned = unsafe {
            GetDIBits(
                dc.0,
                color.0,
                0,
                height as u32,
                pixels.as_mut_ptr() as *mut c_void,
                &mut bi,
                DIB_RGB_COLORS,
            )
        };
        if scanned == 0 {
            return Err("GetDIBits failed on the colour bitmap".into());
        }

        super::bgra_to_rgba(&mut pixels);

        // The legacy-icon path: only read the mask when there is one, and let apply_alpha_fallback
        // decide whether it is actually needed (a modern 32-bpp icon must be left alone).
        if !mask.0.is_null() {
            let stride = super::mask_row_stride(width);
            let mut mask_bits = vec![0u8; stride * height];
            let mut mask_info: BitmapInfo1Bpp = unsafe { std::mem::zeroed() };
            mask_info.header.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
            mask_info.header.biWidth = width as i32;
            mask_info.header.biHeight = -(height as i32);
            mask_info.header.biPlanes = 1;
            mask_info.header.biBitCount = 1;
            mask_info.header.biCompression = BI_RGB;

            // SAFETY: BitmapInfo1Bpp is repr(C) with BITMAPINFOHEADER first, so it is a valid
            // BITMAPINFO with room for the two palette entries a 1-bpp DIB requires.
            let mask_scanned = unsafe {
                GetDIBits(
                    dc.0,
                    mask.0,
                    0,
                    height as u32,
                    mask_bits.as_mut_ptr() as *mut c_void,
                    &mut mask_info as *mut BitmapInfo1Bpp as *mut BITMAPINFO,
                    DIB_RGB_COLORS,
                )
            };
            if mask_scanned != 0 {
                super::apply_alpha_fallback(&mut pixels, &mask_bits, width, height);
            }
        }

        super::encode_png_data_url(&pixels, width as u32, height as u32)
    }

    /// PID → PNG data URL, the whole per-name leg. Split out so the batch loop reads as one line
    /// per name and every failure mode collapses to the same `Err`.
    pub(super) fn icon_data_url_for_pid(
        pid: u32,
        expected_name: &str,
        buf: &mut [u16],
    ) -> Result<String, String> {
        let wide_path = image_path_for_pid(pid, buf)?;

        // Confirm the PID still belongs to the program we were asked about.
        //
        // The snapshot maps name -> first PID; the icon is fetched by re-opening that PID later.
        // Windows recycles PIDs aggressively, so if the process exits in between and a DIFFERENT
        // program is handed the same number, `QueryFullProcessImageNameW` answers for the new one —
        // and its icon would be cached under the OLD name for the whole session. The window is
        // milliseconds and the damage is a wrong 24 px picture, but the check costs one string
        // compare on a path we already have.
        let path = String::from_utf16_lossy(strip_nul(&wide_path));
        let resolved_name = path.rsplit(['\\', '/']).next().unwrap_or("");
        if !resolved_name.eq_ignore_ascii_case(expected_name) {
            return Err("PID no longer names the requested program".into());
        }

        icon_data_url_for_path(&wide_path)
    }

    /// The wide string without its NUL terminator. `image_path_for_pid` always appends exactly one.
    fn strip_nul(wide: &[u16]) -> &[u16] {
        match wide.split_last() {
            Some((0, head)) => head,
            _ => wide,
        }
    }

    /// A Rust string as the NUL-terminated wide string every Win32 `…W` call expects.
    ///
    /// Only ever called on a string that already passed the extension guard, which refuses interior
    /// NULs — so the terminator appended here is the first and only one, and the OS sees exactly
    /// the path that was inspected.
    pub(super) fn wide_nul(path: &str) -> Vec<u16> {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        OsStr::new(path).encode_wide().chain(std::iter::once(0)).collect()
    }

    /// Does this path's drive letter name storage attached to THIS machine?
    ///
    /// The syntactic guard (`is_local_exe_path`) can prove a path is spelled as a local drive path;
    /// it cannot know that `Z:` is a mapped network share, which would put `SHGetFileInfoW` back on
    /// the wire with the user's credentials and back on an unbounded wait if the share is dead. Only
    /// the OS knows, so it is asked.
    ///
    /// Fixed and removable are the two drive types a program is normally installed on, and both are
    /// local by definition. A RAM disk reports `DRIVE_RAMDISK` and a mounted ISO reports
    /// `DRIVE_CDROM`; both are local too, and both are accepted for that reason. `DRIVE_REMOTE`,
    /// `DRIVE_UNKNOWN` and `DRIVE_NO_ROOT_DIR` are not, so an unmapped or remote letter is refused
    /// rather than probed. `GetDriveTypeW` reads the local mount table — it does not itself reach
    /// out to the network, which is what makes it safe to call before the shell call it protects.
    /// `GetDriveTypeW` return values. Spelled out here because windows-sys 0.59 binds the function
    /// but not the constants — they are documented Win32 values, and inventing a name for each one
    /// beats comparing against bare integers at the call site.
    const DRIVE_REMOVABLE: u32 = 2;
    const DRIVE_FIXED: u32 = 3;
    const DRIVE_CDROM: u32 = 5;
    const DRIVE_RAMDISK: u32 = 6;

    pub(super) fn is_local_drive(path: &str) -> bool {
        // `is_local_exe_path` already proved the first three chars are `X:` plus a separator, so
        // the root is exactly that prefix with a backslash. Built here rather than passed in so the
        // two functions cannot drift.
        let Some(drive) = path.chars().next() else {
            return false;
        };
        let root: Vec<u16> = [drive as u16, b':' as u16, b'\\' as u16, 0].to_vec();

        // SAFETY: `root` is a NUL-terminated wide string that outlives the call; the API only reads
        // from it and returns a plain integer.
        let kind = unsafe { GetDriveTypeW(root.as_ptr()) };
        matches!(kind, DRIVE_FIXED | DRIVE_REMOVABLE | DRIVE_RAMDISK | DRIVE_CDROM)
    }
}

/// Resolve the application icon for each requested process NAME (D-01).
///
/// Takes names, never a path: the command derives every image path from its own fresh snapshot, so
/// the webview cannot use it to read an icon out of an arbitrary file. A single per-name failure
/// yields `icon: None` for that name and leaves the rest of the batch resolved — the outer `Err`
/// is reserved for "could not even take a snapshot".
///
/// All Win32 work runs in `spawn_blocking`: Microsoft documents `SHGetFileInfoW` as a
/// background-thread call because a foreground call can hang the UI, and a cold shell cache can
/// spend tens of milliseconds per `.exe`.
#[cfg(windows)]
#[tauri::command]
pub async fn get_process_icons(names: Vec<String>) -> Result<Vec<ProcessIcon>, String> {
    // Bounded before any work starts, and before the request can occupy a blocking-pool thread.
    if names.len() > MAX_ICON_BATCH {
        return Err("icon batch too large".into());
    }

    tokio::task::spawn_blocking(move || {
        // Held for the whole batch, torn down before the worker thread is handed back.
        let _com = win_icon::ComApartment::init()?;
        let by_name = snapshot_process_pids()?;

        let mut path_buf = vec![0u16; win_icon::PATH_BUF_CHARS];
        // Each DISTINCT program is resolved once. A batch that names the same program twenty times
        // is twenty rows of one answer, not twenty shell round-trips.
        let mut resolved: std::collections::BTreeMap<String, Result<String, String>> =
            std::collections::BTreeMap::new();
        for key in distinct_lowercased(&names) {
            // The snapshot keys are lowercased; the frontend may hold the name in whatever case
            // the user picked. Comparison is case-insensitive, storage stays verbatim —
            // process-name semantics belong to the C++ core, which lowercases both sides itself,
            // so nothing here may normalize what the frontend persists.
            let result = by_name
                .get(&key)
                .copied()
                .ok_or_else(|| "process is not running".to_string())
                .and_then(|pid| win_icon::icon_data_url_for_pid(pid, &key, &mut path_buf));
            resolved.insert(key, result);
        }

        // Counts ONLY. A full image path embeds the Windows username, and the process names the
        // user routes are their own business — neither belongs in a log channel.
        let ok_count = resolved.values().filter(|result| result.is_ok()).count();
        log_app(
            "INFO",
            &format!(
                "[processes] icons resolved {} of {} distinct ({} requested)",
                ok_count,
                resolved.len(),
                names.len()
            ),
        );

        Ok(collapse_icon_results(&names, &resolved))
    })
    .await
    .map_err(|e| format!("icon worker panicked: {e}"))?
}

/// Non-Windows twin. Without it the crate stops compiling for a non-Windows check, and the
/// frontend contract (one entry per requested name) still holds — every entry simply falls back.
#[cfg(not(windows))]
#[tauri::command]
pub async fn get_process_icons(names: Vec<String>) -> Result<Vec<ProcessIcon>, String> {
    // The cap runs here too, so the contract a caller sees is the same on every platform.
    if names.len() > MAX_ICON_BATCH {
        return Err("icon batch too large".into());
    }
    Ok(names
        .into_iter()
        .map(|name| ProcessIcon { name, icon: None })
        .collect())
}

/// Resolve the application icon for ONE file the user personally chose through the OS file dialog.
///
/// This is the only command in the module that accepts a caller-supplied path, and it exists for
/// exactly one situation: the user picked a program off the disk to add to the routing rules, so
/// the program is very often not running and the name-based command can never resolve it — there is
/// no process to open.
///
/// The dialog is where the path comes from, and that is all it is. Nothing here can check that a
/// given string ever passed through a dialog — the argument arrives over the IPC bridge like any
/// other — so the narrowing is done by two checks that do not depend on the caller's good faith:
///   * `is_local_exe_path` runs FIRST, before any filesystem access, and admits only a plain
///     local-drive path to an `.exe`. That is what keeps this from being an arbitrary-file read
///     primitive, and it is why the name-based command was left strictly path-free rather than
///     widened to take an optional path.
///   * `GetDriveTypeW` then refuses a drive letter that is really a network mapping. A path can
///     satisfy every syntactic rule and still be `Z:\a.exe` pointing at a remote share, which puts
///     the shell call back on the network with the user's credentials — the exact outcome the
///     namespace rule exists to prevent.
///
/// Deliberately NOT used: `SHGFI_USEFILEATTRIBUTES`. That flag stops the shell touching the file,
/// which sounds like the right hardening and is not — it makes `SHGetFileInfoW` derive the icon
/// from the extension alone, so every program would come back with the same generic `.exe` picture
/// and D-01's whole point (the list reads like the Windows apps list) would be gone. The file has
/// to be opened to get the program's own icon; the two checks above are what make opening it safe.
///
/// The pixel pipeline, the COM apartment and the handle guards are the same ones the batch command
/// uses — this is a second thin entry point over one implementation, not a second implementation.
/// A duplicated pipeline would be a second place to leak a GDI handle from.
///
/// A failure to extract the icon returns `Ok(None)`, not an error: an icon is decoration, and a
/// program that cannot be decorated must still be addable.
#[cfg(windows)]
#[tauri::command]
pub async fn get_process_icon_for_path(path: String) -> Result<Option<String>, String> {
    if !is_local_exe_path(&path) {
        return Err("only an executable file is accepted here".into());
    }

    tokio::task::spawn_blocking(move || {
        // The syntactic guard cannot tell a local drive from a mapped network one; only the OS can.
        // Asked here rather than before `spawn_blocking` because it is an OS call, and every OS
        // call in this module belongs on the blocking pool.
        if !win_icon::is_local_drive(&path) {
            return Err("only an executable file is accepted here".into());
        }

        let _com = win_icon::ComApartment::init()?;
        let wide = win_icon::wide_nul(&path);
        let icon = win_icon::icon_data_url_for_path(&wide).ok();

        // Outcome only. What the user chose is their own business, and a chosen file's location
        // embeds the Windows user name — neither belongs in a log channel.
        log_app(
            "INFO",
            &format!(
                "[processes] chosen-file icon {}",
                if icon.is_some() { "resolved" } else { "unresolved" }
            ),
        );

        Ok(icon)
    })
    .await
    .map_err(|e| format!("icon worker panicked: {e}"))?
}

/// Non-Windows twin. The guard runs here too, so the contract a caller sees — a refusal for
/// anything that is not an executable — is the same on every platform.
#[cfg(not(windows))]
#[tauri::command]
pub async fn get_process_icon_for_path(path: String) -> Result<Option<String>, String> {
    if !is_local_exe_path(&path) {
        return Err("only an executable file is accepted here".into());
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a synthetic BGRA buffer from `(b, g, r, a)` quadruples.
    fn pixels(quads: &[(u8, u8, u8, u8)]) -> Vec<u8> {
        quads
            .iter()
            .flat_map(|&(b, g, r, a)| [b, g, r, a])
            .collect()
    }

    /// Pitfall 3: GDI DIBs are BGRA and PNG is RGBA. Getting this wrong leaves the icon's SHAPE
    /// perfect while its palette is inverted, which is exactly the kind of defect a human glance
    /// at a 24 px row does not catch.
    #[test]
    fn bgra_to_rgba_swaps_blue_and_red_and_leaves_green_and_alpha_alone() {
        let mut buffer = pixels(&[(10, 20, 30, 40), (200, 100, 50, 255)]);

        bgra_to_rgba(&mut buffer);

        assert_eq!(
            buffer,
            vec![30, 20, 10, 40, 50, 100, 200, 255],
            "only bytes 0 and 2 of each pixel may move; green and alpha are untouched"
        );
    }

    /// Pitfall 2: a legacy icon carries no alpha in its colour bitmap — transparency lives in the
    /// separate 1-bpp AND mask, where a SET bit means transparent. Without this the PNG is the
    /// right size and completely invisible, which on screen looks like the D-03 fallback fired.
    #[test]
    fn alpha_from_mask_makes_set_bits_transparent_and_clear_bits_opaque() {
        // 2x2 icon, alpha bytes all zero as a legacy icon returns them.
        let mut buffer = pixels(&[(1, 1, 1, 0), (2, 2, 2, 0), (3, 3, 3, 0), (4, 4, 4, 0)]);
        // 1-bpp mask, DWORD-aligned: 4 bytes per row. Row 0 = bits 10xxxxxx, row 1 = 01xxxxxx.
        let mask = vec![0b1000_0000, 0, 0, 0, 0b0100_0000, 0, 0, 0];

        alpha_from_mask(&mut buffer, &mask, 2, 2);

        let alphas: Vec<u8> = buffer.chunks_exact(4).map(|px| px[3]).collect();
        assert_eq!(
            alphas,
            vec![0, 255, 255, 0],
            "a set mask bit means transparent (alpha 0); a clear bit means fully opaque"
        );
    }

    /// The other half of pitfall 2: a MODERN 32-bpp icon already carries straight, correct alpha.
    /// Applying the mask to it (or un-premultiplying it) corrupts a perfectly good icon, so the
    /// fallback is guarded on "no alpha anywhere at all", not on "a mask exists".
    #[test]
    fn apply_alpha_fallback_leaves_a_modern_icon_untouched() {
        let mut buffer = pixels(&[(1, 1, 1, 0), (2, 2, 2, 128), (3, 3, 3, 0), (4, 4, 4, 0)]);
        let before = buffer.clone();
        // A mask that would flip every alpha byte if it were ever applied.
        let mask = vec![0b1100_0000, 0, 0, 0, 0b1100_0000, 0, 0, 0];

        apply_alpha_fallback(&mut buffer, &mask, 2, 2);

        assert_eq!(
            buffer, before,
            "one non-zero alpha byte is enough to prove the icon carries real alpha"
        );
    }

    /// D-03 / the batch contract: a protected process failing must not cost its neighbours their
    /// icons, and the frontend keys its cache by the name it asked for — so a dropped failure
    /// would leave that row fetching forever instead of falling back.
    #[test]
    fn collapse_icon_results_keeps_request_order_and_marks_only_the_failures() {
        let names = vec![
            "chrome.exe".to_string(),
            "msmpeng.exe".to_string(),
            "code.exe".to_string(),
        ];
        let resolved = std::collections::BTreeMap::from([
            (
                "chrome.exe".to_string(),
                Ok("data:image/png;base64,AAA".to_string()),
            ),
            (
                "msmpeng.exe".to_string(),
                Err("OpenProcess denied".to_string()),
            ),
            (
                "code.exe".to_string(),
                Ok("data:image/png;base64,BBB".to_string()),
            ),
        ]);

        let collapsed = collapse_icon_results(&names, &resolved);

        assert_eq!(collapsed.len(), 3, "one entry per requested name");
        assert_eq!(collapsed[0].name, "chrome.exe");
        assert_eq!(
            collapsed[0].icon.as_deref(),
            Some("data:image/png;base64,AAA")
        );
        assert_eq!(
            collapsed[1].icon, None,
            "the single failure becomes icon: None and nothing else changes"
        );
        assert_eq!(
            collapsed[2].icon.as_deref(),
            Some("data:image/png;base64,BBB"),
            "a failure in the middle must not shift the entries after it"
        );
    }

    /// A name the resolver never answered for reads as unresolved, not as absent — the frontend
    /// keys its cache by the name it ASKED for, so a missing row would leave it fetching forever.
    #[test]
    fn collapse_icon_results_settles_a_name_the_resolver_never_answered() {
        let names = vec!["chrome.exe".to_string(), "ghost.exe".to_string()];
        let resolved = std::collections::BTreeMap::from([(
            "chrome.exe".to_string(),
            Ok("data:image/png;base64,AAA".to_string()),
        )]);

        let collapsed = collapse_icon_results(&names, &resolved);

        assert_eq!(collapsed.len(), 2);
        assert_eq!(collapsed[1].name, "ghost.exe");
        assert_eq!(collapsed[1].icon, None);
    }

    /// ME-02: one answer serves every spelling of the same program, and the caller still gets one
    /// row per name it asked for. Without the fold, a batch of repeats paid a full
    /// `OpenProcess` + `SHGetFileInfoW` + `GetDIBits` + PNG-encode cycle for each repeat.
    #[test]
    fn collapse_icon_results_serves_every_spelling_from_one_resolved_answer() {
        let names = vec![
            "Chrome.exe".to_string(),
            "chrome.exe".to_string(),
            "CHROME.EXE".to_string(),
        ];
        let resolved = std::collections::BTreeMap::from([(
            "chrome.exe".to_string(),
            Ok("data:image/png;base64,AAA".to_string()),
        )]);

        let collapsed = collapse_icon_results(&names, &resolved);

        assert_eq!(collapsed.len(), 3, "one row per REQUESTED name, still");
        for row in &collapsed {
            assert_eq!(row.icon.as_deref(), Some("data:image/png;base64,AAA"));
        }
        // The spelling the caller used comes back untouched — the fold is a lookup key, never a
        // rewrite of what the frontend holds.
        assert_eq!(collapsed[0].name, "Chrome.exe");
        assert_eq!(collapsed[2].name, "CHROME.EXE");
    }

    #[test]
    fn distinct_lowercased_folds_repeats_and_keeps_first_seen_order() {
        let names = vec![
            "Chrome.exe".to_string(),
            "code.exe".to_string(),
            "chrome.exe".to_string(),
            "CODE.EXE".to_string(),
        ];

        assert_eq!(
            distinct_lowercased(&names),
            vec!["chrome.exe".to_string(), "code.exe".to_string()],
            "two programs named four times are two units of work"
        );
    }

    /// The batch bound is a BACKEND rule, not a frontend courtesy: it must hold whatever the
    /// webview sends. The frontend's own `ICON_BATCH_SIZE` is 32, so a legitimate batch has plenty
    /// of headroom and cannot trip this.
    #[test]
    fn max_icon_batch_leaves_headroom_over_the_frontend_batch_size() {
        assert_eq!(
            MAX_ICON_BATCH, 64,
            "2x the frontend's ICON_BATCH_SIZE — change both together or not at all"
        );
    }

    /// The list path's regression guard. The enumeration now records a PID per name, and the risk
    /// of that change is that the picker starts showing one row per INSTANCE — a browser with a
    /// dozen renderers would flood the list — or starts showing kernel pseudo-processes that can
    /// never resolve to anything.
    #[test]
    fn collect_process_pids_dedups_by_name_keeps_the_first_pid_and_drops_pseudo_processes() {
        let raw = vec![
            ("Chrome.exe".to_string(), 111),
            ("chrome.exe".to_string(), 222),
            ("System".to_string(), 4),
            ("[System Process]".to_string(), 0),
            ("Memory Compression".to_string(), 9),
            ("".to_string(), 77),
            ("code.exe".to_string(), 333),
        ];

        let by_name = collect_process_pids(raw);

        assert_eq!(
            by_name.keys().collect::<Vec<_>>(),
            vec!["chrome.exe", "code.exe"],
            "names are lowercased, deduped, and the pseudo-process skip list still applies"
        );
        assert_eq!(
            by_name["chrome.exe"], 111,
            "the FIRST pid seen for a name wins — it is the earliest-started instance"
        );
    }

    /// The transport end of the pipeline: the frontend puts this string straight into an `<img
    /// src>`, so the prefix is part of the contract, not cosmetic.
    #[test]
    fn encode_png_data_url_produces_a_base64_png_data_url() {
        let rgba = vec![255u8, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255];

        let url = encode_png_data_url(&rgba, 2, 2).expect("a 2x2 RGBA buffer must encode");

        assert!(
            url.starts_with("data:image/png;base64,"),
            "the frontend renders this verbatim as an img src"
        );
        assert!(
            url.len() > "data:image/png;base64,".len(),
            "the payload must actually carry encoded bytes"
        );
    }

    // ── The guard on the ONE path-accepting command ───────────────────────────────────────────
    //
    // This guard is the entire reason a caller-supplied path is acceptable at all, so it is
    // tested directly rather than through the command. It is written as an allow-rule — what a
    // path must LOOK LIKE to be accepted — because a deny-list of forbidden shapes is a list
    // someone has to keep complete forever, and the project's standing rule is whitelist, never
    // blacklist.
    //
    // The first version of this guard constrained ONE axis, the extension, and its tests only ever
    // exercised that axis — which is exactly why a UNC path ending in `.exe` sailed through into
    // `SHGetFileInfoW` and out onto the network (HI-01, phase-24 code review). Every rejected shape
    // below therefore gets its own assertion, so the same blind spot cannot reopen quietly.

    #[test]
    fn is_local_exe_path_accepts_an_executable_in_any_letter_case() {
        assert!(is_local_exe_path("C:\\Program Files\\My Tool\\mytool.exe"));
        assert!(is_local_exe_path("C:\\Program Files\\My Tool\\MyTool.EXE"));
        assert!(is_local_exe_path("C:/Program Files/My Tool/mytool.Exe"));
        assert!(
            is_local_exe_path("d:\\games\\Steam\\steam.exe"),
            "a lower-case drive letter is the same drive"
        );
    }

    #[test]
    fn is_local_exe_path_accepts_the_punctuation_real_program_paths_actually_contain() {
        assert!(is_local_exe_path("C:\\Program Files (x86)\\Steam\\steam.exe"));
        assert!(is_local_exe_path(
            "C:\\Users\\me\\AppData\\Local\\my-app_v2\\my-app.exe"
        ));
        assert!(
            is_local_exe_path("C:\\Users\\Иван\\AppData\\Local\\Программа\\app.exe"),
            "a Cyrillic profile name is an ordinary path for this app's users, not an attack"
        );
    }

    #[test]
    fn is_local_exe_path_rejects_every_non_local_namespace() {
        // The HI-01 defect. `SHGetFileInfoW` touches the filesystem, so each of these is an
        // outbound fetch performed with the logged-in user's credentials — or, for the device
        // namespace, not a file at all. None of them is enumerated as forbidden: they are refused
        // because they are not the accepted `X:\…` shape.
        assert!(
            !is_local_exe_path("\\\\evil.example.com\\s\\a.exe"),
            "a UNC path is an SMB session and an NTLM negotiation with a remote host"
        );
        assert!(
            !is_local_exe_path("\\\\evil.example.com@SSL\\DavWWWRoot\\a.exe"),
            "the WebDAV spelling reaches an attacker-controlled HTTPS server the same way"
        );
        assert!(
            !is_local_exe_path("\\\\.\\pipe\\anything.exe"),
            "a device path names a named pipe, not a file"
        );
        assert!(
            !is_local_exe_path("\\\\?\\C:\\Windows\\notepad.exe"),
            "the extended-length prefix bypasses path normalization"
        );
        assert!(
            !is_local_exe_path("//evil.example.com/s/a.exe"),
            "the forward-slash spelling of UNC is the same request"
        );
        assert!(
            !is_local_exe_path("mytool.exe"),
            "a relative path resolves against a working directory this side does not control"
        );
        assert!(
            !is_local_exe_path("\\Windows\\notepad.exe"),
            "a rooted-but-driveless path is likewise resolved elsewhere"
        );
        assert!(
            !is_local_exe_path("C:mytool.exe"),
            "a drive-relative path has no separator and is not the accepted shape"
        );
    }

    #[test]
    fn is_local_exe_path_rejects_characters_outside_the_whitelist() {
        assert!(
            !is_local_exe_path("C:\\Users\\me\\app.exe:stream.exe"),
            "a colon past the drive prefix opens an NTFS alternate data stream"
        );
        assert!(!is_local_exe_path("C:\\Users\\me\\a*.exe"));
        assert!(!is_local_exe_path("C:\\Users\\me\\a?.exe"));
        assert!(!is_local_exe_path("C:\\Users\\me\\a|b.exe"));
        assert!(!is_local_exe_path("C:\\Users\\me\\a\"b.exe"));
        assert!(
            !is_local_exe_path("C:\\Users\\me\\a\u{7}b.exe"),
            "a control character has no place in a path this side is willing to open"
        );
    }

    #[test]
    fn is_local_exe_path_rejects_a_non_canonical_component() {
        assert!(
            !is_local_exe_path("C:\\Users\\me\\..\\..\\Windows\\notepad.exe"),
            "a path that resolves elsewhere is not the path that was inspected"
        );
        assert!(!is_local_exe_path("C:\\Users\\.\\me\\app.exe"));
        assert!(
            !is_local_exe_path("C:\\Users\\\\me\\app.exe"),
            "a doubled separator is not a canonical path"
        );
    }

    #[test]
    fn is_local_exe_path_rejects_a_trailing_dot_or_space_win32_would_strip() {
        // Same class of bug as the NUL rule: Win32 silently strips trailing dots and spaces from a
        // component, so the string the guard judges and the string the OS opens differ.
        assert!(!is_local_exe_path("C:\\Users\\me\\app.exe "));
        assert!(!is_local_exe_path("C:\\Users\\me\\app.exe."));
        assert!(
            !is_local_exe_path("C:\\Users\\me \\app.exe"),
            "a stripped directory component redirects the whole path"
        );
    }

    #[test]
    fn is_local_exe_path_rejects_anything_that_is_not_an_executable() {
        // The original axis, kept: without it, this command would be an arbitrary-file icon-read
        // primitive over everything the webview can name.
        assert!(!is_local_exe_path("C:\\Windows\\System32\\config\\SAM"));
        assert!(!is_local_exe_path("C:\\Users\\me\\Documents\\secrets.txt"));
        assert!(
            !is_local_exe_path("C:\\Users\\me\\app.exe.txt"),
            "the extension must be the LAST thing in the name, not merely present"
        );
        assert!(
            !is_local_exe_path("C:\\Users\\me\\.exe"),
            "an extension with no file name in front of it is not a program"
        );
        assert!(
            !is_local_exe_path("C:\\Program Files\\App\\"),
            "a directory, even one under a program, is not a file to read an icon from"
        );
        assert!(
            !is_local_exe_path("C:\\"),
            "a bare drive root names no file"
        );
        assert!(!is_local_exe_path(""));
    }

    #[test]
    fn is_local_exe_path_rejects_a_path_carrying_an_interior_nul() {
        // A NUL truncates a wide C string, so `evil.dll\0harmless.exe` would pass a naive suffix
        // check and then be handed to the OS as `evil.dll`. Rejecting it here keeps the string the
        // guard inspected and the string the OS receives the same string.
        assert!(!is_local_exe_path("C:\\Users\\me\\evil.dll\u{0}\\harmless.exe"));
    }

    #[test]
    fn is_local_exe_path_rejects_an_absurdly_long_path() {
        // Bounded before `wide_nul` is asked to build a buffer Windows would refuse anyway.
        let long = format!("C:\\{}\\app.exe", "a".repeat(MAX_PATH_CHARS));
        assert!(!is_local_exe_path(&long));
    }
}
