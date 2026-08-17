import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Shield, Zap, Ban } from "lucide-react";
import { Card } from "../../shared/ui";
import { RuleEntryRow } from "./RuleEntryRow";
import { GroupChip } from "./GroupChip";
import { AddRuleInput } from "./AddRuleInput";
import type { RuleEntry, RouteAction, GeoDataStatus, GeoDataIndex, IplistGroup } from "./useRoutingState";

interface RoutingBlockCardProps {
  action: RouteAction;
  vpnMode?: string;
  entries: RuleEntry[];
  geodataStatus: GeoDataStatus;
  geodataCategories: GeoDataIndex;
  iplistGroups: IplistGroup[];
  onAdd: (action: RouteAction, value: string) => string | null;
  onRemove: (action: RouteAction, id: string) => void;
  onMove: (fromAction: RouteAction, toAction: RouteAction, id: string) => void;
  onEnsureGroupCache: (groupId: string) => void | Promise<void>;
}

// Каждый блок несёт свою цветовую идентичность НЕ левой акцентной полоской (баннед AI-артефакт,
// D-01 / feedback_no_left_accent_rail), а тонированной шапкой (canon Phase-20 InteractiveBlock):
// `tint` — светлая заливка строки-шапки; `iconColor` — насыщенный цвет Lucide-иконки (-500 токен).
// Тело блока остаётся нейтральным (--color-bg-surface).
const actionConfig: Record<
  RouteAction,
  {
    titleKey: string;
    descriptionKey: string;
    tint: string;
    iconColor: string;
    icon: typeof Shield;
    badgeVariant: "success" | "accent" | "danger";
  }
> = {
  direct: {
    titleKey: "routing.directTitle",
    descriptionKey: "routing.directDescription",
    tint: "var(--color-success-tint-12)",
    // iconColor is FOREGROUND (the header glyph on the tint) → theme-aware -fg, not raw -500
    // (raw -500 fails WCAG as light-theme foreground — audit §1). tint stays the fill.
    iconColor: "var(--color-success-fg)",
    icon: Zap,
    badgeVariant: "success",
  },
  proxy: {
    titleKey: "routing.proxyTitle",
    descriptionKey: "routing.proxyDescription",
    tint: "var(--color-accent-tint-10)",
    iconColor: "var(--color-accent-fg)",
    icon: Shield,
    badgeVariant: "accent",
  },
  block: {
    titleKey: "routing.blockTitle",
    descriptionKey: "routing.blockDescription",
    tint: "var(--color-danger-tint-10)",
    iconColor: "var(--color-danger-fg)",
    icon: Ban,
    badgeVariant: "danger",
  },
};

// Отображаемое имя чипа-группы. Для iplist_group ищем человекочитаемое имя в дескрипторах групп
// (iplistGroups, приходят из Plan 03) по id после префикса `iplist_group:`; если не нашли (напр.
// спец-ключ ru_whitelist, которого нет в get_iplist_groups) — откатываемся на entry.label, затем на
// голый id. Для geosite показываем саму категорию-value (напр. `geosite:youtube`).
function groupChipLabel(entry: RuleEntry, iplistGroups: IplistGroup[]): string {
  if (entry.type === "iplist_group") {
    const id = entry.value.replace(/^iplist_group:/i, "");
    const found = iplistGroups.find((g) => g.id === id);
    return found?.label ?? entry.label ?? id;
  }
  return entry.value;
}

export function RoutingBlockCard({
  action,
  vpnMode,
  entries,
  geodataStatus,
  geodataCategories,
  iplistGroups,
  onAdd,
  onRemove,
  onMove,
  onEnsureGroupCache,
}: RoutingBlockCardProps) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);

  // In "general" mode (all through VPN) the "proxy" block is redundant.
  // In "selective" mode (all direct) the "direct" block is redundant.
  const isRedundant =
    (action === "proxy" && vpnMode === "general") ||
    (action === "direct" && vpnMode === "selective");
  const config = actionConfig[action];
  const Icon = config.icon;

  return (
    <Card padding="none" className="overflow-hidden">
      {/* Header — тонированная шапка вместо левой полоски (D-01): заливка строки в цвет блока
          (config.tint), цветная Lucide-иконка (config.iconColor), заголовок, счётчик правил, шеврон. */}
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
        // hover:brightness-[0.98] слегка притемняет саму тонированную заливку вместо переключения
        // на нейтральный --color-bg-hover, иначе цветовая идентичность блока «мигала» бы при наведении.
        className="w-full flex items-center gap-2 px-4 py-3 transition-colors hover:brightness-[0.98]"
        style={{ backgroundColor: config.tint }}
      >
        <Icon className="w-4 h-4 shrink-0" style={{ color: config.iconColor }} />
        <span
          className="text-sm font-semibold flex-1 text-left"
          style={{ color: "var(--color-text-primary)" }}
        >
          {t(config.titleKey)}
        </span>
        {/* Счётчик правил в шапке (canon Phase-20 показывает count; live-версия не показывала). */}
        <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>
          {entries.length}
        </span>
        <ChevronDown
          className="w-4 h-4 transition-transform shrink-0"
          style={{
            color: "var(--color-text-muted)",
            transform: collapsed ? "rotate(0deg)" : "rotate(180deg)",
          }}
        />
      </button>

      {/* Content — нейтральное тело под тонированной шапкой (--color-bg-surface). */}
      {!collapsed && (
        <div
          className="px-3 pb-3 pt-2"
          style={{ backgroundColor: "var(--color-bg-surface)" }}
        >
          {/* Description */}
          <p
            className="text-xs px-1 mb-2"
            style={{ color: "var(--color-text-muted)" }}
          >
            {t(config.descriptionKey)}
          </p>

          {/* Redundant mode hint */}
          {isRedundant && (
            <div
              className="flex items-center gap-1.5 px-2 py-1.5 mb-2 rounded text-xs"
              style={{
                backgroundColor: "var(--color-bg-hover)",
                color: "var(--color-text-muted)",
              }}
            >
              <span>{t("routing.redundantHint")}</span>
            </div>
          )}

          {/* Entries list — group entries (geosite / iplist_group) render as the design-canon
              GroupChip with an inline keyboard block-picker (D-02, no drag); plain rules
              (domain / ip / cidr / geoip) keep their RuleEntryRow look. A preset-added or
              manually-added group thus appears as a single movable chip. */}
          {entries.length > 0 ? (
            <div className="space-y-0.5 max-h-[240px] overflow-y-auto">
              {entries.map((entry) =>
                entry.type === "geosite" || entry.type === "iplist_group" ? (
                  <GroupChip
                    key={entry.id}
                    entry={entry}
                    currentAction={action}
                    label={groupChipLabel(entry, iplistGroups)}
                    onRemove={(id) => onRemove(action, id)}
                    onMove={(id, toAction) => onMove(action, toAction, id)}
                  />
                ) : (
                  <RuleEntryRow
                    key={entry.id}
                    entry={entry}
                    currentAction={action}
                    onRemove={(id) => onRemove(action, id)}
                    onMove={(id, toAction) => onMove(action, toAction, id)}
                  />
                ),
              )}
            </div>
          ) : (
            <div className="flex items-center justify-center py-4">
              <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                {t("routing.noEntries")}
              </span>
            </div>
          )}

          {/* Add input */}
          <AddRuleInput
            action={action}
            geodataStatus={geodataStatus}
            geodataCategories={geodataCategories}
            iplistGroups={iplistGroups}
            onAdd={onAdd}
            onEnsureGroupCache={onEnsureGroupCache}
          />
        </div>
      )}
    </Card>
  );
}
