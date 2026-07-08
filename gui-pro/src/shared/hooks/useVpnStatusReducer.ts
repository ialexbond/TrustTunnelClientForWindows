import type { VpnStatus } from "../types";

// Phase 17 (17-05, CA-1) — the PURE status-transition reducer extracted from the
// `useVpnEvents` god-hook's inline `setStatus` body (useVpnEvents.ts:251-405 pre-extraction).
//
// WHY a pure reducer: the transition matrix carried 8+ layered historical guards
// (F0/F4/F16/F17/AUDIT-8/B1/B5/F-7) inlined into a 155-line `setStatus` updater. Every past
// fix NARROWED a guard in place rather than restructuring, so the next lifecycle signal was
// likely to reintroduce the documented «stuck-on-yellow» / «double-snackbar» bug class
// (16-CODE-AUDIT §MAJOR-1). Pinning the matrix behind an EXHAUSTIVE prev×payload×guards
// unit test (useVpnStatusReducer.test.ts) and reducing it to a side-effect-free function is
// the single biggest safety win on this tab: the wiring layer only REPLAYS the declarative
// effects the reducer emits, so effect ORDER and guard CONDITIONS are provably preserved.
//
// CRITICAL — do NOT broaden any guard (17-RESEARCH §Pitfall 4). The conditions below are the
// SAME conditions the inline branches encoded; the extraction is behavior-identical. The
// effect ORDER in `effects[]` mirrors the original emission order inside the updater
// (set-connected-since / clear-error / snackbar / clear-uptime), so the wiring layer replays
// them in the same sequence.

/**
 * The guard inputs the original `setStatus` body read from shared refs, passed as PLAIN
 * values so the reducer is testable in isolation (no ref plumbing). Mirrors
 * useVpnEvents.ts:251-405.
 *
 * - `manualReconnectActive` — a MANUAL frontend save+reconnect is in flight (F0/B5/AUDIT-8):
 *   the shared `manualReconnectActiveRef.current`. Absent ref = false (the safe direction —
 *   never suppress a real terminal disconnect).
 * - `seamlessSwitchActive` — a seamless A→B switch/revert is in flight (F17/B1): mirrors the
 *   App's `isSwitching`. While true, BOTH disconnect snackbars and the error snackbar are
 *   suppressed (the calm amber card + «…восстановлено» banner are the only signals).
 * - `switchSuperseded` — a genuine user disconnect superseded an in-flight switch (F-7): a
 *   one-shot flag CONSUMED here on the connecting→disconnected edge (the wiring layer clears
 *   the ref when it sees the `consume-switch-superseded` effect).
 * - `reconnectPending` — a manual reconnect / switch teardown-settled latch is armed
 *   (`reconnectResolve.current !== null`). The teardown leg of a manual «Сохранить и
 *   переподключить» / a manual switch arrives here as a connected/disconnecting→disconnected
 *   edge; the SEPARATE reconnect-completion listener owns that `disconnected` to fulfil the
 *   promise, so it is NOT a user-visible disconnect and must NOT toast the neutral «VPN
 *   отключён» snackbar. Read from the shared `reconnectResolve` ref in the wiring layer (F7 —
 *   restores the original inline `!reconnectResolve.current` gate that the CA-1 extraction
 *   dropped). The wiring layer's status listener is registered BEFORE the completion listener,
 *   so it reads the ref while it is still armed (same ordering as the pre-extraction inline body).
 */
export interface VpnStatusGuards {
  manualReconnectActive: boolean;
  seamlessSwitchActive: boolean;
  switchSuperseded: boolean;
  reconnectPending: boolean;
  /**
   * BUG-A2 (17-uat, Fable F1): the user pressed «Отмена» on an IN-FLIGHT connect/recovery (App's
   * `connectCancelledRef`, set by handleUserCancel only when statusRef was connecting/recovering). A
   * one-shot flag — NOT derived from `prev`, because handleDisconnect optimistically sets
   * `disconnecting` BEFORE vpn_disconnect, so by the terminal `disconnected` edge `prev` is already
   * `disconnecting` and a prev-based cancel test is UNREACHABLE from every real button (Fable F1). The
   * reducer consumes it (via `consume-connect-cancelled`) on the terminal disconnected/connected/error
   * edge so a cancel that races to connected/error can never mislabel a LATER disconnect.
   */
  connectCancelled: boolean;
}

/**
 * The payload of a `vpn-status` event as far as the transition matrix cares (status + the
 * already-sanitized error string). `attempt`/`max` are handled OUTSIDE the reducer (a plain
 * idempotent side effect on the listener, no dependency on prev) so they are not modelled here.
 */
