import { useTranslation } from "react-i18next";
import { BarChart3, Power, Loader2, Server, LogIn } from "lucide-react";
import type { VpnStatus } from "../App";
import { ConnectionOverview } from "./dashboard/ConnectionOverview";
import { PingChart } from "./dashboard/PingChart";
import { SpeedTestCard } from "./dashboard/SpeedTestCard";
import { SessionStats } from "./dashboard/SessionStats";
import { NetworkInfo } from "./dashboard/NetworkInfo";
import { ServerStatsCard } from "./dashboard/ServerStatsCard";
import { useDashboardState } from "./dashboard/useDashboardState";
import { Button } from "../shared/ui/Button";
import { Card, CardHeader } from "../shared/ui/Card";

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

  // Both disconnected and no SSH — full centered placeholders
  if (!isConnected && !isLoading && !sshConnected) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 gap-6">
        {/* VPN placeholder */}
        <div className="flex flex-col items-center gap-3">
          <div
            className="p-4 rounded-full"
            style={{ backgroundColor: "var(--color-bg-elevated)", border: "1px solid var(--color-border)" }}
          >
            <BarChart3 className="w-8 h-8" style={{ color: "var(--color-text-muted)" }} />
          </div>
          <div className="text-center">
            <p className="text-sm font-semibold mb-1" style={{ color: "var(--color-text-primary)" }}>
              {t("dashboard.disconnected_title", "Dashboard")}
            </p>
            <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
              {configPath
                ? t("dashboard.connect_to_see")
                : t("messages.config_required")}
            </p>
          </div>
          {configPath && (
            <Button variant="success" size="lg" icon={<Power className="w-4 h-4" />} onClick={onConnect}>
              {t("buttons.connect")}
            </Button>
          )}
        </div>

        {/* Server placeholder */}
        <Card padding="md" className="w-full max-w-sm">
          <div className="flex flex-col items-center gap-3 py-3">
            <div
              className="p-3 rounded-full"
              style={{ backgroundColor: "var(--color-bg-elevated)", border: "1px solid var(--color-border)" }}
            >
              <Server className="w-5 h-5" style={{ color: "var(--color-text-muted)" }} />
            </div>
            <p className="text-xs text-center" style={{ color: "var(--color-text-muted)" }}>
              {t("dashboard.server_stats_hint")}
            </p>
            <Button variant="ghost" size="sm" icon={<LogIn className="w-3.5 h-3.5" />} onClick={onNavigateToControl}>
              {t("dashboard.go_to_control")}
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  // Connecting state — loader
  if (isLoading && !isConnected) {
    return (
      <div className="flex flex-col flex-1 overflow-y-auto pr-1">
        {/* VPN connecting placeholder */}
        <div className="flex flex-col items-center justify-center gap-3 py-12">
          <Loader2 className="w-10 h-10 animate-spin" style={{ color: "var(--color-warning-500)" }} />
          <p className="text-sm font-semibold" style={{ color: "var(--color-text-primary)" }}>
            {status === "connecting"
              ? t("status.connecting")
              : status === "disconnecting"
                ? t("status.disconnecting")
                : t("status.recovering")}
          </p>
        </div>

        {/* Server stats still visible if SSH connected */}
        {sshConnected && (
          <div className="flex flex-col gap-3 mt-2">
            <ServerStatsCard onNavigateToControl={onNavigateToControl} />
          </div>
        )}
      </div>
    );
  }

  // VPN disconnected but SSH connected — VPN placeholder + server stats
  if (!isConnected && sshConnected) {
    return (
      <div className="flex flex-col flex-1 overflow-y-auto pr-1">
        <div className="flex flex-col items-center gap-3 py-8">
          <div
            className="p-4 rounded-full"
            style={{ backgroundColor: "var(--color-bg-elevated)", border: "1px solid var(--color-border)" }}
          >
            <BarChart3 className="w-8 h-8" style={{ color: "var(--color-text-muted)" }} />
          </div>
          <div className="text-center">
            <p className="text-sm font-semibold mb-1" style={{ color: "var(--color-text-primary)" }}>
              {t("dashboard.disconnected_title", "Dashboard")}
            </p>
            <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
              {t("dashboard.connect_to_see")}
            </p>
          </div>
          {configPath && (
            <Button variant="success" size="lg" icon={<Power className="w-4 h-4" />} onClick={onConnect}>
              {t("buttons.connect")}
            </Button>
          )}
        </div>

        <div className="flex flex-col gap-3">
          <ServerStatsCard onNavigateToControl={onNavigateToControl} />
        </div>
      </div>
    );
  }

  // Fully connected — full dashboard
  return (
    <div className="flex flex-col gap-3 flex-1 overflow-y-auto pr-1">
      <ConnectionOverview
        status={status}
        connectedSince={connectedSince}
        currentPing={dashboard.currentPing}
        clientConfig={dashboard.clientConfig}
        vpnMode={vpnMode}
        isLoading={isLoading}
        onDisconnect={onDisconnect}
      />

      <PingChart
        pingHistory={dashboard.pingHistory}
        avgPing={dashboard.avgPing}
        isConnected={isConnected}
      />

      <div className="flex gap-3">
        <SpeedTestCard
          speed={dashboard.speed}
          testing={dashboard.speedTesting}
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
  );
}
