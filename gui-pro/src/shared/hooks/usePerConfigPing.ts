import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ConfigPing, PingBand } from "../../components/connection/ConfigPingPill";

/**
 * `usePerConfigPing` — periodically pings the INACTIVE configs' endpoints (D-16 / D-23)
 * so the Connection-tab cards show live reachability bands. It mirrors the interval +
 * cancel-guard pattern of `useAutoConnect`:
 *   - a `cancelled` flag + `clearTimeout` in the effect cleanup (cancel on unmount), which
 *     is what actually makes StrictMode's mount→unmount→remount correct: the first loop's
 *     `cancelled` flag short-circuits all its in-flight + scheduled work, so the remount's
 *     fresh loop is the only one that survives (WR-06 — no separate once-guard needed),
 *   - `invoke<PingResult>("ping_config_endpoint", { configPath, timeoutMs })` per config
 *     (the Rust side reads host:port from the config's own .toml — SSRF-safe).
 *
 * It returns a map of config id → resolved `ConfigPing` band the `ConfigPingPill` renders.
 * The active/connected config is NOT pinged here — its live ping is the tunnel-side signal
 * carried by the lead card; the per-config probe is endpoint reachability for the others.
 *
 * The interval default is 15 s (D-23). The value is a local constant THIS phase; the
 * configurable «Авто-режим» setting that drives it is a later phase.
 */

/** The Rust `PingResult` discriminated union (serde tag = "status", kebab-case). */
type PingResult =
  | { status: "ok"; ms: number }
  | { status: "unreachable" }
  | { status: "no-data" };

/** D-23 default re-measure cadence. Local constant this phase. */
export const PING_INTERVAL_MS = 15000;

/** Default per-probe TCP-connect timeout. A reachable endpoint answers well within this;
 *  a filtered/closed one reads Unreachable at the bound. */
export const PING_TIMEOUT_MS = 3000;

/** IN-37: only show the «measuring» skeleton if a re-measure takes LONGER than this. A fast probe
 *  (the common case) updates the value in place — so the pill no longer flickers a skeleton on
 *  every interval (the owner found the flicker distracting). */
export const SKELETON_DELAY_MS = 1000;

/** Map a numeric round-trip (ms) to a colour band. Owner-set thresholds (IN-22): ≤150 green
 *  / 151–300 yellow / >300 red. (Supersedes the D-16 100/300 proposal.) NOTE (T-30): the
 *  probe is endpoint reachability (DNS+TCP connect to the server), NOT real tunnel latency,
 *  so the value can read higher than the in-tunnel RTT until real latency lands. */
function bandForMs(ms: number): PingBand {
  if (ms <= 150) return "green";
  if (ms <= 300) return "yellow";
  return "red";
}

