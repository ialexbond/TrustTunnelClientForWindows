import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LayoutDashboard,
  Users,
  SlidersHorizontal,
  Terminal,
  LogOut,
} from "lucide-react";
import { cn } from "../shared/lib/cn";
import type { ServerState } from "./server/useServerState";
import { OverviewSection } from "./server/OverviewSection";
import { UsersSection } from "./server/UsersSection";
import { ServerSettingsSection } from "./server/ServerSettingsSection";
import { ServiceSection } from "./server/ServiceSection";

type TabId = "overview" | "users" | "settings" | "service";

interface Tab {
  id: TabId;
  labelKey: string;
  fallback: string;
  icon: React.ReactNode;
}

const tabs: Tab[] = [
  { id: "overview",  labelKey: "tabs.overview",        fallback: "Обзор",        icon: <LayoutDashboard className="w-4 h-4" /> },
  { id: "users",     labelKey: "tabs.users",           fallback: "Пользователи", icon: <Users className="w-4 h-4" /> },
  { id: "settings",  labelKey: "tabs.settings_server", fallback: "Настройки",    icon: <SlidersHorizontal className="w-4 h-4" /> },
  { id: "service",   labelKey: "tabs.service",         fallback: "Сервис",       icon: <Terminal className="w-4 h-4" /> },
];

interface ServerTabsProps {
  state: ServerState;
}

export function ServerTabs({ state }: ServerTabsProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<TabId>("overview");

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Server header — address + disconnect */}
      <div
        className="flex items-center justify-between px-4 py-2 shrink-0"
        style={{ borderBottom: "1px solid var(--color-border)" }}
      >
        <span className="text-xs text-[var(--color-text-muted)] truncate">
          {state.host}{state.port && state.port !== "22" ? `:${state.port}` : ""}
        </span>
        <button
          type="button"
          onClick={state.onDisconnect}
          aria-label={t("control.disconnect")}
          className="flex items-center gap-1.5 px-2 py-1 rounded-[var(--radius-md)] text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] transition-colors cursor-pointer focus-visible:shadow-[var(--focus-ring)] outline-none"
        >
          <LogOut className="w-3.5 h-3.5" />
          {t("control.disconnect")}
        </button>
      </div>

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
            position: activeTab === "settings" ? "relative" : "absolute",
            inset: activeTab === "settings" ? undefined : 0,
            opacity: activeTab === "settings" ? 1 : 0,
            visibility: activeTab === "settings" ? ("visible" as const) : ("hidden" as const),
            transition: "opacity var(--transition-fast)",
          }}
          aria-hidden={activeTab !== "settings"}
        >
          <ServerSettingsSection state={state} />
        </div>
        <div
          className="h-full flex flex-col overflow-hidden scroll-overlay py-4 px-6 space-y-4"
          style={{
            position: activeTab === "service" ? "relative" : "absolute",
            inset: activeTab === "service" ? undefined : 0,
            opacity: activeTab === "service" ? 1 : 0,
            visibility: activeTab === "service" ? ("visible" as const) : ("hidden" as const),
            transition: "opacity var(--transition-fast)",
          }}
          aria-hidden={activeTab !== "service"}
        >
          <ServiceSection state={state} />
        </div>
      </div>
    </div>
  );
}
