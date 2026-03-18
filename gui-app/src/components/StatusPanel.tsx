import { useState, useEffect, type ReactNode } from "react";
import {
  Wifi,
  WifiOff,
  Loader2,
  AlertTriangle,
  Clock,
} from "lucide-react";
import type { VpnStatus } from "../App";

interface StatusPanelProps {
  status: VpnStatus;
  error: string | null;
  connectedSince: Date | null;
  onConnect: () => void;
  onDisconnect: () => void;
}

const STATUS_CONFIG: Record<
  VpnStatus,
  { label: string; dotClass: string; icon: ReactNode; color: string }
> = {
  disconnected: {
    label: "Отключен",
    dotClass: "status-dot-disconnected",
    icon: <WifiOff className="w-8 h-8" />,
    color: "text-gray-400",
  },
  connecting: {
    label: "Подключение...",
    dotClass: "status-dot-connecting",
    icon: <Loader2 className="w-8 h-8 animate-spin" />,
    color: "text-amber-400",
  },
  connected: {
    label: "Подключен",
    dotClass: "status-dot-connected",
    icon: <Wifi className="w-8 h-8" />,
    color: "text-emerald-400",
  },
  disconnecting: {
    label: "Отключение...",
    dotClass: "status-dot-connecting",
    icon: <Loader2 className="w-8 h-8 animate-spin" />,
    color: "text-amber-400",
  },
  recovering: {
    label: "Восстановление...",
    dotClass: "status-dot-connecting",
    icon: <Loader2 className="w-8 h-8 animate-spin" />,
    color: "text-amber-400",
  },
  error: {
    label: "Ошибка",
    dotClass: "status-dot-error",
    icon: <AlertTriangle className="w-8 h-8" />,
    color: "text-red-400",
  },
};

function formatUptime(since: Date): string {
  const diff = Math.floor((Date.now() - since.getTime()) / 1000);
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  const s = diff % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function UptimeCounter({ since }: { since: Date }) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  return <span>{formatUptime(since)}</span>;
}

function StatusPanel({
  status,
  error,
  connectedSince,
  onConnect,
  onDisconnect,
}: StatusPanelProps) {
  const cfg = STATUS_CONFIG[status];

  return (
    <div className="glass-card p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div
            className={`p-3 rounded-xl bg-white/5 border border-white/10 ${cfg.color}`}
          >
            {cfg.icon}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className={`status-dot ${cfg.dotClass}`} />
              <span className="text-base font-semibold">{cfg.label}</span>
            </div>
            {connectedSince && status === "connected" && (
              <div className="flex items-center gap-1 text-xs text-gray-500 mt-0.5">
                <Clock className="w-3 h-3" />
                <UptimeCounter since={connectedSince} />
              </div>
            )}
            {error && (
              <p className="text-[11px] text-red-400 mt-0.5 max-w-sm break-words line-clamp-3" title={error}>
                {error}
              </p>
            )}
          </div>
        </div>

        <div>
          {status === "connecting" || status === "recovering" ? (
            <button
              disabled
              className="px-5 py-2.5 rounded-xl font-semibold text-sm text-white cursor-not-allowed
                         bg-gradient-to-r from-amber-500 to-yellow-500 shadow-lg shadow-amber-500/25 opacity-90"
            >
              {status === "connecting" ? "Подключение..." : "Восстановление..."}
            </button>
          ) : status === "disconnecting" ? (
            <button
              disabled
              className="px-5 py-2.5 rounded-xl font-semibold text-sm text-white cursor-not-allowed
                         bg-gradient-to-r from-amber-500 to-yellow-500 shadow-lg shadow-amber-500/25 opacity-90"
            >
              Отключение...
            </button>
          ) : status === "connected" ? (
            <button
              onClick={onDisconnect}
              className="btn-danger !px-5 !py-2.5 text-sm"
            >
              Отключить
            </button>
          ) : (
            <button
              onClick={onConnect}
              className="btn-primary !px-5 !py-2.5 text-sm"
            >
              Подключить
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default StatusPanel;
