// Phase 13 / Plan 13-02 (Wave 1) — the pure timer policy for the connection notification plate.
//
// `plateLifetime(kind)` returns WHETHER a kind sticks and, if not, HOW LONG it lives before auto-
// dismiss. It is a PURE function (no timers, no state) — mirroring the `decideAutoSwitch` shape —
// so the whole D-02/D-03 policy is unit-testable with `vi.useFakeTimers` at the call site exactly
// like `useAutoSwitch.test.ts`. The actual `setTimeout`/`clearTimeout` (and the D-03 replace-resets-
// timer behaviour) lands at the Wave-2 `notification.tsx` call site, which clears the running
// timeout and restarts it from the new kind's policy on every fresh `notify-plate`.
import type { NotifyKind } from "./notificationCopy";

/** The lifetime decision for one plate render. `sticky` kinds carry no `autoDismissMs` (they wait
 *  for an explicit close — D-02); every other kind auto-dismisses after `autoDismissMs`. */
export interface PlateLifetime {
  /** True → the plate stays until the user closes it (no auto-dismiss timer). */
  sticky: boolean;
  /** Milliseconds before auto-dismiss. Present iff `sticky` is false. */
  autoDismissMs?: number;
}

/** Auto-dismiss duration for the non-sticky kinds (D-02: "success/neutral ~4–5s"). 4500 ms sits in
 *  the middle of the 4–5s band (Claude's Discretion within the plan's stated range). */
export const AUTO_DISMISS_MS = 4500;

/** Pure D-02 timer policy: `connectionError` is sticky (an error the user must acknowledge — no
 *  timer); every other kind auto-dismisses after `AUTO_DISMISS_MS`. Keeping this pure lets the
 *  Wave-2 call site enforce D-03 (a replace clears + restarts the timeout from this fresh value).
 *
 *  13-10 (§A): the new `switching` START kind is NON-sticky and auto-dismisses in the SAME band as
 *  `reconnecting` — it falls through the default branch below (only `connectionError` is sticky). So
 *  if the switch is slow, the «Переключение…» start plate fades and the terminal «Переключено
 *  автоматически» replaces it via the latest-wins staging (D-03) rather than lingering forever. */
export function plateLifetime(kind: NotifyKind): PlateLifetime {
  if (kind === "connectionError") {
    return { sticky: true };
  }
  return { sticky: false, autoDismissMs: AUTO_DISMISS_MS };
}
