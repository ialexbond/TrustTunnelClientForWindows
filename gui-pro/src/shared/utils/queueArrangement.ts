import type { ConfigSummary } from "../hooks/useConfigList";
import { dedupeConfigsByIdentity } from "./dedupeConfigsByIdentity";

/**
 * Lay the user's ARRANGEMENT over the current config list.
 *
 * WHY THE QUEUE IS SHAPED THIS WAY. «Порядок переключения» has two inputs that change independently:
 * the manifest (which servers exist, and what they are called) and the user's dragging (what order
 * they should be tried in). Keeping the ROWS in component state conflated the two — the state was
 * seeded from the manifest and then only re-seeded when the SET of ids changed, which quietly made
 * it a snapshot of everything else. Rename a config and the queue showed the old title forever,
 * because the ids had not moved (owner, 28-UAT: «я поменял имя, но в настройках остаётся старое»).
 *
 * So only the arrangement is state, and it holds IDS — the one thing the user actually decides.
 * Everything a row displays is read from the manifest on every render, which is why a rename, a
 * deletion or an import shows up with no refresh, no re-mount, and no toggle off and on.
 *
 * The old id-set rule was still protecting something real, and this preserves it: `list_configs`
 * returns rows sorted last-used-first, so adopting that sort wholesale would snap the active server
 * to slot 1 and undo the drag the user just made. Here the manifest's order is only ever a FALLBACK
 * for rows the arrangement does not mention.
 *
 *   - ids in `arrangement` that still exist come first, in the user's order,
 *   - anything else follows in `fresh` order (new configs get the highest manifest order, so they
 *     land at the end, which is where a newly imported server belongs),
 *   - ids that no longer exist are ignored — a deleted server cannot hold a slot.
 *
 * An empty arrangement means «never rearranged», so the list is simply the manifest's own order.
 */
export function applyQueueArrangement(
  arrangement: string[],
  fresh: ConfigSummary[],
): ConfigSummary[] {
  if (arrangement.length === 0) return fresh;

  const byId = new Map(fresh.map((c) => [c.id, c] as const));

  const placed: ConfigSummary[] = [];
  const seen = new Set<string>();
  for (const id of arrangement) {
    const row = byId.get(id);
    if (row && !seen.has(id)) {
      placed.push(row);
      seen.add(id);
    }
  }

  for (const row of fresh) {
    if (!seen.has(row.id)) placed.push(row);
  }

  return placed;
}

/**
 * The servers «Порядок переключения» shows, before the user's arrangement is laid over them.
 *
 * Two rules, and both have to hold together, which is why they live in one named function rather
 * than as two steps in the component:
 *
 *  1. COLLAPSE same-server twins, with the same helper and the same active-path tiebreak the
 *     Connection tab uses. The manifest can hold one server as two `.toml` files — a legacy file
 *     beside a migrated one — and «Подключение» shows them as ONE card. This list did not, so the
 *     two tabs disagreed on how many servers exist: the owner counted five there and six here
 *     (28-UAT). Whatever «Подключение» shows is what the user believes they have.
 *  2. SORT by the manifest's own `order`. `list_configs` returns rows last-used-first, and adopting
 *     that would put the active server in slot 1 — but slot 1 here means «tried first», which is a
 *     different claim entirely.
 *
 * Kept as ONE opaque call for the caller's memo on purpose. The hooks compiler preserves a memo that
 * sorts a copy of a PROP, and refuses one that sorts a copy of another call's result — so composing
 * these two in the render body cost the whole component its compilation. It reads better here anyway:
 * «what the queue shows» is one idea, not two coincidental steps.
 */
export function visibleQueueConfigs(
  configs: ConfigSummary[],
  activeConfigPath?: string,
): ConfigSummary[] {
  const deduped = dedupeConfigsByIdentity(configs, activeConfigPath);
  return [...deduped].sort((a, b) => a.order - b.order);
}
