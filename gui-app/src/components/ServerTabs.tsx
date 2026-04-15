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
import { Accordion } from "../shared/ui/Accordion";

type TabId = "status" | "users" | "config" | "security" | "tools";

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
              "flex-1 flex items-center justify-center gap-1.5 py-2 mx-0.5 text-xs font-medium transition-colors rounded-[var(--radius-md)]",
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

      {/* Tab content — cross-fade with visibility+opacity (D-06): mount once, fade between tabs */}
      <div className="flex-1 min-h-0 overflow-hidden relative">
        <div
          className="h-full flex flex-col overflow-hidden scroll-overlay py-4 px-6 space-y-4"
          style={{
            position: activeTab === "status" ? "relative" : "absolute",
            inset: activeTab === "status" ? undefined : 0,
            opacity: activeTab === "status" ? 1 : 0,
            visibility: activeTab === "status" ? ("visible" as const) : ("hidden" as const),
            transition: "opacity var(--transition-fast)",
          }}
          aria-hidden={activeTab !== "status"}
        >
          <ServerStatusSection state={state} />
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
            position: activeTab === "config" ? "relative" : "absolute",
            inset: activeTab === "config" ? undefined : 0,
            opacity: activeTab === "config" ? 1 : 0,
            visibility: activeTab === "config" ? ("visible" as const) : ("hidden" as const),
            transition: "opacity var(--transition-fast)",
          }}
          aria-hidden={activeTab !== "config"}
        >
          <VersionSection state={state} />
          <ConfigSection state={state} />
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
          <SecuritySection state={state} />
          <CertSection state={state} />
        </div>
        <div
          className="h-full flex flex-col overflow-hidden scroll-overlay py-4 px-6 space-y-4"
          style={{
            position: activeTab === "tools" ? "relative" : "absolute",
            inset: activeTab === "tools" ? undefined : 0,
            opacity: activeTab === "tools" ? 1 : 0,
            visibility: activeTab === "tools" ? ("visible" as const) : ("hidden" as const),
            transition: "opacity var(--transition-fast)",
          }}
          aria-hidden={activeTab !== "tools"}
        >
          <UtilitiesSection state={state} />
          <LogsSection state={state} />
          <Accordion
            items={[{
              id: "danger",
              title: (
                <span className="flex items-center gap-1.5">
                  <AlertTriangle
                    className="w-3.5 h-3.5"
                    style={{ color: "var(--color-danger-400)" }}
                  />
                  <span style={{ color: "var(--color-status-error)" }}>
                    {t("server.danger.title", "Опасная зона")}
                  </span>
                </span>
              ),
              content: <DangerZoneSection state={state} />,
            }]}
            defaultOpen={[]}
          />
        </div>
      </div>
    </div>
  );
}
