import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConfigList, type ConfigSummary } from "./useConfigList";
import { usePerConfigPing, toConfigPing, type PingTarget, type ConfigPing } from "./usePerConfigPing";
import { configPingToReading } from "../lib/configPingToReading";
import type { Candidate, Reading } from "../lib/decideAutoSwitch";
import { samePath, normalizePath } from "../utils/samePath";
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
  /**
   * Manually ping every visible config's endpoint ONCE (the «Обновить пинг» button next to «Добавить
   * конфиг»). There is no automatic ping — this is the ONLY way a fresh reachability reading lands.
   * While a tunnel is up the target set still includes every card (BUG-B B2 removed the active-exclusion),
   * so a round DOES measure them — the active reading is then tunnel-routed (F26), display-only, and never
   * drives an auto-switch (the engine reads the frozen pre-connect band).
   */
  refreshPings: () => Promise<void>;
  /** True while a manual ping round is in flight (drives the refresh button's spinner + disabled state). */
  pinging: boolean;
  /** First-load skeleton flag. */
  loading: boolean;
  /** Priority-ordered (manifest order) INACTIVE configs + their latest reading — for the engine. */
  candidates: Candidate[];
  /**
   * PA-2 (17-02): the ACTIVE config's FROZEN pre-connect reachability reading — the honest band the
   * auto-switch engine evaluates for a breach, REPLACING the dishonest through-tunnel `probe_tunnel_latency`.
   * While connected this is the retained `lastGoodByPath` band for `activeConfigPath` (the SAME number the
   * active card shows AT REST — D-02; a manual «Обновить пинг» while connected can surface a live
   * tunnel-routed number on the CARD, but the engine always reads THIS frozen band). While disconnected it
   * is the live direct probe (the engine is inert then anyway). No config carries the password (D-29).
   */
  activeReading: Reading;
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
  /**
   * G-19-PING v2: read a config's CURRENT retained pre-connect band (ms) straight from the live
   * `lastGoodByPath` ref — the SAME honest number the card shows AT REST — or `null` when none is
   * cached. Unlike the `pings`/`patchedPings` snapshot a caller closes over (which can lag one render
   * behind during a synchronous switch+revert), this reads the REF, so it is always current. The
   * D-05 revert uses it to restore A's ping WITHOUT a fresh probe — a fresh probe of the reverted-to
   * server fails through the just-failed B's killswitch (→ «—»); the frozen band is the honest value.
   */
  getRetainedPing: (path: string) => number | null;
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
  // Owner (2026-07-05): ping is now MANUAL-only (the «Обновить пинг» button), so the old F24/F26
  // reason for targets=[] while connected (an AUTO loop pinging through the tunnel and flapping the
  // inactive cards) no longer applies — nothing pings unless the user explicitly clicks. So targets
  // include the INACTIVE cards even while connected: a manual click measures them. The number is
  // tunnel-routed when connected (still not an honest RTT — F26), but the owner asked to see a live
  // measurement on demand. The engine still consumes the FROZEN pre-connect band (candidates below), so
  // this manual live number never drives an auto-switch decision.
  //
  // BUG-B (17-uat) B2: the ACTIVE endpoint is now IN the manual-refresh target set while connected too
  // (the D-02 exclusion is REMOVED), so «Обновить пинг» measures it on demand like the inactive cards —
  // the owner tested live and wants the active card to show a number on all paths AND be refreshable.
  // The connected active probe rides the tunnel to itself, so it can read Unreachable/garbage (F26); the
  // patchedPings CONNECTED branch below therefore FALLS BACK to the retained honest band whenever the
  // active card's live reading is NOT a numeric value (Unreachable / no-data), so a connected server can
  // NEVER regress to «Недоступен» (the original PING-IP tail bug). A NUMERIC live reading DOES show (the
  // owner wants to see it). The auto-switch ENGINE still reads the FROZEN band (candidates/activeReading
  // below), so this live active number never drives a switch decision. While DISCONNECTED every card is
  // probed directly — the honest pre-connect RTT.
  // Stable key for the visible set — extracted so the exhaustive-deps rule can statically check the
  // memo's dep array (a complex expression inline trips the lint rule).
  // PP-8 (17-07, n-8): memoized on `visibleConfigs` so the `.map().join()` over every config is NOT
  // rebuilt on each render (a ping tick / a pure parent re-render). `visibleConfigs` is itself a
  // useMemo, so this recomputes only when the config set (id/path) actually changes.
  const visibleConfigsKey = useMemo(
    () => visibleConfigs.map((c) => `${c.id}:${c.path}`).join("|"),
    [visibleConfigs],
  );
  const targets: PingTarget[] = useMemo(
    () => visibleConfigs.map((c) => ({ id: c.id, path: c.path })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restart only when the visible set changes
    [visibleConfigsKey],
  );
  // Manual ping: `usePerConfigPing` no longer pings automatically (no on-mount, no interval — owner's
  // decision). `refreshPings` runs ONE round over the current targets on demand (the «Обновить пинг»
  // button); `pinging` drives the button spinner. The band map still feeds the cards + the engine.
  const { pings, refreshPings, pinging } = usePerConfigPing(targets);

  // F23/F24: cache each config's LAST-KNOWN good DIRECT reading (a numeric band measured while probed —
  // i.e. while disconnected), keyed by path. While the tunnel is up NOTHING is probed, so this retained
  // value is what EVERY inactive card shows (frozen pre-connect reachability) and what the active card
  // shows as a bridge until the first live tunnel-latency reading lands. Updated in an effect (no render
  // side-effect); the one-render lag is harmless because these values only serve while connected/bridging.
  //
  // F2 (17-REVIEW): the cache key is the NORMALIZED path (`normalizePath` — the SAME form `samePath`
  // compares). The active-config path arrives from localStorage `tt_config_path` (tray adopt / deeplink /
  // legacy writers) in a DIFFERENT string form than the manifest `c.path` (`\` vs `/`, drive-letter case)
  // for the SAME file. Keying + reading raw let `activeReading`/`candidates` look up a form that never
  // matched a write site → `undefined` → `no-data` every tick → the auto-switch engine returns before
  // `decideAutoSwitch` (silently dead) while the UI claims it is armed. Normalizing every write + read
  // guarantees the seed-path form and the manifest-path form can never diverge.
  const lastGoodByPath = useRef<Record<string, ConfigPing>>({});

  // F1 (17-REVIEW): the through-tunnel POISON boundary. A manual «Обновить пинг» while CONNECTED probes
  // the inactive endpoints THROUGH the tunnel (F26 — not an honest RTT), writing tunnel-routed values
  // into `pings`. The cache-write effect's `if (!tunnelUp)` guard only checks the CURRENT status, so on
  // the `tunnelUp true→false` flip it re-runs with the STALE connected-time `pings` still present, the
  // guard now passes, and it would flush every through-tunnel value into `lastGoodByPath` as a fake
  // "honest DIRECT" band — the exact 14-vs-69 fake-number class the phase retired. Ping is manual-only,
  // so nothing overwrites the poison before a reconnect → the frozen card + the PA-2 candidate band show
  // the fake number all session.
  //
  // Airtight fix: remember, by REFERENCE, each `pings[id]` object that was observed while `tunnelUp`.
  // `usePerConfigPing` produces a FRESH object per resolved probe (`toConfigPing`), so on disconnect a
  // genuinely new DIRECT probe yields a DIFFERENT reference while the lingering through-tunnel reading
  // keeps its old one. The cache-write effect then skips any `pings[id]` whose reference still equals its
  // tainted object (never cache the tunnel value), and drops the taint the moment a fresh honest object
  // replaces it. This preserves the honest disconnected-state caching untouched.
  const tunnelTaintedById = useRef<Map<string, ConfigPing>>(new Map());
  useEffect(() => {
    if (tunnelUp) {
      // While connected, any value in `pings` is a through-tunnel manual reading — mark it tainted by
      // reference so the flip-time cache-write can recognise and refuse it.
      for (const c of visibleConfigs) {
        const p = pings[c.id];
        if (p) tunnelTaintedById.current.set(c.id, p);
      }
    }
    // Record each config's latest numeric DIRECT band — but ONLY while DISCONNECTED. A manual ping
    // while connected (now possible — targets always include every card) travels through the tunnel
    // (F26), so it is NOT an honest pre-connect RTT; caching it would poison the frozen band the engine
    // and the post-disconnect bridge rely on. So skip the cache write while tunnelUp — the tunnel-routed
    // number is shown live on the card (patchedPings below) but never becomes the retained "good" value.
    if (!tunnelUp) {
      for (const c of visibleConfigs) {
        const p = pings[c.id];
        if (!p || typeof p.valueMs !== "number") continue;
        // F1: refuse to cache a value that is STILL the through-tunnel object recorded while connected
        // (same reference). A fresh disconnected probe produces a NEW object → it is not tainted → cache
        // it and clear the taint so future rounds for this id cache normally.
        if (tunnelTaintedById.current.get(c.id) === p) continue;
        tunnelTaintedById.current.delete(c.id);
        // F2: key by NORMALIZED path so every read site (activeReading/candidates/patchedPings) —
        // whichever path form it holds — resolves this entry.
        lastGoodByPath.current[normalizePath(c.path)] = { band: p.band, valueMs: p.valueMs };
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
    // F2: the cache is keyed by normalized path, so compare against the normalized live set.
    const live = new Set(visibleConfigs.map((c) => normalizePath(c.path)));
    if (live.size > 0) {
      for (const path of Object.keys(lastGoodByPath.current)) {
        if (!live.has(path)) delete lastGoodByPath.current[path];
      }
    }
    // F1: keep the taint map bounded to the live id set (mirrors usePerConfigPing's WR-05 prune) so a
    // removed config's tainted reference can never linger. Only when the list is non-empty (same
    // transient-empty guard as above).
    if (visibleConfigs.length > 0) {
      const liveIds = new Set(visibleConfigs.map((c) => c.id));
      for (const id of tunnelTaintedById.current.keys()) {
        if (!liveIds.has(id)) tunnelTaintedById.current.delete(id);
      }
    }
  }, [pings, visibleConfigs, tunnelUp]);

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
    // F2: normalize the seed key so `useAutoConnect`'s path form (whatever it passes) lands under the
    // SAME key the manifest-path read sites resolve — otherwise a seeded-but-unnormalized entry would be
    // invisible to activeReading/candidates and the seeded card would still read «—».
    lastGoodByPath.current[normalizePath(path)] = toConfigPing({ status: "ok", ms });
    setSeedVersion((v) => v + 1);
  }, []);

  // G-19-PING v2: read the live frozen band for a path from the ref (never a memo snapshot), under the
  // SAME normalized key seedRetainedPing / the effect at line ~217 write. Returns the numeric ms or null.
  const getRetainedPing = useCallback((path: string): number | null => {
    const retained = lastGoodByPath.current[normalizePath(path)];
    return retained && typeof retained.valueMs === "number" ? retained.valueMs : null;
  }, []);

  // F24/F26 (14-UAT round 3): build the card ping map.
  //   - DISCONNECTED: `pings` already holds live DIRECT probes for every card — use as-is (bridged).
  //   - CONNECTED (tunnel up): a manual «Обновить пинг» DOES probe every card now (BUG-B B2 removed the
  //     active-exclusion), but a connected probe rides the tunnel (F26) so it is display-only. Show a
  //     NUMERIC live reading when present; otherwise fall back to the retained pre-connect band
  //     (`lastGoodByPath`) so the list keeps the same honest low numbers it had before connecting — and the
  //     ACTIVE card never regresses to «Недоступен»/«—» while you are connected to it. A card with no live
  //     and no retained value is simply absent → honest «—».
  const patchedPings = useMemo(() => {
    if (!tunnelUp) {
      // DISCONNECTED. `pings` holds the live direct probes — but right after a disconnect a card may still
      // have no fresh DIRECT reading yet (nothing was probed since connect, or its entry was pruned on a
      // target-set change), so without a bridge such a card would flash «—» until the next reading lands.
      // Seed any config that has no fresh reading YET from its retained pre-connect band.
      //
      // F3 (17-REVIEW): bridge it as a SETTLED value — `measuring:true` ONLY while a manual round is
      // actually in flight (`pinging`). The former unconditional `measuring:true` assumed an auto-probe
      // loop would overwrite it "the moment it resolves"; that loop is GONE (ping is manual-only), so the
      // active card — pruned at connect, re-entering targets with no entry on disconnect — was left in an
      // INDEFINITE shimmer (no number) after EVERY disconnect until the user manually refreshed. Gating on
      // `pinging` shows the retained band as a settled number at rest and only shimmers during a real round,
      // honouring D-02's own "no «—»/measuring flash" promise.
      let bridged: Record<string, ConfigPing> | null = null;
      for (const c of visibleConfigs) {
        if (pings[c.id]) continue;
        const retained = lastGoodByPath.current[normalizePath(c.path)]; // F2: read the normalized key
        if (!retained) continue;
        if (!bridged) bridged = { ...pings };
        bridged[c.id] = pinging ? { ...retained, measuring: true } : retained;
      }
      return bridged ?? pings;
    }
    // CONNECTED (tunnel up). Show a LIVE manual measurement when the user pressed «Обновить пинг»
    // (targets now include every card even connected, so a manual round populates `pings`) — the owner
    // wants to see a fresh number on demand. Otherwise (no manual refresh since connect) freeze the card
    // at its retained pre-connect band. The live connected number is tunnel-routed (F26) and is
    // display-only — the engine still reads the frozen band (candidates below).
    const next: Record<string, ConfigPing> = {};
    const activeConfig = visibleConfigs.find((c) => samePath(c.path, activeConfigPath));
    for (const c of visibleConfigs) {
      const live = pings[c.id];
      const retained = lastGoodByPath.current[normalizePath(c.path)]; // F2: read the normalized key
      // BUG-B (17-uat) B2: the ACTIVE card is now IN targets, so a connected manual refresh CAN read it as
      // Unreachable/garbage through its own tunnel (F26). The user is literally connected to this server,
      // so the active card must NEVER regress to «Недоступен»/«—»: if the live reading is NOT a numeric
      // value (Unreachable / no-data / absent), FALL BACK to the retained honest pre-connect band. A
      // NUMERIC live reading DOES show (the owner wants to see a real on-demand number). Inactive cards
      // keep the prior behaviour (live ?? retained). Matched by identity to the resolved active config.
      const isActive = activeConfig !== undefined && c.id === activeConfig.id;
      if (isActive) {
        const liveNumeric = live && typeof live.valueMs === "number";
        if (liveNumeric) next[c.id] = live;
        else if (retained) next[c.id] = retained;
        else if (live) next[c.id] = live; // no retained bridge yet → show whatever live we have (honest)
        continue;
      }
      if (live) next[c.id] = live;
      else if (retained) next[c.id] = retained;
    }
    return next;
    // F29: `seedVersion` forces THIS memo to recompute after a post-freeze `seedRetainedPing` ref write —
    // the other deps do not change on the connecting→connected transition, so without it the seeded active
    // card would stay «—». It is not read in the body, so exhaustive-deps calls it "unnecessary"; it is
    // exactly the intended recompute trigger, so the rule is disabled for this deps line.
    // F3: `pinging` is read in the disconnected bridge (settle vs shimmer), so it is a genuine dep — the
    // rest-state card must re-settle to a plain number the moment a manual round finishes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pings, visibleConfigs, tunnelUp, seedVersion, pinging]);

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
          // F2: read the frozen band under the normalized key.
          reading: configPingToReading(
            tunnelUp ? lastGoodByPath.current[normalizePath(c.path)] : pings[c.id],
          ),
        })),
    // lastGoodByPath is a ref (frozen while connected); the tunnelUp flip + pings change re-derive this at
    // the connect boundary. F29: NO seedVersion here on purpose — a seeded path is always the ACTIVE
    // config, which is filtered OUT of candidates, so a seed never changes this list.
    [visibleConfigs, activeConfigPath, pings, tunnelUp],
  );

  // PA-2 (17-02): the ACTIVE config's reading the auto-switch engine evaluates for a breach. This
  // REPLACES the dishonest through-tunnel `probe_tunnel_latency` the engine used to invoke each tick
  // (F26 caught it reading 14 ms while the direct RTT was 69 ms — it bypassed the tunnel). While
  // CONNECTED we hand the engine the SAME frozen pre-connect band the active card shows (D-02 —
  // `lastGoodByPath[activeConfigPath]`); the through-tunnel probe is retired entirely. While
  // DISCONNECTED it is the live direct probe (the engine is inert then, so the value is moot). A config
  // with no retained reading reads honest `no-data` (neutral — the engine treats a transient no-data as
  // "wait", never a breach). One honesty thread: the D-04-truthful number feeds BOTH the card and this.
  // seedVersion re-derives this after a post-freeze seedRetainedPing ref write (same reason patchedPings
  // depends on it), so the connecting→connected transition surfaces the seeded active band to the engine.
  const activeReading: Reading = useMemo(() => {
    const activeConfig = visibleConfigs.find((c) => samePath(c.path, activeConfigPath));
    // F2 (17-REVIEW): key the frozen-band lookup off the RESOLVED `activeConfig.path` (normalized), NOT
    // the raw `activeConfigPath` prop. The prop comes from localStorage `tt_config_path` in a different
    // string form (`\` vs `/`, drive-letter case) than the manifest `c.path` the cache is written under;
    // indexing raw returned `undefined` on any such mismatch → `no-data` every tick → useAutoSwitch reset
    // its breach counter and returned BEFORE decideAutoSwitch, so auto-switch was silently dead for the
    // whole session while the UI claimed it was armed. `activeConfig` is already resolved via `samePath`
    // just above, so its `path` is the canonical manifest form — normalize it to match the write key.
    const source = tunnelUp
      ? activeConfig
        ? lastGoodByPath.current[normalizePath(activeConfig.path)]
        : undefined
      : activeConfig
        ? pings[activeConfig.id]
        : undefined;
    return configPingToReading(source);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seedVersion forces re-derive post-freeze
  }, [visibleConfigs, activeConfigPath, pings, tunnelUp, seedVersion]);

  return {
    configs: visibleConfigs,
    pings: patchedPings,
    reload,
    refresh,
    refreshPings,
    pinging,
    loading,
    candidates,
    activeReading,
    seedRetainedPing,
    getRetainedPing,
  };
}
