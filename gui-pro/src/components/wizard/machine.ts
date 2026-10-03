// ═══════════════════════════════════════════════════════
// wizard/machine.ts — explicit step state machine (WIZARD-01 / D-11)
// ═══════════════════════════════════════════════════════
//
// Satisfies WIZARD-01 (a clean step state machine: a typed transition table +
// pure reducer kept OUT of the UI) and D-11 (untangles the three "step" layers
// that drift apart today):
//   (1) the app-level `wizardActive` overlay (App.tsx) — stays a mount gate,
//       NOT modelled here;
//   (2) the wizard's navigation step — this is `WizardMachineState.step`, driven
//       solely by `TRANSITIONS` + `reducer`; it replaces the in-memory counter +
//       the ad-hoc localStorage remap at useWizardState.ts:39-52;
//   (3) the `deploySteps` / `STEPS_ORDER` progress map — stays render-only deploy
//       progress, NOT a machine step.
//
// The persisted snapshot (persist.ts) is a HINT, not the source of truth. On a
// real resume the server is probed and the step is recomputed from server
// reality (server-verified resume lands in 05-02 via `resolveResume`). The
// snapshot only pre-seeds the reducer so a tab switch keeps the screen.
//
// The `Step` union INTENTIONALLY mirrors ALL of `types.ts:WizardStep`
// (welcome/server/checking/found/uninstalling/endpoint/deploying/fetching/
// done/error) so the reducer is the SOLE navigation source with NO compatibility
// shim mapping checking/uninstalling/fetching onto other steps. Dropping those
// intermediates was the Codex HIGH #8 defect; modelling them here is the fix.
// `recovery` is added now for slice 3 (its UI wiring lands in 05-03).
//
// The `ServerProbe` contract now lives in resolveResume.ts (05-02 finalized it —
// the full keyed shape mirroring check_server_installation, still NO `configValid`,
// round-3 LOW D). machine.ts re-exports it so existing importers keep working and
// the WizardEvent union below can reference it without a duplicate definition
// (Codex #9 — one consistent contract). The import is type-only, so the
// machine.ts ↔ resolveResume.ts cycle (resolveResume imports `Step` from here) is
// erased at compile time.

import type { WizardStep } from "./types";
import type { ServerProbe } from "./resolveResume";

export type { ServerProbe };

// Navigation source of truth. SUPERSET of types.ts:WizardStep (every existing
// visible state — none dropped, Codex #8) PLUS `recovery` (new, slice 3).
export type Step =
  | "welcome"
  | "server"
  | "checking"
  | "found"
  | "uninstalling"
  | "endpoint"
  | "deploying"
  | "fetching"
  | "done"
  | "error"
  | "recovery";

// Compile-time guard: WizardStep MUST remain assignable to Step (no visible
// state may silently drop out of the machine). If `types.ts:WizardStep` ever
// gains a value not present in `Step`, this line fails to type-check.
const _wizardStepIsSubsetOfStep: Step = "welcome" as WizardStep;
void _wizardStepIsSubsetOfStep;

// Typed event union covering today's real navigation transitions. Some variants
// (PROBE_RESULT/CONTINUE/START_OVER/APPLY_CONFIG) are reserved for later slices
// and need no transition wiring here — they are valid union members so the
// later-slice code lands cleanly. APPLY_CONFIG in particular is reserved now so
// the 05-03 divergence-resolution branch slots in without a union edit (round-2
// finding C).
export type WizardEvent =
  | { type: "NEXT" }
  | { type: "CHECK" }
  | { type: "SERVER_OK" }
  | { type: "SERVER_FOUND" }
  | { type: "UNINSTALL" }
  | { type: "FETCH" }
  | { type: "PROBE_RESULT"; probe: ServerProbe }
  | { type: "CONTINUE" }
  | { type: "START_OVER" }
  | { type: "APPLY_CONFIG" }
  | { type: "DEPLOY" }
  | { type: "DEPLOY_DONE" }
  // DEPLOY_RETRY_EXHAUSTED (slice 3, D-03 / Codex #6): the bounded silent
  // whole-deploy retry has run out of attempts on a transient SSH drop. This is
  // DISTINCT from FAIL (which lands on the `error` screen with a retry button): an
  // exhausted retry surfaces the Continue / Start-over recovery fork instead, so the
  // user gets the resume-or-clean-up choice rather than an endless manual retry.
  | { type: "DEPLOY_RETRY_EXHAUSTED" }
  | { type: "FAIL"; code: string }
  | { type: "RESET" }
  // GOTO is the imperative navigation primitive the existing hook drives today
  // (it calls setWizardStep("checking"/"found"/"error"/… ) at many sites). It
  // sets the step directly so wiring the machine into useWizardState in 05-01 is
  // a pure state-lift with ZERO visible behavior change (SAFETY-03). The later
  // slices drive navigation through the SEMANTIC events above; GOTO is the
  // bridge that lets the reducer own the step without rewriting every call site
  // in this slice.
  | { type: "GOTO"; step: Step };

