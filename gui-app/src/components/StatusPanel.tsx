import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Wifi,
  WifiOff,
  Loader2,
  AlertTriangle,
  Clock,
  Activity,
  RefreshCw,
  ArrowDown,
  ArrowUp,
} from "lucide-react";
import type { VpnStatus } from "../App";

interface StatusPanelProps {
  status: VpnStatus;
  error: string | null;
  connectedSince: Date | null;
  onConnect: () => void;
  onDisconnect: () => void;
  configPath?: string;
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
    label: "Ожидание сети...",
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

interface SpeedResult {
  download_mbps: number;
  upload_mbps: number;
}

function PingDisplay({ configPath, status }: { configPath?: string; status: VpnStatus }) {
  const [ping, setPing] = useState<number | null>(null);
  const [speed, setSpeed] = useState<SpeedResult | null>(null);
  const [testing, setTesting] = useState(false);
  const endpointRef = useRef<{ host: string; port: number } | null>(null);
  const isConnected = status === "connected";

  // Parse endpoint from config once
  useEffect(() => {
    if (!configPath) return;
    invoke<{ endpoint?: { hostname?: string } }>("read_client_config", { configPath })
      .then((cfg) => {
        const raw = cfg?.endpoint?.hostname || "";
        const parts = raw.split(":");
        const host = parts[0] || "";
        const port = parts.length > 1 ? parseInt(parts[1], 10) : 443;
        if (host) endpointRef.current = { host, port };
      })
      .catch(() => {});
  }, [configPath]);

  const doPing = useCallback(async () => {
    if (!endpointRef.current) return;
    const { host, port } = endpointRef.current;
    try {
      const ms = await invoke<number>("ping_endpoint", { host, port });
      setPing(ms);
    } catch {
      setPing(-1);
    }
  }, []);

  // Only ping when connected; clear on disconnect
  useEffect(() => {
    if (!isConnected) {
      setPing(null);
      setSpeed(null);
      setTesting(false);
      return;
    }
    doPing();
    const iv = setInterval(doPing, 10000);
    return () => clearInterval(iv);
  }, [isConnected, doPing]);

  const runSpeedTest = useCallback(async () => {
    if (testing) return;
    setTesting(true);
    try {
      const result = await invoke<SpeedResult>("speedtest_run");
      setSpeed(result);
    } catch {
      // keep previous result on error
    } finally {
      setTesting(false);
    }
  }, [testing]);

  if (!isConnected || ping === null) return null;

  const color = ping < 0 ? "text-gray-600" : ping < 90 ? "text-emerald-400" : ping <= 200 ? "text-amber-400" : "text-red-400";
  const label = ping < 0 ? "—" : `${ping} ms`;
  const dl = speed?.download_mbps ?? 0;
  const ul = speed?.upload_mbps ?? 0;

  return (
    <div className="flex items-center gap-2 text-xs mt-0.5">
      <div className={`flex items-center gap-1 ${color}`}>
        <Activity className="w-3 h-3" />
        <span>{label}</span>
      </div>
      <span className="text-gray-600">|</span>
      <span className="flex items-center gap-0.5 text-emerald-400">
        <ArrowDown className="w-3 h-3" />{dl} Мбит/с
      </span>
      <span className="flex items-center gap-0.5 text-indigo-400">
        <ArrowUp className="w-3 h-3" />{ul} Мбит/с
      </span>
      <button
        onClick={runSpeedTest}
        disabled={testing}
        className="text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-50"
        title="Тест скорости"
      >
        {testing ? (
          <Loader2 className="w-3 h-3 animate-spin" />
        ) : (
          <RefreshCw className="w-3 h-3" />
        )}
      </button>
    </div>
  );
}

function StatusPanel({
  status,
  error,
  connectedSince,
  onConnect,
  onDisconnect,
  configPath,
}: StatusPanelProps) {
  const cfg = STATUS_CONFIG[status];

  return (
    <div className="glass-card p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div
            className={`p-3 rounded-xl ${cfg.color}`}
            style={{ backgroundColor: "var(--color-bg-elevated)", border: "1px solid var(--color-border)" }}
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
            <PingDisplay configPath={configPath} status={status} />
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
              {status === "connecting" ? "Подключение..." : "Переподключение..."}
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
