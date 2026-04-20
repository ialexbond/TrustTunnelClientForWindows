import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Clock, Power } from "lucide-react";
import type { VpnStatus } from "../shared/types";
import { Button } from "../shared/ui/Button";
import { StatusBadge } from "../shared/ui/StatusBadge";
import { ErrorBanner } from "../shared/ui/ErrorBanner";
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

const statusBadgeVariant = (s: VpnStatus): "connected" | "connecting" | "error" | "disconnected" => {
  if (s === "connected") return "connected";
  if (s === "connecting" || s === "disconnecting" || s === "recovering") return "connecting";
  if (s === "error") return "error";
  return "disconnected";
};

function StatusPanel({
  status,
  error,
  connectedSince,
  onConnect,
  onDisconnect,
}: StatusPanelProps) {
  const { t } = useTranslation();
  const [errorDismissed, setErrorDismissed] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- dismissal must reset synchronously when status changes so the new error banner renders on the same frame
    setErrorDismissed(false);
  }, [status]);

  const isConnected = status === "connected";

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

  return (
    <div
      className="border-b border-[var(--color-border)]"
      style={{ boxShadow: "var(--shadow-sm)" }}
    >
      <div className="px-[var(--space-4)] flex items-center justify-between h-[52px]">
        <div className="flex items-center gap-[var(--space-3)]">
          <StatusBadge variant={statusBadgeVariant(status)} label={statusLabel} />

          {isConnected && connectedSince && (
            <div className="flex items-center gap-[var(--space-1)] text-xs font-mono tabular-nums text-[var(--color-text-muted)]">
              <Clock className="w-3.5 h-3.5" aria-hidden="true" />
              <UptimeCounter since={connectedSince} />
            </div>
          )}
        </div>

        <div>
          {status === "connected" && (
            <Button variant="danger" size="sm" onClick={onDisconnect} aria-label={t("buttons.disconnect")}>
              <Power className="w-3.5 h-3.5" />
              {t("buttons.disconnect")}
            </Button>
          )}
          {status === "connecting" && (
            <Button variant="ghost" size="sm" onClick={onDisconnect}>
              <Power className="w-3.5 h-3.5" />
              {t("buttons.cancel")}
            </Button>
          )}
          {(status === "disconnecting" || status === "recovering") && (
            <Button variant="ghost" size="sm" disabled loading>
              {statusLabel}
            </Button>
          )}
          {(status === "error" || status === "disconnected") && (
            <Button variant="ghost" size="sm" onClick={onConnect}>
              {t("buttons.connect")}
            </Button>
          )}
        </div>
      </div>

      {error && !errorDismissed && (
        <ErrorBanner
          severity="error"
          message={error}
          onDismiss={() => setErrorDismissed(true)}
          className="mx-[var(--space-4)] mb-[var(--space-2)]"
        />
      )}
    </div>
  );
}

export default StatusPanel;
