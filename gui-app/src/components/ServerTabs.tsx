import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useActivityLog } from "../shared/hooks/useActivityLog";
import {
  LayoutDashboard,
  Users,
  SlidersHorizontal,
  Shield,
  Wrench,
  LogOut,
} from "lucide-react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { cn } from "../shared/lib/cn";
import { Divider } from "../shared/ui/Divider";
import { Tooltip } from "../shared/ui/Tooltip";
import { Skeleton } from "../shared/ui/Skeleton";
import { useConfirm } from "../shared/ui/useConfirm";
import type { ServerState } from "./server/useServerState";
import { OverviewSection } from "./server/OverviewSection";
import { UsersSection } from "./server/UsersSection";
import { ServerSettingsSection } from "./server/ServerSettingsSection";
import { SecurityTabSection } from "./server/SecurityTabSection";
import { UtilitiesTabSection } from "./server/UtilitiesTabSection";

type TabId = "overview" | "users" | "configuration" | "security" | "utilities";

interface Tab {
  id: TabId;
  labelKey: string;
  fallback: string;
  icon: React.ReactNode;
}

const tabs: Tab[] = [
  { id: "overview",       labelKey: "tabs.overview",       fallback: "Обзор",         icon: <LayoutDashboard className="w-4 h-4" /> },
  { id: "users",          labelKey: "tabs.users",          fallback: "Пользователи",  icon: <Users className="w-4 h-4" /> },
  { id: "configuration",  labelKey: "tabs.configuration",  fallback: "Конфигурация",  icon: <SlidersHorizontal className="w-4 h-4" /> },
  { id: "security",       labelKey: "tabs.security",       fallback: "Безопасность",  icon: <Shield className="w-4 h-4" /> },
  { id: "utilities",      labelKey: "tabs.utilities",      fallback: "Утилиты",       icon: <Wrench className="w-4 h-4" /> },
];

interface ServerTabsProps {
  state: ServerState;
}

