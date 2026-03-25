import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
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
  Power,
} from "lucide-react";
import type { VpnStatus } from "../App";
import { Card } from "../shared/ui/Card";
import { Button } from "../shared/ui/Button";
import { Badge } from "../shared/ui/Badge";

interface StatusPanelProps {
  status: VpnStatus;
  error: string | null;
  connectedSince: Date | null;
  onConnect: () => void;
  onDisconnect: () => void;
  configPath?: string;
}

function getStatusConfig(status: VpnStatus, t: (key: string) => string) {
  const configs: Record<VpnStatus, { label: string; icon: ReactNode; badgeVariant: "success" | "warning" | "danger" | "default" }> = {
    disconnected: {
      label: t("status.disconnected"),
      icon: <WifiOff className="w-8 h-8" />,
      badgeVariant: "default",
    },
    connecting: {
      label: t("status.connecting_short", "Подключение"),
      icon: <Loader2 className="w-8 h-8 animate-spin" />,
      badgeVariant: "warning",
    },
    connected: {
      label: t("status.connected"),
      icon: <Wifi className="w-8 h-8" />,
      badgeVariant: "success",
    },
    disconnecting: {
      label: t("status.disconnecting_short", "Отключение"),
      icon: <Loader2 className="w-8 h-8 animate-spin" />,
      badgeVariant: "warning",
    },
    recovering: {
      label: t("status.recovering_short", "Восстановление"),
      icon: <Loader2 className="w-8 h-8 animate-spin" />,
      badgeVariant: "warning",
    },
    error: {
      label: t("status.error"),
      icon: <AlertTriangle className="w-8 h-8" />,
      badgeVariant: "danger",
    },
  };
  return configs[status];
}

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
  const { t } = useTranslation();
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
    try {
      const ms = await invoke<number>("ping_endpoint", { host, port });
      setPing(ms);
    } catch {
      setPing(-1);
    }
  }, []);

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

  const pingColor = ping < 0
    ? "var(--color-text-muted)"
    : ping < 90
      ? "var(--color-success-500)"
      : ping <= 200
        ? "var(--color-warning-500)"
        : "var(--color-danger-500)";
  const label = ping < 0 ? "—" : `${ping} ms`;
  const dl = speed?.download_mbps ?? 0;
  const ul = speed?.upload_mbps ?? 0;

  return (
    <div className="flex items-center gap-2 text-xs mt-1">
      <div className="flex items-center gap-1" style={{ color: pingColor }}>
        <Activity className="w-3 h-3" />
        <span>{label}</span>
      </div>
      <span style={{ color: "var(--color-text-muted)" }}>|</span>
      <span className="flex items-center gap-0.5" style={{ color: "var(--color-success-500)" }}>
        <ArrowDown className="w-3 h-3" />{dl} {t("buttons.speed_test", "Мбит/с").includes("Мбит") ? "Мбит/с" : "Mbps"}
      </span>
      <span className="flex items-center gap-0.5" style={{ color: "var(--color-accent-400)" }}>
        <ArrowUp className="w-3 h-3" />{ul} {t("buttons.speed_test", "Мбит/с").includes("Мбит") ? "Мбит/с" : "Mbps"}
      </span>
      <button
        onClick={runSpeedTest}
        disabled={testing}
        className="transition-colors disabled:opacity-50"
        style={{ color: "var(--color-text-muted)" }}
        title={t("buttons.speed_test")}
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
  const { t } = useTranslation();
  const cfg = getStatusConfig(status, t);

  const isLoading = status === "connecting" || status === "disconnecting" || status === "recovering";

  return (
    <Card padding="lg">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {/* Icon container */}
          <div
            className="p-3 rounded-[var(--radius-lg)]"
            style={{
              backgroundColor: "var(--color-bg-elevated)",
              border: "1px solid var(--color-border)",
              color: status === "connected"
                ? "var(--color-success-500)"
                : status === "error"
                  ? "var(--color-danger-500)"
                  : isLoading
                    ? "var(--color-warning-500)"
                    : "var(--color-text-muted)",
            }}
          >
            {cfg.icon}
          </div>

          {/* Status info */}
          <div>
            <div className="flex items-center gap-2">
              <Badge variant={cfg.badgeVariant} size="sm" pulse={status === "connected"}>
                {cfg.label}
              </Badge>
            </div>
            {connectedSince && status === "connected" && (
              <div className="flex items-center gap-1 text-xs mt-1" style={{ color: "var(--color-text-muted)" }}>
                <Clock className="w-3 h-3" />
                <UptimeCounter since={connectedSince} />
              </div>
            )}
            <PingDisplay configPath={configPath} status={status} />
            {error && (
              <p
                className="text-[11px] mt-1 max-w-sm break-words line-clamp-3"
                style={{ color: "var(--color-danger-400)" }}
                title={error}
              >
                {error}
              </p>
            )}
          </div>
        </div>

        {/* Action button */}
        <div>
          {isLoading ? (
            <Button variant="warning" size="lg" disabled loading>
              {status === "connecting"
                ? t("status.connecting")
                : status === "disconnecting"
                  ? t("status.disconnecting")
                  : t("status.recovering")}
            </Button>
          ) : status === "connected" ? (
            <Button
              variant="danger"
              size="lg"
              icon={<Power className="w-4 h-4" />}
              onClick={onDisconnect}
            >
              {t("buttons.disconnect")}
            </Button>
          ) : (
            <Button
              variant="success"
              size="lg"
              icon={<Power className="w-4 h-4" />}
              onClick={onConnect}
            >
              {t("buttons.connect")}
            </Button>
          )}
        </div>
      </div>

    </Card>
  );
}

export default StatusPanel;
