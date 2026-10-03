import type { DefaultsMap } from "../types";

/**
 * Phase 15.1 D-6.2 — hosts.toml static defaults map.
 *
 * 4 array-of-tables: main_hosts, ping_hosts, speedtest_hosts, reverse_proxy_hosts.
 * Each entry: hostname (FQDN), cert_chain_path (path to TLS chain.pem),
 * private_key_path (path to TLS key.pem). main_hosts also supports `allowed_sni`
 * (REQ-15.A — Phase 14.1 anti-DPI per-host SNI list).
 *
 * Defaults для empty entry on add (Plan 15.1-03 ArrayOfTablesBlock onAdd uses these).
 *
 * Sync notice: derived from upstream CONFIGURATION.md as of 2026-04-28.
 * Manual review required at upgrade.
 */
export const HOSTS_DEFAULTS: DefaultsMap = {
  // ─── main_hosts entries default shape ────────────────────────────────────
  "main_hosts": [],
  "main_hosts.hostname": "",
  "main_hosts.cert_chain_path": "",
  "main_hosts.private_key_path": "",
  "main_hosts.allowed_sni": [],

  // ─── ping_hosts entries default shape ────────────────────────────────────
  "ping_hosts": [],
  "ping_hosts.hostname": "",
  "ping_hosts.cert_chain_path": "",
  "ping_hosts.private_key_path": "",

  // ─── speedtest_hosts entries default shape ───────────────────────────────
  "speedtest_hosts": [],
  "speedtest_hosts.hostname": "",
  "speedtest_hosts.cert_chain_path": "",
  "speedtest_hosts.private_key_path": "",

  // ─── reverse_proxy_hosts entries default shape ───────────────────────────
  "reverse_proxy_hosts": [],
  "reverse_proxy_hosts.hostname": "",
  "reverse_proxy_hosts.cert_chain_path": "",
  "reverse_proxy_hosts.private_key_path": "",
};
