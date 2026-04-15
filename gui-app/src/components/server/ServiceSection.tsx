import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw, PowerOff, Power, AlertTriangle } from "lucide-react";
import { Card, CardHeader } from "../../shared/ui/Card";
import { Button } from "../../shared/ui/Button";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { Accordion } from "../../shared/ui/Accordion";
import type { ServerState } from "./useServerState";
import { SecuritySection } from "./SecuritySection";
import { LogsSection } from "./LogsSection";
import { DangerZoneSection } from "./DangerZoneSection";

interface Props {
  state: ServerState;
}

export function ServiceSection({ state }: Props) {
  const { t } = useTranslation();
  const { serverInfo, actionLoading, sshParams, runAction } = state;

  const [confirmStop, setConfirmStop] = useState(false);

  return (
    <div className="space-y-4">
      {/* Block 1: Service Controls */}
      <Card>
        <CardHeader
          title={t("server.service.controls_title")}
          icon={<RefreshCw className="w-3.5 h-3.5" />}
        />
        <div className="flex flex-wrap gap-2">
          {/* Restart (always available when server info is loaded) */}
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw className="w-3.5 h-3.5" />}
            loading={actionLoading === "restart"}
            onClick={() =>
              runAction(
                "restart",
                () => invoke("server_restart_service", sshParams),
                t("server.actions.success_restart")
              )
            }
          >
            {t("server.actions.restart")}
          </Button>

          {/* Stop (only when service is active) */}
          {serverInfo?.serviceActive && (
            <Button
              variant="danger-outline"
              size="sm"
              icon={<PowerOff className="w-3.5 h-3.5" />}
              loading={actionLoading === "stop"}
              onClick={() => setConfirmStop(true)}
            >
              {t("server.actions.stop")}
            </Button>
          )}

          {/* Start (only when service is stopped) */}
          {serverInfo && !serverInfo.serviceActive && (
            <Button
              variant="primary"
              size="sm"
              icon={<Power className="w-3.5 h-3.5" />}
              loading={actionLoading === "start"}
              onClick={() =>
                runAction(
                  "start",
                  () => invoke("server_start_service", sshParams),
                  t("server.actions.success_start")
                )
              }
            >
              {t("server.actions.start")}
            </Button>
          )}
        </div>

        {/* ConfirmDialog for stop service (T-11-03: elevation guard) */}
        <ConfirmDialog
          open={confirmStop}
          title={t("server.danger.stop_title")}
          message={t("server.danger.stop_message")}
          confirmLabel={t("buttons.confirm")}
          cancelLabel={t("buttons.cancel")}
          variant="danger"
          loading={actionLoading === "stop"}
          onCancel={() => setConfirmStop(false)}
          onConfirm={() => {
            setConfirmStop(false);
            runAction(
              "stop",
              () => invoke("server_stop_service", sshParams),
              t("server.actions.success_stop")
            );
          }}
        />
      </Card>

      {/* Block 2: Security Diagnostics (R-02: aria-live for screen readers) */}
      <div aria-live="polite">
        <SecuritySection state={state} />
      </div>

      {/* Block 3: Logs */}
      <LogsSection state={state} />

      {/* Block 4: DangerZone Accordion */}
      <Accordion
        defaultOpen={[]}
        items={[
          {
            id: "danger-zone",
            title: (
              <span
                className="flex items-center gap-2 text-sm font-[var(--font-weight-semibold)]"
                style={{ color: "var(--color-danger-500)" }}
              >
                <AlertTriangle className="w-3.5 h-3.5" />
                {t("server.danger.title")}
              </span>
            ),
            content: <DangerZoneSection state={state} />,
          },
        ]}
      />
    </div>
  );
}
