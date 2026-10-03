/**
 * Phase 15.1 D-2.3 + REQ-15.8 — Cross-tab ownership documentation.
 *
 * rules.toml = single TOML file shared между двумя UI tabs:
 *   Configuration tab (Phase 15.1) owns: [[rule]] entries with `cidr` field
 *   Users tab (Phase 14.1) owns: [[rule]] entries with `client_random_prefix` field
 *
 * Implementation in rules-merge.ts (Plan 15.1-04):
 *   - splitRulesByOwnership separates by predicate
 *   - mergeRulesEntries preserves Users-owned entries on Configuration save
 *   - Backend Plan 15.1-01 emits `rules-toml-changed` event для cross-tab cache invalidation
 *
 * This file documents ownership invariants as data — code lives in rules-merge.ts.
 *
 * Sync notice: ownership rules anchored to Phase 14.1 anti-DPI design.
 * Re-evaluate if upstream rule schema changes.
 */

/**
 * Configuration tab владеет [[rule]] entries with these fields.
 *
 * Predicate: `(rule) => rule.cidr !== undefined`. На save Configuration перезаписывает
 * только entries c этим shape.
 */
export const CONFIGURATION_OWNED_RULE_FIELDS = ["cidr"] as const;

/**
 * Users tab владеет [[rule]] entries with these fields.
 *
 * Predicate: `(rule) => rule.client_random_prefix !== undefined`. Configuration
 * tab preserves these on save (frontend pre-merge — D-2.3).
 */
export const USERS_OWNED_RULE_FIELDS = ["client_random_prefix"] as const;

/**
 * Set of file names whose changes emit a `rules-toml-changed`-style event для
 * cross-tab cache invalidation. Currently only "rules"; extension point if
 * other shared files appear in future phases.
 */
export const CROSS_TAB_FILES = ["rules"] as const;
