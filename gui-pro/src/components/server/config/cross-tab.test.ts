import { describe, it } from "vitest";

/**
 * Phase 15.1 — Wave 0 stub. Realised in Plan 15.1-04.
 *
 * Will cover REQ-15.8 cross-tab cache invalidation pattern:
 *   - useRulesTomlChanged hook subscribes via @tauri-apps/api/event listen()
 *   - Hook callback fires when payload.file === "rules.toml"
 *   - Cleanup unsubscribes on unmount
 *   - Users tab cache invalidated upon event reception
 */
describe("cross-tab rules-toml-changed event", () => {
  it.todo("useRulesTomlChanged subscribes to listen() on mount (REQ-15.8)");
  it.todo("callback fires когда payload.file === 'rules.toml' (REQ-15.8)");
  it.todo("listen() unsubscribed on unmount (REQ-15.8)");
});
