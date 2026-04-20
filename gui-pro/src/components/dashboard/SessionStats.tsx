import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Clock, RefreshCw, AlertTriangle, BarChart3 } from "lucide-react";
import { Card, CardHeader } from "../../shared/ui/Card";
import { formatUptime } from "../../shared/utils/uptime";

interface SessionStatsProps {
  connectedSince: Date | null;
  recoveryCount: number;
  errorCount: number;
  isConnected: boolean;
}

export function SessionStats({ connectedSince, recoveryCount, errorCount, isConnected }: SessionStatsProps) {
  const { t } = useTranslation();
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!isConnected || !connectedSince) return;
    const iv = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(iv);
  }, [isConnected, connectedSince]);

  const items = [
    {
      icon: <Clock className="w-3.5 h-3.5" />,
      label: t("dashboard.uptime", "Uptime"),
      value: connectedSince && isConnected ? formatUptime(connectedSince) : "—",
    },
    {
      icon: <RefreshCw className="w-3.5 h-3.5" />,
      label: "Recovery",
      value: isConnected ? String(recoveryCount) : "—",
      color: recoveryCount > 0 ? "var(--color-warning-400)" : undefined,
    },
    {
      icon: <AlertTriangle className="w-3.5 h-3.5" />,
      label: t("dashboard.errors", "Errors"),
      value: isConnected ? String(errorCount) : "—",
      color: errorCount > 0 ? "var(--color-danger-400)" : undefined,
    },
  ];

  return (
    <Card padding="md" className="flex-1">
      <CardHeader
        title={t("dashboard.session", "Session")}
        icon={<BarChart3 className="w-4 h-4" />}
      />
      <div className="space-y-2">
        {items.map((item) => (
          <div key={item.label} className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs" style={{ color: "var(--color-text-muted)" }}>
              {item.icon}
              <span>{item.label}</span>
            </div>
            <span
              className="text-sm font-semibold font-mono tabular-nums"
              style={{ color: item.color || "var(--color-text-primary)" }}
            >
              {item.value}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}
