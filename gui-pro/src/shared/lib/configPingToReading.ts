import type { ConfigPing } from "../hooks/usePerConfigPing";

/**
 * A config's latest reachability reading — the same shape `ping_config_endpoint` produces.
 *
 * Phase 28 / plan 28-09: this type used to live in `shared/lib/decideAutoSwitch.ts`, the pure
 * decision heart of the retired frontend latency-polling engine. That file is gone (27 D-06 moved
 * failover into Rust, where it fires on a real loss of the tunnel instead of a measured band), so
 * the type moved HERE — to the module that produces `Reading` values — rather than to a new shared
 * file. `useConfigPingSource` re-exports nothing; it imports from this producer.
 */
export type Reading =
  | { status: "ok"; ms: number }
  | { status: "unreachable" }
  | { status: "no-data" };

/**
 * Map a presentation-layer `ConfigPing` (what `usePerConfigPing` resolves for the cards) to the
 * `Reading` shape (Phase 12 / 12-07).
 *
 * Why a mapper exists: `usePerConfigPing` already pings every INACTIVE config and stores the
 * result as a `ConfigPing` (a colour `band` + an optional numeric `valueMs`) for the pills.
 * `useConfigPingSource` reuses that SAME data for its per-config readings — there must be exactly
 * ONE inactive-ping loop (T-12-14) — so instead of pinging again we translate the stored band:
 *
 *   - green / yellow / red  → `{ status: "ok", ms }`   (a real round-trip; the colour band is a
 *                             presentation detail and is deliberately dropped here — only the
 *                             measured ms survives into a `Reading`).
 *   - timeout               → `{ status: "unreachable" }`  (endpoint did not answer in time).
 *   - no-data / missing     → `{ status: "no-data" }`      (never probed yet / honest no-data).
 *   - measuring             → treated as no-data: a re-measure in flight carries the PRIOR band on
 *                             the pill, but we conservatively report no-data until a fresh value
 *                             lands rather than presenting a stale number as current.
 *
 * Pure: no React, no invoke, no timers — a pure-fn module home, unit-testable in isolation.
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
