import { useState, useEffect } from "react";
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

  useEffect(() => {
    if (!serverInfo?.serviceActive) return;
    const listenPort = 443;
    invoke<number>("ping_endpoint", { host: state.host, port: listenPort })
      .then((ms) => setPing(ms))
      .catch(() => setPing(-1));
  }, [state.host, serverInfo?.serviceActive]);

  if (!serverInfo) return null;

  // Soft refresh — only updates data, doesn't remount anything
  const handleSoftRefresh = async () => {
    setRefreshing(true);
    await loadServerInfo();
    setRefreshing(false);
  };

  return (
    <Card padding="lg">
      <CardHeader
        title={t("server.status.title")}
        icon={<Server className="w-4 h-4" />}
        action={
          <Tooltip text={t("server.status.tooltip")}>
            <button
              onClick={handleSoftRefresh}
              disabled={refreshing}
              className="flex items-center gap-1.5 text-[11px] transition-opacity hover:opacity-80"
              style={{ color: "var(--color-text-muted)" }}
            >
              {refreshing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              {t("server.actions.refresh_status")}
            </button>
          </Tooltip>
        }
      />

      {/* Hero status row */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div
            className="w-3 h-3 rounded-full shrink-0"
            style={{
              backgroundColor: serverInfo.serviceActive ? "var(--color-success-500)" : "var(--color-danger-500)",
              boxShadow: serverInfo.serviceActive
                ? "0 0 12px rgba(16, 185, 129, 0.6)"
                : "0 0 12px rgba(239, 68, 68, 0.4)",
            }}
          />
          <div>
            <span className="text-base font-semibold" style={{ color: "var(--color-text-primary)" }}>
              {serverInfo.serviceActive ? t("server.status.running") : t("server.status.stopped")}
            </span>
            <span className="text-xs ml-2.5" style={{ color: "var(--color-text-muted)" }}>
              {state.host}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {ping !== null && (
            <Badge variant={ping > 0 ? (ping < 100 ? "success" : ping < 300 ? "warning" : "danger") : "danger"} size="sm">
              <Activity className="w-2.5 h-2.5" />
              {ping > 0 ? `${ping}ms` : "N/A"}
            </Badge>
          )}
          <Badge variant="accent" size="md">
            v{serverInfo.version || "?"}
          </Badge>
        </div>
      </div>

      {/* Service control toolbar — nowrap to prevent multiline buttons */}
      <div className="flex gap-2" style={{ whiteSpace: "nowrap" }}>
        {serverInfo.serviceActive ? (
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw className="w-3.5 h-3.5" />}
              loading={actionLoading === "Перезапуск"}
              onClick={() =>
                runAction("Перезапуск", () => invoke("server_restart_service", sshParams))
              }
            >
              {t("server.actions.restart")}
            </Button>
            <Button
              variant="danger-outline"
              size="sm"
              icon={<PowerOff className="w-3.5 h-3.5" />}
              loading={actionLoading === "Остановка"}
              onClick={() =>
                runAction("Остановка", () => invoke("server_stop_service", sshParams))
              }
            >
              {t("server.actions.stop")}
            </Button>
          </>
        ) : (
          <Button
            variant="success"
            size="sm"
            icon={<Power className="w-3.5 h-3.5" />}
            loading={actionLoading === "Запуск"}
            onClick={() =>
              runAction("Запуск", () => invoke("server_start_service", sshParams))
            }
          >
            {t("server.actions.start")}
          </Button>
        )}
        <Button
          variant="danger-outline"
          size="sm"
          icon={<RotateCcw className="w-3.5 h-3.5" />}
          loading={actionLoading === "Перезагрузка сервера"}
          onClick={() => setConfirmReboot(true)}
        >
          {t("server.actions.reboot_server")}
        </Button>
      </div>
    </Card>
  );
}
