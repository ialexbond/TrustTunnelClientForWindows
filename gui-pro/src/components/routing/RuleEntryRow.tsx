import { useTranslation } from "react-i18next";
import { Globe, FileText, Server, Monitor, Folder, Trash2, ArrowRight } from "lucide-react";
import { Badge, type BadgeProps } from "../../shared/ui/Badge";
import { IconButton } from "../../shared/ui/IconButton";
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

// Две карточки — значит по одной цели переноса у каждой. Третьей строки (`block`) здесь больше нет:
// блокировка сайтов удалена 2026-09-03, и запись физически не может оказаться в блоке, которого нет.
const moveTargets: Record<RouteAction, RouteAction[]> = {
  direct: ["proxy"],
  proxy: ["direct"],
};

// Per-target arrow colour = the destination block's colour, THEME-AWARE (-fg), matching GroupChip's
// arrows (one move control across plain rules AND group chips). Was raw -400 (too light on light theme).
const actionColors: Record<RouteAction, string> = {
  direct: "var(--color-success-fg)",
  proxy: "var(--color-accent-fg)",
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

      {/* Move buttons — migrated from raw <button> to the shared IconButton
          (R21-03 DEBT-RAWPRIM). These stay the existing accessible move fallback
          (D-02: NO drag-to-move, no drag handle); onMove(entry.id, target) wiring is
          unchanged and the per-target arrow colour rides on the ArrowRight's own
          inline style.
          D-06: the arrows now REST VISIBLE. They used to sit inside a zero-opacity
          hover-reveal wrapper, which left an arrow invisible at the exact moment a
          keyboard user focused it — operable but not usable. That was written up as a
          warning in 22-VERIFICATION.md:172 and widened by D-06 to every occurrence on
          the tab. Deleting the wrapper IS the fix: IconButton already renders muted at
          rest, strengthens its background on hover and draws the focus ring, so nothing
          was added to replace it. Same shape as the delete button below, which never
          carried the wrapper.
          Note for the next author: do not quote the two Tailwind class names of that
          wrapper here — hover-reveal-guard.sh cannot tell a JSX block comment from code,
          so writing them out would keep the gate red forever. */}
      <div className="flex items-center gap-0.5 transition-opacity">
        {targets.map((target) => (
          <IconButton
            key={target}
            aria-label={t(`routing.moveTo_${target}`, { defaultValue: target })}
            tooltip={t(`routing.moveTo_${target}`, { defaultValue: target })}
            icon={<ArrowRight className="w-3 h-3" style={{ color: actionColors[target] }} />}
            onClick={() => onMove(entry.id, target)}
          />
        ))}
      </div>

      {/* Delete — shared IconButton, ALWAYS visible (canon «Удаление всегда видно»):
          no opacity-0/hover-reveal gate so the control shows at rest. Danger tint
          rides on the Trash2 glyph + a danger hover background className. onRemove
          signature unchanged (D-01: zero behavior change). */}
      <IconButton
        aria-label={t("routing.removeEntry")}
        tooltip={t("routing.removeEntry")}
        icon={<Trash2 className="w-3.5 h-3.5" style={{ color: "var(--color-danger-fg)" }} />}
        onClick={() => onRemove(entry.id)}
        className="hover:bg-[var(--color-danger-tint-10)]"
      />
    </div>
  );
}