/** Map a Rust `PingResult` to the `ConfigPing` the pill renders. */
function toConfigPing(result: PingResult): ConfigPing {
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

/**
 * Ping the given inactive configs on an interval. Returns `{ id → ConfigPing }`.
 *
 * @param targets the inactive configs to probe (id + path). The caller passes a STABLE
 *   array reference (or memoizes it) — the loop re-derives from the latest targets each
 *   tick via a ref, so changing the list does not restart the interval, but the effect
 *   keys on the joined ids so adding/removing a config does re-seed the loop cleanly.
 */
export function usePerConfigPing(targets: PingTarget[]): Record<string, ConfigPing> {
  const [pings, setPings] = useState<Record<string, ConfigPing>>({});

  // Latest targets, read inside the loop without restarting the interval on every render.
  // Written in an effect (not during render) so the ref stays lint-clean; the loop only
  // reads it on the next tick, so the one-render lag is irrelevant.
  const targetsRef = useRef(targets);
  useEffect(() => {
    targetsRef.current = targets;
  });

  // A stable key for the current target set — adding/removing a config changes it, so the
  // effect re-runs and re-seeds the loop; a pure re-render with the same ids does not.
  const targetsKey = targets
    .map((tg) => tg.id)
    .sort()
    .join("|");

  useEffect(() => {
    // WR-06: the previous `startedKeyRef` once-guard was DEAD — the cleanup reset it to
    // null on EVERY unmount, so on StrictMode's mount→unmount→remount the remount saw
    // `null !== targetsKey` and started a second loop anyway. Only the first loop's
    // `cancelled` flag (set in its cleanup) made that correct. So the guard added surface
    // without doing its stated job; it is removed. The `cancelled` flag below + the
    // `[targetsKey]` dep already give the right semantics: a remount/genuine target change
    // cancels the prior loop and starts exactly one fresh loop.
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // WR-05: prune `pings` entries whose config id is no longer a target. `pings` only ever
    // GREW (keyed by id, written with `{ ...prev, [id]: … }`), so a deleted config's last-known
    // band lingered in state until unmount — unbounded growth across add/delete churn, and a
    // latent trap: migration ids are path-derived and CAN recur, so a reclaimed id could briefly
    // paint a stale band before its first fresh probe. Dropping dead ids on each re-seed keeps
    // the map bounded to the live target set and guarantees a reused id starts clean.
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

    const pingAll = async () => {
      const current = targetsRef.current;
      // Probe each target; resolve all before scheduling the next tick so a slow probe
      // does not pile up overlapping rounds.
      await Promise.all(
        current.map(async (tg) => {
          // IN-37: do NOT flash the «measuring» skeleton immediately — only if the probe takes
          // LONGER than SKELETON_DELAY_MS. A fast re-measure (the common case) just updates the
          // value in place, so the pill no longer flickers a skeleton on every interval. The
          // timer keeps the prior band's tint via the pill while it shows.
          const skeletonTimer = setTimeout(() => {
            if (cancelled) return;
            setPings((prev) => ({
              ...prev,
              [tg.id]: { ...(prev[tg.id] ?? { band: "no-data" }), measuring: true },
            }));
          }, SKELETON_DELAY_MS);
          try {
            const result = await invoke<PingResult>("ping_config_endpoint", {
              configPath: tg.path,
              timeoutMs: PING_TIMEOUT_MS,
            });
            clearTimeout(skeletonTimer);
            // WR-06 (gap 1): if cancelled mid-probe, do NOT leave the card stuck showing
            // the «measuring» skeleton — clear the measuring flag (keeping the prior band)
            // so the card settles instead of spinning until the next genuine re-seed.
            if (cancelled) {
              setPings((prev) =>
                prev[tg.id]?.measuring
                  ? { ...prev, [tg.id]: { ...prev[tg.id], measuring: false } }
                  : prev,
              );
              return;
            }
            // toConfigPing carries no `measuring`, so this also clears the skeleton if it showed.
            setPings((prev) => ({ ...prev, [tg.id]: toConfigPing(result) }));
          } catch {
            clearTimeout(skeletonTimer);
            // A failed invoke (backend unavailable / bad path) reads honest no-data «—»
            // (never red) rather than surfacing a hard error on the card.
            if (cancelled) {
              // Same as the success path: clear the measuring flag on cancel so the card
              // does not stick on the spinner (WR-06 gap 1).
              setPings((prev) =>
                prev[tg.id]?.measuring
                  ? { ...prev, [tg.id]: { ...prev[tg.id], measuring: false } }
                  : prev,
              );
              return;
            }
            setPings((prev) => ({ ...prev, [tg.id]: { band: "no-data" } }));
          }
        }),
      );
    };

    const loop = async () => {
      if (cancelled) return;
      await pingAll();
      if (cancelled) return;
      timer = setTimeout(() => void loop(), PING_INTERVAL_MS);
    };

    void loop();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // `targets` is intentionally consumed via the serialized `targetsKey` dep (re-run only on a
    // genuine target-set change, not on every render that rebuilds an equal array).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetsKey]);

  return pings;
}