export interface WizardMachineState {
  step: Step;
  // Carried from a FAIL event so the error screen can show a stable reason code.
  errorCode?: string;
}

// Install-only wizard (D-01 / 06-RESEARCH §"Entry-flow & Welcome-removal Rewiring
// Map"): there is no 3-card welcome menu anymore, so the machine's default lands on
// the install-first screen `server`. The `"welcome"` union member is kept harmlessly
// (PATTERNS §E) to minimize churn — nothing seeds it now.
export const INITIAL_STATE: WizardMachineState = { step: "server" };

// Per-step navigation that does NOT depend on the event payload. FAIL and RESET
// are handled uniformly in the reducer (FAIL carries a code; RESET is global) so
// they are intentionally absent from the per-step rows below.
type StepTransitions = Partial<Record<WizardEvent["type"], Step>>;

// Encodes today's actual navigation flow:
//   welcome --NEXT--> server
//   server  --CHECK--> checking        (the "checking" intermediate, Codex #8)
//   server  --SERVER_OK--> endpoint    (not-installed → configure)
//   checking --SERVER_FOUND--> found   (installed server detected)
//   found   --FETCH--> fetching        (export an existing user's config)
//   found   --UNINSTALL--> uninstalling
//   found   --SERVER_OK--> endpoint    (re-configure an installed server)
//   endpoint --DEPLOY--> deploying
//   deploying --DEPLOY_DONE--> done
//   fetching  --DEPLOY_DONE--> done    (export finished)
// FAIL (→ error, from any in-flight step) and RESET (→ server, from any step)
// are applied in the reducer, not duplicated per-row. (D-01: RESET re-pointed
// welcome→server — the install-only wizard's clean slate is the server screen.)
export const TRANSITIONS: Record<Step, StepTransitions> = {
  welcome: { NEXT: "server" },
  server: { CHECK: "checking", SERVER_OK: "endpoint" },
  checking: { SERVER_FOUND: "found", SERVER_OK: "endpoint" },
  found: { FETCH: "fetching", UNINSTALL: "uninstalling", SERVER_OK: "endpoint" },
  uninstalling: { SERVER_OK: "server" },
  endpoint: { DEPLOY: "deploying" },
  // DEPLOY_RETRY_EXHAUSTED routes the bounded-retry exhaustion to the recovery fork
  // (D-03 / Codex #6) — NOT to `error`. A normal one-shot deploy FAIL still goes to
  // `error` (handled globally in the reducer); only an EXHAUSTED silent retry lands
  // here, giving the user the Continue / Start-over choice instead of looping.
  deploying: { DEPLOY_DONE: "done", DEPLOY_RETRY_EXHAUSTED: "recovery" },
  fetching: { DEPLOY_DONE: "done" },
  done: {},
  error: {},
  // recovery fork (slice 3, WIZARD-03 / D-01). Three explicit user choices:
  //   • START_OVER  → server (after the EXTENDED full-clean uninstall completes,
  //                   D-04). This is the ONLY recovery event with a static target —
  //                   a clean slate always lands back at the install-first screen.
  //                   (D-01: re-pointed welcome→server — the welcome menu is deleted.)
  //   • CONTINUE    → "checking": Continue does NOT hard-code its destination
  //                   (round-2 finding E). It re-runs the probe + resolveResume in
  //                   the hook and the FINAL step is whatever resolveResume returns
  //                   (endpoint / fetching / done / recovery). The table only routes
  //                   it to the transient "checking" state; the hook then drives the
  //                   real GOTO. Encoding `endpoint`/`deploying` here would defeat the
  //                   single-source-of-truth resume (finding E), so we DON'T.
  //   • APPLY_CONFIG → "deploying": the divergence-resolution action (round-2 finding
  //                   C). It calls deploy_server(overwrite_config=true) (the REAL
  //                   command — no phantom deploy_configure IPC, round-3 LOW C), which
  //                   the hook runs as a normal deploy; the deploy screen shows
  //                   progress. The FINAL resume after it also re-runs resolveResume.
  recovery: { START_OVER: "server", CONTINUE: "checking", APPLY_CONFIG: "deploying" },
};

// Pure reducer. Looks up TRANSITIONS[step][event.type]; an event with no entry
// for the current step is a NO-OP and the SAME state object is returned (so
// callers can rely on reference equality to skip re-renders). FAIL is a global
// transition to `error` that also carries the reason code; RESET is a global
// transition back to `server` (D-01: install-only wizard — there is no welcome menu).
export function reducer(
  state: WizardMachineState,
  event: WizardEvent,
): WizardMachineState {
  if (event.type === "RESET") {
    return state.step === "server" ? state : { step: "server" };
  }
  if (event.type === "FAIL") {
    return { step: "error", errorCode: event.code };
  }
  if (event.type === "GOTO") {
    return state.step === event.step ? state : { step: event.step };
  }
  const next = TRANSITIONS[state.step][event.type];
  if (next === undefined) {
    return state; // illegal event for this step → true no-op
  }
  return { step: next };
}
