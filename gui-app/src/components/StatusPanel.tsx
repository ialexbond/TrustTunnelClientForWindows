import { useState, useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Wifi,
  WifiOff,
  Loader2,
  AlertTriangle,
  Clock,
  Power,
} from "lucide-react";
import type { VpnStatus } from "../App";
import { Card } from "../shared/ui/Card";
import { Button } from "../shared/ui/Button";
import { Badge } from "../shared/ui/Badge";
import { formatUptime } from "../shared/utils/uptime";

interface StatusPanelProps {
  status: VpnStatus;
  error: string | null;
  connectedSince: Date | null;
  onConnect: () => void;
  onDisconnect: () => void;
}

function getStatusConfig(status: VpnStatus, t: (key: string) => string) {
  const configs: Record<VpnStatus, { label: string; icon: ReactNode; badgeVariant: "success" | "warning" | "danger" | "default" }> = {
    disconnected: {
      label: t("status.disconnected"),
      icon: <WifiOff className="w-8 h-8" />,
      badgeVariant: "default",
    },
    connecting: {
      label: t("status.connecting_short"),
      icon: <Loader2 className="w-8 h-8 animate-spin" />,
      badgeVariant: "warning",
    },
    connected: {
      label: t("status.connected"),
      icon: <Wifi className="w-8 h-8" />,
      badgeVariant: "success",
    },
    disconnecting: {
      label: t("status.disconnecting_short"),
      icon: <Loader2 className="w-8 h-8 animate-spin" />,
      badgeVariant: "warning",
    },
    recovering: {
      label: t("status.recovering_short"),
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
              <Badge variant={cfg.badgeVariant} size="sm">
                {cfg.label}
              </Badge>
            </div>
            {connectedSince && status === "connected" && (
              <div className="flex items-center gap-1 text-xs mt-1" style={{ color: "var(--color-text-muted)" }}>
                <Clock className="w-3 h-3" />
                <UptimeCounter since={connectedSince} />
              </div>
            )}
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
