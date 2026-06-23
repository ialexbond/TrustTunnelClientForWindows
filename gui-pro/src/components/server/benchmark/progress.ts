/**
 * Benchmark progress reducer (09-38 R2-F01-b) — HONEST section-based progress.
 *
 * Background: the IPQuality script (xykt/IPQuality) emits NO real progress
 * markers. The old design fabricated a 5-step percent in Rust (1→20 … 5→90,
 * section 6 unmapped) which stuck at 90% and — worse — could not represent a
 * dual-stack server that runs the SIX sections TWICE (once per IP block).
 *
 * This module replaces the fabricated percent with a pure reducer driven by two
 * real structural markers the script DOES print:
 *   - a per-IP block header (`IP QUALITY CHECK REPORT …<ip>`) → one `block`
 *     marker, tagged v4/v6 by the header IP;
 *   - the six `N. <name>` section headers per block → six `section` markers.
 *
 * The determinate bar is `completedSections / (6 × blocksSeen)`. On a
 * single-stack server blocksSeen=1 (denominator 6); on a dual-stack server the
 * second block bumps blocksSeen to 2 (denominator 12) — which would DROP a
 * finished block-1 from 100% to 50%, so we clamp the percent monotonically
 * (`Math.max(prev, computed)`). The bar reaches 100 ONLY on the explicit
 * `complete` marker (the modal feeds this on the completed-state transition).
 *
 * The reducer is i18n-free: it exposes `{ currentFamily, currentSection }` and
 * this module exports the section→key and family→key maps so the modal builds
 * the Russian step label («IPv4 · Риск-скоринг») via `t()`.
 *
 * Pure module — no React, no Tauri, no DOM. Unknown markers never throw.
 */

export type IpFamily = "v4" | "v6";

/** A structural marker emitted by the Rust streaming loop, consumed here. */
export type ProgressMarker =
  | { kind: "block"; family: IpFamily }
  | { kind: "section"; section: number }
  | { kind: "complete" };

export interface ProgressState {
  /** Number of IP blocks whose header we have seen (denominator factor). */
  blocksSeen: number;
  /** Total `N. <name>` section headers seen across all blocks (numerator). */
  completedSections: number;
  /** Family of the block currently being processed (for the step label). */
  currentFamily: IpFamily | null;
  /** Section number 1..6 of the most recent section header (for the label). */
  currentSection: number | null;
  /** Derived determinate percent, 0..100, monotonic, 100 only on complete. */
  percent: number;
  /** Sticky completion flag — once true the bar holds 100. */
  done: boolean;
}

/** A benign zero state — indeterminate bar, no progress yet. */
export function initialProgress(): ProgressState {
  return {
    blocksSeen: 0,
    completedSections: 0,
    currentFamily: null,
    currentSection: null,
    percent: 0,
    done: false,
  };
}

/**
 * Section number (1..6) → i18n key suffix. The modal keys
 * `server.service.benchmark.progress.section.<suffix>` off this.
 */
export const SECTION_LABEL_KEYS: Record<number, string> = {
  1: "basic",
  2: "ip_type",
  3: "risk_score",
  4: "risk_factors",
  5: "accessibility",
  6: "email",
};

/**
 * IP family → i18n key suffix for the short tag («IPv4» / «IPv6»). The modal
 * keys `server.service.benchmark.progress.family.<suffix>` off this.
 */
export const FAMILY_LABEL: Record<IpFamily, string> = {
  v4: "v4",
  v6: "v6",
};

/**
 * Reduce one marker into the next progress state. Pure: returns a NEW state,
 * never mutates the input. Monotonic: the derived percent never decreases.
 */
export function computeProgress(prev: ProgressState, marker: ProgressMarker): ProgressState {
  switch (marker.kind) {
    case "block": {
      const blocksSeen = prev.blocksSeen + 1;
      const next: ProgressState = {
        ...prev,
        blocksSeen,
        currentFamily: marker.family,
        // A new block starts its own six sections; the global `completedSections`
        // counter keeps accumulating (it is the numerator over ALL blocks).
        currentSection: null,
      };
      return { ...next, percent: derivePercent(next, prev.percent) };
    }

    case "section": {
      const next: ProgressState = {
        ...prev,
        completedSections: prev.completedSections + 1,
        currentSection: marker.section,
      };
      return { ...next, percent: derivePercent(next, prev.percent) };
    }

    case "complete":
      return { ...prev, done: true, percent: 100 };

    default:
      // Defensive: unknown marker → unchanged state (never throws).
      return prev;
  }
}

