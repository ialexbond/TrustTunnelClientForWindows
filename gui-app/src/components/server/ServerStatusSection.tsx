import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  Server,
  RefreshCw,
  Power,
  PowerOff,
  RotateCcw,
  Activity,
  Loader2,
  WifiOff,
} from "lucide-react";
import { Card, CardHeader } from "../../shared/ui/Card";
import { Button } from "../../shared/ui/Button";
import { Badge } from "../../shared/ui/Badge";
import { Tooltip } from "../../shared/ui/Tooltip";
import type { ServerState } from "./useServerState";

interface Props {
  state: ServerState;
}

export function ServerStatusSection({ state }: Props) {
  const { t } = useTranslation();
  const { serverInfo, actionLoading, sshParams, runAction, loadServerInfo, setConfirmReboot } = state;

  const [ping, setPing] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [rebootCountdown, setRebootCountdown] = useState(0);
  const rebooting = state.rebooting;
  const setRebooting = state.setRebooting;
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
        // Server is back!
        if (info) {
          setRebooting(false);
          setRebootCountdown(0);
          state.setServerInfo(info);
          state.pushSuccess(t("server.actions.success_reboot_done"));
          invoke<number>("ping_endpoint", { host: state.host, port: 443 })
            .then((ms) => setPing(ms))
            .catch(() => setPing(-1));
        }
      } catch {
        // Still rebooting — continue polling
        // After 2 min timeout, go back to SSH connection screen
        if (elapsed >= 120) {
          setRebooting(false);
          setRebootCountdown(0);
          // Clear SSH creds → ControlPanelPage shows SSH form
          invoke("clear_ssh_credentials").catch(() => {});
          localStorage.setItem("trusttunnel_control_refresh", Date.now().toString());
        }
      }
    }, 10000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rebooting]);

  if (!serverInfo) return null;

  const refreshPing = () => {
    invoke<number>("ping_endpoint", { host: state.host, port: 443 })
      .then((ms) => setPing(ms))
      .catch(() => setPing(-1));
  };

  const handleSoftRefresh = async () => {
    setRefreshing(true);
    await loadServerInfo(true);
    refreshPing();
    setRefreshing(false);
  };

  const pingVariant = (() => {
    if (ping === null) return "neutral";
    if (ping <= 0) return "neutral";
    if (ping < 100) return "success";
    if (ping < 300) return "warning";
    return "danger";
  })();

  return (
    <Card padding="lg">
      <CardHeader
        title={t("server.status.title")}
        icon={<Server className="w-4 h-4" />}
      />

      {/* Rebooting state */}
      {rebooting ? (
        <div className="flex items-center gap-3 mb-4 py-2">
          <Loader2 className="w-5 h-5 animate-spin" style={{ color: "var(--color-warning-500)" }} />
          <div>
            <span className="text-sm font-medium" style={{ color: "var(--color-warning-500)" }}>
              {t("server.status.rebooting")}
            </span>
            <span className="text-xs ml-2" style={{ color: "var(--color-text-muted)" }}>
              {rebootCountdown > 0 ? `${rebootCountdown}s` : ""}
            </span>
          </div>
        </div>
      ) : (
        <>
          {/* Status row */}
          <div className="flex items-center gap-2.5 mb-4 flex-wrap">
            <div
              className="w-3 h-3 rounded-full shrink-0"
              style={{
                backgroundColor: serverInfo.serviceActive ? "var(--color-success-500)" : "var(--color-danger-500)",
                boxShadow: "none",
              }}
            />
            <span className="text-base font-[var(--font-weight-semibold)]" style={{ color: "var(--color-text-primary)" }}>
              {serverInfo.serviceActive ? t("server.status.running") : t("server.status.stopped")}
            </span>
            <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>{state.host}</span>
            <Tooltip text={t("server.actions.refresh_status")}>
              <button
                onClick={handleSoftRefresh}
                disabled={refreshing}
                className="p-1 rounded transition-opacity hover:opacity-70"
                style={{ color: "var(--color-text-muted)" }}
              >
                {refreshing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              </button>
            </Tooltip>
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

          {/* Service control toolbar */}
          <div className="flex gap-2" style={{ whiteSpace: "nowrap" }}>
            {serverInfo.serviceActive ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<RefreshCw className="w-3.5 h-3.5" />}
                  loading={actionLoading === "restart"}
                  onClick={() =>
                    runAction("restart", () => invoke("server_restart_service", sshParams), t("server.actions.success_restart"))
                  }
                >
                  {t("server.actions.restart")}
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  icon={<PowerOff className="w-3.5 h-3.5" />}
                  loading={actionLoading === "stop"}
                  onClick={() =>
                    runAction("stop", () => invoke("server_stop_service", sshParams), t("server.actions.success_stop"))
                  }
                >
                  {t("server.actions.stop")}
                </Button>
              </>
            ) : (
              <Button
                variant="primary"
                size="sm"
                icon={<Power className="w-3.5 h-3.5" />}
                loading={actionLoading === "start"}
                onClick={() =>
                  runAction("start", () => invoke("server_start_service", sshParams), t("server.actions.success_start"))
                }
              >
                {t("server.actions.start")}
              </Button>
            )}
            <Button
              variant="danger"
              size="sm"
              icon={<RotateCcw className="w-3.5 h-3.5" />}
              loading={rebooting}
              onClick={() => setConfirmReboot(true)}
            >
              {t("server.actions.reboot_server")}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
