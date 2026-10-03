import { describe, it, expect } from "vitest";
import {
  reducer,
  TRANSITIONS,
  INITIAL_STATE,
  type Step,
  type WizardEvent,
  type WizardMachineState,
} from "./machine";
import type { WizardStep } from "./types";

// ─── Pure reducer tests — no renderHook needed (harness shape from
//     useWizardState.test.ts:1-26, minus the Tauri mocks which a pure
//     reducer does not touch). ───────────────────────────────────────

describe("wizard machine reducer", () => {
  // ─── 1. Initial state ───────────────────────────────
  // D-01: install-only wizard — the welcome menu is deleted, so the machine's
  // default lands on the install-first screen `server` (06-RESEARCH rewiring map).
  it("starts at server (install-only wizard, D-01)", () => {
    expect(INITIAL_STATE).toEqual({ step: "server" });
  });

  // ─── 2. Happy path INCLUDING the checking/fetching intermediates ──
  it("walks the install happy path through the checking intermediate", () => {
    // INITIAL_STATE is now `server` (D-01); the wizard opens straight on the
    // install-first screen, no NEXT from a deleted welcome menu.
    let s: WizardMachineState = INITIAL_STATE;
    expect(s.step).toBe("server");
    s = reducer(s, { type: "CHECK" }); // server -> checking
    expect(s.step).toBe("checking");
    s = reducer(s, { type: "SERVER_FOUND" }); // checking -> found
    expect(s.step).toBe("found");
  });

  it("walks the deploy happy path server -> endpoint -> deploying -> done", () => {
    let s: WizardMachineState = { step: "server" };
    s = reducer(s, { type: "SERVER_OK" }); // server -> endpoint
    expect(s.step).toBe("endpoint");
    s = reducer(s, { type: "DEPLOY" }); // endpoint -> deploying
    expect(s.step).toBe("deploying");
    s = reducer(s, { type: "DEPLOY_DONE" }); // deploying -> done
    expect(s.step).toBe("done");
  });

  it("reaches the fetching intermediate on the export path", () => {
    // checking -> found (server already installed) -> fetching -> done
    let s: WizardMachineState = { step: "found" };
    s = reducer(s, { type: "FETCH" }); // found -> fetching
    expect(s.step).toBe("fetching");
    s = reducer(s, { type: "DEPLOY_DONE" }); // fetching -> done
    expect(s.step).toBe("done");
  });

  it("can reach uninstalling from found", () => {
    const s = reducer({ step: "found" }, { type: "UNINSTALL" });
    expect(s.step).toBe("uninstalling");
  });

  // ─── 3. Illegal events are no-ops (same state object back) ──────────
  it("returns the SAME state object when the event is illegal for the step", () => {
    const start: WizardMachineState = { step: "welcome" };
    // welcome has no DEPLOY transition
    const next = reducer(start, { type: "DEPLOY" });
    expect(next).toBe(start); // reference-equal: true no-op
    expect(next.step).toBe("welcome");
  });

  it("ignores an unrelated event mid-flow without changing the step", () => {
    const start: WizardMachineState = { step: "endpoint" };
    const next = reducer(start, { type: "SERVER_FOUND" });
    expect(next.step).toBe("endpoint");
  });

  // ─── 4. FAIL from any in-flight step -> error, carrying the code ────
  it("FAIL transitions to error and carries the reason code", () => {
    const s = reducer({ step: "deploying" }, { type: "FAIL", code: "deploy-timeout" });
    expect(s.step).toBe("error");
    expect(s.errorCode).toBe("deploy-timeout");
  });

  it("FAIL works from checking too", () => {
    const s = reducer({ step: "checking" }, { type: "FAIL", code: "ssh-down" });
    expect(s.step).toBe("error");
    expect(s.errorCode).toBe("ssh-down");
  });

  // ─── 5. RESET returns to server from every step ────────────────────
  // D-01: RESET re-pointed welcome→server — the install-only wizard's clean slate
  // is the install-first screen, not the deleted welcome menu.
  it("RESET returns to server from any step", () => {
    const steps: Step[] = [
      "welcome", "checking", "found", "uninstalling", "endpoint",
      "deploying", "fetching", "done", "error", "recovery",
    ];
    for (const step of steps) {
      expect(reducer({ step }, { type: "RESET" }).step).toBe("server");
    }
  });

  // ─── 6. Codex #8 — no dropped state: WizardStep ⊆ Step ─────────────
  it("every WizardStep literal is a valid machine Step (type-level + runtime)", () => {
    const allWizardSteps: WizardStep[] = [
      "welcome", "server", "checking", "found", "uninstalling",
      "endpoint", "deploying", "fetching", "done", "error",
    ];
    for (const ws of allWizardSteps) {
      // Type-level: assignable without a cast proves WizardStep ⊆ Step.
      const asStep: Step = ws;
      // Runtime: every visible step is a key in the transition table.
      expect(TRANSITIONS).toHaveProperty(asStep);
    }
  });

  it("the Step union includes the recovery step (slice 3)", () => {
    const recovery: Step = "recovery";
    expect(TRANSITIONS).toHaveProperty(recovery);
  });

  // ─── 6b. Recovery fork transitions (slice 3, WIZARD-03 / D-01) ──────
  describe("recovery fork (slice 3)", () => {
    it("recovery --START_OVER--> server (the only static recovery target, D-04 / D-01)", () => {
      // D-01: re-pointed welcome→server — Start over lands on the install-first
      // screen now that the welcome menu is deleted.
      const s = reducer({ step: "recovery" }, { type: "START_OVER" });
      expect(s.step).toBe("server");
    });

    it("recovery --CONTINUE--> does NOT hard-code endpoint/deploying (finding E)", () => {
      // Continue routes to the transient probe state ("checking"); the hook then
      // re-runs resolveResume and drives the real destination. The table MUST NOT
      // encode endpoint/deploying as the CONTINUE target — that would defeat the
      // single-source-of-truth resume (round-2 finding E).
      const target = TRANSITIONS["recovery"]["CONTINUE"];
      expect(target).not.toBe("endpoint");
      expect(target).not.toBe("deploying");
      expect(target).toBe("checking");
    });

    it("recovery --APPLY_CONFIG--> deploying (divergence-resolution via deploy_server, finding C)", () => {
      const s = reducer({ step: "recovery" }, { type: "APPLY_CONFIG" });
      expect(s.step).toBe("deploying");
    });

    it("deploying --DEPLOY_RETRY_EXHAUSTED--> recovery (bounded-retry exhaustion, D-03 / Codex #6)", () => {
      // An exhausted silent whole-deploy retry surfaces the recovery fork, NOT the
      // error screen — the user gets Continue / Start over instead of looping.
      const s = reducer({ step: "deploying" }, { type: "DEPLOY_RETRY_EXHAUSTED" });
      expect(s.step).toBe("recovery");
    });

    it("a normal deploying FAIL still lands on error (not recovery)", () => {
      // Only EXHAUSTION goes to recovery; a single FAIL keeps the error-screen path.
      const s = reducer({ step: "deploying" }, { type: "FAIL", code: "deploy-error" });
      expect(s.step).toBe("error");
    });

    it("illegal events from recovery are no-ops (same state object back)", () => {
      const start: WizardMachineState = { step: "recovery" };
      // recovery has no NEXT/CHECK/DEPLOY transitions.
      for (const ev of [{ type: "NEXT" }, { type: "CHECK" }, { type: "DEPLOY" }] as WizardEvent[]) {
        const next = reducer(start, ev);
        expect(next).toBe(start); // reference-equal: true no-op
        expect(next.step).toBe("recovery");
      }
    });
  });

  // ─── 7. Reserved events exist in the union (no wiring required here) ─
  it("reserved later-slice events are valid no-ops on welcome", () => {
    const reserved: WizardEvent[] = [
      {
        type: "PROBE_RESULT",
        // 05-02 finalized the ServerProbe shape — a clean (not-installed) probe.
        probe: {
          installed: false,
          binaryInstalled: false,
          credentialsExist: false,
          rulesExist: false,
          vpnConfigExists: false,
          hostsConfigExists: false,
          certPresent: false,
          unitExists: false,
          unitEnabled: false,
          serviceActive: false,
          partial: false,
          configDiverges: false,
          localExportComplete: false,
        },
      },
      { type: "CONTINUE" },
      { type: "START_OVER" },
      { type: "APPLY_CONFIG" },
    ];
    for (const ev of reserved) {
      // They are valid union members and must not throw; on welcome they are no-ops.
      expect(reducer({ step: "welcome" }, ev).step).toBe("welcome");
    }
  });
});
