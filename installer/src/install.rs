use crate::InstallerConfig;
use std::io::{self, Cursor, Read};
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(windows)]
use windows::core::*;
#[cfg(windows)]
use windows::Win32::System::Registry::*;
#[cfg(windows)]
use windows::Win32::UI::Shell::*;
#[cfg(windows)]
use windows::Win32::System::Com::*;

// ─── Payload ──────────────────────────────────────────

/// Payload zip is embedded at compile time via include_bytes!
/// The build script (build_installer.ps1) creates output/payload.zip
/// BEFORE compiling the installer, so this file exists at build time.
const EMBEDDED_PAYLOAD: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/output/payload.zip"));

fn find_payload() -> io::Result<Vec<u8>> {
    Ok(EMBEDDED_PAYLOAD.to_vec())
}

// ─── Previous installation detection ──────────────────

#[cfg(windows)]
pub struct PreviousInstall {
    pub version: String,
    pub install_dir: PathBuf,
    pub is_nsis: bool,
}

#[cfg(windows)]
pub fn detect_previous_install(config: &InstallerConfig) -> Option<PreviousInstall> {
    // Check HKLM (our installer) and HKCU (NSIS per-user install)
    let keys = [
        (HKEY_LOCAL_MACHINE, format!("SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{}", config.product_name)),
        (HKEY_CURRENT_USER, format!("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{}", config.product_name)),
        // Tauri NSIS uses the product name with GUID
        (HKEY_CURRENT_USER, format!("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{}", config.identifier)),
    ];

    for (root, subkey) in &keys {
        if let Some(info) = read_uninstall_key(*root, subkey) {
            return Some(info);
        }
    }
    None
}

#[cfg(windows)]
fn read_uninstall_key(root: HKEY, subkey: &str) -> Option<PreviousInstall> {
    use windows::core::HSTRING;

    unsafe {
        let mut key = HKEY::default();
        let subkey_w = HSTRING::from(subkey);
        let result = RegOpenKeyExW(root, &subkey_w, 0, KEY_READ, &mut key);
        if result.is_err() {
            return None;
        }

        let version = reg_read_string(key, "DisplayVersion").unwrap_or_default();
        let install_dir = reg_read_string(key, "InstallLocation")
            .map(PathBuf::from)
            .unwrap_or_default();
        let uninstall_str = reg_read_string(key, "UninstallString").unwrap_or_default();
        let is_nsis = uninstall_str.to_lowercase().contains("uninstall.exe")
            && !uninstall_str.contains("--uninstall");

        let _ = RegCloseKey(key);

        if install_dir.as_os_str().is_empty() {
            return None;
        }

        Some(PreviousInstall {
            version,
            install_dir,
            is_nsis,
        })
    }
}

#[cfg(windows)]
pub unsafe fn reg_read_string(key: HKEY, name: &str) -> Option<String> {
    use windows::core::HSTRING;

    let name_w = HSTRING::from(name);
    let mut data_type = REG_VALUE_TYPE::default();
    let mut size: u32 = 0;

    let result = RegQueryValueExW(key, &name_w, None, Some(&mut data_type), None, Some(&mut size));
    if result.is_err() || size == 0 {
        return None;
    }

    let mut buf = vec![0u8; size as usize];
    let result = RegQueryValueExW(
        key,
        &name_w,
        None,
        Some(&mut data_type),
        Some(buf.as_mut_ptr()),
        Some(&mut size),
    );
    if result.is_err() {
        return None;
    }

    // REG_SZ: null-terminated UTF-16
    let wide: Vec<u16> = buf
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    let s = String::from_utf16_lossy(&wide);
    Some(s.trim_end_matches('\0').to_string())
}

// ─── Installation ─────────────────────────────────────

pub struct InstallProgress {
    pub current: usize,
    pub total: usize,
    pub file_name: String,
}

