import { useState, useEffect } from "react";
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

  const isLoading = status === "connecting" || status === "disconnecting" || status === "recovering";
  const isConnected = status === "connected";

  const statusVariant: "success" | "warning" | "danger" | "default" =
    isConnected ? "success" : isLoading ? "warning" : status === "error" ? "danger" : "default";

  const statusLabel = isConnected
    ? t("status.connected")
    : status === "connecting"
      ? t("status.connecting_short")
      : status === "disconnecting"
        ? t("status.disconnecting_short")
        : status === "recovering"
          ? t("status.recovering_short")
          : status === "error"
            ? t("status.error")
            : t("status.disconnected");

  const statusIcon = isLoading
    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
    : status === "error"
      ? <AlertTriangle className="w-3.5 h-3.5" />
      : isConnected
        ? <Wifi className="w-3.5 h-3.5" />
        : <WifiOff className="w-3.5 h-3.5" />;

  return (
    <div className="pt-3 pb-0">
      <div className="flex items-center justify-between px-4">
        <div className="flex items-center gap-3">
          <Badge variant={statusVariant} size="md" icon={statusIcon}>
            {statusLabel}
          </Badge>

          {isConnected && connectedSince && (
            <div className="flex items-center gap-1 text-xs tabular-nums" style={{ color: "var(--color-text-muted)", minWidth: "5.5em" }}>
              <Clock className="w-3.5 h-3.5" />
              <UptimeCounter since={connectedSince} />
            </div>
          )}
        </div>

        <div>
          {isLoading ? (
            <Button variant="warning" size="sm" disabled loading>
              {statusLabel}
            </Button>
          ) : isConnected ? (
            <Button
              variant="danger"
              size="sm"
              icon={<Power className="w-3.5 h-3.5" />}
              onClick={onDisconnect}
            >
              {t("buttons.disconnect")}
            </Button>
          ) : (
            <Button
              variant="success"
              size="sm"
              icon={<Power className="w-3.5 h-3.5" />}
              onClick={onConnect}
            >
              {t("buttons.connect")}
            </Button>
          )}
        </div>
      </div>

      {error && (
        <p
          className="text-[11px] mt-1.5 px-4 max-w-sm break-words line-clamp-3"
          style={{ color: "var(--color-danger-400)" }}
          title={error}
        >
          {error}
        </p>
      )}

      <div className="mt-2 border-b" style={{ borderColor: "var(--color-border)" }} />
    </div>
  );
}

export default StatusPanel;
