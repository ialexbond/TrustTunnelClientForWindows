import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, Trash2, PowerOff, Power } from "lucide-react";
import { CardHeader } from "../../shared/ui/Card";
import { Button } from "../../shared/ui/Button";
import { useConfirm } from "../../shared/ui/useConfirm";
import { formatError } from "../../shared/utils/formatError";
import type { ServerState } from "./useServerState";

interface Props {
  state: ServerState;
}

export function DangerZoneSection({ state }: Props) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const {
    uninstallLoading,
    setUninstallLoading,
    sshParams,
    onClearConfig: _onClearConfig,
    setActionResult,
    serverInfo,
    actionLoading,
    runAction,
  } = state;

  // D-3.4 + W1 contrast: Stop is DESTRUCTIVE (disconnects all VPN clients) — variant: "danger".
  // Contrast: Cancel benchmark in Plan 17-03 uses variant: "warning" (non-destructive).
  const handleStopService = async () => {
    const ok = await confirm({
      title: t("server.danger.stop_title"),
      message: t("server.danger.stop_message"),
      variant: "danger",
      // CTA-01 (09-24): action-verb label instead of the generic «Подтвердить»
      // so the destructive button names the consequence it triggers.
      confirmText: t("server.danger.stop_confirm_btn"),
      cancelText: t("buttons.cancel"),
    });
    if (!ok) return;
    await runAction(
      "stop",
      () => invoke("server_stop_service", sshParams),
      t("server.actions.success_stop"),
    );
  };

  // D-3.3 — no confirm, recovery action (Start is not destructive)
  const handleStartService = async () => {
    await runAction(
      "start",
      () => invoke("server_start_service", sshParams),
      t("server.actions.success_start"),
    );
  };

  const handleUninstall = async () => {
    const ok = await confirm({
      title: t("server.danger.confirm_uninstall_title"),
      message: t("server.danger.confirm_uninstall_message"),
      variant: "danger",
      confirmText: t("server.danger.confirm_delete_btn"),
      cancelText: t("buttons.cancel"),
    });
    if (!ok) return;
    setUninstallLoading(true);
    try {
      await invoke("uninstall_server", sshParams);
      state.setServerInfo({ installed: false, version: "", serviceActive: false, users: [] });
      state.pushSuccess(t("server.danger.uninstalled", "VPN удалён с сервера"));
    } catch (e) {
      setActionResult({ type: "error", message: formatError(e) });
    } finally {
      setUninstallLoading(false);
    }
  };

  return (
    <>
      <div
        className="rounded-[var(--radius-xl)] p-4 border transition-colors"
        style={{
          backgroundColor: "var(--color-danger-tint-03)",
          borderColor: "var(--color-danger-tint-25)",
        }}
      >
        <CardHeader
          title={t("server.danger.title")}
          icon={
            <AlertTriangle
              className="w-3.5 h-3.5"
              style={{ color: "var(--color-danger-400)" }}
            />
          }
        />

        <div className="flex flex-wrap gap-2">
          {/* D-3.3: Stop — conditionally when service is active */}
          {serverInfo?.serviceActive === true && (
            <Button
              data-testid="danger-zone-stop-button"
              variant="danger-outline"
              size="sm"
              icon={<PowerOff className="w-3.5 h-3.5" />}
              loading={actionLoading === "stop"}
              onClick={() => void handleStopService()}
            >
              {t("server.actions.stop")}
            </Button>
          )}
          {/* D-3.3: Start — conditionally when service is inactive (recovery, no confirm) */}
          {serverInfo && !serverInfo.serviceActive && (
            <Button
              data-testid="danger-zone-start-button"
              variant="primary"
              size="sm"
              icon={<Power className="w-3.5 h-3.5" />}
              loading={actionLoading === "start"}
              onClick={() => void handleStartService()}
            >
              {t("server.actions.start")}
            </Button>
          )}
          {/* Uninstall — destructive endpoint (Reinstall removed per UAT 2026-05-19) */}
          <Button
            data-testid="danger-zone-uninstall-button"
            variant="danger"
            size="sm"
            icon={<Trash2 className="w-3.5 h-3.5" />}
            loading={uninstallLoading}
            onClick={handleUninstall}
          >
            {t("server.danger.uninstall")}
          </Button>
        </div>
      </div>
    </>
  );
}
