/* eslint-disable react-refresh/only-export-components -- the PRESET_TILES backing map + tile types are co-located with the grid by design (single data-driven source of truth for the tile set, adjusted at the render-review checkpoint per D-01a). */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Globe,
  Youtube,
  MessageCircle,
  Users,
  Gamepad2,
  Clapperboard,
  MessagesSquare,
  ShieldAlert,
  Megaphone,
  EyeOff,
  Check,
  Plus,
  MousePointerClick,
  type LucideIcon,
} from "lucide-react";
import { Card } from "../../shared/ui/Card";
import { PanelHeader } from "../../shared/ui/PanelHeader";
import type { RoutingRules, RouteAction, RuleEntryType } from "./useRoutingState";

// ═══════════════════════════════════════════════════════
// PresetGrid — production «Быстрые пресеты» (T-25 / D-01).
//
// Ports the Phase-20 design canon (PresetGrid.stories.tsx) into a live component. Unlike the
// story's label-only mock, every tile carries a REAL, resolvable backing token (a geosite category
// or an iplist group id) — the source is 22-RESEARCH §C "proposed preset-to-backing map". One click
// adds the whole group as a SINGLE chip to a smart-default block via the existing addEntry (groups
// are stored by reference, never exploded into domains). The tile set is intentionally a single
// data-driven const (PRESET_TILES) so it is trivial to adjust at the owner render-review (D-01a).
// ═══════════════════════════════════════════════════════

/** Целевой блок по умолчанию, куда приземляется группа: цвет несёт смысл действия. */
type Target = RouteAction; // "direct" | "proxy" | "block"

// Design-canon color mapping (verbatim from the story): the tint/color of the target block.
// Titles come from i18n (routing.<target>Title) — the story hardcoded Russian; production localizes.
const targetTint: Record<Target, string> = {
  direct: "var(--color-success-tint-12)",
  proxy: "var(--color-accent-tint-10)",
  block: "var(--color-danger-tint-10)",
};
// Foreground (icon + caption + border) uses the THEME-AWARE -fg token, not the raw -500 primitive:
// -500 is tuned for dark and is too light as light-theme foreground (fails WCAG — see audit §1).
const targetColor: Record<Target, string> = {
  direct: "var(--color-success-fg)",
  proxy: "var(--color-accent-fg)",
  block: "var(--color-danger-fg)",
};
// Maps a target block to its existing i18n title key (routing.directTitle / proxyTitle / blockTitle).
const targetTitleKey: Record<Target, string> = {
  direct: "routing.directTitle",
  proxy: "routing.proxyTitle",
  block: "routing.blockTitle",
};

/**
 * A preset tile — a named routing group + where it lands + WHAT it is backed by.
 *
 * `backing` is a fixed project token (NOT user free-text — no injection surface, see threat model):
 *   - `geosite:<cat>`        — resolved from the downloaded geodata `.dat`; gated on geodataDownloaded.
 *   - `iplist_group:<id>`    — resolved from the iplist.opencck.org group cache; fetched on add.
 *
 * The special RU backing `iplist_group:ru_whitelist` is an iplist_group whose id is NOT in
 * get_iplist_groups but IS a valid group-cache key (fetch_whitelist_domains). ensureGroupCache
 * special-cases it; it needs no geodata. The `geosite:ru-available-only-inside` alternative is the
 * owner call at review (A2).
 */
export interface PresetTile {
  id: string;
  /** i18n key under routing.presets for the visible label. */
  labelKey: string;
  icon: LucideIcon;
  /** Smart-default block the group lands in (RESEARCH §C). */
  target: Target;
  /** Fixed backing token — `geosite:<cat>` or `iplist_group:<id>`. */
  backing: string;
}

// The data-driven tile set (22-RESEARCH §C). RU → «Напрямую»; media/social/games/RF-blocked →
// «Через VPN»; ads & Windows-telemetry → «Заблокировать». geosite backings resolve straight from
// the .dat (no network prefetch); iplist_group backings need a fetch-on-add (Pitfall #2).
// Adjust freely at the render-review checkpoint (D-01a) — this const is the single source of truth.
export const PRESET_TILES: PresetTile[] = [
  { id: "ru", labelKey: "routing.presets.tile_ru", icon: Globe, target: "direct", backing: "iplist_group:ru_whitelist" },
  { id: "youtube", labelKey: "routing.presets.tile_youtube", icon: Youtube, target: "proxy", backing: "geosite:youtube" },
  { id: "discord", labelKey: "routing.presets.tile_discord", icon: MessageCircle, target: "proxy", backing: "geosite:discord" },
  { id: "social", labelKey: "routing.presets.tile_social", icon: Users, target: "proxy", backing: "iplist_group:socials" },
  { id: "games", labelKey: "routing.presets.tile_games", icon: Gamepad2, target: "proxy", backing: "iplist_group:games" },
  { id: "streaming", labelKey: "routing.presets.tile_streaming", icon: Clapperboard, target: "proxy", backing: "iplist_group:video" },
  { id: "messengers", labelKey: "routing.presets.tile_messengers", icon: MessagesSquare, target: "proxy", backing: "iplist_group:messengers" },
  { id: "ruBlocked", labelKey: "routing.presets.tile_ruBlocked", icon: ShieldAlert, target: "proxy", backing: "geosite:ru-blocked" },
  { id: "ads", labelKey: "routing.presets.tile_ads", icon: Megaphone, target: "block", backing: "geosite:category-ads-all" },
  { id: "winSpy", labelKey: "routing.presets.tile_winSpy", icon: EyeOff, target: "block", backing: "geosite:win-spy" },
];

