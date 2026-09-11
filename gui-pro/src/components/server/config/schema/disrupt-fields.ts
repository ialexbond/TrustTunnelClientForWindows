import type { ConfigFileName, DisruptSet } from "../types";

/**
 * Phase 15.1 D-4.4 — Static disrupt-high fields map.
 *
 * "Disrupt-high" = changing this field disconnects active VPN users.
 * UI shows footer warning «Эти изменения отключат активных пользователей VPN»
 * if any dirty field intersects this set.
 *
 * Sources:
 *   - listen_address change → service rebinds, all active TCP/UDP sessions drop
 *   - ipv6_available toggle → adapter reconfigure, active sessions drop
 *   - main_hosts cert_chain_path / private_key_path / hostname → TLS handshake renegotiation
 *
 * Other paths considered НЕ disrupt-high (e.g. timeouts can be tuned hot, log_level safe,
 * speedtest/ping toggles drop only those endpoints).
 *
 * Conservative posture: over-warn rather than under-warn (T-15.1-24 mitigation).
 *
 * Sync notice: aligned с upstream CONFIGURATION.md as of 2026-04-28.
 * Manual review required at upgrade.
 */

/** vpn.toml fields whose change disconnects active VPN users. */
export const VPN_DISRUPT_HIGH: DisruptSet = new Set<string>([
  "listen_address",
  "ipv6_available",
]);

/** hosts.toml fields whose change disconnects active VPN users. */
export const HOSTS_DISRUPT_HIGH: DisruptSet = new Set<string>([
  "main_hosts.hostname",
  "main_hosts.cert_chain_path",
  "main_hosts.private_key_path",
]);

/**
 * rules.toml — empty by design.
 *
 * Backend re-evaluates rule list per-connection (NOT per-restart), so adding
 * or removing rules никогда не disconnects existing sessions; new sessions
 * see the updated list immediately.
 */
export const RULES_DISRUPT_HIGH: DisruptSet = new Set<string>([
  // intentionally empty — see header
]);

/**
 * credentials.toml — empty by design.
 *
 * D-2.1 makes credentials.toml read-only в Configuration tab; the file never
 * reaches the save flow from this UI. Empty set documents intent.
 */
export const CREDENTIALS_DISRUPT_HIGH: DisruptSet = new Set<string>([
  // intentionally empty — see header
]);

/**
 * Aggregate: file → disrupt set, consumed by useTomlConfigState.options.disruptSets
 * (Plan 15.1-04). Keyed by `ConfigFileName | "credentials"` to also cover
 * the read-only preview file even though its set is empty.
 */
export const DISRUPT_SETS: Record<ConfigFileName | "credentials", DisruptSet> = {
  vpn: VPN_DISRUPT_HIGH,
  hosts: HOSTS_DISRUPT_HIGH,
  rules: RULES_DISRUPT_HIGH,
  credentials: CREDENTIALS_DISRUPT_HIGH,
};
