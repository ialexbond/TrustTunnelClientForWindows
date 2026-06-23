import { describe, it, expect } from "vitest";
import {
  initialProgress,
  computeProgress,
  deriveEstimatedPercent,
  combineProgress,
  EXPECTED_RUN_SECONDS,
  TIME_ESTIMATE_CAP,
  SECTION_LABEL_KEYS,
  FAMILY_LABEL,
  type ProgressState,
  type ProgressMarker,
} from "./progress";

// Helper: fold a sequence of markers through the reducer starting from initial
// state, returning the full series of percents (one per step) plus the final
// state. Lets us assert monotonicity over the whole run.
function fold(markers: ProgressMarker[]): { percents: number[]; final: ProgressState } {
  let state = initialProgress();
  const percents: number[] = [];
  for (const m of markers) {
    state = computeProgress(state, m);
    percents.push(state.percent);
  }
  return { percents, final: state };
}

// A full IP block = its `block` marker followed by its six `section` markers.
function block(family: "v4" | "v6"): ProgressMarker[] {
  return [
    { kind: "block", family },
    { kind: "section", section: 1 },
    { kind: "section", section: 2 },
    { kind: "section", section: 3 },
    { kind: "section", section: 4 },
    { kind: "section", section: 5 },
    { kind: "section", section: 6 },
  ];
}

function isMonotonic(series: number[]): boolean {
  for (let i = 1; i < series.length; i++) {
    if (series[i] < series[i - 1]) return false;
  }
  return true;
}

