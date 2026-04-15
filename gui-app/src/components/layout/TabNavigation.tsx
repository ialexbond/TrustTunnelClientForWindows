import { useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Monitor, Cable, GitBranch, Settings, Info } from "lucide-react";
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
  { id: "connection", labelKey: "tabs.connection",   icon: <Cable size={18} /> },
  { id: "routing",    labelKey: "tabs.routing",      icon: <GitBranch size={18} /> },
  { id: "settings",   labelKey: "tabs.appSettings",  icon: <Settings size={18} /> },
  { id: "about",      labelKey: "tabs.about",        icon: <Info size={18} /> },
];

/**
 * Bottom tab navigation bar.
 * Tabs distributed evenly (flex-1), hover effect wraps content only.
 * Roving focus: only active tab in tab order, arrow keys move focus cyclically.
 */
export function TabNavigation({ activeTab, onTabChange }: TabNavigationProps) {
  const { t } = useTranslation();
  const navRef = useRef<HTMLElement>(null);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    const tabEls = navRef.current?.querySelectorAll<HTMLElement>('[role="tab"]');
    if (!tabEls) return;
    const currentIdx = TABS.findIndex(t => t.id === activeTab);
    if (e.key === "ArrowRight") {
      e.preventDefault();
      tabEls[(currentIdx + 1) % TABS.length].focus();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      tabEls[(currentIdx - 1 + TABS.length) % TABS.length].focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      tabEls[0].focus();
    } else if (e.key === "End") {
      e.preventDefault();
      tabEls[tabEls.length - 1].focus();
    }
  };

  return (
    <nav
      role="tablist"
      className="flex items-center justify-center shrink-0"
      style={{ height: 56 }}
      ref={navRef}
      onKeyDown={handleKeyDown}
    >
      <div className="flex items-center w-full" style={{ maxWidth: 720 }}>
        {TABS.map((tab) => {
          const active = activeTab === tab.id;

          return (
            <div key={tab.id} className="flex-1 flex items-center justify-center">
              <button
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                onClick={() => onTabChange(tab.id)}
                className={[
                  "flex flex-col items-center justify-center rounded-[var(--radius-lg)] transition-colors duration-[var(--transition-fast)] outline-none cursor-pointer",
                  "focus-visible:ring-2 focus-visible:ring-[var(--color-accent-interactive)] focus-visible:ring-offset-1",
                  !active ? "hover:bg-[var(--color-bg-hover)]" : "",
                ].join(" ")}
                style={{
                  maxWidth: 120,
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
              </button>
            </div>
          );
        })}
      </div>
    </nav>
  );
}
