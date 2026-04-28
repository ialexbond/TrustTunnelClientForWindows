/**
 * Phase 15.1 D-2.3 + REQ-15.8 — rules.toml frontend-side ownership merge.
 *
 * rules.toml = single TOML file shared между двумя UI tabs:
 *   Configuration tab owns: [[rule]] entries with `cidr` field (manual access control)
 *   Users tab (Phase 14.1) owns: [[rule]] entries with `client_random_prefix` field (anti-DPI per-user)
 *
 * Phase 15.1 save flow:
 *   1. Read FRESH rules.toml via server_get_config_bundle (не cached!)
 *   2. Parse via smol-toml
 *   3. Split fresh entries by ownership predicates
 *   4. Replace Configuration-owned entries with new edits
 *   5. Preserve Users-owned entries unchanged
 *   6. Stringify merged → raw_content
 *   7. Send to backend via server_save_config_file
 *
 * Backend emits Tauri event `rules-toml-changed` after successful write
 * (Plan 15.1-01 implementation) — Users tab subscribes via useRulesTomlChanged
 * to invalidate its cache.
 */

/** Single [[rule]] entry в rules.toml. Fields per upstream CONFIGURATION.md. */
export interface RuleEntry {
  cidr?: string;
  client_random_prefix?: string;
  action?: "allow" | "deny";
  // Forward-compat: any other fields preserved
  [key: string]: unknown;
}

/**
 * Predicate: entry is Users-owned if it has client_random_prefix field.
 * Phase 14.1 server_add_user_advanced писал в rules.toml client_random_prefix per-user.
 */
export function isUsersOwned(entry: RuleEntry): boolean {
  return typeof entry.client_random_prefix === "string" && entry.client_random_prefix.length > 0;
}

/**
 * Predicate: entry is Configuration-owned if it has cidr field but no client_random_prefix.
 */
export function isConfigOwned(entry: RuleEntry): boolean {
  return typeof entry.cidr === "string" && entry.cidr.length > 0 && !isUsersOwned(entry);
}

/**
 * Split fresh rules entries by ownership.
 * Returns { configOwned, usersOwned, other } — `other` covers edge case entries
 * with neither cidr nor client_random_prefix (preserve as-is).
 */
export function splitRulesByOwnership(entries: RuleEntry[]): {
  configOwned: RuleEntry[];
  usersOwned: RuleEntry[];
  other: RuleEntry[];
} {
  const configOwned: RuleEntry[] = [];
  const usersOwned: RuleEntry[] = [];
  const other: RuleEntry[] = [];
  for (const entry of entries) {
    if (isUsersOwned(entry)) {
      usersOwned.push(entry);
    } else if (isConfigOwned(entry)) {
      configOwned.push(entry);
    } else {
      other.push(entry);
    }
  }
  return { configOwned, usersOwned, other };
}

/**
 * Merge: combine Users-owned (preserved) + new Configuration-owned + other entries.
 * Order: Users-owned first (per D-2.3 implementation note), then Configuration-owned, then other.
 */
export function mergeRulesEntries(
  usersOwned: RuleEntry[],
  newConfigOwned: RuleEntry[],
  other: RuleEntry[] = [],
): RuleEntry[] {
  return [...usersOwned, ...newConfigOwned, ...other];
}
