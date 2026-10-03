import type { DefaultsMap } from "../types";

/**
 * Phase 15.1 D-6.2 — rules.toml static defaults map.
 *
 * [[rule]] schema:
 *   cidr (string, optional) — Configuration tab owns (D-2.3 manual access control)
 *   client_random_prefix (string, optional) — Users tab owns (Phase 14.1 anti-DPI per-user)
 *   action (string, required, "allow" | "deny")
 *
 * Default empty rule entry: action="allow" (most permissive default), cidr="" / prefix=""
 * для type detection в schema-builder.
 *
 * Sync notice: derived from upstream CONFIGURATION.md as of 2026-04-28.
 * Manual review required at upgrade.
 */
export const RULES_DEFAULTS: DefaultsMap = {
  "rule": [],
  "rule.cidr": "",
  "rule.client_random_prefix": "",
  "rule.action": "allow",
};
