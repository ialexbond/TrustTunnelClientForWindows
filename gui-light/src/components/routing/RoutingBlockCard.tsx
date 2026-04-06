import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Shield, Zap, Ban } from "lucide-react";
import { Card } from "../../shared/ui";
import { RuleEntryRow } from "./RuleEntryRow";
import { AddRuleInput } from "./AddRuleInput";
import type { RuleEntry, RouteAction, GeoDataStatus, GeoDataIndex } from "./useRoutingState";

interface RoutingBlockCardProps {
  action: RouteAction;
  vpnMode?: string;
  entries: RuleEntry[];
  geodataStatus: GeoDataStatus;
  geodataCategories: GeoDataIndex;
  onAdd: (action: RouteAction, value: string) => string | null;
  onRemove: (action: RouteAction, id: string) => void;
  onMove: (fromAction: RouteAction, toAction: RouteAction, id: string) => void;
}

const actionConfig: Record<
  RouteAction,
  {
    titleKey: string;
    descriptionKey: string;
    borderColor: string;
    icon: typeof Shield;
    badgeVariant: "success" | "accent" | "danger";
  }
> = {
  direct: {
    titleKey: "routing.directTitle",
    descriptionKey: "routing.directDescription",
    borderColor: "var(--color-success-500)",
    icon: Zap,
    badgeVariant: "success",
  },
  proxy: {
    titleKey: "routing.proxyTitle",
    descriptionKey: "routing.proxyDescription",
    borderColor: "var(--color-accent-500)",
    icon: Shield,
    badgeVariant: "accent",
  },
  block: {
    titleKey: "routing.blockTitle",
    descriptionKey: "routing.blockDescription",
    borderColor: "var(--color-danger-500)",
    icon: Ban,
    badgeVariant: "danger",
  },
};

export function RoutingBlockCard({
  action,
  vpnMode,
  entries,
  geodataStatus,
  geodataCategories,
  onAdd,
  onRemove,
  onMove,
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
    <Card
      padding="none"
      className="overflow-hidden"
      style={{
        borderLeftWidth: "3px",
        borderLeftColor: config.borderColor,
      }}
    >
      {/* Header */}
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-3 transition-colors hover:bg-[var(--color-bg-hover)]"
      >
        <Icon className="w-4 h-4 shrink-0" style={{ color: config.borderColor }} />
        <span
          className="text-sm font-semibold flex-1 text-left"
          style={{ color: "var(--color-text-primary)" }}
        >
          {t(config.titleKey)}
        </span>
        <ChevronDown
          className="w-4 h-4 transition-transform shrink-0"
          style={{
            color: "var(--color-text-muted)",
            transform: collapsed ? "rotate(0deg)" : "rotate(180deg)",
          }}
        />
      </button>

      {/* Content */}
      {!collapsed && (
        <div className="px-3 pb-3">
          {/* Description */}
          <p
            className="text-[10px] px-1 mb-2"
            style={{ color: "var(--color-text-muted)" }}
          >
            {t(config.descriptionKey)}
          </p>

          {/* Redundant mode hint */}
          {isRedundant && (
            <div
              className="flex items-center gap-1.5 px-2 py-1.5 mb-2 rounded text-[10px]"
              style={{
                backgroundColor: "var(--color-bg-hover)",
                color: "var(--color-text-muted)",
              }}
            >
              <span>{t("routing.redundantHint")}</span>
            </div>
          )}

          {/* Entries list */}
          {entries.length > 0 ? (
            <div className="space-y-0.5 max-h-[240px] overflow-y-auto">
              {entries.map((entry) => (
                <RuleEntryRow
                  key={entry.id}
                  entry={entry}
                  currentAction={action}
                  onRemove={(id) => onRemove(action, id)}
                  onMove={(id, toAction) => onMove(action, toAction, id)}
                />
              ))}
            </div>
          ) : (
            <div className="flex items-center justify-center py-4">
              <span className="text-[11px]" style={{ color: "var(--color-text-muted)" }}>
                {t("routing.noEntries")}
              </span>
            </div>
          )}

          {/* Add input */}
          <AddRuleInput
            action={action}
            geodataStatus={geodataStatus}
            geodataCategories={geodataCategories}
            onAdd={onAdd}
          />
        </div>
      )}
    </Card>
  );
}
