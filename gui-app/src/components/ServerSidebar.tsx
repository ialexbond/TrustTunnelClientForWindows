import { useTranslation } from "react-i18next";
import { Server, Plus, Power, Loader2 } from "lucide-react";
import { cn } from "../shared/lib/cn";

export interface ServerEntry {
  id: string;
  host: string;
  port: string;
  label?: string;
  status: "connected" | "connecting" | "disconnected" | "error";
}

interface ServerSidebarProps {
  servers: ServerEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAddServer: () => void;
  onDisconnect: (id: string) => void;
}

const statusDot: Record<ServerEntry["status"], string> = {
  connected: "bg-emerald-400",
  connecting: "bg-amber-400 animate-pulse",
  disconnected: "bg-neutral-500",
  error: "bg-red-400",
};

export function ServerSidebar({ servers, selectedId, onSelect, onAddServer, onDisconnect }: ServerSidebarProps) {
  const { t } = useTranslation();

  return (
    <div className="w-[200px] shrink-0 flex flex-col border-r border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
      {/* Header */}
      <div className="h-[40px] flex items-center px-3 border-b border-[var(--color-border)]">
        <span className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider">
          {t("sidebar.servers", "Серверы")}
        </span>
      </div>

      {/* Server list */}
      <div className="flex-1 overflow-y-auto py-1">
        {servers.map((srv) => (
          <button
            key={srv.id}
            onClick={() => onSelect(srv.id)}
            className={cn(
              "w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors group",
              selectedId === srv.id
                ? "bg-[var(--color-bg-elevated)] text-[var(--color-text-primary)]"
                : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-elevated)]/50"
            )}
          >
            {/* Status dot */}
            <div className={cn("w-2 h-2 rounded-full shrink-0", statusDot[srv.status])} />

            {/* Server info */}
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium truncate">
                {srv.label || srv.host}
              </div>
              {srv.label && (
                <div className="text-[10px] text-[var(--color-text-muted)] truncate">
                  {srv.host}:{srv.port}
                </div>
              )}
            </div>

            {/* Quick disconnect (only when connected + hovered) */}
            {srv.status === "connected" && (
              <button
                onClick={(e) => { e.stopPropagation(); onDisconnect(srv.id); }}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-red-500/20 transition-opacity"
                title={t("buttons.disconnect", "Отключить")}
              >
                <Power className="w-3 h-3 text-red-400" />
              </button>
            )}

            {/* Connecting spinner */}
            {srv.status === "connecting" && (
              <Loader2 className="w-3 h-3 animate-spin text-amber-400 shrink-0" />
            )}
          </button>
        ))}

        {servers.length === 0 && (
          <div className="px-3 py-6 text-center">
            <Server className="w-5 h-5 mx-auto mb-2 text-[var(--color-text-muted)]" />
            <p className="text-xs text-[var(--color-text-muted)]">
              {t("sidebar.no_servers", "Нет серверов")}
            </p>
          </div>
        )}
      </div>

      {/* Add server button */}
      <div className="p-2 border-t border-[var(--color-border)]">
        <button
          onClick={onAddServer}
          className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-[var(--radius-md)] text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-elevated)] transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          {t("sidebar.add_server", "Добавить сервер")}
        </button>
      </div>
    </div>
  );
}
