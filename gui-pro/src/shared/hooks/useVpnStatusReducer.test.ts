import { describe, it, expect } from "vitest";
// Phase 17 Wave 0 (17-01) — RED (GREEN by 17-05).
//
// CA-1: `useVpnEvents` is a 604-line god-hook whose `setStatus` transition matrix carries 8+
// layered historical guards (F0/F4/F16/F17/AUDIT-8/B1/B5/F-7). Before that matrix can be
// SAFELY decomposed, its behavior must be pinned by an EXHAUSTIVE prev × payload × guards
// spec so the extraction is provably behavior-preserving (Pitfall 4: broadening any guard
// reintroduces the "stuck-on-yellow" / "double-snackbar" class).
//
// This spec references the not-yet-extracted PURE reducer:
//   reduceVpnStatus(prev, payload, guards) → { nextStatus, effects }
// The module `./useVpnStatusReducer` does not exist yet — the import fails to resolve, which
// is the intended Wave-0 RED. 17-05 extracts the reducer out of `useVpnEvents`'s setStatus
// body (verbatim behavior) and flips this GREEN in place.
//
// `effects` enumerates the side-effects the listener performs today, as declarative tags the
// wiring layer replays: "snack:connected", "snack:disconnected", "snack:error",
// "snack:suppressed" (a snackbar deliberately NOT shown), "clear-uptime", "set-connected-since",
// "clear-error". `nextStatus === prev` encodes the no-dwell suppression (the listener's
// `return prev`).
import { reduceVpnStatus } from "./useVpnStatusReducer";
import type { VpnStatus } from "../types";

// The guard flags the current setStatus body reads (mirrored from useVpnEvents.ts:251-405):
//   manualReconnectActive — a MANUAL frontend save+reconnect is in flight (F0/B5/AUDIT-8)
//   seamlessSwitchActive  — a seamless A→B switch/revert is in flight (F17/F-7/B1)
//   switchSuperseded      — a user disconnect superseded an in-flight switch (F-7)
//   reconnectPending      — the teardown-settled latch (`reconnectResolve.current !== null`) is
//                           armed during a manual reconnect/switch teardown leg (F7 parity gate)
//   connectCancelled      — the user pressed «Отмена» on an in-flight connect/recovery (BUG-A2 F1);
//                           explicit one-shot flag, NOT prev-based (prev is `disconnecting` by then)
function guards(over: Partial<{
  manualReconnectActive: boolean;
  seamlessSwitchActive: boolean;
  switchSuperseded: boolean;
  reconnectPending: boolean;
  connectCancelled: boolean;
}> = {}) {
  return {
    manualReconnectActive: false,
    seamlessSwitchActive: false,
    switchSuperseded: false,
    reconnectPending: false,
    connectCancelled: false,
    ...over,
  };
}

function payload(status: VpnStatus, error: string | null = null) {
  return { status, error };
}

