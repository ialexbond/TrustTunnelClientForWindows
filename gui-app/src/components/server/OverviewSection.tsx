import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  Loader2,
  WifiOff,
  Activity,
  RefreshCw,
  Users,
  Globe,
  Shield,
} from "lucide-react";
import { Badge } from "../../shared/ui/Badge";
import { StatusIndicator } from "../../shared/ui/StatusIndicator";
import { IconButton } from "../../shared/ui/IconButton";
// CertSection lives in Security tab — Overview shows only summary indicators
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

  const userCount = serverInfo.users?.length ?? 0;

  return (
    <>
      {/* ── Row 1: Status Hero (full width) ── */}
      <div
        className="rounded-[var(--radius-lg)] p-[var(--space-4)]"
        style={{ backgroundColor: "var(--color-bg-surface)", border: "1px solid var(--color-border)" }}
      >
        {rebooting ? (
          <div className="flex items-center gap-3">
            <Loader2 className="w-5 h-5 animate-spin" style={{ color: "var(--color-warning-500)" }} />
            <span className="text-sm font-[var(--font-weight-semibold)]" style={{ color: "var(--color-warning-500)" }}>
              {t("server.status.rebooting")}
            </span>
            {rebootCountdown > 0 && (
              <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>{rebootCountdown}s</span>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <StatusIndicator
                status={serverInfo.serviceActive ? "success" : "danger"}
                size="md"
                pulse={serverInfo.serviceActive}
                label={serverInfo.serviceActive ? t("server.status.running") : t("server.status.stopped")}
              />
              <span className="text-sm font-[var(--font-weight-semibold)]" style={{ color: "var(--color-text-primary)" }}>
                {serverInfo.serviceActive ? t("server.status.running") : t("server.status.stopped")}
              </span>
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
            <div className="flex items-center gap-2">
              <Badge variant="neutral" size="sm">v{serverInfo.version || "?"}</Badge>
              <IconButton
                aria-label={t("server.status.refresh_aria")}
                icon={refreshing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                onClick={handleSoftRefresh}
                disabled={refreshing}
              />
            </div>
          </div>
        )}
      </div>

      {/* ── Row 2: Asymmetric grid — Protocol (2/3) + Users (1/3) ── */}
      <div className="grid gap-3" style={{ gridTemplateColumns: "2fr 1fr" }}>
        {/* Protocol card — wide */}
        <div
          className="rounded-[var(--radius-lg)] p-[var(--space-4)] flex items-center gap-3"
          style={{ backgroundColor: "var(--color-bg-surface)", border: "1px solid var(--color-border)" }}
        >
          <div
            className="shrink-0 flex items-center justify-center w-9 h-9 rounded-[var(--radius-md)]"
            style={{ backgroundColor: "var(--color-bg-elevated)" }}
          >
            <Globe className="w-4 h-4" style={{ color: "var(--color-text-muted)" }} />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-[var(--font-weight-semibold)] truncate" style={{ color: "var(--color-text-primary)" }}>
              {protocolValue}
            </p>
            <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
              :{listenPort || "443"}
            </p>
          </div>
        </div>

        {/* Users card — compact, accent highlight */}
        <div
          className="rounded-[var(--radius-lg)] p-[var(--space-4)] flex flex-col items-center justify-center"
          style={{ backgroundColor: "var(--color-bg-surface)", border: "1px solid var(--color-border)" }}
        >
          <div className="flex items-center gap-1.5">
            <Users className="w-3.5 h-3.5" style={{ color: "var(--color-text-muted)" }} />
            <span className="text-lg font-[var(--font-weight-semibold)]" style={{ color: "var(--color-text-primary)" }}>
              {userCount}
            </span>
          </div>
          <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
            {t("server.overview.users")}
          </p>
        </div>
      </div>

      {/* ── Row 3: Security summary (full width, compact horizontal) ── */}
      <div
        className="rounded-[var(--radius-lg)] px-[var(--space-4)] py-3 flex items-center gap-4"
        style={{ backgroundColor: "var(--color-bg-surface)", border: "1px solid var(--color-border)" }}
      >
        <Shield className="w-4 h-4 shrink-0" style={{ color: "var(--color-text-muted)" }} />
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-1.5">
            <StatusIndicator status="neutral" size="sm" />
            <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>Firewall</span>
          </div>
          <div className="flex items-center gap-1.5">
            <StatusIndicator status="neutral" size="sm" />
            <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>Fail2Ban</span>
          </div>
          <div className="flex items-center gap-1.5">
            <StatusIndicator status="neutral" size="sm" />
            <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>SSH</span>
          </div>
          <div className="flex items-center gap-1.5">
            <StatusIndicator status={state.certRaw ? "success" : "neutral"} size="sm" />
            <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>TLS</span>
          </div>
        </div>
      </div>
    </>
  );
}