/// Perform the full installation. Calls `on_progress` for UI updates.
#[cfg(windows)]
pub fn perform_install(
    config: &InstallerConfig,
    install_dir: &Path,
    create_desktop_shortcut: bool,
    on_progress: impl Fn(InstallProgress),
) -> std::result::Result<(), String> {
    // 1. Kill running processes
    kill_processes(config);

    // 2. Load and extract payload
    let payload = find_payload().map_err(|e| format!("Не удалось найти payload.zip: {}", e))?;
    extract_zip(&payload, install_dir, &on_progress)?;

    // 3. Create shortcuts
    if create_desktop_shortcut {
        let exe_path = install_dir.join(config.exe_name);
        create_shortcut_desktop(&exe_path, config.product_name)?;
    }
    create_shortcut_start_menu(install_dir, config)?;

    // 4. Copy installer as uninstaller
    let uninstaller_path = install_dir.join("uninstall.exe");
    let self_exe = std::env::current_exe().map_err(|e| e.to_string())?;
    std::fs::copy(&self_exe, &uninstaller_path).map_err(|e| format!("Copy uninstaller: {}", e))?;

    // 5. Write registry (Add/Remove Programs)
    write_uninstall_registry(config, install_dir)?;

    // 6. Check/install WebView2
    check_webview2(install_dir)?;

    Ok(())
}

fn kill_processes(config: &InstallerConfig) {
    let _ = Command::new("taskkill")
        .args(["/F", "/IM", config.exe_name])
        .output();
    let _ = Command::new("taskkill")
        .args(["/F", "/IM", config.sidecar_name])
        .output();
    std::thread::sleep(std::time::Duration::from_millis(500));
}

fn extract_zip(
    data: &[u8],
    dest: &Path,
    on_progress: &impl Fn(InstallProgress),
) -> std::result::Result<(), String> {
    let reader = Cursor::new(data);
    let mut archive = zip::ZipArchive::new(reader).map_err(|e| format!("Bad zip: {}", e))?;
    let total = archive.len();

    std::fs::create_dir_all(dest).map_err(|e| format!("Папка '{}': {}", dest.display(), e))?;

    for i in 0..total {
        let mut file = archive.by_index(i).map_err(|e| format!("Zip entry: {}", e))?;
        let name = file.name().replace('/', "\\");

        on_progress(InstallProgress {
            current: i + 1,
            total,
            file_name: name.clone(),
        });

        let out_path = dest.join(&name);

        if file.is_dir() {
            std::fs::create_dir_all(&out_path).ok();
            continue;
        }

        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).ok();
        }

        let mut buf = Vec::new();
        file.read_to_end(&mut buf)
            .map_err(|e| format!("Read zip entry '{}': {}", name, e))?;
        std::fs::write(&out_path, &buf)
            .map_err(|e| format!("Write '{}': {}", out_path.display(), e))?;
    }

    Ok(())
}

// ─── Shortcuts ────────────────────────────────────────

#[cfg(windows)]
fn create_shortcut_desktop(target_exe: &Path, name: &str) -> std::result::Result<(), String> {
    let desktop = get_known_folder_path(FOLDERID_Desktop)?;
    let lnk_path = PathBuf::from(&desktop).join(format!("{}.lnk", name));
    create_shell_link(target_exe, &lnk_path)
}

#[cfg(windows)]
fn create_shortcut_start_menu(install_dir: &Path, config: &InstallerConfig) -> std::result::Result<(), String> {
    let programs = get_known_folder_path(FOLDERID_Programs)?;
    let folder = PathBuf::from(&programs).join(config.product_name);
    std::fs::create_dir_all(&folder).ok();
    let lnk_path = folder.join(format!("{}.lnk", config.product_name));
    let target_exe = install_dir.join(config.exe_name);
    create_shell_link(&target_exe, &lnk_path)
}

#[cfg(windows)]
pub fn get_known_folder_path(folder_id: windows::core::GUID) -> std::result::Result<String, String> {
    unsafe {
        let path = SHGetKnownFolderPath(&folder_id, KNOWN_FOLDER_FLAG::default(), None)
            .map_err(|e| format!("SHGetKnownFolderPath: {}", e))?;
        let result = path.to_string().map_err(|e| format!("Path to string: {}", e))?;
        CoTaskMemFree(Some(path.as_ptr() as *const _));
        // windows crate may wrap PWSTR in quotes — strip them
        Ok(result.trim_matches('"').trim().to_string())
    }
}

#[cfg(windows)]
fn create_shell_link(target: &Path, lnk_path: &Path) -> std::result::Result<(), String> {
    use windows::Win32::System::Com::*;
    use windows::Win32::UI::Shell::*;
    use windows::core::HSTRING;

    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        let shell_link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
            .map_err(|e| format!("CoCreateInstance: {}", e))?;

        let target_str = HSTRING::from(target.to_string_lossy().as_ref());
        shell_link.SetPath(&target_str).map_err(|e| format!("SetPath: {}", e))?;

        if let Some(dir) = target.parent() {
            let dir_str = HSTRING::from(dir.to_string_lossy().as_ref());
            shell_link.SetWorkingDirectory(&dir_str).ok();
        }

        let persist: IPersistFile = shell_link
            .cast()
            .map_err(|e| format!("QueryInterface IPersistFile: {}", e))?;

        let lnk_str = HSTRING::from(lnk_path.to_string_lossy().as_ref());
        persist
            .Save(&lnk_str, true)
            .map_err(|e| format!("Save .lnk: {}", e))?;

        CoUninitialize();
    }
    Ok(())
}

