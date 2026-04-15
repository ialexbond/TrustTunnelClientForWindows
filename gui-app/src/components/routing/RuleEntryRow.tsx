import { useTranslation } from "react-i18next";
import { Globe, FileText, Server, Monitor, Folder, Trash2, ArrowRight } from "lucide-react";
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

const typeBadgeBg: Record<string, string> = {
  domain: "var(--color-bg-hover)",
  ip: "none",
  cidr: "none",
  geoip: "var(--color-status-connected-border)",
  geosite: "var(--color-status-connecting-border)",
  iplist_group: "var(--color-bg-hover)",
};

const typeBadgeColor: Record<string, string> = {
  domain: "var(--color-text-secondary)",
  ip: "var(--color-accent-400)",
  cidr: "var(--color-accent-400)",
  geoip: "var(--color-success-400)",
  geosite: "var(--color-warning-400)",
  iplist_group: "var(--color-text-secondary)",
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
  const targets = moveTargets[currentAction];

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg group hover:bg-[var(--color-bg-hover)] transition-colors">
      <Icon
        className="w-3.5 h-3.5 shrink-0"
        style={{ color: "var(--color-text-muted)" }}
      />
      <span
        className="shrink-0 inline-flex items-center justify-center rounded-[var(--radius-md)] text-[9px] font-[var(--font-weight-semibold)] uppercase tracking-wide px-1 py-0.5"
        style={{
          width: "58px",
          textAlign: "center",
          backgroundColor: typeBadgeBg[entry.type] || "var(--color-bg-hover)",
          color: typeBadgeColor[entry.type] || "var(--color-text-secondary)",
        }}
      >
        {entry.type}
      </span>
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
        className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-[rgba(239,68,68,0.1)] transition-all"
        title={t("routing.removeEntry")}
      >
        <Trash2 className="w-3.5 h-3.5" style={{ color: "var(--color-danger-400)" }} />
      </button>
    </div>
  );
}
