import { useRef, useState, useEffect, useCallback, type ReactNode } from "react";
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
 * Pill indicator: absolutely positioned div animated via translateX (D-01, NAV-01).
 */
export function TabNavigation({ activeTab, onTabChange }: TabNavigationProps) {
  const { t } = useTranslation();
  const navRef = useRef<HTMLElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [pillOffset, setPillOffset] = useState(0);
  const [pillWidth, setPillWidth] = useState(0);

  const updatePillPosition = useCallback(() => {
    const activeIndex = TABS.findIndex(t => t.id === activeTab);
    const container = containerRef.current;
    const activeButton = tabRefs.current[activeIndex];
    if (!container || !activeButton) return;

    const containerRect = container.getBoundingClientRect();
    const buttonRect = activeButton.getBoundingClientRect();
    setPillOffset(buttonRect.left - containerRect.left);
    setPillWidth(buttonRect.width);
  }, [activeTab]);

  useEffect(() => {
    updatePillPosition();
  }, [updatePillPosition]);

  useEffect(() => {
    window.addEventListener("resize", updatePillPosition);
    return () => window.removeEventListener("resize", updatePillPosition);
  }, [updatePillPosition]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    const tabEls = navRef.current?.querySelectorAll<HTMLElement>('[role="tab"]');
    if (!tabEls) return;
    const currentIdx = TABS.findIndex(t => t.id === activeTab);

    let nextIdx: number | null = null;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      nextIdx = (currentIdx + 1) % TABS.length;
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      nextIdx = (currentIdx - 1 + TABS.length) % TABS.length;
    } else if (e.key === "Home") {
      e.preventDefault();
      nextIdx = 0;
    } else if (e.key === "End") {
      e.preventDefault();
      nextIdx = TABS.length - 1;
    }

    if (nextIdx !== null) {
      tabEls[nextIdx].focus();
      onTabChange(TABS[nextIdx].id);
    }
  };

  return (
    <nav
      role="tablist"
      className="flex items-center justify-center shrink-0"
      style={{ height: 64 }}
      ref={navRef}
      onKeyDown={handleKeyDown}
    >
      <div ref={containerRef} className="relative flex items-stretch w-full" style={{ maxWidth: 720 }}>
        {/* Pill indicator — per D-01, D-02. Animated via translateX per NAV-01. */}
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            left: 0,
            top: "50%",
            width: pillWidth > 0 ? pillWidth - 8 : `calc(100% / ${TABS.length} - 8px)`,
            height: 50,
            marginLeft: 4,
            transform: `translateX(${pillOffset}px) translateY(-50%)`,
            backgroundColor: "var(--color-bg-elevated)",
            boxShadow: "var(--shadow-xs)",
            borderRadius: "var(--radius-lg)",
            zIndex: 0,
            transition: "transform var(--transition-slow) var(--ease-out)",
            pointerEvents: "none" as const,
          }}
        />
        {TABS.map((tab, index) => {
          const active = activeTab === tab.id;

          return (
            <button
              key={tab.id}
              ref={(el) => { tabRefs.current[index] = el; }}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => onTabChange(tab.id)}
              className="flex-1 flex items-center justify-center outline-none cursor-pointer bg-transparent border-none p-0 focus-visible:shadow-[var(--focus-ring)]"
              style={{
                color: active ? "var(--color-accent-interactive)" : "var(--color-text-secondary)",
                position: "relative",
              }}
            >
              <span
                className={[
                  "flex flex-col items-center justify-center rounded-[var(--radius-lg)] transition-colors duration-[var(--transition-fast)]",
                  "focus-visible:ring-2 focus-visible:ring-[var(--color-accent-interactive)]",
                  !active ? "hover:bg-[var(--color-bg-hover)]" : "",
                ].join(" ")}
                style={{
                  width: "calc(100% - 8px)",
                  height: 50,
                }}
              >
                {tab.icon}
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: active ? 600 : 400,
                    lineHeight: 1,
                    marginTop: 4,
                    whiteSpace: "nowrap",
                  }}
                >
                  {t(tab.labelKey)}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