// ─── Registry ─────────────────────────────────────────

#[cfg(windows)]
fn write_uninstall_registry(config: &InstallerConfig, install_dir: &Path) -> std::result::Result<(), String> {
    use windows::core::HSTRING;

    let subkey = format!(
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{}",
        config.product_name
    );

    unsafe {
        let mut key = HKEY::default();
        let subkey_w = HSTRING::from(subkey.as_str());
        let err = RegCreateKeyExW(
            HKEY_LOCAL_MACHINE,
            &subkey_w,
            0,
            None,
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE,
            None,
            &mut key,
            None,
        );
        if err.is_err() {
            return Err(format!("RegCreateKeyEx: {:?}", err));
        }

        let set = |name: &str, value: &str| {
            let name_w = HSTRING::from(name);
            let value_w: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
            let _ = RegSetValueExW(
                key,
                &name_w,
                0,
                REG_SZ,
                Some(unsafe {
                    std::slice::from_raw_parts(value_w.as_ptr() as *const u8, value_w.len() * 2)
                }),
            );
        };

        set("DisplayName", config.product_name);
        set("DisplayVersion", config.version);
        set("Publisher", "TrustTunnel");
        set(
            "UninstallString",
            &format!(
                "\"{}\" --uninstall",
                install_dir.join("uninstall.exe").display()
            ),
        );
        set("InstallLocation", &install_dir.display().to_string());
        set(
            "DisplayIcon",
            &format!("{},0", install_dir.join(config.exe_name).display()),
        );

        // Set NoModify and NoRepair as DWORD
        let no_modify: u32 = 1;
        let name_w = HSTRING::from("NoModify");
        let _ = RegSetValueExW(
            key,
            &name_w,
            0,
            REG_DWORD,
            Some(unsafe {
                std::slice::from_raw_parts(
                    &no_modify as *const u32 as *const u8,
                    std::mem::size_of::<u32>(),
                )
            }),
        );
        let name_w = HSTRING::from("NoRepair");
        let _ = RegSetValueExW(
            key,
            &name_w,
            0,
            REG_DWORD,
            Some(unsafe {
                std::slice::from_raw_parts(
                    &no_modify as *const u32 as *const u8,
                    std::mem::size_of::<u32>(),
                )
            }),
        );

        let _ = RegCloseKey(key);
    }

    Ok(())
}

// ─── WebView2 ─────────────────────────────────────────

fn check_webview2(install_dir: &Path) -> std::result::Result<(), String> {
    // Check if WebView2 runtime is installed
    #[cfg(windows)]
    {
        use windows::core::HSTRING;

        let key_paths = [
            "SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
            "SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        ];

        let mut found = false;
        for path in &key_paths {
            unsafe {
                let mut key = HKEY::default();
                let path_w = HSTRING::from(*path);
                if RegOpenKeyExW(HKEY_LOCAL_MACHINE, &path_w, 0, KEY_READ, &mut key).is_ok() {
                    found = true;
                    let _ = RegCloseKey(key);
                    break;
                }
            }
        }

        if !found {
            // Try to run WebView2 bootstrapper if bundled
            let bootstrapper = install_dir.join("MicrosoftEdgeWebview2Setup.exe");
            if bootstrapper.exists() {
                let _ = Command::new(&bootstrapper)
                    .args(["/silent", "/install"])
                    .status();
            }
        }
    }

    Ok(())
}

/// Default install directory
pub fn default_install_dir(config: &InstallerConfig) -> PathBuf {
    // Use SHGetKnownFolderPath for reliable LocalAppData path
    #[cfg(windows)]
    {
        if let Ok(local) = get_known_folder_path(FOLDERID_LocalAppData) {
            let mut path = PathBuf::from(local.trim());
            path.push(config.product_name);
            return path;
        }
    }
    // Absolute fallback
    let home = std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\Users\\Public".to_string());
    PathBuf::from(home).join("AppData").join("Local").join(config.product_name)
}
