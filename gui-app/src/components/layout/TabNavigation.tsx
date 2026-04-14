import { useTranslation } from "react-i18next";
import type { AppTab } from "../../shared/types";

interface TabNavigationProps {
  activeTab: AppTab;
  onTabChange: (tab: AppTab) => void;
  hasConfig: boolean;
}

interface TabDef {
  id: AppTab;
  labelKey: string;
  requiresConfig?: boolean;
}

const TABS: TabDef[] = [
  { id: "control",    labelKey: "tabs.controlPanel" },
  { id: "connection", labelKey: "tabs.connection",  requiresConfig: true },
  { id: "routing",    labelKey: "tabs.routing",     requiresConfig: true },
  { id: "settings",   labelKey: "tabs.appSettings", requiresConfig: true },
  { id: "about",      labelKey: "tabs.about" },
];

/**
 * Horizontal tab navigation bar for the Application Shell.
 * Renders 5 tabs using AppTab union type with i18n labels.
 * Tabs requiring config are disabled when hasConfig=false.
 */
export function TabNavigation({ activeTab, onTabChange, hasConfig }: TabNavigationProps) {
  const { t } = useTranslation();

  return (
    <nav
      role="tablist"
      className="flex items-end shrink-0 px-2"
      style={{
        borderBottom: "1px solid var(--color-border)",
        backgroundColor: "var(--color-bg-secondary)",
      }}
    >
      {TABS.map((tab) => {
        const disabled = !!tab.requiresConfig && !hasConfig;
        const active = activeTab === tab.id;

        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={active}
            disabled={disabled}
            onClick={() => !disabled && onTabChange(tab.id)}
            className="relative px-3 py-2 text-xs font-medium transition-colors select-none"
            style={{
              color: active
                ? "var(--color-text-primary)"
                : "var(--color-text-secondary)",
              opacity: disabled ? "var(--opacity-disabled)" : 1,
              cursor: disabled ? "not-allowed" : "pointer",
              borderBottom: active
                ? "2px solid var(--color-accent-interactive)"
                : "2px solid transparent",
              marginBottom: "-1px",
              background: "transparent",
              outline: "none",
            }}
          >
            {t(tab.labelKey)}
          </button>
        );
      })}
    </nav>
  );
}
