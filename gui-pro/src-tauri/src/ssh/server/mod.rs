mod server_bbr;
mod server_benchmark;
mod server_config;
mod server_hosts;
mod server_install;
mod server_lifecycle;
mod server_monitoring;
mod server_mtproto;
pub mod server_rules;
pub mod server_ssh_key;
mod server_security;
// Phase 18 — UN-2 pre-install server snapshot (Plan 18-01, D-04): captured before the
// first install mutation; the uninstall side reads it to prove "ours vs the admin's".
pub(crate) mod snapshot;
// Phase 18 — atomic-swap sidecar update pipeline (Plan 18-05, REQ-18-UPDATE-FLOW-03..07)
mod server_update;
mod server_uptime;
mod server_version;
pub mod cert_probe;
pub mod tlv_encoder;
pub mod users_advanced;

pub use server_bbr::*;
pub use server_benchmark::*;
pub use server_config::*;
pub use server_hosts::*;
pub use server_install::*;
pub use server_lifecycle::*;
pub use server_monitoring::*;
pub use server_mtproto::*;
// Phase 18 — Plan 18-05 (server_update.rs) re-exports follow at module bottom.
pub use server_update::{update_sidecar, update_sidecar_cancel, BackupStatus, UpdateStep};
pub use server_security::*;
pub use server_uptime::*;
pub use server_version::*;
pub use server_rules::{add_user_rule, remove_user_rule, find_user_rule, UserRule};
pub use cert_probe::{decode_cert_der_b64, fetch_endpoint_cert, EndpointCertInfo};
pub use tlv_encoder::append_missing_tlvs;
pub use users_advanced::{
    get_user_advanced, list_user_advanced, upsert_user_advanced, delete_user_advanced,
    reconcile_users_advanced, UserAdvanced,
};