/**
 * Honest determinate percent. Two requirements pull against each other:
 *   (1) the bar must be MONOTONIC (never step backward), and
 *   (2) a dual-stack server (block 2) must ADVANCE the bar past where block 1
 *       left it — no stick-at-90.
 *
 * If we used the naive `completedSections / (6 × blocksSeen)` and let a finished
 * block-1 saturate near the top, the monotonic clamp would pin the bar there
 * through all of block 2 (the stick-at-90 bug in disguise). The fix: each
 * COMPLETED SECTION is an honest, real event, so we advance per completed
 * section along a curve that (a) is strictly increasing in `completedSections`
 * and (b) asymptotically approaches — but never reaches — 100 before the
 * explicit `complete` marker. We use an exponential-decay curve:
 *
 *     percent = round(100 × (1 − DECAY^completedSections))
 *
 * with DECAY chosen so six sections (a single-stack run) land near the high
 * 80s/low 90s, and twelve sections (dual-stack) land higher still — so block 2
 * genuinely moves the bar forward — yet neither hits 100 (reserved for
 * `complete`). Because the curve depends ONLY on the monotonically-growing
 * `completedSections`, the result is monotonic without an explicit clamp; we
 * keep the `Math.max(prev, …)` belt-and-suspenders anyway.
 */
const PROGRESS_DECAY = 0.7; // 1−0.7^6 ≈ 0.88; 1−0.7^12 ≈ 0.986 (block 2 advances).

function derivePercent(state: ProgressState, prevPercent: number): number {
  if (state.done) return 100;
  if (state.completedSections === 0) return prevPercent; // header only → hold
  const curve = 1 - Math.pow(PROGRESS_DECAY, state.completedSections);
  const scaled = Math.min(99, Math.round(100 * curve));
  return Math.max(prevPercent, scaled);
}

// ── R3-F02 (09-40): TIME-BASED ESTIMATED progress ───────────────────────────
//
// Owner decision (locked 2026-06-23): the IPQuality section markers do NOT
// stream over the SSH exec channel — the remote output is buffered and arrives
// in a BURST near the end of the run, so the marker reducer above can only ever
// produce one late value and then the result drops in. A determinate
// section-driven bar therefore cannot animate.
//
// The fix is an HONEST time estimate: drive the bar off ELAPSED SECONDS over the
// expected run duration, eased and capped below 100, and ANCHOR it forward to a
// real marker whenever one does arrive (Math.max — never backward). 100 stays
// reserved for the explicit `complete` signal.
//
// This module stays PURE: it takes elapsed seconds as an argument and calls NO
// timer / Date API. BenchmarkModal owns the interval and feeds elapsed in.

/**
 * Expected total benchmark run duration, in seconds. The captured real run was
 * 128s (the typical window is ~120-150s). This is the BASIS for the eased time
 * estimate — it is NOT a measured percent and the bar never reaches 100 on time
 * alone (see TIME_ESTIMATE_CAP). Used by `deriveEstimatedPercent`.
 */
export const EXPECTED_RUN_SECONDS = 128;

/**
 * Hard ceiling for the time-only estimate. The bar fills toward this cap while
 * the run is in flight and only snaps to 100 on the explicit `complete` signal,
 * so the user never sees a fake 100% before the result actually arrives.
 */
export const TIME_ESTIMATE_CAP = 95;

// Ease-out exponent. `1 − (1 − t)^EASE_EXPONENT` front-loads progress: the bar
// moves fast at the start (so it visibly responds immediately) and decelerates
// toward the cap. >1 makes it eased (not linear); 2.2 keeps the midpoint clearly
// ahead of a linear ramp while still leaving visible motion late in the run.
const EASE_EXPONENT = 2.2;

/**
 * Pure time-based estimate: elapsed seconds → integer percent.
 *
 * - 0 at elapsed 0; strictly increasing across the run window;
 * - EASED (ease-out) so the front of the run moves faster than a linear ramp;
 * - CAPPED at TIME_ESTIMATE_CAP (95) at and beyond EXPECTED_RUN_SECONDS — never
 *   100 from time alone (100 is owned by the `complete` marker).
 *
 * No timer / Date / DOM — the caller supplies elapsed seconds.
 */
export function deriveEstimatedPercent(elapsedSeconds: number): number {
  const t = Math.max(0, Math.min(1, elapsedSeconds / EXPECTED_RUN_SECONDS));
  const eased = 1 - Math.pow(1 - t, EASE_EXPONENT);
  return Math.round(eased * TIME_ESTIMATE_CAP);
}

/**
 * Forward-anchored combine: the displayed percent is the GREATER of the time
 * estimate and the marker-implied percent — so when a real section marker
 * arrives ahead of the time estimate the bar SNAPS FORWARD to it, and when the
 * time estimate is ahead a (late, behind) marker never pulls the bar backward.
 *
 * 100 is returned ONLY when the marker state is `done` (the explicit complete
 * signal); otherwise the result stays below 100 (the marker reducer caps at 99
 * and the time estimate caps at TIME_ESTIMATE_CAP).
 */
export function combineProgress(timePercent: number, markerState: ProgressState): number {
  if (markerState.done) return 100;
  return Math.max(timePercent, markerState.percent);
}
