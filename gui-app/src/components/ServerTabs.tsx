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
import { AlertTriangle, Loader2 } from "lucide-react";
import { cn } from "../shared/lib/cn";
import { Tooltip } from "../shared/ui/Tooltip";
import { Skeleton } from "../shared/ui/Skeleton";
import type { ServerState } from "./server/useServerState";
import { OverviewSection } from "./server/OverviewSection";
import { UsersSection } from "./server/UsersSection";
import { ServerSettingsSection } from "./server/ServerSettingsSection";
import { SecurityTabSection } from "./server/SecurityTabSection";
import { UtilitiesTabSection } from "./server/UtilitiesTabSection";
import { ConfirmDialog } from "../shared/ui/ConfirmDialog";

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
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);

  const handleTabKeyDown = (e: React.KeyboardEvent, currentIndex: number) => {
    const lastIndex = tabs.length - 1;
    let nextIndex: number | null = null;
    if (e.key === "ArrowRight") nextIndex = currentIndex < lastIndex ? currentIndex + 1 : 0;
    if (e.key === "ArrowLeft") nextIndex = currentIndex > 0 ? currentIndex - 1 : lastIndex;
    if (nextIndex !== null) {
      e.preventDefault();
      setActiveTab(tabs[nextIndex].id);
      activityLog("USER", `tab.switch target="${tabs[nextIndex].id}"`, "ServerTabs");
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
        <div
          aria-hidden="true"
          className="shrink-0 mx-2 self-stretch my-1.5"
          style={{ width: "1px", backgroundColor: "var(--color-border)" }}
        />
        <Tooltip text={t("control.disconnect")} position="bottom">
          <button
            type="button"
            onClick={() => {
              setShowDisconnectConfirm(true);
              activityLog("USER", "server.disconnect.initiated", "ServerTabs.LogOutIcon");
            }}
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
              <div className="flex flex-col items-center justify-center py-12 gap-3" style={{ color: "var(--color-text-muted)" }}>
                <AlertTriangle className="w-8 h-8" style={{ color: "var(--color-danger-400)" }} />
                <p className="text-sm text-center max-w-sm">{state.error}</p>
              </div>
            ) : (
              <>
                {tab.id === "overview" && <OverviewSection state={state} />}
                {tab.id === "users" && <UsersSection state={state} />}
                {tab.id === "configuration" && <ServerSettingsSection state={state} />}
                {tab.id === "security" && <SecurityTabSection state={state} />}
                {tab.id === "utilities" && <UtilitiesTabSection state={state} />}
              </>
            )}
          </div>
        ))}
      </div>

      <ConfirmDialog
        isOpen={showDisconnectConfirm}
        variant="danger"
        title={t("server.disconnect.confirm_title")}
        message={t("server.disconnect.confirm_message")}
        confirmLabel={t("buttons.confirm")}
        cancelLabel={t("buttons.cancel")}
        onConfirm={() => {
          activityLog("USER", "server.disconnect.confirmed", "ConfirmDialog");
          setShowDisconnectConfirm(false);
          state.onDisconnect();
        }}
        onCancel={() => {
          activityLog("USER", "server.disconnect.cancelled", "ConfirmDialog");
          setShowDisconnectConfirm(false);
        }}
      />
    </div>
  );
}
