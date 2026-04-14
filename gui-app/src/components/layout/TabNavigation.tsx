import { type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Monitor, Settings, GitBranch, SlidersHorizontal, Info } from "lucide-react";
import type { AppTab } from "../../shared/types";

interface TabNavigationProps {
  activeTab: AppTab;
  onTabChange: (tab: AppTab) => void;
}

interface TabDef {
  id: AppTab;
  labelKey: string;
  icon: ReactNode;
}

const TABS: TabDef[] = [
  { id: "control",    labelKey: "tabs.controlPanel", icon: <Monitor size={18} /> },
  { id: "connection", labelKey: "tabs.connection",   icon: <Settings size={18} /> },
  { id: "routing",    labelKey: "tabs.routing",      icon: <GitBranch size={18} /> },
  { id: "settings",   labelKey: "tabs.appSettings",  icon: <SlidersHorizontal size={18} /> },
  { id: "about",      labelKey: "tabs.about",        icon: <Info size={18} /> },
];

/**
 * Bottom tab navigation bar.
 * Tabs distributed evenly (flex-1), hover effect wraps content only.
 */
export function TabNavigation({ activeTab, onTabChange }: TabNavigationProps) {
  const { t } = useTranslation();

  return (
    <nav
      role="tablist"
      className="flex items-center shrink-0"
      style={{
        height: 56,
        borderTop: "1px solid var(--color-border)",
      }}
    >
      {TABS.map((tab) => {
        const active = activeTab === tab.id;

        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={active}
            onClick={() => onTabChange(tab.id)}
            className="flex-1 flex flex-col items-center justify-center outline-none group cursor-pointer"
          >
            {/* Fixed-size hover area — icon + text */}
            <div
              className={[
                "flex flex-col items-center justify-center rounded-[var(--radius-lg)] transition-colors duration-[var(--transition-fast)]",
                !active ? "group-hover:bg-[var(--color-bg-hover)]" : "",
              ].join(" ")}
              style={{
                width: 120,
                height: 44,
                backgroundColor: active ? "var(--color-bg-elevated)" : undefined,
                color: active
                  ? "var(--color-accent-interactive)"
                  : "var(--color-text-secondary)",
              }}
            >
              {tab.icon}
              <span
                style={{
                  fontSize: 10,
                  fontWeight: active ? 600 : 400,
                  lineHeight: 1,
                  marginTop: 3,
                  whiteSpace: "nowrap",
                }}
              >
                {t(tab.labelKey)}
              </span>
            </div>
          </button>
        );
      })}
    </nav>
  );
}
