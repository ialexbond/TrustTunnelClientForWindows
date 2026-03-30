import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  Power,
  Wifi,
  Loader2,
  AlertTriangle,
  Clock,
  Activity,
  FolderOpen,
  FileDown,
} from "lucide-react";
import type { VpnStatus } from "../shared/types";

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

/* ── Ping ── */

function usePing(configPath?: string, status?: VpnStatus) {
  const [ping, setPing] = useState<number | null>(null);
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
    try {
      setPing(await invoke<number>("ping_endpoint", { host, port }));
    } catch {
      setPing(-1);
    }
  }, []);

  useEffect(() => {
    if (!isConnected) {
      setPing(null);
      return;
    }
    doPing();
    const iv = setInterval(doPing, 10000);
    return () => clearInterval(iv);
  }, [isConnected, doPing]);

  return ping;
}

/* ── Props ── */

interface VpnScreenProps {
  status: VpnStatus;
  error: string | null;
  connectedSince: Date | null;
  configPath: string;
  vpnMode: string;
  onConnect: () => void;
  onDisconnect: () => void;
  onImportConfig: () => void;
}

/* ── Component ── */

function VpnScreen({
  status,
  error,
  connectedSince,
  configPath,
  vpnMode,
  onConnect,
  onDisconnect,
  onImportConfig,
}: VpnScreenProps) {
  const { t } = useTranslation();
  const ping = usePing(configPath, status);
  const isConnected = status === "connected";
  const isBusy = status === "connecting" || status === "disconnecting" || status === "recovering";

  const handleCircleClick = () => {
    if (isBusy) return;
    if (isConnected) onDisconnect();
    else onConnect();
  };

  // Status-dependent styles
  const getCircleStyles = (): {
    borderColor: string;
    background: string;
    boxShadow: string;
  } => {
    switch (status) {
      case "connected":
        return {
          borderColor: "var(--color-accent-500)",
          background: "linear-gradient(135deg, rgba(99, 102, 241, 0.2), rgba(99, 102, 241, 0.05))",
          boxShadow: "0 0 40px rgba(99, 102, 241, 0.15), 0 0 80px rgba(99, 102, 241, 0.05)",
        };
      case "connecting":
      case "disconnecting":
      case "recovering":
        return {
          borderColor: "var(--color-warning-400)",
          background: "rgba(251, 191, 36, 0.05)",
          boxShadow: "0 0 30px rgba(251, 191, 36, 0.1)",
        };
      case "error":
        return {
          borderColor: "var(--color-danger-400)",
          background: "rgba(248, 113, 113, 0.05)",
          boxShadow: "0 0 30px rgba(248, 113, 113, 0.1)",
        };
      default:
        return {
          borderColor: "var(--color-border-hover)",
          background: "var(--color-bg-elevated)",
          boxShadow: "none",
        };
    }
  };

  const circleStyles = getCircleStyles();

  const statusLabel: Record<VpnStatus, string> = {
    disconnected: t("status.disconnected"),
    connecting: t("status.connecting"),
    connected: t("status.connected"),
    disconnecting: t("status.disconnecting"),
    recovering: t("status.recovering"),
    error: t("status.error"),
  };

  const getStatusColor = (): string => {
    switch (status) {
      case "connected": return "var(--color-accent-500)";
      case "connecting":
      case "disconnecting":
      case "recovering": return "var(--color-warning-400)";
      case "error": return "var(--color-danger-400)";
      default: return "var(--color-text-muted)";
    }
  };

  const pingColor =
    ping == null ? "" : ping < 0 ? "var(--color-text-muted)" : ping < 90 ? "var(--color-success-400)" : ping <= 200 ? "var(--color-warning-400)" : "var(--color-danger-400)";
  const pingLabel = ping == null ? null : ping < 0 ? "\u2014" : `${ping} ms`;

  // ─── No config: show import prompt ───
  if (!configPath) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6">
        <div
          className="p-4 rounded-2xl"
          style={{ backgroundColor: "rgba(99, 102, 241, 0.1)" }}
        >
          <FileDown className="w-10 h-10" style={{ color: "var(--color-accent-500)" }} />
        </div>
        <div className="text-center space-y-1">
          <h2 className="text-sm font-semibold" style={{ color: "var(--color-text-primary)" }}>
            {t("wizard.import.title")}
          </h2>
          <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
            {t("vpn.no_config_hint")}
          </p>
        </div>
        <button
          onClick={onImportConfig}
          className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium transition-all active:scale-95"
          style={{
            backgroundColor: "var(--color-accent-500)",
            color: "white",
            boxShadow: "0 4px 12px rgba(99, 102, 241, 0.3)",
          }}
        >
          <FolderOpen className="w-4 h-4" />
          {t("wizard.import.title")}
        </button>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col items-center justify-between py-6 px-4">
      {/* ── Big circle button ── */}
      <div className="flex flex-col items-center gap-4 flex-1 justify-center">
        <button
          onClick={handleCircleClick}
          disabled={isBusy}
          className={`relative w-[120px] h-[120px] rounded-full border-[3px] flex flex-col items-center justify-center gap-1
                     transition-all duration-300
                     ${isBusy ? "cursor-not-allowed opacity-80" : "hover:scale-105 active:scale-95 cursor-pointer"}`}
          style={{
            borderColor: circleStyles.borderColor,
            background: circleStyles.background,
            boxShadow: circleStyles.boxShadow,
          }}
        >
          {/* Pulse glow for connected */}
          {isConnected && (
            <div
              className="absolute inset-[-6px] rounded-full animate-pulse"
              style={{
                border: "2px solid var(--color-accent-500)",
                opacity: 0.4,
                animationDuration: "2s",
              }}
            />
          )}

          {/* Spinning animation for busy states */}
          {isBusy && (
            <div
              className="absolute inset-[-4px] rounded-full border-2 border-transparent animate-spin"
              style={{
                borderTopColor: "var(--color-warning-400)",
                animationDuration: "1.2s",
              }}
            />
          )}

          {/* Status icon */}
          {isBusy ? (
            <Loader2 className="w-9 h-9 animate-spin" style={{ color: "var(--color-warning-400)" }} />
          ) : isConnected ? (
            <Wifi className="w-9 h-9" style={{ color: "var(--color-accent-500)" }} />
          ) : status === "error" ? (
            <AlertTriangle className="w-9 h-9" style={{ color: "var(--color-danger-400)" }} />
          ) : (
            <Power className="w-9 h-9" style={{ color: "var(--color-text-muted)" }} />
          )}

          {/* Ping inside circle when connected */}
          {isConnected && pingLabel && (
            <div
              className="flex items-center gap-0.5 text-[10px] font-medium"
              style={{ color: pingColor }}
            >
              <Activity className="w-3 h-3" />
              {pingLabel}
            </div>
          )}
        </button>

        {/* Status label */}
        <span className="text-sm font-semibold" style={{ color: getStatusColor() }}>
          {statusLabel[status]}
        </span>

        {/* Uptime */}
        {connectedSince && isConnected && (
          <div
            className="flex items-center gap-1.5 text-xs -mt-2"
            style={{ color: "var(--color-text-muted)" }}
          >
            <Clock className="w-3 h-3" />
            <UptimeCounter since={connectedSince} />
          </div>
        )}

        {/* VPN Mode indicator */}
        {isConnected && (
          <div
            className="text-[10px] px-2.5 py-0.5 rounded-full"
            style={{
              backgroundColor: "var(--color-bg-hover)",
              color: "var(--color-text-muted)",
            }}
          >
            {vpnMode === "selective" ? t("vpn_modes.selective") : t("vpn_modes.general")}
          </div>
        )}

        {/* Error */}
        {error && (
          <p
            className="text-[10px] text-center max-w-[280px] break-words line-clamp-2 -mt-1"
            style={{ color: "var(--color-danger-400)" }}
            title={error}
          >
            {error}
          </p>
        )}
      </div>

      {/* ── Config file indicator (bottom) ── */}
      <div className="w-full pt-4">
        <div
          className="flex items-center gap-2 px-3 py-2 rounded-lg"
          style={{
            backgroundColor: "var(--color-bg-surface)",
            border: "1px solid var(--color-border)",
          }}
        >
          <FolderOpen className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--color-text-muted)" }} />
          <span
            className="flex-1 text-[10px] truncate font-mono"
            style={{ color: "var(--color-text-secondary)" }}
          >
            {configPath.split(/[/\\]/).pop()}
          </span>
          <button
            onClick={onImportConfig}
            className="text-[10px] font-medium px-2 py-0.5 rounded transition-colors"
            style={{
              color: "var(--color-accent-500)",
              backgroundColor: "rgba(99, 102, 241, 0.1)",
            }}
          >
            {t("buttons.change")}
          </button>
        </div>
      </div>
    </div>
  );
}

export default VpnScreen;
