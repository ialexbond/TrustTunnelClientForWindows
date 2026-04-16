import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LayoutDashboard,
  Users,
  SlidersHorizontal,
  Shield,
  Wrench,
  LogOut,
} from "lucide-react";
import { cn } from "../shared/lib/cn";
import type { ServerState } from "./server/useServerState";
import { OverviewSection } from "./server/OverviewSection";
import { UsersSection } from "./server/UsersSection";
import { ServerSettingsSection } from "./server/ServerSettingsSection";
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
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Tab bar */}
      <div
        className="flex items-center shrink-0"
        style={{ borderBottom: "1px solid var(--color-border)", padding: "4px 8px" }}
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              "flex-1 flex items-center justify-center gap-1.5 py-2 mx-1 text-xs font-[var(--font-weight-semibold)] transition-colors rounded-[var(--radius-md)]",
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

        {/* Disconnect icon - visually separated from tabs */}
        <button
          type="button"
          onClick={() => setShowDisconnectConfirm(true)}
          aria-label={t("control.disconnect")}
          title={t("control.disconnect")}
          className={cn(
            "shrink-0 flex items-center justify-center",
            "h-9 w-9 rounded-[var(--radius-md)]",
            "text-[var(--color-text-muted)]",
            "hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]",
            "transition-colors",
            "focus-visible:shadow-[var(--focus-ring)] outline-none",
            "border-l border-[var(--color-border)] ml-2 pl-2"
          )}
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>

      {/* Tab content — cross-fade with visibility+opacity: mount once, fade between tabs */}
      <div className="flex-1 min-h-0 overflow-hidden relative">
        <div
          className="h-full flex flex-col overflow-hidden scroll-overlay py-4 px-6 space-y-4"
          style={{
            position: activeTab === "overview" ? "relative" : "absolute",
            inset: activeTab === "overview" ? undefined : 0,
            opacity: activeTab === "overview" ? 1 : 0,
            visibility: activeTab === "overview" ? ("visible" as const) : ("hidden" as const),
            transition: "opacity var(--transition-fast)",
          }}
          aria-hidden={activeTab !== "overview"}
        >
          <OverviewSection state={state} />
        </div>
        <div
          className="h-full flex flex-col overflow-hidden scroll-overlay py-4 px-6 space-y-4"
          style={{
            position: activeTab === "users" ? "relative" : "absolute",
            inset: activeTab === "users" ? undefined : 0,
            opacity: activeTab === "users" ? 1 : 0,
            visibility: activeTab === "users" ? ("visible" as const) : ("hidden" as const),
            transition: "opacity var(--transition-fast)",
          }}
          aria-hidden={activeTab !== "users"}
        >
          <UsersSection state={state} />
        </div>
        <div
          className="h-full flex flex-col overflow-hidden scroll-overlay py-4 px-6 space-y-4"
          style={{
            position: activeTab === "configuration" ? "relative" : "absolute",
            inset: activeTab === "configuration" ? undefined : 0,
            opacity: activeTab === "configuration" ? 1 : 0,
            visibility: activeTab === "configuration" ? ("visible" as const) : ("hidden" as const),
            transition: "opacity var(--transition-fast)",
          }}
          aria-hidden={activeTab !== "configuration"}
        >
          <ServerSettingsSection state={state} />
        </div>
        <div
          className="h-full flex flex-col overflow-hidden scroll-overlay py-4 px-6 space-y-4"
          style={{
            position: activeTab === "security" ? "relative" : "absolute",
            inset: activeTab === "security" ? undefined : 0,
            opacity: activeTab === "security" ? 1 : 0,
            visibility: activeTab === "security" ? ("visible" as const) : ("hidden" as const),
            transition: "opacity var(--transition-fast)",
          }}
          aria-hidden={activeTab !== "security"}
        >
          <div className="text-sm text-[var(--color-text-muted)]">Security tab (Plan 03)</div>
        </div>
        <div
          className="h-full flex flex-col overflow-hidden scroll-overlay py-4 px-6 space-y-4"
          style={{
            position: activeTab === "utilities" ? "relative" : "absolute",
            inset: activeTab === "utilities" ? undefined : 0,
            opacity: activeTab === "utilities" ? 1 : 0,
            visibility: activeTab === "utilities" ? ("visible" as const) : ("hidden" as const),
            transition: "opacity var(--transition-fast)",
          }}
          aria-hidden={activeTab !== "utilities"}
        >
          <div className="text-sm text-[var(--color-text-muted)]">Utilities tab (Plan 03)</div>
        </div>
      </div>

      <ConfirmDialog
        open={showDisconnectConfirm}
        variant="danger"
        title={t("server.disconnect.confirm_title")}
        message={t("server.disconnect.confirm_message")}
        confirmLabel={t("buttons.confirm")}
        cancelLabel={t("buttons.cancel")}
        onConfirm={() => {
          setShowDisconnectConfirm(false);
          state.onDisconnect();
        }}
        onCancel={() => setShowDisconnectConfirm(false)}
      />
    </div>
  );
}