describe("reduceVpnStatus — CA-1 exhaustive transition matrix (RED until 17-05)", () => {
  // ── Baseline: nextStatus always mirrors the payload status unless a suppression guard bites ──
  const ALL: VpnStatus[] = [
    "connecting",
    "connected",
    "disconnecting",
    "disconnected",
    "error",
    "recovering",
    "reconnecting",
  ];

  it("with no guards active, nextStatus == payload.status for every status", () => {
    for (const s of ALL) {
      const { nextStatus } = reduceVpnStatus("connected", payload(s), guards());
      expect(nextStatus).toBe(s);
    }
  });

  // ── No-dwell / stuck-on-yellow suppression (F0/F4/B5/AUDIT-8) ─────────────────────────
  // While a MANUAL reconnect is in flight, a transient disconnecting/disconnected from the
  // teardown is HIDDEN (return prev) so «Переподключение» stays continuous — but ONLY when
  // prev === "reconnecting" AND manualReconnectActive. A REAL terminal disconnect during an
  // AUTO reconnect (manualReconnectActive false) must COMMIT (AUDIT-8 fix).
  it("suppresses transient disconnecting/disconnected during a MANUAL reconnect (prev=reconnecting)", () => {
    for (const s of ["disconnecting", "disconnected"] as VpnStatus[]) {
      const { nextStatus } = reduceVpnStatus(
        "reconnecting",
        payload(s),
        guards({ manualReconnectActive: true }),
      );
      expect(nextStatus).toBe("reconnecting"); // return prev — no «Отключение»/«Отключён» flash
    }
  });

  it("does NOT suppress a terminal disconnected during an AUTO reconnect (manualReconnectActive=false)", () => {
    const { nextStatus } = reduceVpnStatus(
      "reconnecting",
      payload("disconnected"),
      guards({ manualReconnectActive: false }),
    );
    expect(nextStatus).toBe("disconnected"); // AUDIT-8: real drop commits, no stuck-on-yellow
  });

  it("does NOT suppress a disconnected from prev=recovering even with a manual reconnect flag", () => {
    // From «Восстановление» a disconnected is ALWAYS terminal (WR-03) — never suppressed.
    const { nextStatus } = reduceVpnStatus(
      "recovering",
      payload("disconnected"),
      guards({ manualReconnectActive: true }),
    );
    expect(nextStatus).toBe("disconnected");
  });

  // ── Snackbar routing on the disconnected edge ────────────────────────────────────────
  // Fable F1: the cancel is routed by the EXPLICIT `connectCancelled` guard, NOT by `prev`. Without
  // the flag, a connecting → disconnected (non-error) edge is a BACKEND settle → the pre-BUG-A2 neutral
  // «VPN отключён» (F5: no false «отменено»). WITH the flag it is the user's «Отмена» → «Подключение
  // отменено» (+ the flag is consumed). The flag is set by App's handleUserCancel ONLY for an in-flight
  // connect/recovery; handleDisconnect sets `disconnecting` first, so by this terminal edge `prev` is
  // `disconnecting` — a prev-based cancel test would be unreachable from every real button (Fable F1).
  it("connecting → disconnected WITHOUT the cancel flag shows neutral «VPN отключён» (backend settle, F5)", () => {
    const { effects } = reduceVpnStatus("connecting", payload("disconnected"), guards());
    expect(effects).toContain("snack:disconnected");
    expect(effects).not.toContain("snack:cancelled");
    expect(effects).not.toContain("snack:error");
  });

  it("connecting → disconnected WITH the cancel flag shows «Подключение отменено» + consumes the flag (F1)", () => {
    const { effects } = reduceVpnStatus(
      "connecting",
      payload("disconnected"),
      guards({ connectCancelled: true }),
    );
    expect(effects).toContain("snack:cancelled");
    expect(effects).toContain("consume-connect-cancelled");
    expect(effects).not.toContain("snack:disconnected");
    expect(effects).not.toContain("snack:error");
  });

  it("disconnecting → disconnected WITH the cancel flag shows «Подключение отменено» (the REAL button path, F1)", () => {
    // THIS is the real button path: handleUserCancel sets the flag, then handleDisconnect sets
    // `disconnecting` optimistically, so the terminal edge arrives with prev="disconnecting". The flag
    // (not prev) carries the cancel intent — the exact case a prev-based test missed (Fable F1).
    const { effects } = reduceVpnStatus(
      "disconnecting",
      payload("disconnected"),
      guards({ connectCancelled: true }),
    );
    expect(effects).toContain("snack:cancelled");
    expect(effects).toContain("consume-connect-cancelled");
    expect(effects).not.toContain("snack:disconnected");
  });

  it("cancel flag + an error payload still routes red snack:error (a real failure raced in), and consumes the flag", () => {
    const { effects } = reduceVpnStatus(
      "connecting",
      payload("disconnected", "boom"),
      guards({ connectCancelled: true }),
    );
    expect(effects).toContain("snack:error");
    expect(effects).toContain("consume-connect-cancelled");
    expect(effects).not.toContain("snack:cancelled");
  });

  it("cancel flag is CONSUMED on a connected terminal edge (a cancel that raced to connected) — one-shot", () => {
    const { effects } = reduceVpnStatus("connecting", payload("connected"), guards({ connectCancelled: true }));
    // The success toast still fires; the flag is drained so it can't mislabel a LATER disconnect.
    expect(effects).toContain("snack:connected");
    expect(effects).toContain("consume-connect-cancelled");
  });

  it("cancel flag is CONSUMED on an error terminal edge (a cancel that raced to error) — one-shot", () => {
    const { effects } = reduceVpnStatus(
      "connecting",
      payload("error", "connect-timeout"),
      guards({ connectCancelled: true }),
    );
    expect(effects).toContain("snack:error");
    expect(effects).toContain("consume-connect-cancelled");
    expect(effects).not.toContain("snack:cancelled");
  });

  it("connecting → error WITHOUT the cancel flag still shows the error snackbar (no false cancel)", () => {
    const { effects } = reduceVpnStatus("connecting", payload("error", "connect-timeout"), guards());
    expect(effects).toContain("snack:error");
    expect(effects).not.toContain("snack:cancelled");
    expect(effects).not.toContain("consume-connect-cancelled");
  });

  it("connecting → disconnected with switchSuperseded shows the NEUTRAL disconnect snackbar (F-7)", () => {
    const { effects } = reduceVpnStatus(
      "connecting",
      payload("disconnected"),
      guards({ switchSuperseded: true }),
    );
    expect(effects).toContain("snack:disconnected");
    expect(effects).not.toContain("snack:error");
    // F-7 supersede owns this edge (consume the one-shot flag + neutral snack) — NOT the cancel path.
    expect(effects).not.toContain("snack:cancelled");
  });

  it("connected → disconnected shows the neutral «VPN отключён» snackbar", () => {
    const { effects } = reduceVpnStatus("connected", payload("disconnected"), guards());
    expect(effects).toContain("snack:disconnected");
  });

  it("disconnecting → disconnected (3.4 teardown) also shows the neutral disconnect snackbar", () => {
    const { effects } = reduceVpnStatus("disconnecting", payload("disconnected"), guards());
    expect(effects).toContain("snack:disconnected");
  });

  // ── F7: the reconnectPending latch suppresses the neutral disconnect snackbar ────────
  // A manual «Сохранить и переподключить» / a manual switch teardown leg arrives as a
  // connected/disconnecting→disconnected edge WHILE `reconnectResolve` is armed. That
  // `disconnected` is owned by the separate completion listener (it fulfils the promise) —
  // it is NOT a user-visible disconnect, so the neutral «VPN отключён» must NOT toast.
  // This restores the pre-CA-1 inline `!reconnectResolve.current` gate the extraction dropped.
  it("suppresses the neutral disconnect snackbar while reconnectPending is armed (F7, prev=connected)", () => {
    const { effects, nextStatus } = reduceVpnStatus(
      "connected",
      payload("disconnected"),
      guards({ reconnectPending: true }),
    );
    expect(effects).not.toContain("snack:disconnected");
    // The status still commits (the latch only gates the SNACKBAR, not the transition) and
    // the uptime clock still stops — only the toast is suppressed.
    expect(nextStatus).toBe("disconnected");
    expect(effects).toContain("clear-uptime");
  });

  it("suppresses the neutral disconnect snackbar while reconnectPending is armed (F7, prev=disconnecting)", () => {
    const { effects } = reduceVpnStatus(
      "disconnecting",
      payload("disconnected"),
      guards({ reconnectPending: true }),
    );
    expect(effects).not.toContain("snack:disconnected");
  });

  it("still shows the neutral disconnect snackbar when reconnectPending is NOT armed (F7 parity)", () => {
    // The default guard has reconnectPending:false — a genuine user disconnect (no reconnect
    // latch) still toasts «VPN отключён», exactly as before the gate was restored.
    const { effects } = reduceVpnStatus(
      "connected",
      payload("disconnected"),
      guards({ reconnectPending: false }),
    );
    expect(effects).toContain("snack:disconnected");
  });

  // ── Double-snackbar / seamless-switch suppression (F17) ──────────────────────────────
  it("suppresses BOTH disconnect snackbars while a seamless switch is active", () => {
    const fromConnecting = reduceVpnStatus(
      "connecting",
      payload("disconnected"),
      guards({ seamlessSwitchActive: true }),
    );
    expect(fromConnecting.effects).not.toContain("snack:error");
    expect(fromConnecting.effects).not.toContain("snack:disconnected");

    const fromConnected = reduceVpnStatus(
      "connected",
      payload("disconnected"),
      guards({ seamlessSwitchActive: true }),
    );
    expect(fromConnected.effects).not.toContain("snack:disconnected");
  });

  // ── Terminal-error short-circuit (B1) ────────────────────────────────────────────────
  it("shows the error snackbar ONLY from an in-flight connect (prev connecting/reconnecting)", () => {
    for (const prev of ["connecting", "reconnecting"] as VpnStatus[]) {
      const { effects } = reduceVpnStatus(prev, payload("error", "connect-timeout"), guards());
      expect(effects).toContain("snack:error");
    }
    // A late-mount / re-emit landing on error from a non-connecting prev does NOT re-toast.
    const { effects } = reduceVpnStatus("connected", payload("error", "x"), guards());
    expect(effects).not.toContain("snack:error");
  });

  it("suppresses the error snackbar while a seamless switch is active (calm amber card only)", () => {
    const { effects } = reduceVpnStatus(
      "connecting",
      payload("error", "boom"),
      guards({ seamlessSwitchActive: true }),
    );
    expect(effects).not.toContain("snack:error");
  });

  // ── Success + uptime effects ─────────────────────────────────────────────────────────
  it("→ connected sets connected-since, clears the error, and shows the success snackbar", () => {
    const { effects } = reduceVpnStatus("connecting", payload("connected"), guards());
    expect(effects).toContain("set-connected-since");
    expect(effects).toContain("clear-error");
    expect(effects).toContain("snack:connected");
  });

  it("recovering/reconnecting/disconnecting stop the uptime clock (clear-connected-since)", () => {
    for (const s of ["recovering", "reconnecting", "disconnecting"] as VpnStatus[]) {
      const { effects } = reduceVpnStatus("connected", payload(s), guards());
      expect(effects).toContain("clear-uptime");
    }
  });
});
