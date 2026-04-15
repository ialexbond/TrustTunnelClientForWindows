import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  Users,
  Settings,
  Shield,
  Wrench,
  AlertTriangle,
  LogOut,
} from "lucide-react";
import { cn } from "../shared/lib/cn";
import type { ServerState } from "./server/useServerState";
import { ServerStatusSection } from "./server/ServerStatusSection";
import { UsersSection } from "./server/UsersSection";
import { VersionSection } from "./server/VersionSection";
import { ConfigSection } from "./server/ConfigSection";
import { CertSection } from "./server/CertSection";
import { SecuritySection } from "./server/SecuritySection";
import { UtilitiesSection } from "./server/UtilitiesSection";
import { LogsSection } from "./server/LogsSection";
import { DangerZoneSection } from "./server/DangerZoneSection";

type TabId = "status" | "users" | "config" | "security" | "tools" | "danger";

interface Tab {
  id: TabId;
  labelKey: string;
  fallback: string;
  icon: React.ReactNode;
}

const tabs: Tab[] = [
  { id: "status",   labelKey: "tabs.status",   fallback: "Статус",      icon: <Activity className="w-4 h-4" /> },
  { id: "users",    labelKey: "tabs.users",    fallback: "Пользователи", icon: <Users className="w-4 h-4" /> },
  { id: "config",   labelKey: "tabs.config",   fallback: "Конфигурация", icon: <Settings className="w-4 h-4" /> },
  { id: "security", labelKey: "tabs.security", fallback: "Безопасность", icon: <Shield className="w-4 h-4" /> },
  { id: "tools",    labelKey: "tabs.tools",    fallback: "Инструменты",  icon: <Wrench className="w-4 h-4" /> },
  { id: "danger",   labelKey: "tabs.danger",   fallback: "Опасная зона", icon: <AlertTriangle className="w-4 h-4" /> },
];

interface ServerTabsProps {
  state: ServerState;
}

export function ServerTabs({ state }: ServerTabsProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<TabId>("status");

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
          className="flex items-center gap-1.5 px-2 py-1 rounded-[var(--radius-md)] text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] transition-colors cursor-pointer"
        >
          <LogOut className="w-3.5 h-3.5" />
          {t("control.disconnect")}
        </button>
      </div>

      {/* Tab bar */}
      <div
        className="flex items-center px-3 shrink-0"
        style={{ borderBottom: "1px solid var(--color-border)" }}
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              "flex-1 flex items-center justify-center gap-2 py-2.5 text-xs font-medium transition-colors border-b -mb-px",
              activeTab === tab.id
                ? "border-[var(--color-accent-interactive)] text-[var(--color-text-primary)]"
                : "border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
            )}
          >
            {tab.icon}
            <span>{t(tab.labelKey, tab.fallback)}</span>
          </button>
        ))}
      </div>

      {/* Tab content — display:none caching (D-13, D-14): mount once, toggle visibility */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <div
          className="h-full flex flex-col overflow-hidden scroll-overlay py-4 px-6 space-y-4"
          style={{ display: activeTab === "status" ? "flex" : "none" }}
        >
          <ServerStatusSection state={state} />
        </div>
        <div
          className="h-full flex flex-col overflow-hidden scroll-overlay py-4 px-6 space-y-4"
          style={{ display: activeTab === "users" ? "flex" : "none" }}
        >
          <UsersSection state={state} />
        </div>
        <div
          className="h-full flex flex-col overflow-hidden scroll-overlay py-4 px-6 space-y-4"
          style={{ display: activeTab === "config" ? "flex" : "none" }}
        >
          <VersionSection state={state} />
          <ConfigSection state={state} />
        </div>
        <div
          className="h-full flex flex-col overflow-hidden scroll-overlay py-4 px-6 space-y-4"
          style={{ display: activeTab === "security" ? "flex" : "none" }}
        >
          <SecuritySection state={state} />
          <CertSection state={state} />
        </div>
        <div
          className="h-full flex flex-col overflow-hidden scroll-overlay py-4 px-6 space-y-4"
          style={{ display: activeTab === "tools" ? "flex" : "none" }}
        >
          <UtilitiesSection state={state} />
          <LogsSection state={state} />
        </div>
        <div
          className="h-full flex flex-col overflow-hidden scroll-overlay py-4 px-6 space-y-4"
          style={{ display: activeTab === "danger" ? "flex" : "none" }}
        >
          <DangerZoneSection state={state} />
        </div>
      </div>
    </div>
  );
}
