// NOTE: This component is currently unused (kept for future multi-server feature)
import { useTranslation } from "react-i18next";
import { Plus, Power, Loader2 } from "lucide-react";
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

export function ServerSidebar({ servers, selectedId, onSelect, onAddServer, onDisconnect }: ServerSidebarProps) {
  const { t } = useTranslation();

  return (
    <div
      className="shrink-0 flex flex-col h-full"
      style={{ width: 220, backgroundColor: "var(--color-bg-surface)" }}
    >
      {/* Header */}
      <div className="h-[40px] flex items-center px-3">
        <span
          className="text-[var(--color-text-muted)]"
          style={{ fontSize: "11px", fontWeight: 500, letterSpacing: "0.04em", textTransform: "uppercase" }}
        >
          {t("sidebar.servers", "Серверы")}
        </span>
      </div>

      {/* Server list */}
      <div className="flex-1 overflow-y-auto px-1.5 space-y-0.5">
        {servers.map((srv) => (
          <button
            key={srv.id}
            onClick={() => onSelect(srv.id)}
            className={cn(
              "w-full flex items-center gap-2.5 px-2.5 py-2 rounded-[var(--radius-md)] text-left transition-colors group",
              selectedId === srv.id
                ? "bg-[var(--color-bg-elevated)] text-[var(--color-text-primary)]"
                : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
            )}
          >
            {/* Status dot */}
            <div
              className="w-1.5 h-1.5 rounded-full shrink-0"
              style={{
                backgroundColor:
                  srv.status === "connected" ? "var(--color-status-connected)" :
                  srv.status === "connecting" ? "var(--color-status-connecting)" :
                  srv.status === "error" ? "var(--color-status-error)" :
                  "var(--color-text-muted)"
              }}
            />

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

            {/* Quick disconnect */}
            {srv.status === "connected" && (
              <button
                onClick={(e) => { e.stopPropagation(); onDisconnect(srv.id); }}
                className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 p-1 rounded-[var(--radius-sm)] hover:bg-[var(--color-status-error-bg)] transition-opacity"
                aria-label={t("buttons.disconnect", "Отключить") + " " + (srv.label || srv.host)}
              >
                <Power className="w-3 h-3" style={{ color: "var(--color-status-error)" }} />
              </button>
            )}

            {/* Connecting spinner */}
            {srv.status === "connecting" && (
              <Loader2 className="w-3 h-3 animate-spin shrink-0" style={{ color: "var(--color-status-connecting)" }} />
            )}
          </button>
        ))}
      </div>

      {/* Add server button */}
      <div className="px-1.5 py-2">
        <button
          onClick={onAddServer}
          className="w-full flex items-center gap-1.5 px-2.5 py-1.5 rounded-[var(--radius-md)] text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          {t("sidebar.add_server", "Добавить сервер")}
        </button>
      </div>
    </div>
  );
}