const GEOSITE_PREFIX = "geosite:";
const IPLIST_PREFIX = "iplist_group:";

/** Is this backing a geosite category (resolved from the downloaded .dat)? */
function isGeositeBacking(backing: string): boolean {
  return backing.startsWith(GEOSITE_PREFIX);
}

/** Is this backing an iplist group (needs a fetch-on-add + no geodata dependency)? */
function isIplistBacking(backing: string): boolean {
  return backing.startsWith(IPLIST_PREFIX);
}

/**
 * Parse a backing token into the EXACT (type, value) pair the entry would be stored as — mirrors
 * useRoutingState.parseEntryValue. The added-state must match this exact pair, NOT the human label
 * (Pitfall #4): `geosite:youtube` and `iplist_group:youtube` are DIFFERENT entries.
 */
function parseBacking(backing: string): { type: RuleEntryType; value: string } {
  if (isGeositeBacking(backing)) return { type: "geosite", value: backing.slice(GEOSITE_PREFIX.length) };
  if (isIplistBacking(backing)) return { type: "iplist_group", value: backing.slice(IPLIST_PREFIX.length) };
  return { type: "domain", value: backing };
}

/** The iplist group id (prefix stripped) — the key ensureGroupCache expects (`games`, `ru_whitelist`). */
function iplistGroupId(backing: string): string {
  return backing.slice(IPLIST_PREFIX.length);
}

/** Cross-block scan for the exact (type,value) this tile's backing would add (D-06, Pitfall #4). */
function isTileAdded(rules: RoutingRules, backing: string): boolean {
  const { type, value } = parseBacking(backing);
  return (["direct", "proxy", "block"] as RouteAction[]).some((block) =>
    rules[block].some((e) => e.type === type && e.value === value),
  );
}

export interface PresetGridProps {
  /** Current rules — drives the "already added" (idempotent) state per tile. */
  rules: RoutingRules;
  /** = useRoutingState.addEntry. Called with (smart-default target, backing token). */
  onAdd: (action: RouteAction, value: string) => string | null;
  /** = useRoutingState.ensureGroupCache. Prefetch an iplist_group's domain cache before it resolves. */
  ensureGroupCache: (groupId: string) => void;
  /** Gates geosite-backed tiles: without the .dat a geosite category resolves to nothing (Pitfall #3). */
  geodataDownloaded: boolean;
  /** Gates block-target tiles: the block card is hidden when off, so the group would vanish (Pitfall #1). */
  blockRoutingEnabled: boolean;
}

interface TileButtonProps {
  tile: PresetTile;
  added: boolean;
  /** Non-null when the tile is gated (disabled with a reason) rather than added. */
  disabledHint: string | null;
  onAdd: () => void;
}

