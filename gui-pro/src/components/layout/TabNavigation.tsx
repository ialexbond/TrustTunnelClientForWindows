import { useRef, useState, useEffect, useCallback, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Monitor, Cable, GitBranch, Settings, Info } from "lucide-react";
import { getTabPanelId, getTabButtonId } from "./tabIds";
import type { AppTab } from "../../shared/types";

interface TabNavigationProps {
  activeTab: AppTab;
  onTabChange: (tab: AppTab) => void;
  /**
   * Phase 19 split (UI-SPEC §Block 1) — replaces the Phase 18 `hasUpdate` prop.
   *
   * `hasAppUpdate` — when `true`, an 8×8 accent dot appears top-right on the
   * «О программе» pill (was «Настройки» in Phase 18; moved per UI-SPEC §Block 1
   * §A.1 — the About page is the canonical destination for app-update CTA).
   *
   * `hasSidecarUpdate` — when `true`, an 8×8 accent dot appears top-right on
   * the «Панель управления» pill (UI-SPEC §Block 1 §A.2). Sidecar updates are
   * server-bound, so the dot lives on the entry-point pill that opens the
   * Server panel; the inner «Сервис» tab carries its own dot via `ServerTabs`.
   *
   * Both dots are static (D-DECISION-UI-2.1 — 10% accent rule, no motion).
   * Default: `false` (backwards-compat — App.tsx pre-Phase 19 callers receive
   * no dots until they opt-in via the new props).
   */
  hasAppUpdate?: boolean;
  hasSidecarUpdate?: boolean;
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
export function TabNavigation({
  activeTab,
  onTabChange,
  hasAppUpdate = false,
  hasSidecarUpdate = false,
}: TabNavigationProps) {
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

  // WAI-ARIA Tabs manual activation (Phase 12.5, D-19):
  // Arrow / Home / End move FOCUS only — activation requires Enter/Space/click.
  // This prevents accidental activation of heavy tabs (Control/Connection) while
  // users just navigate the tablist.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    // Find which tab currently has keyboard focus — roving focus means activeTab
    // may lag behind focus as the user arrows around.
    const tabEls = Array.from(
      navRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [],
    );
    if (tabEls.length === 0) return;
    const focusedIdx = tabEls.findIndex((el) => el === document.activeElement);
    const currentIdx = focusedIdx >= 0 ? focusedIdx : TABS.findIndex((t) => t.id === activeTab);

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
      // Manual activation: move focus, DO NOT call onTabChange.
      // User must press Enter/Space/click to activate the focused tab.
      tabEls[nextIdx].focus();
    }
  };

  return (
    <nav
      role="tablist"
      className="flex items-center justify-center shrink-0 px-6"
      style={{ height: 64 }}
      ref={navRef}
      onKeyDown={handleKeyDown}
    >
      <div ref={containerRef} className="relative flex items-stretch w-full gap-[var(--space-2)]">
        {/* Pill indicator — per D-01, D-02. Animated via translateX per NAV-01.
            Phase 13.UAT G-06: width = pillWidth (full button width) вместо pillWidth-8,
            marginLeft: 0 — убраны 4px cushion, чтобы pill + button visible area
            выровнены по краям nav wrapper (совпадает с px-6 tabpanel → визуальные
            вертикальные линии). */}
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            left: 0,
            top: "50%",
            width: pillWidth > 0 ? pillWidth : `calc(100% / ${TABS.length})`,
            height: 50,
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
              id={getTabButtonId(tab.id)}
              aria-selected={active}
              aria-controls={getTabPanelId(tab.id)}
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
                  !active ? "hover:bg-[var(--color-bg-hover)]" : "",
                ].join(" ")}
                style={{
                  width: "100%",
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
              {/* Phase 19 (UI-SPEC §Block 1) — two independent update dots.
                  Both static (D-DECISION-UI-2.1, no motion). Position relative
                  to the button (already position: relative above).
                    • App-update dot   → «О программе» (about) pill
                    • Sidecar-update dot → «Панель управления» (control) pill
                  Phase 18 dot was on «Настройки» (settings) — moved per UI-SPEC. */}
              {hasAppUpdate && tab.id === "about" && (
                <span
                  style={{
                    position: "absolute",
                    top: 8,
                    right: 8,
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    backgroundColor: "var(--color-accent-interactive)",
                  }}
                  role="status"
                  aria-label={t("app.update.dot_aria")}
                  data-testid="about-update-dot"
                />
              )}
              {hasSidecarUpdate && tab.id === "control" && (
                <span
                  style={{
                    position: "absolute",
                    top: 8,
                    right: 8,
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    backgroundColor: "var(--color-accent-interactive)",
                  }}
                  role="status"
                  aria-label={t("app.update.dot_aria")}
                  data-testid="control-sidecar-update-dot"
                />
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
