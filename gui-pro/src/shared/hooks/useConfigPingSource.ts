import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConfigList, type ConfigSummary } from "./useConfigList";
import { usePerConfigPing, toConfigPing, type PingTarget } from "./usePerConfigPing";
import { configPingToReading } from "../lib/configPingToReading";
import type { ConfigPing } from "../../components/connection/ConfigPingPill";
import type { Candidate } from "../lib/decideAutoSwitch";
import { samePath } from "../utils/samePath";
import { dedupeConfigsByIdentity } from "../utils/dedupeConfigsByIdentity";
import type { VpnStatus } from "../types";

/**
 * `useConfigPingSource` — the SINGLE App-level source of the multi-config list + the inactive-ping
 * loop (Phase 12 / 12-07).
 *
 * Background: before this hook, `ConnectionPanel` owned BOTH `useConfigList` and `usePerConfigPing`
 * internally. The auto-switch engine (`useAutoSwitch`) also needs that exact data — the inactive
 * configs in priority order with their latest ping reading — to build its candidate list. Running a
 * SECOND `usePerConfigPing` for the engine would mean two inactive-ping loops fanning out the same
 * probes (T-12-14, a self-DoS). So the App now owns ONE loop here and feeds both consumers:
 *   - ConnectionPanel receives `configs`/`pings`/`reload`/`refresh`/`loading` as props (it falls
 *     back to its own internal hooks only when these are NOT supplied — keeps its unit tests intact).
 *   - useAutoSwitch receives the derived `candidates` (priority-ordered inactive configs + readings).
 *
 * It mirrors ConnectionPanel's prior derivation exactly so the cards and the engine agree on the
 * same identity-collapsed list and the same target set:
 *   - `dedupeConfigsByIdentity` collapses same-server (host+user) twins before pinging (11-UAT gap A),
 *     active-path-aware so the connected file wins;
 *   - the ping targets are memoized on the joined id|path so a pure re-render does not restart the
 *     loop (usePerConfigPing keys on the target set internally too).
 *
 * The candidate list (D-02) is the dedup'd configs MINUS the active one, sorted by manifest `order`,
 * each joined with its latest reading mapped back from the pill's `ConfigPing` (configPingToReading).
 * The engine walks this top-down and switches to the first reachable+below-threshold config.
 */
export interface ConfigPingSource {
  /** Identity-collapsed config list (the exact set the cards render + the engine considers). */
  configs: ConfigSummary[];
  /** id → latest ConfigPing band, the SAME map the cards render. */
  pings: Record<string, ConfigPing>;
  /** Re-fetch the manifest list WITH the loading skeleton (initial/explicit). */
  reload: () => Promise<void>;
  /** Re-fetch the manifest list SILENTLY (no skeleton). */
  refresh: () => Promise<void>;
  /** First-load skeleton flag. */
  loading: boolean;
  /** Priority-ordered (manifest order) INACTIVE configs + their latest reading — for the engine. */
  candidates: Candidate[];
  /**
   * F29: seed a config's retained pre-connect band directly (path + numeric ms), bypassing the probe
   * loop. Used on AUTO-CONNECT-ON-LAUNCH (and a manual connect right after launch) where the VPN
   * connects BEFORE the background probe loop has a warm reading — `useAutoConnect` already measures the
   * config's honest DIRECT RTT right before `vpn_connect` (for the notification plate); this delivers
   * that SAME number into the freeze cache so the connected card shows the real ping instead of «—» or a
   * cold-boot 200/500. Honest (a direct pre-connect measurement, never through-tunnel) and it makes the
   * card + the notification agree.
   */
  seedRetainedPing: (path: string, ms: number) => void;
}

/**
 * @param activeConfigPath the currently-active config path (excluded from candidates; also feeds
 *   the active-aware dedup so the connected twin wins).
 * @param status the live VPN status. F24/F26: while the tunnel is up NO config is probed (any probe
 *   either rides the tunnel and reads garbage, or bypasses it entirely — there is no honest in-tunnel
 *   RTT available to this process), so EVERY card (active included) is FROZEN at its last pre-connect
 *   reachability. While disconnected every config is probed directly so live pre-connect RTTs fill the
 *   cache + show on the cards.
 */
