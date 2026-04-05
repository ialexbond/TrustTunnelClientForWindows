use crate::InstallerConfig;
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(windows)]
use windows::core::*;
#[cfg(windows)]
use windows::Win32::System::Registry::*;
#[cfg(windows)]
use windows::Win32::UI::Shell::*;

/// Perform full uninstallation.
#[cfg(windows)]
pub fn perform_uninstall(
    config: &InstallerConfig,
    on_progress: impl Fn(&str),
) -> std::result::Result<(), String> {
    // 1. Find install directory from registry
    let install_dir = find_install_dir(config)?;

    // 2. Kill running processes
    on_progress("Stopping processes...");
    let _ = Command::new("taskkill")
        .args(["/F", "/IM", config.exe_name])
        .output();
    let _ = Command::new("taskkill")
        .args(["/F", "/IM", config.sidecar_name])
        .output();
    std::thread::sleep(std::time::Duration::from_millis(500));

    // 3. Remove desktop shortcut
    on_progress("Removing shortcuts...");
    remove_desktop_shortcut(config.product_name);
    remove_start_menu_shortcut(config.product_name);

    // 4. Clean registry: URL handlers, autostart
    on_progress("Cleaning registry...");
    clean_registry(config);

    // 5. Remove user data files
    on_progress("Removing data...");
    remove_data_files(&install_dir);

    // 6. Remove program files
    on_progress("Removing files...");
    // We can't delete ourselves while running, so schedule deletion
    let self_exe = std::env::current_exe().unwrap_or_default();
    let in_install_dir = self_exe
        .parent()
        .map(|p| p == install_dir)
        .unwrap_or(false);

    // Remove all files except ourselves
    if let Ok(entries) = std::fs::read_dir(&install_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if in_install_dir && path == self_exe {
                continue; // Skip self
            }
            if path.is_dir() {
                let _ = std::fs::remove_dir_all(&path);
            } else {
                let _ = std::fs::remove_file(&path);
            }
        }
    }

    // 7. Remove uninstall registry key
    on_progress("Finishing...");
    remove_uninstall_registry(config);

    // 8. Schedule self-deletion (cmd /c ping + del trick)
    if in_install_dir {
        let install_dir_str = install_dir.display().to_string();
        let self_exe_str = self_exe.display().to_string();
        let _ = Command::new("cmd")
            .args([
                "/C",
                &format!(
                    "ping -n 3 127.0.0.1 >nul && del /f /q \"{}\" && rmdir /s /q \"{}\"",
                    self_exe_str, install_dir_str
                ),
            ])
            .spawn();
    }

    Ok(())
}

#[cfg(windows)]
fn find_install_dir(config: &InstallerConfig) -> std::result::Result<PathBuf, String> {
    // Try to get from registry
    let subkey = format!(
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{}",
        config.product_name
    );

    unsafe {
        let mut key = HKEY::default();
        let subkey_w = HSTRING::from(subkey.as_str());

        // Try HKLM first (our installer), then HKCU (NSIS)
        for root in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
            if RegOpenKeyExW(root, &subkey_w, 0, KEY_READ, &mut key).is_ok() {
                if let Some(dir) = crate::install::reg_read_string(key, "InstallLocation") {
                    let _ = RegCloseKey(key);
                    if !dir.is_empty() {
                        return Ok(PathBuf::from(dir));
                    }
                }
                let _ = RegCloseKey(key);
            }
        }
    }

    // Fallback: assume we're in the install directory
    let self_exe = std::env::current_exe().map_err(|e| e.to_string())?;
    self_exe
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "Cannot determine install directory".to_string())
}

#[cfg(windows)]
fn remove_desktop_shortcut(product_name: &str) {
    if let Ok(desktop) = crate::install::get_known_folder_path(FOLDERID_Desktop) {
        let lnk = PathBuf::from(&desktop).join(format!("{}.lnk", product_name));
        let _ = std::fs::remove_file(lnk);
    }
}

#[cfg(windows)]
fn remove_start_menu_shortcut(product_name: &str) {
    if let Ok(programs) = crate::install::get_known_folder_path(FOLDERID_Programs) {
        let folder = PathBuf::from(&programs).join(product_name);
        let _ = std::fs::remove_dir_all(folder);
    }
}

#[cfg(windows)]
fn clean_registry(_config: &InstallerConfig) {
    unsafe {
        // Remove URL protocol handlers
        for proto in ["trusttunnel", "tt"] {
            let key = HSTRING::from(format!("Software\\Classes\\{}", proto));
            let _ = RegDeleteTreeW(HKEY_CURRENT_USER, &key);
        }

        // Remove autostart entries
        let run_key = HSTRING::from("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
        let mut key = HKEY::default();
        if RegOpenKeyExW(HKEY_CURRENT_USER, &run_key, 0, KEY_WRITE, &mut key).is_ok() {
            for name in [
                "TrustTunnel",
                "TrustTunnel Client Pro",
                "TrustTunnel Client Light",
                "trusttunnel",
                "trusttunnel-light",
            ] {
                let name_w = HSTRING::from(name);
                let _ = RegDeleteValueW(key, &name_w);
            }
            let _ = RegCloseKey(key);
        }
    }
}

fn remove_data_files(install_dir: &Path) {
    // Config files
    let files = [
        "trusttunnel_client.toml",
        "routing_rules.json",
        "exclusions.json",
        "active_groups.json",
        "connection_history.json",
        "ssh_credentials.json",
        "known_hosts.json",
        ".sidecar.pid",
        ".start_minimized",
        ".pending_deeplink",
        "trusttunnel_setup.exe",
        "trusttunnel_update.zip",
    ];
    for f in &files {
        let _ = std::fs::remove_file(install_dir.join(f));
    }

    // Data directories
    let dirs = ["webview_data", "geodata", "resolved", "group_cache"];
    for d in &dirs {
        let _ = std::fs::remove_dir_all(install_dir.join(d));
    }
}

#[cfg(windows)]
fn remove_uninstall_registry(config: &InstallerConfig) {
    let subkey = format!(
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{}",
        config.product_name
    );

    unsafe {
        // Remove from HKLM (our installer)
        let key = HSTRING::from(subkey.as_str());
        let _ = RegDeleteTreeW(HKEY_LOCAL_MACHINE, &key);

        // Also clean HKCU (NSIS leftover)
        let _ = RegDeleteTreeW(HKEY_CURRENT_USER, &key);

        // Clean by identifier too (Tauri NSIS format)
        let id_key = HSTRING::from(format!(
            "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{}",
            config.identifier
        ));
        let _ = RegDeleteTreeW(HKEY_CURRENT_USER, &id_key);
    }
}