describe("computeProgress", () => {
  // ── Test E (single-stack): one block → monotonic, ends at 6/6 < 100 before
  //    completion; the explicit `complete` signal yields 100. ──────────────────
  it("single-stack block is monotonic and reaches 100 only on complete", () => {
    const { percents, final } = fold(block("v4"));
    expect(isMonotonic(percents)).toBe(true);
    // Before completion the bar has NOT hit 100 (the `complete` signal owns 100).
    expect(final.percent).toBeLessThan(100);
    expect(final.percent).toBeGreaterThan(0);

    // The explicit complete signal snaps to 100.
    const completed = computeProgress(final, { kind: "complete" });
    expect(completed.percent).toBe(100);
  });

  // ── Test F (dual-stack — the stick-at-90 fix): block1 then block2 sections
  //    are MONOTONIC across the block boundary AND advance past block 1 into
  //    block 2 (the bar does not freeze), reaching 100 only on `complete`. ──────
  it("dual-stack advances through block 2 without sticking, monotonic, 100 only on complete", () => {
    const markers = [...block("v4"), ...block("v6")];
    const { percents, final } = fold(markers);

    // Monotonic across the whole run, including the block1→block2 boundary
    // where the denominator jumps 6→12 (the monotonic clamp must hold).
    expect(isMonotonic(percents)).toBe(true);

    // The percent AT the end of block 1 (index 6 = block marker + 6 sections).
    const endOfBlock1 = percents[6];
    // The percent during/after block 2 must move FORWARD past where block 1
    // left it — proves the bar does not stick (the old stick-at-90 bug).
    const endOfBlock2 = final.percent;
    expect(endOfBlock2).toBeGreaterThan(endOfBlock1);

    // Still below 100 until the explicit completion signal.
    expect(final.percent).toBeLessThan(100);
    const completed = computeProgress(final, { kind: "complete" });
    expect(completed.percent).toBe(100);
  });

  // Single-stack also reaches 100 on completion (parity with dual-stack).
  it("single-stack reaches 100 on the complete signal", () => {
    const { final } = fold(block("v4"));
    expect(computeProgress(final, { kind: "complete" }).percent).toBe(100);
  });

  // ── Test G (step label): the reducer exposes the current step as
  //    { family, section } so the modal can render «IPv4 · Риск-скоринг». ───────
  it("exposes {family, section} for the step label", () => {
    // Section 3 of the v4 block → family 'v4', section 3.
    const afterV4S3 = fold([
      { kind: "block", family: "v4" },
      { kind: "section", section: 1 },
      { kind: "section", section: 2 },
      { kind: "section", section: 3 },
    ]).final;
    expect(afterV4S3.currentFamily).toBe("v4");
    expect(afterV4S3.currentSection).toBe(3);

    // Section 6 of the v6 block → family 'v6', section 6.
    const afterV6S6 = fold([...block("v4"), ...block("v6")]).final;
    expect(afterV6S6.currentFamily).toBe("v6");
    expect(afterV6S6.currentSection).toBe(6);
  });

  // ── Label maps exist for i18n keying (reducer stays i18n-free). ─────────────
  it("maps section numbers 1..6 to i18n key suffixes", () => {
    expect(SECTION_LABEL_KEYS[1]).toBe("basic");
    expect(SECTION_LABEL_KEYS[2]).toBe("ip_type");
    expect(SECTION_LABEL_KEYS[3]).toBe("risk_score");
    expect(SECTION_LABEL_KEYS[4]).toBe("risk_factors");
    expect(SECTION_LABEL_KEYS[5]).toBe("accessibility");
    expect(SECTION_LABEL_KEYS[6]).toBe("email");
  });

  it("maps families to short i18n tag keys", () => {
    expect(FAMILY_LABEL.v4).toBeTruthy();
    expect(FAMILY_LABEL.v6).toBeTruthy();
    expect(FAMILY_LABEL.v4).not.toBe(FAMILY_LABEL.v6);
  });

  // ── Purity / safety: unknown markers never throw, idle state is sane. ───────
  it("initial state is a benign zero", () => {
    const s = initialProgress();
    expect(s.percent).toBe(0);
    expect(s.blocksSeen).toBe(0);
    expect(s.completedSections).toBe(0);
    expect(s.currentFamily).toBeNull();
    expect(s.currentSection).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  R3-F02 (09-40): TIME-BASED ESTIMATED progress.
//
//  The benchmark section markers do NOT stream — they arrive batched at the end
//  of the run (the captured run was 128s). A determinate section bar can never
//  animate, so the bar is driven by a TIME estimate, anchored FORWARD to any
//  real marker when one arrives. progress.ts stays PURE (no timer/Date) — it
//  receives elapsed seconds as an argument; BenchmarkModal owns the interval.
// ════════════════════════════════════════════════════════════════════════════
describe("deriveEstimatedPercent / combineProgress (R3-F02 time estimate)", () => {
  // ── Test A: named constant in the 120-150 window, referenced (no literal). ──
  it("EXPECTED_RUN_SECONDS is the captured-run value in the 120-150 window", () => {
    expect(EXPECTED_RUN_SECONDS).toBe(128);
    expect(EXPECTED_RUN_SECONDS).toBeGreaterThanOrEqual(120);
    expect(EXPECTED_RUN_SECONDS).toBeLessThanOrEqual(150);
  });

  // ── Test B: 0 at start, strictly increasing across the window, EASED. ──
  it("is 0 at elapsed 0 and strictly increasing across the run window", () => {
    expect(deriveEstimatedPercent(0)).toBe(0);
    const p10 = deriveEstimatedPercent(10);
    const p30 = deriveEstimatedPercent(30);
    const p60 = deriveEstimatedPercent(60);
    const p100 = deriveEstimatedPercent(100);
    expect(p10).toBeGreaterThan(0);
    expect(p30).toBeGreaterThan(p10);
    expect(p60).toBeGreaterThan(p30);
    expect(p100).toBeGreaterThan(p60);
  });

  it("is EASED (not a linear ramp) — the front of the run moves faster than linear", () => {
    // A plain linear ramp at the run midpoint (64s) would read cap/2 ≈ 47.
    // An ease-out front-loads progress, so the midpoint must be AHEAD of linear.
    const mid = deriveEstimatedPercent(EXPECTED_RUN_SECONDS / 2);
    const linearMid = Math.round((0.5) * TIME_ESTIMATE_CAP);
    expect(mid).toBeGreaterThan(linearMid);
    // And it must not equal the plain linear value at an arbitrary early sample.
    const at10 = deriveEstimatedPercent(10);
    const linearAt10 = Math.round((10 / EXPECTED_RUN_SECONDS) * 100);
    expect(at10).not.toBe(linearAt10);
  });

  // ── Test C: capped ~95 at/beyond the expected duration (never 100 from time). ──
  it("is capped between 90 and 95 at and far beyond the expected duration", () => {
    const atExpected = deriveEstimatedPercent(EXPECTED_RUN_SECONDS);
    const farBeyond = deriveEstimatedPercent(EXPECTED_RUN_SECONDS * 10);
    expect(atExpected).toBeLessThanOrEqual(95);
    expect(atExpected).toBeGreaterThanOrEqual(90);
    expect(farBeyond).toBeLessThanOrEqual(95);
    expect(farBeyond).toBeGreaterThanOrEqual(90);
    // Never 100 from time alone.
    expect(farBeyond).toBeLessThan(100);
  });

  it("clamps negative elapsed to 0", () => {
    expect(deriveEstimatedPercent(-5)).toBe(0);
  });

  // ── Test D: combine snaps FORWARD to the marker, never backward; monotonic. ──
  it("snaps forward to the marker-implied percent when the marker is ahead", () => {
    // Marker reducer well into a dual-stack run yields a high marker percent.
    const markerState = fold([...block("v4"), ...block("v6")]).final;
    // A small time estimate (early in elapsed) is BEHIND the marker → snap forward.
    const combined = combineProgress(5, markerState);
    expect(combined).toBe(markerState.percent);
    expect(combined).toBeGreaterThan(5);
  });

  it("does not let a behind marker pull the time estimate backward", () => {
    // A single early section marker yields a small marker percent.
    const markerState = fold([{ kind: "block", family: "v4" }, { kind: "section", section: 1 }]).final;
    // A large time estimate (deep into the run) is AHEAD of the marker → keep time.
    const timePercent = deriveEstimatedPercent(EXPECTED_RUN_SECONDS);
    const combined = combineProgress(timePercent, markerState);
    expect(combined).toBe(timePercent);
    expect(combined).toBeGreaterThan(markerState.percent);
  });

  it("is monotonic for non-decreasing elapsed and non-decreasing marker state", () => {
    let markerState = initialProgress();
    const series: number[] = [];
    const elapsedTicks = [0, 5, 10, 20, 40, 60, 90, 120, 200];
    const markers: ProgressMarker[] = [...block("v4"), ...block("v6")];
    let mi = 0;
    for (const elapsed of elapsedTicks) {
      // Fold one more marker each tick to simulate a non-decreasing marker state.
      if (mi < markers.length) {
        markerState = computeProgress(markerState, markers[mi]);
        mi++;
      }
      series.push(combineProgress(deriveEstimatedPercent(elapsed), markerState));
    }
    expect(isMonotonic(series)).toBe(true);
  });

  // ── Test E: complete owns 100 — combine never returns 100 from time/markers. ──
  it("never returns 100 except when the marker state is done", () => {
    const notDone = fold([...block("v4"), ...block("v6")]).final;
    expect(notDone.done).toBe(false);
    // Even with the max time estimate, not-done never reaches 100.
    expect(combineProgress(deriveEstimatedPercent(EXPECTED_RUN_SECONDS * 100), notDone)).toBeLessThan(100);

    const done = computeProgress(notDone, { kind: "complete" });
    expect(done.done).toBe(true);
    // Done yields 100 regardless of the time estimate.
    expect(combineProgress(0, done)).toBe(100);
    expect(combineProgress(50, done)).toBe(100);
  });
});
