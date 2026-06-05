import { vi, expect, type Mock } from "vitest";

/**
 * D-29 activity-log spy helper (Phase 3 safety-net, Wave 0).
 *
 * D-29 invariant (memory/security-posture.md §D-29): a credential-touching
 * surface must NEVER write a secret into the activity-log channel. Today each
 * test re-declares an anonymous `vi.fn()` and walks its calls by hand — and
 * UserModal's D-29 path is left unguarded entirely (RESEARCH §4.2 / §6.5).
 *
 * This module gives every stream ONE named spy plus a reusable absence-assertion
 * so the invariant is proven the same way everywhere — and the spy has a name in
 * failure output instead of "spy".
 *
 * ── Usage ──
 * Because `vi.mock` is hoisted and needs a literal module path, the consuming
 * test still writes the one-line mock at top level, but reuses THIS named spy:
 *
 *   import { activityLogSpy, expectNoSecretLogged } from "../../test/fixtures";
 *   vi.mock("../../shared/hooks/useActivityLog", () => ({
 *     useActivityLog: () => ({ log: activityLogSpy }),
 *   }));
 *   // ...render the credential surface...
 *   expectNoSecretLogged("TOPSECRET123");
 *
 * `installActivityLogSpy()` resets the spy (call in beforeEach) and returns the
 * spy + assertion bundle for streams that prefer a local handle.
 */

/**
 * NAMED spy (not anonymous) — shows as `activityLogSpy` in assertion failures.
 * Streams wire it into `useActivityLog` via the top-level `vi.mock` shown above.
 */
export const activityLogSpy: Mock = vi.fn();

/**
 * Assert that NO recorded log call carried `secret` as a substring of any
 * string argument. Walks every call + every string arg. The probe secret is
 * asserted ABSENT — it is never printed by this helper (printing it would
 * itself violate D-29).
 */
export function expectNoSecretLogged(secret: string): void {
  for (const call of activityLogSpy.mock.calls) {
    for (const arg of call) {
      if (typeof arg === "string") {
        expect(arg).not.toContain(secret);
      }
    }
  }
}

export interface ActivityLogSpyHandle {
  /** The shared named spy (same reference as the module export). */
  spy: Mock;
  /** Absence assertion bound to this spy. */
  expectNoSecretLogged: (secret: string) => void;
}

/**
 * Reset the shared spy (drops prior calls) and return a handle. Call in
 * `beforeEach` so each test starts with a clean call history.
 */
export function installActivityLogSpy(): ActivityLogSpyHandle {
  activityLogSpy.mockReset();
  return { spy: activityLogSpy, expectNoSecretLogged };
}
