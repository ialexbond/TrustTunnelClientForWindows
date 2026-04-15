import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  Tag,
  Shield,
  Network,
  Users,
  Loader2,
  WifiOff,
  Activity,
  RefreshCw,
} from "lucide-react";
import { Card, CardHeader } from "../../shared/ui/Card";
import { Badge } from "../../shared/ui/Badge";
import { StatCard } from "../../shared/ui/StatCard";
import { StatusIndicator } from "../../shared/ui/StatusIndicator";
import { IconButton } from "../../shared/ui/IconButton";
import { CertSection } from "./CertSection";
import type { ServerState } from "./useServerState";

interface Props {
  state: ServerState;
}

export function OverviewSection({ state }: Props) {
  const { t } = useTranslation();
  const { serverInfo, sshParams, loadServerInfo, rebooting, setRebooting, setServerInfo } = state;

  const [ping, setPing] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [rebootCountdown, setRebootCountdown] = useState(0);
  const healthPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Initial ping ──
  useEffect(() => {
    if (!serverInfo?.serviceActive) { setPing(null); return; }
    invoke<number>("ping_endpoint", { host: state.host, port: 443 })
      .then((ms) => setPing(ms))
      .catch(() => setPing(-1));
  }, [state.host, serverInfo?.serviceActive]);

  // ── Background health check: ping every 30s ──
  useEffect(() => {
    if (!serverInfo?.serviceActive || rebooting) return;
    healthPollRef.current = setInterval(() => {
      invoke<number>("ping_endpoint", { host: state.host, port: 443 })
        .then((ms) => setPing(ms))
        .catch(() => setPing(-1));
    }, 30000);
    return () => { if (healthPollRef.current) clearInterval(healthPollRef.current); };
  }, [state.host, serverInfo?.serviceActive, rebooting]);

  // ── Reboot polling ──
  useEffect(() => {
    if (!rebooting) return;
    let elapsed = 0;
    const interval = setInterval(async () => {
      elapsed += 10;
      setRebootCountdown(elapsed);
      try {
        const info = await invoke<{ installed: boolean; version: string; serviceActive: boolean; users: string[] }>(
          "check_server_installation", sshParams
        );
        if (info) {
          setRebooting(false);
          setRebootCountdown(0);
          setServerInfo(info);
          state.pushSuccess(t("server.actions.success_reboot_done"));
          invoke<number>("ping_endpoint", { host: state.host, port: 443 })
            .then((ms) => setPing(ms))
            .catch(() => setPing(-1));
        }
      } catch {
        if (elapsed >= 120) {
          setRebooting(false);
          setRebootCountdown(0);
          invoke("clear_ssh_credentials").catch(() => {});
          localStorage.setItem("trusttunnel_control_refresh", Date.now().toString());
        }
      }
    }, 10000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rebooting]);

  const refreshPing = useCallback(() => {
    invoke<number>("ping_endpoint", { host: state.host, port: 443 })
      .then((ms) => setPing(ms))
      .catch(() => setPing(-1));
  }, [state.host]);

  const handleSoftRefresh = async () => {
    setRefreshing(true);
    await loadServerInfo(true);
    refreshPing();
    setRefreshing(false);
  };

  if (!serverInfo) return null;

  const pingVariant = (() => {
    if (ping === null) return "neutral";
    if (ping <= 0) return "neutral";
    if (ping < 100) return "success";
    if (ping < 300) return "warning";
    return "danger";
  })();

  // Parse protocol from serverInfo — fall back to "WireGuard"
  const protocolValue = serverInfo.protocol ?? "WireGuard";
  const listenPort = serverInfo.listenPort;

  return (
    <>
      {/* Block 1: Server Status */}
      <Card padding="lg">
        <CardHeader
          title={t("server.status.title")}
          icon={<Activity className="w-4 h-4" />}
        />

        {/* Rebooting state */}
        {rebooting ? (
          <div className="flex items-center gap-3 mb-4 py-2">
            <Loader2 className="w-5 h-5 animate-spin" style={{ color: "var(--color-warning-500)" }} />
            <div>
              <span className="text-sm font-[var(--font-weight-semibold)]" style={{ color: "var(--color-warning-500)" }}>
                {t("server.status.rebooting")}
              </span>
              <span className="text-xs ml-2" style={{ color: "var(--color-text-muted)" }}>
                {rebootCountdown > 0 ? `${rebootCountdown}s` : ""}
              </span>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2.5 flex-wrap">
            {/* StatusIndicator dot — replaces raw div */}
            <StatusIndicator
              status={serverInfo.serviceActive ? "success" : "danger"}
              size="md"
              pulse={serverInfo.serviceActive}
              label={serverInfo.serviceActive ? t("server.status.running") : t("server.status.stopped")}
            />
            <span className="text-base font-[var(--font-weight-semibold)]" style={{ color: "var(--color-text-primary)" }}>
              {serverInfo.serviceActive ? t("server.status.running") : t("server.status.stopped")}
            </span>
            {/* IP removed — already shown in ServerTabs header (DC-03 fix) */}
            <IconButton
              aria-label={t("server.status.refresh_aria")}
              icon={refreshing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              onClick={handleSoftRefresh}
              disabled={refreshing}
              className="h-9 w-9"
            />
            {ping !== null && ping > 0 && (
              <Badge variant={pingVariant as "success" | "warning" | "danger" | "neutral"} size="sm">
                <Activity className="w-2.5 h-2.5" />
                {ping}ms
              </Badge>
            )}
            {ping !== null && ping <= 0 && (
              <Badge variant="neutral" size="sm">
                <WifiOff className="w-2.5 h-2.5" />
                {t("server.status.no_connection")}
              </Badge>
            )}
          </div>
        )}
      </Card>

      {/* Block 2: StatCard 2×2 grid */}
      <div className="grid grid-cols-2 gap-4">
        <StatCard
          label={t("server.overview.version")}
          value={serverInfo.version || "?"}
          icon={<Tag className="w-4 h-4" />}
          loading={!serverInfo}
        />
        <StatCard
          label={t("server.overview.protocol")}
          value={protocolValue}
          icon={<Shield className="w-4 h-4" />}
          loading={!serverInfo}
        />
        <StatCard
          label={t("server.overview.port")}
          value={listenPort ? String(listenPort) : "?"}
          icon={<Network className="w-4 h-4" />}
          loading={!serverInfo}
        />
        <StatCard
          label={t("server.overview.users")}
          value={String(serverInfo.users?.length ?? 0)}
          icon={<Users className="w-4 h-4" />}
          loading={!serverInfo}
        />
      </div>

      {/* Block 3: TLS Certificate — use CertSection as sub-component (Pitfall 3) */}
      <CertSection state={state} />
    </>
  );
}