export function useConfigPingSource(activeConfigPath: string, status: VpnStatus): ConfigPingSource {
  const { configs, reload, refresh, loading } = useConfigList();

  // F24 (14-UAT round 3): while a tunnel is UP, a direct probe of ANY endpoint rides the tunnel and reads
  // garbage (active ≈ 2× / Unreachable; inactive fluctuates wildly). So while up we probe nothing and
  // freeze every card at its pre-connect value. While DISCONNECTED (or error) all configs ARE probed
  // directly — the honest pre-connect RTT that fills lastGoodByPath and shows on the cards.
  const tunnelUp = status !== "disconnected" && status !== "error";

  // F26 (14-UAT round 3): there is NO live "tunnel ping". The former `probe_tunnel_latency` (a reference
  // host on :443 probed while connected) does NOT actually traverse the tunnel from this process — the
  // prebuilt C++ core owns routing/killswitch and exposes no in-tunnel RTT, and depending on the user's
  // split-tunnel mode the probe to 8.8.8.8 rides the tunnel OR goes straight to the internet. The owner
  // caught it: connected read «14 ms» while the server's DIRECT pre-connect RTT was 69 ms — a through-
  // tunnel path is bounded BELOW by the client→server leg, so 14 < 69 proves the probe bypassed the
  // tunnel (it measured the client's direct latency to Google, not the tunnel). We cannot honestly
  // measure the tunnel's latency from here, so we do NOT show a fake live number: while connected EVERY
  // card (active included) is frozen at its honest pre-connect reachability.

  // Active-path-aware identity collapse — same rule ConnectionPanel applied internally, lifted
  // here so the cards (fed these configs as a prop) and the engine see the identical set.
  const visibleConfigs = useMemo(
    () => dedupeConfigsByIdentity(configs, activeConfigPath),
    [configs, activeConfigPath],
  );

  // Ping targets, memoized on the joined id|path so a pure re-render does not re-seed the loop.
  // F24 (14-UAT round 3): while the tunnel is UP, probe NOTHING directly. A direct probe of ANY
  // endpoint — active OR inactive — travels THROUGH the current tunnel (client → active VPN server →
  // that endpoint), so it reads garbage: the active endpoint IS the server (~2× / Unreachable), and an
  // inactive endpoint reads tunnel-latency + a random detour that FLUCTUATES wildly (the owner saw the
  // inactive cards flip «Недоступен» → 586 мс → 207 мс → 2000 мс during a switch). You physically cannot
  // measure another server's real ping while riding your own tunnel. So while connected we freeze every
  // card (active included) at its last pre-connect reachability (lastGoodByPath) and stop probing (F26:
  // there is no honest live tunnel number to show instead). While DISCONNECTED all configs ARE probed
  // directly (honest pre-connect RTT — fills the cache + shows live). `tunnelUp` in the dep re-seeds the
  // loop on connect/disconnect.
  const targets: PingTarget[] = useMemo(
    () =>
      tunnelUp ? [] : visibleConfigs.map((c) => ({ id: c.id, path: c.path })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restart only when the set / tunnel state changes
    [visibleConfigs.map((c) => `${c.id}:${c.path}`).join("|"), tunnelUp],
  );
  const pings = usePerConfigPing(targets);

  // F23/F24: cache each config's LAST-KNOWN good DIRECT reading (a numeric band measured while probed —
  // i.e. while disconnected), keyed by path. While the tunnel is up NOTHING is probed, so this retained
  // value is what EVERY inactive card shows (frozen pre-connect reachability) and what the active card
  // shows as a bridge until the first live tunnel-latency reading lands. Updated in an effect (no render
  // side-effect); the one-render lag is harmless because these values only serve while connected/bridging.
  const lastGoodByPath = useRef<Record<string, ConfigPing>>({});
  useEffect(() => {
    // Record each config's latest numeric direct band (measured while it was probed — i.e. inactive,
    // or the selected config while disconnected).
    for (const c of visibleConfigs) {
      const p = pings[c.id];
      if (p && typeof p.valueMs === "number") {
        lastGoodByPath.current[c.path] = { band: p.band, valueMs: p.valueMs };
      }
    }
    // F23: invalidate entries whose path left the config list (deleted config), so a REUSED path
    // (delete X, import a different server Y at the same filename) never serves X's retained RTT to
    // Y's card/engine. Mirrors usePerConfigPing's WR-05 prune of the id-keyed pings map.
    // Fable R2 review (MINOR): SKIP the prune when the list is transiently EMPTY. useConfigList.reload()'s
    // catch does setConfigs([]) on a failed list_configs invoke; without this guard a single failed
    // reload while connected would wipe the WHOLE cache — including the connected active config's
    // retained pre-connect RTT, which BRIDGES the card until the first live tunnel-latency reading lands
    // (and covers the connecting/reconnecting phases). An empty list is never a real "all configs
    // deleted" state worth pruning.
    const live = new Set(visibleConfigs.map((c) => c.path));
    if (live.size > 0) {
      for (const path of Object.keys(lastGoodByPath.current)) {
        if (!live.has(path)) delete lastGoodByPath.current[path];
      }
    }
  }, [pings, visibleConfigs]);

  // F29 (14-UAT round 3): seed a config's retained band directly. On AUTO-CONNECT-ON-LAUNCH the VPN
  // connects FASTER than the background probe loop gets a warm reading, so at the connecting→connected
  // freeze the cache is either EMPTY (the in-flight probe was cancelled by the re-seed) → card «—», or
  // holds a cold-boot 200/500 (the one round that raced OS startup measured cold DNS + first TCP on a
  // just-woken network) → frozen wrong for the whole session. `useAutoConnect` ALREADY measures the
  // config's honest DIRECT RTT right before `vpn_connect` (after `network_ready`, for the notification
  // plate) — this delivers that best-available number into `lastGoodByPath` so the card shows the real
  // ping. `seedVersion` bumps a state so the `patchedPings` / `candidates` memos (whose deps —
  // pings/visibleConfigs/tunnelUp — do NOT change on the connecting→connected transition) recompute and
  // actually SHOW the seeded value; without it the ref write would be invisible past the freeze. One
  // extra render per connect — no storm. Stays honest: a direct pre-connect measurement, never
  // through-tunnel (the cancel-on-re-seed invariant in usePerConfigPing already blocks any probe that
  // could have resolved after the tunnel started forming).
  const [seedVersion, setSeedVersion] = useState(0);
  const seedRetainedPing = useCallback((path: string, ms: number) => {
    lastGoodByPath.current[path] = toConfigPing({ status: "ok", ms });
    setSeedVersion((v) => v + 1);
  }, []);

  // F24/F26 (14-UAT round 3): build the card ping map.
  //   - DISCONNECTED: `pings` already holds live DIRECT probes for every card — use as-is (bridged).
  //   - CONNECTED (tunnel up): no honest probe is possible (every probe rides the tunnel or bypasses it —
  //     see F26 above), so we probed nothing → `pings` is empty. FREEZE EVERY card (active included) at its
  //     last pre-connect reachability (`lastGoodByPath`) so the list shows the same honest low numbers it
  //     did before connecting, instead of a fake live tunnel number or fluctuating garbage. A config with
  //     no retained value is simply absent → honest «—».
  const patchedPings = useMemo(() => {
    if (!tunnelUp) {
      // DISCONNECTED. `pings` holds the live direct probes — but right after a disconnect they are all
      // still empty (the connected-time freeze ran with targets=[] → usePerConfigPing pruned to {}), so
      // without a bridge every card would flash «—» for 1–3 s until the first fresh probe lands (Fable R4
      // MINOR). Seed each config that has no fresh reading YET from its retained pre-connect band, marked
      // `measuring` so it reads as re-checking (a coloured shimmer at the prior band) rather than a stale
      // final value; the live probe overwrites it the moment it resolves.
      let bridged: Record<string, ConfigPing> | null = null;
      for (const c of visibleConfigs) {
        if (pings[c.id]) continue;
        const retained = lastGoodByPath.current[c.path];
        if (!retained) continue;
        if (!bridged) bridged = { ...pings };
        bridged[c.id] = { ...retained, measuring: true };
      }
      return bridged ?? pings;
    }
    // CONNECTED (tunnel up). Freeze EVERY card — active and inactive alike — at its retained pre-connect
    // band. No live probe, no fake tunnel number.
    const next: Record<string, ConfigPing> = {};
    for (const c of visibleConfigs) {
      const retained = lastGoodByPath.current[c.path];
      if (retained) next[c.id] = retained;
    }
    return next;
    // F29: `seedVersion` forces THIS memo to recompute after a post-freeze `seedRetainedPing` ref write —
    // the other deps do not change on the connecting→connected transition, so without it the seeded active
    // card would stay «—». It is not read in the body, so exhaustive-deps calls it "unnecessary"; it is
    // exactly the intended recompute trigger, so the rule is disabled for this deps line.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pings, visibleConfigs, tunnelUp, seedVersion]);

  // D-02 candidate list: inactive configs in manifest order, each with its latest reading. The engine
  // consumes this only while connected+masterOn; when off it is harmlessly ignored.
  // F24 (14-UAT round 3): while CONNECTED feed the engine the STABLE frozen pre-connect reachability
  // (lastGoodByPath — the same number the card shows), NEVER the live through-tunnel probe. The live
  // probe is garbage while connected (rides the tunnel, fluctuates 190↔600 ms), so basing a switch
  // decision on it caused false verdicts; the frozen pre-connect reachability is the best STABLE proxy
  // for a candidate's quality. While DISCONNECTED the live direct probe is honest (and the engine is
  // inert anyway).
  const candidates: Candidate[] = useMemo(
    () =>
      visibleConfigs
        .filter((c) => !samePath(c.path, activeConfigPath))
        .sort((a, b) => a.order - b.order)
        .map((c) => ({
          path: c.path,
          order: c.order,
          reading: configPingToReading(tunnelUp ? lastGoodByPath.current[c.path] : pings[c.id]),
        })),
    // lastGoodByPath is a ref (frozen while connected); the tunnelUp flip + pings change re-derive this at
    // the connect boundary. F29: NO seedVersion here on purpose — a seeded path is always the ACTIVE
    // config, which is filtered OUT of candidates, so a seed never changes this list.
    [visibleConfigs, activeConfigPath, pings, tunnelUp],
  );

  return {
    configs: visibleConfigs,
    pings: patchedPings,
    reload,
    refresh,
    loading,
    candidates,
    seedRetainedPing,
  };
}
