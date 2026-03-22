import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Wifi,
  Loader2,
  AlertTriangle,
  Clock,
  Activity,
  RefreshCw,
  ArrowDown,
  ArrowUp,
  FolderOpen,
  Power,
} from "lucide-react";
import type { VpnStatus } from "../App";

interface StatusPanelProps {
  status: VpnStatus;
  error: string | null;
  connectedSince: Date | null;
  onConnect: () => void;
  onDisconnect: () => void;
  configPath?: string;
  onBrowseConfig?: () => void;
  onConfigPathChange?: (path: string) => void;
}

/* ── Helpers ── */

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
    const iv = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(iv);
  }, []);
  return <span>{formatUptime(since)}</span>;
}

/* ── Ring colours per status ── */

const RING: Record<VpnStatus, { ring: string; glow: string; bg: string; icon: string }> = {
  disconnected: { ring: "border-gray-700", glow: "", bg: "bg-gray-800/50", icon: "text-gray-500" },
  connecting:   { ring: "border-amber-500/70 animate-pulse", glow: "shadow-amber-500/20", bg: "bg-amber-500/10", icon: "text-amber-400" },
  connected:    { ring: "border-emerald-500/70", glow: "shadow-emerald-500/30", bg: "bg-emerald-500/10", icon: "text-emerald-400" },
  disconnecting:{ ring: "border-amber-500/70 animate-pulse", glow: "shadow-amber-500/20", bg: "bg-amber-500/10", icon: "text-amber-400" },
  recovering:   { ring: "border-amber-500/70 animate-pulse", glow: "shadow-amber-500/20", bg: "bg-amber-500/10", icon: "text-amber-400" },
  error:        { ring: "border-red-500/70", glow: "shadow-red-500/30", bg: "bg-red-500/10", icon: "text-red-400" },
};

const LABEL: Record<VpnStatus, string> = {
  disconnected: "Отключен",
  connecting: "Подключение...",
  connected: "Подключен",
  disconnecting: "Отключение...",
  recovering: "Ожидание сети...",
  error: "Ошибка",
};

/* ── Ping + Speed ── */

interface SpeedResult { download_mbps: number; upload_mbps: number; }

function usePingSpeed(configPath?: string, status?: VpnStatus) {
  const [ping, setPing] = useState<number | null>(null);
  const [speed, setSpeed] = useState<SpeedResult | null>(null);
  const [testing, setTesting] = useState(false);
  const endpointRef = useRef<{ host: string; port: number } | null>(null);
  const isConnected = status === "connected";

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
    try { setPing(await invoke<number>("ping_endpoint", { host, port })); }
    catch { setPing(-1); }
  }, []);

  useEffect(() => {
    if (!isConnected) { setPing(null); setSpeed(null); setTesting(false); return; }
    doPing();
    const iv = setInterval(doPing, 10000);
    return () => clearInterval(iv);
  }, [isConnected, doPing]);

  const runSpeedTest = useCallback(async () => {
    if (testing) return;
    setTesting(true);
    try { setSpeed(await invoke<SpeedResult>("speedtest_run")); }
    catch { /* keep prev */ }
    finally { setTesting(false); }
  }, [testing]);

  return { ping, speed, testing, runSpeedTest };
}

/* ── Main component ── */

function StatusPanel({
  status, error, connectedSince, onConnect, onDisconnect,
  configPath, onBrowseConfig, onConfigPathChange,
}: StatusPanelProps) {
  const r = RING[status];
  const { ping, speed, testing, runSpeedTest } = usePingSpeed(configPath, status);
  const isConnected = status === "connected";
  const isBusy = status === "connecting" || status === "disconnecting" || status === "recovering";

  const handleCircleClick = () => {
    if (isBusy) return;
    if (isConnected) onDisconnect();
    else onConnect();
  };

  const pingColor = ping == null ? "" : ping < 0 ? "text-gray-600" : ping < 90 ? "text-emerald-400" : ping <= 200 ? "text-amber-400" : "text-red-400";
  const pingLabel = ping == null ? null : ping < 0 ? "—" : `${ping} ms`;

  return (
    <div className="flex-1 flex flex-col items-center justify-between py-6 px-4">
      {/* ── Big circle button ── */}
      <div className="flex flex-col items-center gap-4">
        <button
          onClick={handleCircleClick}
          disabled={isBusy}
          className={`relative w-36 h-36 rounded-full border-[3px] ${r.ring} ${r.bg}
                     flex flex-col items-center justify-center gap-1
                     transition-all duration-300 shadow-xl ${r.glow}
                     ${isBusy ? "cursor-not-allowed opacity-80" : "hover:scale-105 active:scale-95 cursor-pointer"}`}
        >
          {/* Status icon */}
          {isBusy ? (
            <Loader2 className={`w-10 h-10 animate-spin ${r.icon}`} />
          ) : isConnected ? (
            <Wifi className="w-10 h-10 text-emerald-400" />
          ) : status === "error" ? (
            <AlertTriangle className="w-10 h-10 text-red-400" />
          ) : (
            <Power className="w-10 h-10 text-gray-500" />
          )}

          {/* Ping inside circle when connected */}
          {isConnected && pingLabel && (
            <div className={`flex items-center gap-0.5 text-[11px] font-medium ${pingColor}`}>
              <Activity className="w-3 h-3" />
              {pingLabel}
            </div>
          )}
        </button>

        {/* Status label */}
        <span className={`text-sm font-semibold ${r.icon}`}>{LABEL[status]}</span>

        {/* Uptime */}
        {connectedSince && isConnected && (
          <div className="flex items-center gap-1.5 text-xs text-gray-500 -mt-2">
            <Clock className="w-3 h-3" />
            <UptimeCounter since={connectedSince} />
          </div>
        )}

        {/* Speed row */}
        {isConnected && (
          <div className="flex items-center gap-3 text-[11px] -mt-1">
            <span className="flex items-center gap-0.5 text-emerald-400">
              <ArrowDown className="w-3 h-3" />{speed?.download_mbps ?? 0} Мбит/с
            </span>
            <span className="flex items-center gap-0.5 text-indigo-400">
              <ArrowUp className="w-3 h-3" />{speed?.upload_mbps ?? 0} Мбит/с
            </span>
            <button
              onClick={runSpeedTest}
              disabled={testing}
              className="text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-50"
              title="Тест скорости"
            >
              {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            </button>
          </div>
        )}

        {/* Error */}
        {error && (
          <p className="text-[10px] text-red-400 text-center max-w-[280px] break-words line-clamp-2 -mt-1" title={error}>
            {error}
          </p>
        )}
      </div>

      {/* ── Config file selector (bottom) ── */}
      <div className="w-full mt-auto pt-4">
        <label className="block text-[10px] text-gray-600 mb-1 text-center">Файл конфигурации</label>
        <div className="flex gap-1.5">
          <input
            type="text"
            value={configPath || ""}
            onChange={(e) => onConfigPathChange?.(e.target.value)}
            placeholder="trusttunnel_client.toml"
            className="flex-1 bg-white/5 border border-white/10 rounded-lg px-2.5 py-1.5 text-[10px]
                       text-gray-300 placeholder-gray-700 focus:outline-none focus:border-indigo-500/50
                       focus:ring-1 focus:ring-indigo-500/25 transition-colors truncate"
          />
          <button
            onClick={onBrowseConfig}
            className="p-1.5 bg-white/5 border border-white/10 rounded-lg
                       hover:bg-white/10 transition-colors text-gray-500 hover:text-gray-300"
            title="Выбрать файл"
          >
            <FolderOpen className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

export default StatusPanel;
