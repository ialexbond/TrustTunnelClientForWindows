import type { ConfigPing } from "../../components/connection/ConfigPingPill";
import type { Reading } from "./decideAutoSwitch";

/**
 * Map a presentation-layer `ConfigPing` (what `usePerConfigPing` resolves for the cards) BACK
 * to the decision `Reading` shape the pure `decideAutoSwitch` consumes (Phase 12 / 12-07).
 *
 * Why a mapper exists: `usePerConfigPing` already pings every INACTIVE config and stores the
 * result as a `ConfigPing` (a colour `band` + an optional numeric `valueMs`) for the pills. The
 * auto-switch engine's candidate list must reuse that SAME data — there must be exactly ONE
 * inactive-ping loop (T-12-14) — so instead of pinging again we translate the stored band:
 *
 *   - green / yellow / red  → `{ status: "ok", ms }`   (a real round-trip the engine can
 *                             compare against the threshold; the band itself is irrelevant to the
 *                             decision — only the ms matters, and decideAutoSwitch re-checks it).
 *   - timeout               → `{ status: "unreachable" }`  (endpoint did not answer in time).
 *   - no-data / missing     → `{ status: "no-data" }`      (never probed yet / honest no-data).
 *   - measuring             → treated as no-data: a re-measure in flight carries the PRIOR band on
 *                             the pill, but for a switch decision we conservatively report no-data
 *                             until a fresh value lands (never switch TO a config we are unsure of).
 *
 * Pure: no React, no invoke, no timers — mirrors `decideAutoSwitch.ts`'s pure-fn home so it is
 * unit-testable in isolation.
 */
export function configPingToReading(ping: ConfigPing | undefined): Reading {
  if (!ping) return { status: "no-data" };
  switch (ping.band) {
    case "green":
    case "yellow":
    case "red":
      // A numeric band always carries valueMs from usePerConfigPing; guard anyway so a
      // malformed entry degrades to no-data rather than emitting NaN to the decision.
      return typeof ping.valueMs === "number"
        ? { status: "ok", ms: ping.valueMs }
        : { status: "no-data" };
    case "timeout":
      return { status: "unreachable" };
    case "no-data":
    case "measuring":
    default:
      return { status: "no-data" };
  }
}
