/**
 * Phase 15.1 — Schema data barrel.
 *
 * Aggregate constants для useTomlConfigState consumption (Plan 15.1-04):
 *   DEFAULTS_MAPS — keyed by `ConfigFileName | "credentials"`
 *   DISRUPT_SETS  — keyed by same
 *
 * Cross-tab ownership data (Plan 15.1-04 rules-merge.ts):
 *   CONFIGURATION_OWNED_RULE_FIELDS / USERS_OWNED_RULE_FIELDS / CROSS_TAB_FILES
 *
 * No code logic in this barrel — pure data re-exports + aggregates.
 */
import type { ConfigFileName, DefaultsMap } from "../types";

import { CREDENTIALS_DEFAULTS } from "./credentials.defaults";
import { HOSTS_DEFAULTS } from "./hosts.defaults";
import { RULES_DEFAULTS } from "./rules.defaults";
import { VPN_DEFAULTS } from "./vpn.defaults";

// ─── Per-file defaults map re-exports ────────────────────────────────────────
export { CREDENTIALS_DEFAULTS, HOSTS_DEFAULTS, RULES_DEFAULTS, VPN_DEFAULTS };

// ─── Disrupt-high sets re-exports ────────────────────────────────────────────
export {
  CREDENTIALS_DISRUPT_HIGH,
  DISRUPT_SETS,
  HOSTS_DISRUPT_HIGH,
  RULES_DISRUPT_HIGH,
  VPN_DISRUPT_HIGH,
} from "./disrupt-fields";

// ─── Cross-tab ownership data re-exports ─────────────────────────────────────
export {
  CONFIGURATION_OWNED_RULE_FIELDS,
  CROSS_TAB_FILES,
  USERS_OWNED_RULE_FIELDS,
} from "./owned-rule-fields";

/**
 * Aggregate defaults map for useTomlConfigState `options.defaultsMaps` prop.
 *
 * Keyed by ConfigFileName + "credentials" — credentials.toml has a defaults
 * map (для read-only preview type detection per D-2.1) даже хотя backend
 * rejects writes на этот файл.
 */
export const DEFAULTS_MAPS: Record<ConfigFileName | "credentials", DefaultsMap> = {
  vpn: VPN_DEFAULTS,
  hosts: HOSTS_DEFAULTS,
  rules: RULES_DEFAULTS,
  credentials: CREDENTIALS_DEFAULTS,
};
