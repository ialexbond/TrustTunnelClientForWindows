import { useMemo } from "react";
import { useConfigList, type ConfigSummary } from "./useConfigList";
import { usePerConfigPing, type PingTarget } from "./usePerConfigPing";
import { configPingToReading } from "../lib/configPingToReading";
import type { ConfigPing } from "../../components/connection/ConfigPingPill";
import type { Candidate } from "../lib/decideAutoSwitch";
import { samePath } from "../utils/samePath";
import { dedupeConfigsByIdentity } from "../utils/dedupeConfigsByIdentity";

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
}

/**
 * @param activeConfigPath the currently-active config path (excluded from candidates; also feeds
 *   the active-aware dedup so the connected twin wins).
 */
export function useConfigPingSource(activeConfigPath: string): ConfigPingSource {
  const { configs, reload, refresh, loading } = useConfigList();

  // Active-path-aware identity collapse — same rule ConnectionPanel applied internally, lifted
  // here so the cards (fed these configs as a prop) and the engine see the identical set.
  const visibleConfigs = useMemo(
    () => dedupeConfigsByIdentity(configs, activeConfigPath),
    [configs, activeConfigPath],
  );

  // Ping targets, memoized on the joined id|path so a pure re-render does not re-seed the loop.
  const targets: PingTarget[] = useMemo(
    () => visibleConfigs.map((c) => ({ id: c.id, path: c.path })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restart only when the set changes
    [visibleConfigs.map((c) => `${c.id}:${c.path}`).join("|")],
  );
  const pings = usePerConfigPing(targets);

  // D-02 candidate list: inactive configs in manifest order, each with its latest reading. The
  // engine consumes this only while connected+masterOn; when off it is harmlessly ignored.
  const candidates: Candidate[] = useMemo(
    () =>
      visibleConfigs
        .filter((c) => !samePath(c.path, activeConfigPath))
        .sort((a, b) => a.order - b.order)
        .map((c) => ({
          path: c.path,
          order: c.order,
          reading: configPingToReading(pings[c.id]),
        })),
    [visibleConfigs, activeConfigPath, pings],
  );

  return { configs: visibleConfigs, pings, reload, refresh, loading, candidates };
}
