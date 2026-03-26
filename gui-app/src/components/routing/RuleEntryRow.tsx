import { useTranslation } from "react-i18next";
import { Globe, FileText, Server, Monitor, Folder, Trash2, ArrowRight } from "lucide-react";
import { Badge } from "../../shared/ui";
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

const typeBadgeVariant: Record<string, "default" | "success" | "warning" | "danger" | "accent"> = {
  domain: "default",
  ip: "accent",
  cidr: "accent",
  geoip: "success",
  geosite: "warning",
  iplist_group: "default",
};

const moveTargets: Record<RouteAction, RouteAction[]> = {
  direct: ["proxy", "block"],
  proxy: ["direct", "block"],
  block: ["direct", "proxy"],
};

const actionColors: Record<RouteAction, string> = {
  direct: "var(--color-success-400)",
  proxy: "var(--color-accent-400)",
  block: "var(--color-danger-400)",
};

export function RuleEntryRow({ entry, currentAction, onRemove, onMove }: RuleEntryRowProps) {
  const { t } = useTranslation();
  const Icon = typeIcons[entry.type] || Monitor;
  const targets = moveTargets[currentAction];

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg group hover:bg-[var(--color-bg-hover)] transition-colors">
      <Icon
        className="w-3.5 h-3.5 shrink-0"
        style={{ color: "var(--color-text-muted)" }}
      />
      <span
        className="flex-1 text-xs font-mono truncate"
        style={{ color: "var(--color-text-primary)" }}
      >
        {entry.value}
      </span>
      <Badge variant={typeBadgeVariant[entry.type]} size="sm">
        {entry.type}
      </Badge>

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
        className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-[rgba(239,68,68,0.1)] transition-all"
        title={t("routing.removeEntry")}
      >
        <Trash2 className="w-3.5 h-3.5" style={{ color: "var(--color-danger-400)" }} />
      </button>
    </div>
  );
}
