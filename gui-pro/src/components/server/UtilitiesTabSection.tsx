import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw, PowerOff, Power, AlertTriangle, Zap } from "lucide-react";
import { Card, CardHeader } from "../../shared/ui/Card";
import { Button } from "../../shared/ui/Button";
import { Toggle } from "../../shared/ui/Toggle";
import { Accordion } from "../../shared/ui/Accordion";
import { useConfirm } from "../../shared/ui/useConfirm";
import type { ServerState } from "./useServerState";
import { useBbrState } from "./useBbrState";
import { useMtProtoState } from "./useMtProtoState";
import { MtProtoSection } from "./MtProtoSection";
import { LogsSection } from "./LogsSection";
import { DangerZoneSection } from "./DangerZoneSection";

interface Props {
  state: ServerState;
}

export function UtilitiesTabSection({ state }: Props) {
  const { t } = useTranslation();
  const { serverInfo, actionLoading, sshParams, runAction, pushSuccess } = state;
  const confirm = useConfirm();

  const bbr = useBbrState(sshParams, pushSuccess);
  const mtproto = useMtProtoState(sshParams, pushSuccess);

  const handleStopService = async () => {
    const ok = await confirm({
      title: t("server.danger.stop_title"),
      message: t("server.danger.stop_message"),
      variant: "danger",
      confirmText: t("buttons.confirm"),
      cancelText: t("buttons.cancel"),
    });
    if (!ok) return;
    runAction(
      "stop",
      () => invoke("server_stop_service", sshParams),
      t("server.actions.success_stop"),
    );
  };

  return (
    <div className="space-y-4">
      {/* Block 1: Service Controls — перенесено из ServiceSection */}
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
              onClick={handleStopService}
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

      </Card>

      {/* Block 2: BBR Toggle — перенесено из ServerSettingsSection */}
      <Card>
        <CardHeader
          title={t("server.utilities.bbr.label")}
          icon={<Zap className="w-3.5 h-3.5" />}
        />
        <Toggle
          checked={bbr.enabled}
          onChange={() => void bbr.toggle()}
          label={t("server.utilities.bbr.label")}
          description={
            bbr.loading
              ? t("server.utilities.bbr.detecting")
              : t("server.utilities.bbr.description")
          }
          icon={<Zap className="w-3 h-3" />}
          disabled={bbr.loading}
        />
      </Card>

      {/* Block 3: MTProto — перенесено из ServerSettingsSection Advanced Accordion */}
      {mtproto.status && <MtProtoSection state={mtproto} />}

      {/* Block 4: Logs — перенесено из ServiceSection */}
      <LogsSection state={state} />

      {/* Block 5: DangerZone Accordion (T-12-07: closed by default + ConfirmDialog) */}
      <Accordion
        defaultOpen={[]}
        items={[
          {
            id: "danger-zone",
            title: (
              <span
                className="flex items-center gap-2 text-sm font-semibold"
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
