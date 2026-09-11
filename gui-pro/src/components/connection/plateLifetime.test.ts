// Phase 13 / Plan 13-02 (Wave 1) — GREEN fake-timer tests for the plate-lifetime timer policy.
//
// The 3 `it` names are inherited VERBATIM from the Wave-0 (13-01) `it.todo` scaffold. They drive
// the PURE `plateLifetime` policy through the tiny `makePlateTimer` harness below: `vi.useFakeTimers()`
// installs a controllable clock, the harness arms a real `setTimeout` from the policy's value, and
// `advanceTimersByTime` steps the clock past (or short of) the auto-dismiss band. No backend and no
// wall-clock waiting are involved, so each assertion is deterministic — proving:
//   - D-02: `connectionError` is sticky (no dismiss ever fires),
//   - D-02: success/neutral kinds auto-dismiss inside the 4–5s band,
//   - D-03: applying a NEW kind's policy restarts the timer from the fresh value (the reducer/reset
//     itself lands in Wave 2; here we assert the pure policy yields a fresh timer value).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { plateLifetime, AUTO_DISMISS_MS } from "./plateLifetime";
import type { NotifyKind } from "./notificationCopy";

/** Minimal call-site model of the Wave-2 timer: arm from a kind's policy, clearing any running
 *  timeout first (this IS the D-03 replace-resets-timer behaviour the real notification.tsx runs). */
function makePlateTimer(onDismiss: () => void) {
  let handle: ReturnType<typeof setTimeout> | null = null;
  return {
    /** Apply a kind: sticky → clear + no timer; otherwise (re)start from `autoDismissMs`. */
    show(kind: NotifyKind) {
      if (handle !== null) {
        clearTimeout(handle);
        handle = null;
      }
      const policy = plateLifetime(kind);
      if (!policy.sticky && policy.autoDismissMs !== undefined) {
        handle = setTimeout(onDismiss, policy.autoDismissMs);
      }
    },
  };
}

describe("plateLifetime", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("connectionError is sticky (no auto-dismiss) (D-02)", () => {
    // Pure policy: an error carries no timer.
    expect(plateLifetime("connectionError")).toEqual({ sticky: true });

    // Behavioural: no dismiss fires even after well past the auto-dismiss band (6s).
    const onDismiss = vi.fn();
    const timer = makePlateTimer(onDismiss);
    timer.show("connectionError");
    vi.advanceTimersByTime(6000);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("success/neutral kinds auto-dismiss within the 4–5s band (D-02)", () => {
    // Pure policy: every non-error kind dismisses in 4000–5000 ms. 13-10: the `switching` START kind
    // is non-sticky and shares the same auto-dismiss band, so a slow switch's start plate fades and the
    // terminal «Переключено автоматически» replaces it (D-03).
    for (const kind of ["connected", "reconnecting", "recovering", "autoSwitched", "autoConnected", "disconnected", "switching"] as const) {
      const policy = plateLifetime(kind);
      expect(policy.sticky).toBe(false);
      expect(policy.autoDismissMs).toBeGreaterThanOrEqual(4000);
      expect(policy.autoDismissMs).toBeLessThanOrEqual(5000);
    }

    // Behavioural: the dismiss fires once, right at AUTO_DISMISS_MS — not before.
    const onDismiss = vi.fn();
    const timer = makePlateTimer(onDismiss);
    timer.show("connected");
    vi.advanceTimersByTime(AUTO_DISMISS_MS - 1);
    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("a replace resets the running dismiss timer (D-03)", () => {
    const onDismiss = vi.fn();
    const timer = makePlateTimer(onDismiss);

    // Show a success plate, let it run PART-way (just under the deadline)…
    timer.show("connected");
    vi.advanceTimersByTime(AUTO_DISMISS_MS - 500);
    expect(onDismiss).not.toHaveBeenCalled();

    // …then replace it with a fresh kind. The old timer must NOT fire at its original deadline;
    // the new full window starts over from AUTO_DISMISS_MS measured from THIS moment.
    timer.show("reconnecting");
    vi.advanceTimersByTime(500); // reaches the ORIGINAL timer's deadline — it must not fire.
    expect(onDismiss).not.toHaveBeenCalled();

    // The replacement fires only after its OWN full window elapses (AUTO_DISMISS_MS from the
    // replace). We are now 500 ms into that window, so advance the remaining (AUTO_DISMISS_MS - 500)
    // to just cross it.
    vi.advanceTimersByTime(AUTO_DISMISS_MS - 500 - 1);
    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
