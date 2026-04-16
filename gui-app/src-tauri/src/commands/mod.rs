pub mod vpn;
pub mod ssh_commands;
pub mod config;
pub mod network;
pub mod updater;
pub mod history;
pub mod deeplink;
pub mod protocol;
pub mod activity_log;

// Re-export items used directly by lib.rs (tray handlers, run() setup)
pub use vpn::{AppState, kill_sidecar_from_state, kill_stale_sidecar};
