import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Wifi, Loader2, Clock, Activity, Shield, Globe, Power } from "lucide-react";
import type { VpnStatus } from "../../App";
import type { ClientConfig } from "../settings/useSettingsState";
import { Card } from "../../shared/ui/Card";
import { Badge } from "../../shared/ui/Badge";
import { Button } from "../../shared/ui/Button";
import { formatUptime } from "../../shared/utils/uptime";

interface ConnectionOverviewProps {
  status: VpnStatus;
  connectedSince: Date | null;
  currentPing: number | null;
  clientConfig: ClientConfig | null;
  vpnMode: string;
  isLoading: boolean;
  onDisconnect: () => void;
}

export function ConnectionOverview({
  status,
  connectedSince,
  currentPing,
  clientConfig,
  vpnMode,
  isLoading,
  onDisconnect,
}: ConnectionOverviewProps) {
  const { t } = useTranslation();
  const [, setTick] = useState(0);
  const isConnected = status === "connected";

  useEffect(() => {
    if (!isConnected || !connectedSince) return;
    const iv = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(iv);
  }, [isConnected, connectedSince]);

  const statusVariant = isConnected ? "success" : isLoading ? "warning" : "default";
  const statusLabel = isConnected
    ? t("status.connected")
    : t(`status.${status === "connecting" ? "connecting_short" : status === "disconnecting" ? "disconnecting_short" : status === "recovering" ? "recovering_short" : status}`);

  const statusIcon = isLoading
    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
    : <Wifi className="w-3.5 h-3.5" />;

  const protocol = clientConfig?.endpoint?.upstream_protocol?.toUpperCase() || "—";
  const modeLabel = vpnMode === "selective" ? t("vpn_modes.selective") : t("vpn_modes.general");

  const pingColor = currentPing === null
    ? "var(--color-text-muted)"
    : currentPing < 0
      ? "var(--color-text-muted)"
      : currentPing < 90
        ? "var(--color-success-500)"
        : currentPing <= 200
          ? "var(--color-warning-500)"
          : "var(--color-danger-500)";

  return (
    <Card padding="md">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Badge variant={statusVariant} size="md" icon={statusIcon}>
            {statusLabel}
          </Badge>

          {isConnected && connectedSince && (
            <div className="flex items-center gap-1 text-xs tabular-nums" style={{ color: "var(--color-text-muted)", minWidth: "5.5em" }}>
              <Clock className="w-3.5 h-3.5" />
              <span>{formatUptime(connectedSince)}</span>
            </div>
          )}

          {isConnected && currentPing !== null && (
            <div className="flex items-center gap-1 text-xs" style={{ color: pingColor }}>
              <Activity className="w-3.5 h-3.5" />
              <span>{currentPing < 0 ? "—" : `${currentPing} ms`}</span>
            </div>
          )}

          <div className="flex items-center gap-3 text-xs" style={{ color: "var(--color-text-muted)" }}>
            <div className="flex items-center gap-1">
              <Shield className="w-3.5 h-3.5" />
              <span>{protocol}</span>
            </div>
            <div className="flex items-center gap-1">
              <Globe className="w-3.5 h-3.5" />
              <span>{modeLabel}</span>
            </div>
          </div>
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
          ) : null}
        </div>
      </div>
    </Card>
  );
}
