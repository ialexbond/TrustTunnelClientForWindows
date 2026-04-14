import { useTranslation } from "react-i18next";
import { Server, Plus, Power, Loader2 } from "lucide-react";
import { cn } from "../shared/lib/cn";
import { EmptyState } from "../shared/ui/EmptyState";

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

export function ServerSidebar({ servers, selectedId, onSelect, onAddServer, onDisconnect }: ServerSidebarProps) {
  const { t } = useTranslation();

  return (
    <div
      className="shrink-0 flex flex-col"
      style={{ width: 220, backgroundColor: "var(--color-bg-secondary)" }}
    >
      {/* Header */}
      <div className="h-[40px] flex items-center px-3">
        <span
          className="uppercase text-[var(--color-text-muted)]"
          style={{ fontSize: "11px", fontWeight: 400, letterSpacing: "0.02em" }}
        >
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
                : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
            )}
          >
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

            {/* Quick disconnect (only when connected + hovered or keyboard focused) */}
            {srv.status === "connected" && (
              <button
                onClick={(e) => { e.stopPropagation(); onDisconnect(srv.id); }}
                className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 p-0.5 rounded hover:bg-[var(--color-status-error-bg)] transition-opacity"
                aria-label={t("buttons.disconnect", "Отключить") + " " + (srv.label || srv.host)}
              >
                <Power className="w-3 h-3" style={{ color: "var(--color-status-error)" }} />
              </button>
            )}

            {/* Connecting spinner — token var for color */}
            {srv.status === "connecting" && (
              <Loader2 className="w-3 h-3 animate-spin shrink-0" style={{ color: "var(--color-status-connecting)" }} />
            )}
          </button>
        ))}

        {/* Empty state — uses shared EmptyState component */}
        {servers.length === 0 && (
          <EmptyState
            icon={<Server className="w-5 h-5" />}
            heading={t("sidebar.no_servers", "Нет серверов")}
            body={t("sidebar.no_servers_hint", "Настройте подключение в «Панель управления»")}
          />
        )}
      </div>

      {/* Add server button */}
      <div className="p-2">
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
