#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod gui;
mod install;
mod uninstall;

use std::env;

/// Installer configuration — set at build time via build script.
/// The payload zip is embedded as `PAYLOAD.zip` next to the installer exe,
/// or baked into the binary via include_bytes! in release builds.
pub struct InstallerConfig {
    pub product_name: &'static str,
    pub version: &'static str,
    pub exe_name: &'static str,
    pub sidecar_name: &'static str,
    pub identifier: &'static str,
}

/// Detect which edition to install based on exe name.
fn detect_edition() -> InstallerConfig {
    let exe = env::current_exe().unwrap_or_default();
    let name = exe
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();

    if name.contains("light") {
        InstallerConfig {
            product_name: "TrustTunnel Client Light",
            version: "2.2.0",
            exe_name: "TrustTunnel Client Light.exe",
            sidecar_name: "trusttunnel_client.exe",
            identifier: "com.trusttunnel.light",
        }
    } else {
        InstallerConfig {
            product_name: "TrustTunnel Client Pro",
            version: "2.2.0",
            exe_name: "TrustTunnel Client Pro.exe",
            sidecar_name: "trusttunnel_client.exe",
            identifier: "com.trusttunnel.gui",
        }
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let config = detect_edition();

    if args.iter().any(|a| a == "--uninstall") {
        gui::run_uninstaller(&config);
    } else {
        gui::run_installer(&config);
    }
}
