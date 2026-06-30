pub mod vpn;
pub mod ssh_commands;
pub mod config;
pub mod network;
pub mod geoip;
pub mod updater;
pub mod history;
pub mod deeplink;
pub mod protocol;
pub mod activity_log;
pub mod manifest;
pub mod ping;
pub mod paths;

// Re-export items used directly by lib.rs (tray handlers, run() setup)
pub use vpn::{AppState, begin_shutdown, kill_sidecar_from_state, kill_stale_sidecar};
