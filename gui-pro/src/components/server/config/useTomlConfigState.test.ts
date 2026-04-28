import { describe, it } from "vitest";

/**
 * Phase 15.1 — Wave 0 stub. Realised in Plan 15.1-04.
 *
 * Will cover:
 *   REQ-15.8: rules.toml frontend pre-merge preserves Users-owned
 *             client_random_prefix entries
 *   REQ-15.8: rules.toml merge: Configuration owns cidr-based;
 *             Users owns client_random_prefix
 *   D-29: bundle does NOT log raw credentials.toml passwords к activity.log
 *   WR-03: cancelledRef pattern guards stale data overwrite during in-flight invoke
 *   D-8.1: stop-on-first-failure save batch — fail на N-м stops; files 1..N-1
 *          уже на диске
 *   Pitfall 4: loadBundle uses single SSH channel via server_get_config_bundle
 *   D-6.1: buildFileSchemaTree second pass adds isExplicit=false synthetic
 *          schemas for defaults-only fields
 *   D-6.1: ConfigurationTab showAll toggle reveals isExplicit=false fields
 *          after toggle ON
 */
describe("useTomlConfigState", () => {
  it.todo("rules.toml merge preserves Users-owned client_random_prefix entries (REQ-15.8)");
  it.todo("rules.toml merge: Config owns cidr-based, Users owns client_random_prefix (REQ-15.8)");
  it.todo("activity.log never receives raw credentials.toml content (D-29)");
  it.todo("cancelledRef guards stale invoke result (WR-03)");
  it.todo("save batch stop-on-first-failure (D-8.1)");
  it.todo("loadBundle uses single SSH channel via server_get_config_bundle (Pitfall 4)");
  it.todo("D-6.1: buildFileSchemaTree adds isExplicit=false synthetic schemas for defaults-only fields");
  it.todo("D-6.1: ConfigurationTab showAll toggle reveals isExplicit=false fields after toggle ON");
});
