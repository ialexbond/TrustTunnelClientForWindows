import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * `usePerConfigPing` — pings the INACTIVE configs' endpoints ON DEMAND (D-16 / manual-refresh)
 * so the Connection-tab cards show reachability bands. The former automatic 15 s interval loop is
 * GONE (owner's decision): there is NO on-mount ping and NO recurring re-measure. Instead the hook
 * exposes a `refreshPings()` that runs exactly ONE ping round over the CURRENT targets, triggered by
 * the manual «Обновить пинг» button next to «Добавить конфиг».
 *
 * What stays from the interval era:
 *   - the cancel-on-re-seed / unmount safety: a `cancelled` flag (flipped in the effect cleanup)
 *     short-circuits any in-flight round so a target-set change or unmount cannot let a stale probe
 *     write back after the fact (WR-06 — no separate once-guard needed);
 *   - WR-05 prune: on each target-set change, `pings` entries whose config id is no longer a target
 *     are dropped so the map stays bounded and a reused (migration-derived) id starts clean;
 *   - `invoke<PingResult>("ping_config_endpoint", { configPath, timeoutMs })` per config (the Rust side
 *     reads host:port from the config's own .toml — SSRF-safe).
 *
 * It returns `{ pings, refreshPings, pinging }`:
 *   - `pings` — a map of config id → resolved `ConfigPing` band the `ConfigPingPill` renders;
 *   - `refreshPings()` — run one manual ping round over the current targets (resolves when done);
 *   - `pinging` — true while a round is in flight (drives the button's spinner + disabled state).
 *
 * F23 / BUG-B (17-uat B2): the caller (`useConfigPingSource`) now includes the ACTIVE config in
 * `targets` too — the former F23/D-02 active-exclusion was REMOVED (owner wants the active card
 * refreshable on demand). While connected a direct probe of the active endpoint rides the tunnel
 * (~2× the real RTT / Unreachable — F26), so that live number is DISPLAY-ONLY; the auto-switch engine
 * never reads it (it consumes the FROZEN pre-connect band `useConfigPingSource.lastGoodByPath`). This
 * hook simply probes whatever `targets` it is given (active + inactive).
 */

// ─── Ping band types (PA-3: relocated from the presentation component) ────────────────────
//
// PA-3 (17-02): `PingBand` + `ConfigPing` live HERE, in the STATE module that produces them, not in
// `ConfigPingPill.tsx` (the presentation component that merely renders them). Before this move the
// hooks imported the type UPWARD from the component — a layer inversion (16-PATTERN-AUDIT §MAJOR-1):
// state should not depend on presentation. Now `ConfigPingPill` + every consumer imports these DOWNWARD
// from the state module (mirrors `ConfigSummary` living in `useConfigList.ts`). Pure relocation — the
// banding, `bandForMs`, and the five rendered states are byte-unchanged.

/** Ping colour band — mirrors the Rust `PingResult` discriminant + the design's D-16
 *  unmeasurable states. `green`/`yellow`/`red` carry a numeric value; `timeout`/`no-data`/
 *  `measuring` deliberately do NOT (that distinction is the whole point of D-16). */
export type PingBand = "green" | "yellow" | "red" | "timeout" | "no-data" | "measuring";

/** The resolved ping state for one config, as `usePerConfigPing` produces it. */
export interface ConfigPing {
  band: PingBand;
  /** Numeric round-trip in ms — present ONLY for green/yellow/red. */
  valueMs?: number;
  /** True while RE-measuring a config whose band is already known: the pill renders as a
   *  coloured Skeleton tinted to `band` instead of the value, then resolves to the new
   *  band. The standalone `measuring` band is the first-ever probe (grey skeleton). */
  measuring?: boolean;
}

/** The Rust `PingResult` discriminated union (serde tag = "status", kebab-case). Exported so the
 *  App-level tunnel-latency probe (`useConfigPingSource`) reuses the SAME shape + mapper — the active
 *  card and this inactive-ping loop then band identical readings (owner: "везде одинаково"). */
export type PingResult =
  | { status: "ok"; ms: number }
  | { status: "unreachable" }
  | { status: "no-data" };

/** Default per-probe TCP-connect timeout. A reachable endpoint answers well within this;
 *  a filtered/closed one reads Unreachable at the bound. */
export const PING_TIMEOUT_MS = 3000;

/** Map a numeric round-trip (ms) to a colour band. Owner-set thresholds (IN-22): ≤150 green
 *  / 151–300 yellow / >300 red. (Supersedes the D-16 100/300 proposal.) NOTE (T-30): the
 *  probe is endpoint reachability (DNS+TCP connect to the server), NOT real tunnel latency,
 *  so the value can read higher than the in-tunnel RTT until real latency lands.
 *  Exported (TA-1) so a boundary test can lock the exact owner-set 150/300 cutoffs — the
 *  green-only sample inputs elsewhere would let a `<=`→`<` or threshold-swap regression pass. */
export function bandForMs(ms: number): PingBand {
  if (ms <= 150) return "green";
  if (ms <= 300) return "yellow";
  return "red";
}

/** Map a Rust `PingResult` to the `ConfigPing` the pill renders. Exported so the active card's live
 *  tunnel-latency reading (`useConfigPingSource`) bands through the EXACT same thresholds — one mapper,
 *  identical bands whether the number came from an inactive direct probe or the active tunnel probe. */
export function toConfigPing(result: PingResult): ConfigPing {
  if (result.status === "ok") {
    return { band: bandForMs(result.ms), valueMs: result.ms };
  }
  if (result.status === "unreachable") {
    return { band: "timeout" };
  }
  return { band: "no-data" };
}

/** One config to ping: its id + the .toml path the Rust side reads host:port from. */
export interface PingTarget {
  id: string;
  path: string;
}

/** What the hook returns — the band map plus the manual-refresh trigger and its in-flight flag. */
export interface PerConfigPing {
  /** id → latest ConfigPing band the cards render. */
  pings: Record<string, ConfigPing>;
  /** Run ONE ping round over the current targets on demand. Resolves when the round settles. */
  refreshPings: () => Promise<void>;
  /** True while a manual round is in flight (drives the refresh button's spinner + disabled state). */
  pinging: boolean;
}

/**
 * Ping the given inactive configs ON DEMAND. Returns `{ pings, refreshPings, pinging }`.
 *
 * There is NO automatic ping — nothing fires on mount and there is no interval. The caller triggers a
 * round by calling `refreshPings()` (wired to the «Обновить пинг» button). Changing the target set
 * still prunes dead ids from `pings` (WR-05) and cancels any in-flight round, but does NOT itself
 * start a new one.
 *
 * @param targets the inactive configs to probe (id + path). The caller passes a STABLE array reference
 *   (or memoizes it) — a manual round re-derives from the latest targets via a ref, and the prune keys
 *   on the joined ids so adding/removing a config prunes cleanly without a stale-band flash.
 */
export function usePerConfigPing(targets: PingTarget[]): PerConfigPing {
  const [pings, setPings] = useState<Record<string, ConfigPing>>({});
  const [pinging, setPinging] = useState(false);

  // Latest targets, read inside a manual round without re-subscribing on every render. Written in an
  // effect (not during render) so the ref stays lint-clean; a round only reads it when invoked, so the
  // one-render lag is irrelevant.
  const targetsRef = useRef(targets);
  useEffect(() => {
    targetsRef.current = targets;
  });

  // A generation counter that a target-set change / unmount bumps. A manual round captures the
  // generation it started under; if the generation moves (re-seed or unmount) while a probe is in
  // flight, the round is `cancelled` and stops writing back. This replaces the interval era's
  // per-effect `cancelled` closure — there is no long-lived effect loop anymore, so the guard lives in
  // a ref shared by every round. (WR-06: same cancel-on-re-seed / unmount semantics, no once-guard.)
  const generationRef = useRef(0);

  // A stable key for the current target set — adding/removing a config changes it, so the prune effect
  // re-runs and drops dead ids; a pure re-render with the same ids does not.
  const targetsKey = targets
    .map((tg) => tg.id)
    .sort()
    .join("|");

  useEffect(() => {
    // Each target-set change starts a new generation, cancelling any in-flight round from the previous
    // set so a stale probe cannot write a band for an id that just left the list.
    generationRef.current += 1;

    // WR-05: prune `pings` entries whose config id is no longer a target. The map is keyed by id and
    // written with `{ ...prev, [id]: … }`, so without this a deleted config's last-known band would
    // linger until unmount — unbounded growth across add/delete churn, and a latent trap: migration ids
    // are path-derived and CAN recur, so a reclaimed id could briefly paint a stale band before its
    // first fresh probe. Dropping dead ids here keeps the map bounded to the live target set and
    // guarantees a reused id starts clean.
    const liveIds = new Set(targets.map((tg) => tg.id));
    setPings((prev) => {
      const next: Record<string, ConfigPing> = {};
      let changed = false;
      for (const [id, ping] of Object.entries(prev)) {
        if (liveIds.has(id)) {
          next[id] = ping;
        } else {
          changed = true; // a dead id is being dropped
        }
      }
      // Return the SAME reference when nothing was pruned so this does not cause an extra render.
      return changed ? next : prev;
    });

    return () => {
      // Unmount / next re-seed: bump the generation so any round still in flight stops writing back.
      generationRef.current += 1;
    };
    // `targets` is intentionally consumed via the serialized `targetsKey` dep (re-run only on a genuine
    // target-set change, not on every render that rebuilds an equal array).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetsKey]);

  // Run ONE ping round over the current targets. PP-7 (perf audit): coalesce the whole round into as
  // FEW setPings as possible — the interval era wrote per-target on every resolution (2N+ renders per
  // round); here each target resolves into a local `results` object and the round commits ONE merged
  // setPings at the end. An empty target set is a no-op (no state churn). Cancel-safe: a round captures
  // its generation and drops its result write if the generation moved (re-seed / unmount) meanwhile.
  const refreshPings = useCallback(async (): Promise<void> => {
    const current = targetsRef.current;
    if (current.length === 0) return;
    const myGeneration = generationRef.current;
    setPinging(true);
    try {
      const results = await Promise.all(
        current.map(async (tg): Promise<[string, ConfigPing]> => {
          try {
            const result = await invoke<PingResult>("ping_config_endpoint", {
              configPath: tg.path,
              timeoutMs: PING_TIMEOUT_MS,
            });
            return [tg.id, toConfigPing(result)];
          } catch {
            // A failed invoke (backend unavailable / bad path) reads honest no-data «—» (never red)
            // rather than surfacing a hard error on the card.
            return [tg.id, { band: "no-data" }];
          }
        }),
      );
      // Cancel guard: if the target set changed (or the hook unmounted) while this round was in flight,
      // discard the result entirely — writing it could paint a band for an id that just left the list.
      if (generationRef.current !== myGeneration) return;
      // PP-7: single merged commit for the whole round. Merge over `prev` (not a bare object) so a
      // target absent from `results` — impossible here since results covers `current`, but defensive —
      // keeps its prior band, and the prune effect owns removing dead ids.
      setPings((prev) => {
        const next = { ...prev };
        for (const [id, ping] of results) next[id] = ping;
        return next;
      });
    } finally {
      // Only the round that is still current owns clearing the flag — a superseded round leaves it to
      // whichever round is now live, so the button's spinner tracks the ACTIVE round, not a stale one.
      if (generationRef.current === myGeneration) setPinging(false);
    }
  }, []);

  return { pings, refreshPings, pinging };
}
