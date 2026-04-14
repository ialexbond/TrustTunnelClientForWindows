import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  Users,
  Settings,
  Shield,
  Wrench,
  AlertTriangle,
} from "lucide-react";
import { cn } from "../shared/ui/cn";
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
  { id: "status",   labelKey: "tabs.status",   fallback: "Статус",      icon: <Activity className="w-3.5 h-3.5" /> },
  { id: "users",    labelKey: "tabs.users",    fallback: "Пользователи", icon: <Users className="w-3.5 h-3.5" /> },
  { id: "config",   labelKey: "tabs.config",   fallback: "Конфигурация", icon: <Settings className="w-3.5 h-3.5" /> },
  { id: "security", labelKey: "tabs.security", fallback: "Безопасность", icon: <Shield className="w-3.5 h-3.5" /> },
  { id: "tools",    labelKey: "tabs.tools",    fallback: "Инструменты",  icon: <Wrench className="w-3.5 h-3.5" /> },
  { id: "danger",   labelKey: "tabs.danger",   fallback: "Опасная зона", icon: <AlertTriangle className="w-3.5 h-3.5" /> },
];

interface ServerTabsProps {
  state: ServerState;
}

export function ServerTabs({ state }: ServerTabsProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<TabId>("status");

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Tab bar */}
      <div className="flex items-center gap-0.5 px-3 border-b border-[var(--color-border)] bg-[var(--color-bg-primary)]">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-2 text-xs font-medium transition-colors border-b-2 -mb-px",
              activeTab === tab.id
                ? "border-[var(--color-accent-interactive)] text-[var(--color-text-primary)]"
                : "border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
            )}
          >
            {tab.icon}
            <span className="hidden sm:inline">{t(tab.labelKey, tab.fallback)}</span>
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 scroll-overlay py-3 px-4 space-y-4">
        {activeTab === "status" && <ServerStatusSection state={state} />}
        {activeTab === "users" && <UsersSection state={state} />}
        {activeTab === "config" && (
          <>
            <VersionSection state={state} />
            <ConfigSection state={state} />
          </>
        )}
        {activeTab === "security" && (
          <>
            <SecuritySection state={state} />
            <CertSection state={state} />
          </>
        )}
        {activeTab === "tools" && (
          <>
            <UtilitiesSection state={state} />
            <LogsSection state={state} />
          </>
        )}
        {activeTab === "danger" && <DangerZoneSection state={state} />}
      </div>
    </div>
  );
}
