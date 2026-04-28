import { useState, useId, type ReactNode, type KeyboardEvent } from "react";
import { cn } from "../lib/cn";

/**
 * Phase 15.1 — WAI-ARIA Tabs primitive для compact inline navigation.
 *
 * Use case: nested protocol tabs в [listen_protocols] секции vpn.toml
 * (HTTP/1 | HTTP/2 | QUIC) per D-9.1. Reusable wherever a small horizontal
 * tab strip is needed inside a larger panel.
 *
 * Differs from gui-pro/src/components/ServerTabs.tsx (large pill-bar at
 * server panel level):
 *   - Compact: text-mono-sm labels, underline indicator (not pill)
 *   - Reusable primitive: takes tabs array as prop вместо hardcoded list
 *   - Manual activation per WAI-ARIA: Arrow keys move focus only,
 *     Enter/Space/click activate
 *
 * Per D-PRE-4 (Phase 15.1) — нет отдельного Storybook story для TabsInline;
 * visible через единый Screens/ConfigurationTab story (Plan 15.1-07).
 *
 * Reference: WAI-ARIA Authoring Practices 1.2 — Tabs Pattern
 * https://www.w3.org/WAI/ARIA/apg/patterns/tabs/
 */
export interface TabsInlineTab {
  /** Stable id; used in DOM ids (`tab-{prefix}-{id}` / `panel-{prefix}-{id}`). */
  id: string;
  /** Human-readable label (rendered as visible tab text). */
  label: string;
  /** Tab panel content rendered when this tab is active. */
  content: ReactNode;
}

export interface TabsInlineProps {
  tabs: TabsInlineTab[];
  /** Initially active tab id. Defaults to the first tab. */
  defaultTab?: string;
  /**
   * Optional id prefix to disambiguate multiple TabsInline instances
   * sharing the same DOM. If absent, useId() is used (stripped of `:`).
   */
  idPrefix?: string;
  /** Optional aria-label на tablist (e.g. "Listen protocols"). */
  ariaLabel?: string;
  className?: string;
}

export function TabsInline({
  tabs,
  defaultTab,
  idPrefix,
  ariaLabel,
  className,
}: TabsInlineProps) {
  const reactId = useId();
  // useId() returns ":r0:"-style strings — sanitize for use in DOM ids
  const prefix = idPrefix ?? reactId.replace(/:/g, "");
  const [activeTab, setActiveTab] = useState<string>(
    defaultTab ?? tabs[0]?.id ?? ""
  );

  const handleKeyDown = (
    e: KeyboardEvent<HTMLButtonElement>,
    currentIndex: number
  ) => {
    const lastIndex = tabs.length - 1;
    let nextIndex: number | null = null;
    if (e.key === "ArrowRight") {
      nextIndex = currentIndex < lastIndex ? currentIndex + 1 : 0;
    } else if (e.key === "ArrowLeft") {
      nextIndex = currentIndex > 0 ? currentIndex - 1 : lastIndex;
    } else if (e.key === "Home") {
      nextIndex = 0;
    } else if (e.key === "End") {
      nextIndex = lastIndex;
    }
    if (nextIndex !== null) {
      e.preventDefault();
      // Manual activation per WAI-ARIA Tabs Pattern: focus moves only,
      // do NOT call setActiveTab. Activation requires Enter/Space/click.
      document
        .getElementById(`tab-${prefix}-${tabs[nextIndex].id}`)
        ?.focus();
    }
  };

  if (tabs.length === 0) return null;

  const activePanel = tabs.find((t) => t.id === activeTab) ?? tabs[0];

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {/* Tab strip — underline indicator, mono-sm compact labels */}
      <div
        role="tablist"
        aria-label={ariaLabel}
        className="flex items-center gap-1 border-b border-[var(--color-border)]"
      >
        {tabs.map((tab, idx) => {
          const isActive = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`tab-${prefix}-${tab.id}`}
              aria-selected={isActive}
              aria-controls={`panel-${prefix}-${tab.id}`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={(e) => handleKeyDown(e, idx)}
              className={cn(
                "px-3 py-2 text-mono-sm transition-colors rounded-t-[var(--radius-sm)]",
                "focus-visible:shadow-[var(--focus-ring)] outline-none",
                "border-b-2",
                isActive
                  ? "text-[var(--color-text-primary)] border-[var(--color-accent-interactive)]"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] border-transparent"
              )}
              // WCAG touch target — 32 px minimum (UI-SPEC §Spacing exception)
              style={{ minHeight: "32px" }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Active tab panel */}
      <div
        role="tabpanel"
        id={`panel-${prefix}-${activePanel.id}`}
        aria-labelledby={`tab-${prefix}-${activePanel.id}`}
      >
        {activePanel.content}
      </div>
    </div>
  );
}