/** One preset tile — icon in the target-block color + localized label + a "куда добавится" caption. */
function PresetTileButton({ tile, added, disabledHint, onAdd }: TileButtonProps) {
  const { t } = useTranslation();
  const [hover, setHover] = useState(false);

  const Icon = tile.icon;
  const tint = targetTint[tile.target];
  const color = targetColor[tile.target];
  const targetTitle = t(targetTitleKey[tile.target]);
  const label = t(tile.labelKey);

  const gated = disabledHint !== null;
  const disabled = added || gated;
  // Colored hover highlight only on an actionable tile — added/gated stay calm.
  const showHover = hover && !disabled;

  const ariaLabel = added
    ? t("routing.presets.ariaAdded", { name: label, target: targetTitle })
    : gated
      ? t("routing.presets.ariaDisabled", { name: label, hint: disabledHint })
      : t("routing.presets.ariaAdd", { name: label, target: targetTitle });

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onAdd}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="relative flex flex-col items-center justify-center gap-2 rounded-[var(--radius-lg)] border px-3 py-4 text-center transition-colors disabled:cursor-default"
      // «Added» больше НЕ гасим прозрачностью (opacity:0.65 роняло контраст подписи до ~1.65:1 —
      // читалось «выключено», а не «выбрано»; audit §2). Выбранная плитка = ПОЛОЖИТЕЛЬНЫЙ маркер:
      // тонировка блока + цветная рамка + галка в углу. Наведение на актуальную даёт тот же тинт/рамку
      // (с «＋»). Приглушаем прозрачностью ТОЛЬКО gated-плитку (geosite без геоданных) — она нерабочая.
      style={{
        borderColor: showHover || added ? color : "var(--color-border)",
        backgroundColor: showHover || added ? tint : "var(--color-bg-elevated)",
        opacity: gated ? 0.5 : 1,
        cursor: disabled ? "default" : "pointer",
      }}
      aria-label={ariaLabel}
    >
      <span
        className="flex h-10 w-10 items-center justify-center rounded-[var(--radius-md)]"
        style={{ backgroundColor: tint }}
      >
        <Icon className="h-5 w-5" style={{ color }} />
      </span>
      <span className="text-sm font-medium" style={{ color: "var(--color-text-primary)" }}>
        {label}
      </span>

      {/* Caption = inline "куда приземлилось" note. Idle: muted target title. Added: arrow + target
          title in the block color. Gated: the localized reason (enable blocking / download geodata). */}
      {added ? (
        <span className="text-[11px] font-medium" style={{ color }}>
          → {targetTitle}
        </span>
      ) : gated ? (
        <span className="text-[11px]" style={{ color: "var(--color-text-muted)" }}>
          {disabledHint}
        </span>
      ) : (
        <span className="text-[11px]" style={{ color: "var(--color-text-muted)" }}>
          {targetTitle}
        </span>
      )}

      {/* Hover (actionable): a prominent «＋» in the corner. */}
      {showHover && (
        <span
          className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full"
          style={{ backgroundColor: color }}
        >
          <Plus className="h-3 w-3" style={{ color: "var(--color-bg-surface)" }} />
        </span>
      )}

      {/* Already added: a calm check instead of the plus. */}
      {added && (
        <span
          className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full"
          style={{ backgroundColor: "var(--color-success-fg)" }}
        >
          <Check className="h-3 w-3" style={{ color: "var(--color-bg-surface)" }} />
        </span>
      )}
    </button>
  );
}

/**
 * The production preset grid. Mounts at the top of «Маршрутизация» (between the geodata card and the
 * routing blocks). Each tile: computes its added-state from `rules` (exact backing token), lands at
 * its smart-default block on click, prefetches the cache for iplist backings (Pitfall #2), and gates
 * on geodata-downloaded (geosite) / blockRouting (block target) so a group never silently lands in a
 * hidden or empty target (Pitfalls #1/#3).
 */
export function PresetGrid({ rules, onAdd, ensureGroupCache, geodataDownloaded, blockRoutingEnabled }: PresetGridProps) {
  const { t } = useTranslation();

  const handleAdd = (tile: PresetTile) => {
    const result = onAdd(tile.target, tile.backing);
    // Fetch-on-add ONLY for iplist backings (geosite resolves from the local .dat). Prefetch after a
    // successful add (addEntry returns null on success; a duplicate would already be a disabled tile).
    if (result === null && isIplistBacking(tile.backing)) {
      ensureGroupCache(iplistGroupId(tile.backing));
    }
  };

  // Compute the disabled reason (if any) for a tile. Only geosite-backed tiles gate here (on
  // geodata-downloaded, Pitfall #3). Block-target tiles are NO LONGER disabled-with-a-hint when
  // blocking is off — they are HIDDEN entirely (owner D-2/F-3, see below), so there is no block
  // branch here. iplist backings need NO geodata (their ids are a backend list — Plan-03).
  const disabledHintFor = (tile: PresetTile): string | null => {
    if (isGeositeBacking(tile.backing) && !geodataDownloaded) return t("routing.presets.geodataDisabledHint");
    return null;
  };

  // Owner D-2/F-3: when block routing is OFF the block card is hidden, so a block-target preset would
  // have nowhere to land — do NOT show a disabled tile, HIDE it outright. Block tiles reappear the
  // moment blocking is enabled in Settings. (Non-block tiles are always listed; geosite ones may gate.)
  const visibleTiles = PRESET_TILES.filter((tile) => tile.target !== "block" || blockRoutingEnabled);

  return (
    // Wrapped in a Card (canon parity, audit P-4): presets sit in the same padded panel as the
    // VPN-Mode and GeoData cards, not floating card-less on the page.
    <Card padding="md">
      {/* Shared `PanelHeader` — the same header the «Настройки» cards use, so this card's glyph is
          a tinted chip on the title line rather than a bare accent icon. The section note moved into
          the header's own `description` slot (it was a separate <p> under a hand-built row) and the
          one-click hint into its `action` slot, so both keep their exact words and their exact
          relationship to the title. Note: a preset is an EXPLICIT route for its category,
          independent of the VPN mode. */}
      <PanelHeader
        icon={<MousePointerClick className="h-4 w-4" />}
        title={t("routing.presets.title")}
        description={t("routing.presets.note")}
        action={
          <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>
            {t("routing.presets.hint")}
          </span>
        }
      />
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
        {visibleTiles.map((tile) => (
          <PresetTileButton
            key={tile.id}
            tile={tile}
            added={isTileAdded(rules, tile.backing)}
            disabledHint={disabledHintFor(tile)}
            onAdd={() => handleAdd(tile)}
          />
        ))}
      </div>
    </Card>
  );
}
