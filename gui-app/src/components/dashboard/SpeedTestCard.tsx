import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, RefreshCw, Loader2, Gauge, AlertTriangle } from "lucide-react";
import { Card, CardHeader } from "../../shared/ui/Card";
import { Button } from "../../shared/ui/Button";
import type { SpeedResult } from "./useDashboardState";

interface SpeedTestCardProps {
  speed: SpeedResult | null;
  testing: boolean;
  error: string | null;
  onRunTest: () => void;
  isConnected: boolean;
}

export function SpeedTestCard({ speed, testing, error, onRunTest, isConnected }: SpeedTestCardProps) {
  const { t } = useTranslation();
  const unit = t("units.mbps", "Mbps");

  return (
    <Card padding="md" className="flex-1">
      <CardHeader
        title={t("dashboard.speed_test", "Speed Test")}
        icon={<Gauge className="w-4 h-4" />}
        action={
          <Button
            variant="ghost"
            size="sm"
            icon={testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            onClick={onRunTest}
            disabled={!isConnected || testing}
          >
            {t("dashboard.run_test", "Test")}
          </Button>
        }
      />
      {error && !testing ? (
        <div className="flex items-center gap-2 text-xs py-4 px-1" style={{ color: "var(--color-danger-500)" }}>
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">{t("dashboard.speed_test_failed", "Speed test failed. Try again later.")}</span>
        </div>
      ) : !speed ? (
        <div
          className="flex items-center justify-center text-xs py-4"
          style={{ color: "var(--color-text-muted)" }}
        >
          {isConnected
            ? t("dashboard.run_speed_test", "Run speed test")
            : t("dashboard.no_data", "No data — connect to VPN")}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs" style={{ color: "var(--color-text-muted)" }}>
              <ArrowDown className="w-3.5 h-3.5" style={{ color: "var(--color-success-500)" }} />
              <span>Download</span>
            </div>
            <span className="text-sm font-semibold" style={{ color: "var(--color-success-500)" }}>
              {speed.download_mbps.toFixed(1)} {unit}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs" style={{ color: "var(--color-text-muted)" }}>
              <ArrowUp className="w-3.5 h-3.5" style={{ color: "var(--color-accent-400)" }} />
              <span>Upload</span>
            </div>
            <span className="text-sm font-semibold" style={{ color: "var(--color-accent-400)" }}>
              {speed.upload_mbps.toFixed(1)} {unit}
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}
