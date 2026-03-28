import { useTranslation } from "react-i18next";
import { BarChart3, Power, Loader2, Server, LogIn } from "lucide-react";
import type { VpnStatus } from "../shared/types";
import StatusPanel from "./StatusPanel";
import { PingChart } from "./dashboard/PingChart";
import { SpeedTestCard } from "./dashboard/SpeedTestCard";
import { SessionStats } from "./dashboard/SessionStats";
import { NetworkInfo } from "./dashboard/NetworkInfo";
import { ServerStatsCard } from "./dashboard/ServerStatsCard";
import { useDashboardState } from "./dashboard/useDashboardState";
import { Button } from "../shared/ui/Button";
import { Card } from "../shared/ui/Card";

interface DashboardPanelProps {
  status: VpnStatus;
  connectedSince: Date | null;
  configPath: string;
  vpnMode: string;
  onConnect: () => void;
  onDisconnect: () => void;
  onNavigateToControl: () => void;
}

function hasSshCreds(): boolean {
  try {
    const raw = localStorage.getItem("trusttunnel_control_ssh");
    if (!raw) return false;
    const obj = JSON.parse(raw);
    return !!(obj.host && (obj.password || obj.keyPath));
  } catch {
    return false;
  }
}

export default function DashboardPanel({
  status,
  connectedSince,
  configPath,
  vpnMode,
  onConnect,
  onDisconnect,
  onNavigateToControl,
}: DashboardPanelProps) {
  const { t } = useTranslation();
  const dashboard = useDashboardState(status, configPath, connectedSince);
  const isConnected = status === "connected";
  const isLoading = status === "connecting" || status === "disconnecting" || status === "recovering";
  const sshConnected = hasSshCreds();

  // ── Connected: full dashboard with StatusPanel ──
  if (isConnected) {
    return (
      <div className="h-full flex flex-col overflow-hidden">
        <StatusPanel
          status={status}
          error={null}
          connectedSince={connectedSince}
          onConnect={onConnect}
          onDisconnect={onDisconnect}
        />

        <div className="flex flex-col gap-3 flex-1 overflow-y-auto px-0 py-3">
          <PingChart
            pingHistory={dashboard.pingHistory}
            avgPing={dashboard.avgPing}
            isConnected={isConnected}
          />

          <div className="flex gap-3">
            <SpeedTestCard
              speed={dashboard.speed}
              testing={dashboard.speedTesting}
              error={dashboard.speedError}
              onRunTest={dashboard.runSpeedTest}
              isConnected={isConnected}
            />
            <SessionStats
              connectedSince={connectedSince}
              recoveryCount={dashboard.recoveryCount}
              errorCount={dashboard.errorCount}
              isConnected={isConnected}
            />
          </div>

          <NetworkInfo clientConfig={dashboard.clientConfig} />

          <ServerStatsCard onNavigateToControl={onNavigateToControl} />
        </div>
      </div>
    );
  }

  // ── Not connected: placeholders + server stats if SSH ──
  const connectingLabel = status === "connecting"
    ? t("status.connecting")
    : status === "disconnecting"
      ? t("status.disconnecting")
      : status === "recovering"
        ? t("status.recovering")
        : null;

  return (
    <div className={sshConnected
      ? "flex flex-col flex-1 overflow-y-auto px-4 py-4 gap-4"
      : "flex flex-col items-center justify-center flex-1 gap-4 px-4"
    }>
      {/* VPN placeholder card */}
      <Card padding="md" className={sshConnected ? "" : "w-full max-w-sm"}>
        <div className="flex flex-col items-center gap-3 py-3">
          <div
            className="p-3 rounded-full"
            style={{ backgroundColor: "var(--color-bg-elevated)", border: "1px solid var(--color-border)" }}
          >
            <BarChart3 className="w-5 h-5" style={{ color: "var(--color-text-muted)" }} />
          </div>
          <div className="text-center">
            <p className="text-sm font-semibold mb-1" style={{ color: "var(--color-text-primary)" }}>
              {t("dashboard.disconnected_title", "Дашборд")}
            </p>
            <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
              {configPath
                ? t("dashboard.connect_to_see")
                : t("messages.config_required")}
            </p>
          </div>
          {configPath && (
            <Button
              variant="success"
              size="sm"
              icon={isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Power className="w-3.5 h-3.5" />}
              onClick={isLoading ? onDisconnect : onConnect}
            >
              {connectingLabel || t("buttons.connect")}
            </Button>
          )}
        </div>
      </Card>

      {/* Server section — always same instance, never remounts */}
      {sshConnected ? (
        <ServerStatsCard onNavigateToControl={onNavigateToControl} />
      ) : (
        <Card padding="md" className="w-full max-w-sm">
          <div className="flex flex-col items-center gap-3 py-3">
            <div
              className="p-3 rounded-full"
              style={{ backgroundColor: "var(--color-bg-elevated)", border: "1px solid var(--color-border)" }}
            >
              <Server className="w-5 h-5" style={{ color: "var(--color-text-muted)" }} />
            </div>
            <div className="text-center">
              <p className="text-sm font-semibold mb-1" style={{ color: "var(--color-text-primary)" }}>
                {t("dashboard.server_title", "Сервер")}
              </p>
              <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                {t("dashboard.server_stats_hint")}
              </p>
            </div>
            <Button variant="ghost" size="sm" icon={<LogIn className="w-3.5 h-3.5" />} onClick={onNavigateToControl}>
              {t("dashboard.go_to_control")}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
