import { useTranslation } from "react-i18next";
import { Globe, FileText, Server, Monitor, Folder, Trash2, ArrowRight } from "lucide-react";
import { Badge, type BadgeProps } from "../../shared/ui/Badge";
import type { RuleEntry, RouteAction } from "./useRoutingState";

interface RuleEntryRowProps {
  entry: RuleEntry;
  currentAction: RouteAction;
  onRemove: (id: string) => void;
  onMove: (id: string, toAction: RouteAction) => void;
}

const typeIcons: Record<string, typeof Globe> = {
  domain: Monitor,
  ip: Server,
  cidr: Server,
  geoip: Globe,
  geosite: FileText,
  iplist_group: Folder,
};

// R4-F08: the type badge was a hand-rolled <span> with same-hue saturated pairs
// (success-400 on connected-border, warning-400 on connecting-border) + a fixed
// 58px width + cramped padding — low contrast AND squeezed. Migrated to the shared
// Badge: each rule type maps to a semantic variant whose theme-scoped status text
// (e.g. success-400 on dark / success-600 on light) over a subtle tint-bg + border
// reads clearly in BOTH themes, while staying distinct (geoip green, geosite amber,
// ip/cidr blue/info, domain/iplist_group neutral). Padding now comes from the
// design-system badge (px-2.5 / py-[3px]) instead of the squeezed px-1 / 58px width.
//
// R5-F02 (round-5 UAT): the shared Badge sizes to its content, so the six rule
// types (IP·2 … IPLIST_GROUP·12 chars) rendered at wildly different widths and
// the added-sites column started at a different x per row → the list looked
// crooked. Give every rule-type badge a shared min-width (justify-center so short
// labels sit centred in the box) so the value column aligns.
// R5-F02b (round-5 re-test): min-w-[112px] (sized to the rare IPLIST_GROUP) was
// far too WIDE — GEOSITE/GEOIP/DOMAIN had huge empty slack. Owner: size them to
// GEOSITE (the longest COMMON type). min-w-[80px] ≈ GEOSITE's rendered width, so
// the common types align tightly; the rare iplist_group just grows past it (it is
// a min-width, never truncates). Row-LOCAL className — NOT the shared Badge.
const typeBadgeVariant: Record<string, NonNullable<BadgeProps["variant"]>> = {
  domain: "neutral",
  ip: "info",
  cidr: "info",
  geoip: "success",
  geosite: "warning",
  iplist_group: "neutral",
};

const moveTargets: Record<RouteAction, RouteAction[]> = {
  direct: ["proxy"],
  proxy: ["direct"],
  block: ["direct", "proxy"], // block card hidden, but keep for data integrity
};

const actionColors: Record<RouteAction, string> = {
  direct: "var(--color-success-400)",
  proxy: "var(--color-accent-400)",
  block: "var(--color-danger-400)",
};

export function RuleEntryRow({ entry, currentAction, onRemove, onMove }: RuleEntryRowProps) {
  const { t } = useTranslation();
  const Icon = typeIcons[entry.type] || Monitor;
  const badgeVariant = typeBadgeVariant[entry.type] || "neutral";
  const targets = moveTargets[currentAction];

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg group hover:bg-[var(--color-bg-hover)] transition-colors">
      <Icon
        className="w-3.5 h-3.5 shrink-0"
        style={{ color: "var(--color-text-muted)" }}
      />
      <Badge variant={badgeVariant} className="shrink-0 justify-center min-w-[80px]">
        {entry.type}
      </Badge>
      <span
        className="flex-1 text-xs font-mono truncate"
        style={{ color: "var(--color-text-primary)" }}
      >
        {entry.value}
      </span>

      {/* Move buttons */}
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {targets.map((target) => (
          <button
            key={target}
            onClick={() => onMove(entry.id, target)}
            className="p-1 rounded hover:bg-[var(--color-bg-active)] transition-colors"
            title={t(`routing.moveTo_${target}`, { defaultValue: target })}
          >
            <ArrowRight className="w-3 h-3" style={{ color: actionColors[target] }} />
          </button>
        ))}
      </div>

      {/* Delete */}
      <button
        onClick={() => onRemove(entry.id)}
        className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-[var(--color-danger-tint-10)] transition-all"
        title={t("routing.removeEntry")}
      >
        <Trash2 className="w-3.5 h-3.5" style={{ color: "var(--color-danger-400)" }} />
      </button>
    </div>
  );
}