export function ServerTabs({ state }: ServerTabsProps) {
  const { t } = useTranslation();
  const { log: activityLog } = useActivityLog();
  const confirm = useConfirm();
  const [activeTab, setActiveTab] = useState<TabId>("overview");

  const handleDisconnect = async () => {
    activityLog("USER", "server.disconnect.initiated", "ServerTabs.LogOutIcon");
    const ok = await confirm({
      title: t("server.disconnect.confirm_title"),
      message: t("server.disconnect.confirm_message"),
      variant: "danger",
      confirmText: t("buttons.confirm"),
      cancelText: t("buttons.cancel"),
    });
    if (ok) {
      activityLog("USER", "server.disconnect.confirmed", "ConfirmDialog");
      state.onDisconnect();
    } else {
      activityLog("USER", "server.disconnect.cancelled", "ConfirmDialog");
    }
  };

  // WAI-ARIA Tabs manual activation (Phase 12.5, D-19):
  // Arrow / Home / End move FOCUS only — activation requires Enter/Space/click.
  // This prevents accidental activation of heavy SSH tabs while navigating.
  const handleTabKeyDown = (e: React.KeyboardEvent, currentIndex: number) => {
    const lastIndex = tabs.length - 1;
    let nextIndex: number | null = null;
    if (e.key === "ArrowRight") nextIndex = currentIndex < lastIndex ? currentIndex + 1 : 0;
    else if (e.key === "ArrowLeft") nextIndex = currentIndex > 0 ? currentIndex - 1 : lastIndex;
    else if (e.key === "Home") nextIndex = 0;
    else if (e.key === "End") nextIndex = lastIndex;
    if (nextIndex !== null) {
      e.preventDefault();
      // Manual activation: move focus only, do NOT call setActiveTab.
      document.getElementById(`tab-${tabs[nextIndex].id}`)?.focus();
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Tab bar */}
      <div
        role="tablist"
        aria-label={t("tabs.server_tabs", "Серверные вкладки")}
        className="flex items-center shrink-0 px-6 gap-1"
        style={{ borderBottom: "1px solid var(--color-border)", paddingTop: "4px", paddingBottom: "4px" }}
      >
        {tabs.map((tab, idx) => (
          <button
            key={tab.id}
            role="tab"
            id={`tab-${tab.id}`}
            aria-selected={activeTab === tab.id}
            aria-controls={`panel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => {
              setActiveTab(tab.id);
              activityLog("USER", `tab.switch target="${tab.id}"`, "ServerTabs");
            }}
            onKeyDown={(e) => handleTabKeyDown(e, idx)}
            className={cn(
              "flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-[var(--font-weight-semibold)] transition-colors rounded-[var(--radius-md)]",
              "focus-visible:shadow-[var(--focus-ring)] outline-none",
              activeTab === tab.id
                ? "bg-[var(--color-bg-elevated)] text-[var(--color-text-primary)] shadow-[var(--shadow-xs)]"
                : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
            )}
          >
            {tab.icon}
            <span>{t(tab.labelKey, tab.fallback)}</span>
          </button>
        ))}

        {/* Separator + Disconnect icon */}
        <Divider orientation="vertical" className="shrink-0 mx-2 my-1.5" />
        <Tooltip text={t("control.disconnect")} position="bottom">
          <button
            type="button"
            onClick={handleDisconnect}
            aria-label={t("control.disconnect")}
            className={cn(
              "shrink-0 flex items-center justify-center",
              "h-8 w-8 rounded-[var(--radius-md)]",
              "text-[var(--color-text-muted)]",
              "hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]",
              "transition-colors",
              "focus-visible:shadow-[var(--focus-ring)] outline-none"
            )}
          >
            <LogOut className="w-4 h-4" />
          </button>
        </Tooltip>
      </div>

      {/* Tab content — cross-fade with visibility+opacity: mount once, fade between tabs */}
      <div className="flex-1 min-h-0 overflow-hidden relative">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            role="tabpanel"
            id={`panel-${tab.id}`}
            aria-labelledby={`tab-${tab.id}`}
            className="h-full flex flex-col overflow-hidden scroll-overlay py-4 px-6 space-y-4"
            style={{
              position: activeTab === tab.id ? "relative" : "absolute",
              inset: activeTab === tab.id ? undefined : 0,
              opacity: activeTab === tab.id ? 1 : 0,
              visibility: activeTab === tab.id ? ("visible" as const) : ("hidden" as const),
              transition: "opacity var(--transition-fast)",
            }}
            aria-hidden={activeTab !== tab.id}
          >
            {state.loading ? (
              <div className="space-y-4">
                <Skeleton variant="card" height={100} />
                <Skeleton variant="line" width="60%" height={14} />
                <Skeleton variant="line" width="40%" height={14} />
                <Skeleton variant="card" height={80} />
              </div>
            ) : state.error ? (
              <div className="flex flex-col items-center justify-center py-12 gap-4" style={{ color: "var(--color-text-muted)" }}>
                <AlertTriangle className="w-8 h-8" style={{ color: "var(--color-danger-400)" }} />
                <p className="text-sm text-center max-w-sm">{state.error}</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => state.loadServerInfo()}
                    className={cn(
                      "flex items-center gap-1.5 px-3 py-1.5 text-xs font-[var(--font-weight-semibold)] rounded-[var(--radius-md)]",
                      "bg-[var(--color-bg-elevated)] text-[var(--color-text-primary)]",
                      "hover:bg-[var(--color-bg-hover)] transition-colors",
                      "focus-visible:shadow-[var(--focus-ring)] outline-none"
                    )}
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    {t("errors.retry")}
                  </button>
                </div>
              </div>
            ) : (
              <>
                {tab.id === "overview" && (
                  <OverviewSection
                    state={state}
                    activeServerTab={activeTab}
                    onNavigate={(nextTab) => {
                      setActiveTab(nextTab);
                      activityLog(
                        "USER",
                        `tab.switch target="${nextTab}" source="overview-drilldown"`,
                        "OverviewSection",
                      );
                    }}
                  />
                )}
                {tab.id === "users" && <UsersSection state={state} />}
                {tab.id === "configuration" && <ServerSettingsSection state={state} />}
                {tab.id === "security" && <SecurityTabSection state={state} />}
                {tab.id === "utilities" && <UtilitiesTabSection state={state} />}
              </>
            )}
          </div>
        ))}
      </div>

    </div>
  );
}