export interface VpnStatusPayload {
  status: VpnStatus;
  error?: string | null;
}

/**
 * Declarative effect tags the wiring layer replays. Enumerates exactly the side-effects the
 * original inline `setStatus` body performed, in emission order:
 *
 * - `set-connected-since` — stamp `connectedSince = new Date()` (the → connected edge).
 * - `clear-uptime` — clear `connectedSince` (a drop/teardown edge: recovering/reconnecting/
 *   disconnecting; also the disconnected-from-connected edge inside the disconnect arm).
 * - `clear-error` — `setError(null)` on the → connected edge (WR-01).
 * - `snack:connected` — «VPN connected» success snackbar.
 * - `snack:disconnected` — neutral «VPN отключён» snackbar.
 * - `snack:cancelled` — «Подключение отменено» snackbar (BUG-A2): a connect/recovery that the user
 *   cancelled before it ever became a live tunnel. Routed by the explicit `connectCancelled` flag
 *   (NOT by `prev` — Fable F1), so it fires on the REAL button path (handleUserCancel → optimistic
 *   `disconnecting` → terminal `disconnected`). Distinct from `snack:disconnected` (a GENUINE
 *   live-tunnel disconnect) so the toast honestly reads "cancelled", not "VPN отключён".
 * - `snack:error` — red «Connection failed» / localized error snackbar.
 * - `consume-switch-superseded` — clear the one-shot `switchSupersededRef` (F-7).
 * - `consume-connect-cancelled` — clear the one-shot `connectCancelledRef` (BUG-A2 F1) on the
 *   terminal edge that consumed it (disconnected → cancel toast) or that raced past it
 *   (connected/error), so a stale flag can never mislabel a LATER disconnect.
 *
 * `nextStatus === prev` encodes the no-dwell suppression (the original `return prev`).
 */
export type VpnStatusEffect =
  | "set-connected-since"
  | "clear-uptime"
  | "clear-error"
  | "snack:connected"
  | "snack:disconnected"
  | "snack:cancelled"
  | "snack:error"
  | "consume-switch-superseded"
  | "consume-connect-cancelled";

export interface VpnStatusReduction {
  nextStatus: VpnStatus;
  effects: VpnStatusEffect[];
}

/**
 * Pure reduction of a `vpn-status` transition. Same (prev, payload, guards) → same
 * { nextStatus, effects[] }; no side effects, no refs mutated. Encodes the transition matrix
 * from useVpnEvents.ts:251-405 VERBATIM — same guard conditions, same effect emission order.
 */
