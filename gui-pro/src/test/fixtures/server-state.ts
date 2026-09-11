import { vi } from "vitest";
import type { ServerState } from "../../components/server/useServerState";

/**
 * Shared `makeState()` ServerState factory (Phase 3 safety-net, Wave 0).
 *
 * Lifted from the in-file factory that previously lived inside
 * OverviewSection.test.tsx so the seven parallel Wave-1 per-surface plans can
 * import ONE factory instead of each re-declaring its own — the worktree
 * merge-conflict landmine called out in RESEARCH §4.1 / §6.2.
 *
 * Defaults mirror the OverviewSection.test.tsx factory verbatim, EXTENDED with
 * two fields the panel-integration / cert streams need (RESEARCH §3 stream 1 +
 * §4.1):
 *   - `certRaw: null`               — preloaded cert payload slot (CertSection /
 *                                     CertModal read `state.certRaw`)
 *   - `loadServerInfo: vi.fn()`     — async refresh callback streams assert on
 *
 * Every other default value is identical to the original factory, so a test
 * that switches from its local `makeState` to this shared one observes no
 * behavioral change. Overrides are shallow-merged last (partial-override
 * convention from TESTING.md §State factory pattern).
 *
 * The cast to `ServerState` is intentional: ServerState is a large hook return
 * type with ~40 fields; tests only populate the subset each surface reads. The
 * `as unknown as ServerState` keeps the factory honest about that while still
 * giving call-sites the real type for autocomplete + override typing.
 */
export function makeState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    serverInfo: {
      installed: true,
      version: "1.0.20",
      serviceActive: true,
      users: ["user1", "user2"],
      protocol: "WireGuard",
      listenPort: 51820,
    } as ServerState["serverInfo"],
    // R2-F08 (Plan 09-37): default to a settled/loaded state — existing tests
    // model a fully loaded panel, so users are "known" (the loading sentinel is
    // exercised explicitly by the R2-F08 tests that override this to false).
    usersKnown: true,
    actionLoading: null,
    sshParams: { host: "10.0.0.1", port: 22, user: "root", password: "pass" },
    runAction: vi.fn(),
    loadServerInfo: vi.fn().mockResolvedValue(undefined),
    rebooting: false,
    setRebooting: vi.fn(),
    host: "10.0.0.1",
    setServerInfo: vi.fn(),
    pushSuccess: vi.fn(),
    // ── Phase 3 extension: cert payload slot (default null) ──
    // CertSection / CertModal read `state.certRaw` (and `state.setCertRaw`).
    // Default null mirrors the real hook's initial cert state so existing
    // OverviewSection callers (which never touched certRaw) stay green.
    certRaw: null,
    setCertRaw: vi.fn(),
    ...overrides,
  } as unknown as ServerState;
}