export function reduceVpnStatus(
  prev: VpnStatus,
  payload: VpnStatusPayload,
  guards: VpnStatusGuards,
): VpnStatusReduction {
  const effects: VpnStatusEffect[] = [];
  const status = payload.status;

  // F0 (no-dwell guard, NARROWED — Codex M1 / AUDIT-8 / B5): suppress an intermediate
  // "disconnecting"/"disconnected" ONLY during «Переподключение» (a MANUAL save+reconnect,
  // where useVpnActions sets prev = "reconnecting" up-front and the teardown emits a transient
  // teardown edge we hide so the label stays continuous — no «Отключение»/«Отключён» flash).
  // Keyed on prev==="reconnecting" && manualReconnectActive — NOT broadened to recovering /
  // no-mark, so a REAL terminal disconnect during an AUTO reconnect still commits (AUDIT-8
  // stuck-on-yellow fix intact). `return prev` == nextStatus mirrors prev, no effects.
  if (
    prev === "reconnecting" &&
    (status === "disconnected" || status === "disconnecting") &&
    guards.manualReconnectActive
  ) {
    return { nextStatus: prev, effects };
  }

  // Show appropriate snackbar / uptime effect based on transition (emission order preserved).
  if (status === "connected") {
    // → connected: stamp uptime, clear any lingering recovery/error banner (WR-01), toast.
    effects.push("set-connected-since");
    effects.push("clear-error");
    effects.push("snack:connected");
    // BUG-A2 F1: a cancel that RACED to connected (the vpn_disconnect lost to a just-landed Connected)
    // must consume the flag here — else a stale connectCancelled would mislabel the NEXT genuine
    // disconnect as «Подключение отменено». One-shot: drained on any terminal edge.
    if (guards.connectCancelled) effects.push("consume-connect-cancelled");
  } else if (status === "disconnected") {
    // The disconnect arm clears uptime first, then routes the snackbar.
    effects.push("clear-uptime");
    // F17: during a seamless switch+revert suppress BOTH disconnect snackbars.
    const suppressDisconnectSnack = guards.seamlessSwitchActive;
    // BUG-A2 F1: check the EXPLICIT connect-cancel flag FIRST — it is authoritative for "the user
    // pressed «Отмена» on an in-flight connect/recovery". It is NOT derived from `prev`: handleDisconnect
    // optimistically sets `disconnecting` BEFORE vpn_disconnect, so by this terminal `disconnected` edge
    // `prev` is `disconnecting` — a prev-based cancel test is unreachable from every button (Fable F1).
    // Only a CLEAN teardown (no error) reads as a cancel; an error payload means a real failure raced in
    // (keep the red snack:error). Always CONSUME the flag here (one-shot), and skip the prev-based
    // routing below so a cancel is never ALSO toasted as «VPN отключён». A BACKEND edge (sidecar-exit-0,
    // recovery-give-up) never sets connectCancelledRef, so it falls through to the prev-based logic
    // unchanged — no false «отменено» (Fable F5).
    if (guards.connectCancelled) {
      effects.push("consume-connect-cancelled");
      if (!suppressDisconnectSnack) {
        effects.push(payload.error ? "snack:error" : "snack:cancelled");
      }
    } else if (prev === "connecting" || prev === "recovering") {
      if (guards.switchSuperseded) {
        // F-7: a genuine user disconnect SUPERSEDED an in-flight switch — the
        // connecting→disconnected edge is the user's intended disconnect, NOT a connect
        // failure → neutral «VPN отключён», never red. Consume the flag (one-shot).
        // NOTE: no `reconnectPending` gate here — the original inline arm gated ONLY the
        // `prev==="connected"||"disconnecting"` teardown branch on `!reconnectResolve.current`;
        // this connecting→disconnected supersede arm was never reconnect-gated.
        effects.push("consume-switch-superseded");
        if (!suppressDisconnectSnack) effects.push("snack:disconnected");
      } else if (!suppressDisconnectSnack) {
        // A raw connecting/recovering → disconnected edge with NO explicit cancel flag: this is a
        // BACKEND-driven settle (e.g. a connect that failed straight to disconnected WITH a fixed error
        // string — F16 — or a recovery give-up). error present → red snack:error (F16 localizes it, or
        // the empty-generic errors.connection_failed); no error → neutral «VPN отключён» (the pre-BUG-A2
        // routing, restored — the CANCEL case is now flag-based above, Fable F1/F5).
        effects.push(payload.error ? "snack:error" : "snack:disconnected");
      }
    } else if (prev === "connected" || prev === "disconnecting") {
      // Was connected (or the 3.4 Disconnecting teardown) → neutral disconnect snackbar.
      // F7: gated on `!reconnectPending` (the shared `reconnectResolve` latch, read in the
      // wiring layer) EXACTLY as the pre-extraction inline arm did. When a manual reconnect /
      // switch teardown is in flight the SEPARATE reconnect-completion listener owns this
      // `disconnected` edge to fulfil the promise — it is the teardown leg, NOT a user-visible
      // disconnect, so the neutral «VPN отключён» snackbar must be suppressed (else the teardown
      // half of every save-and-reconnect / switch would flash «VPN отключён» before the
      // destination «VPN подключён» — the F-8 double-snackbar class). Today `seamlessSwitchActive`
      // masks this for the switch path, but the gate restores exact parity for any direct caller.
      if (!suppressDisconnectSnack && !guards.reconnectPending) effects.push("snack:disconnected");
    }
  } else if (status === "error") {
    // B1: the error edge ALSO toasts, but ONLY from an in-flight connect (prev connecting/
    // reconnecting) so a late-mount snapshot / re-emit of an already-error status does NOT
    // re-toast; SUPPRESSED during a seamless switch (calm amber card covers it).
    const suppressErrorSnack = guards.seamlessSwitchActive;
    if ((prev === "connecting" || prev === "reconnecting") && !suppressErrorSnack) {
      effects.push("snack:error");
    }
    // BUG-A2 F1: a cancel that RACED to error (vpn_disconnect lost to a just-landed Error) must consume
    // the flag here too — a genuine failure showed its own red snack:error above; draining the flag
    // stops a stale connectCancelled from mislabelling the NEXT disconnect. One-shot on any terminal edge.
    if (guards.connectCancelled) effects.push("consume-connect-cancelled");
  } else if (status === "recovering" || status === "reconnecting" || status === "disconnecting") {
    // F1 / 3.4 R-DCT: a drop / teardown is NOT "up" — stop the uptime clock.
    effects.push("clear-uptime");
  }

  return { nextStatus: status, effects };
}
