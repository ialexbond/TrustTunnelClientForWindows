import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, Trash2, PowerOff, Power } from "lucide-react";
import { CardHeader } from "../../shared/ui/Card";
import { Button } from "../../shared/ui/Button";
import { useConfirm } from "../../shared/ui/useConfirm";
import { UninstallDialog } from "./UninstallDialog";
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

  // UN-1 (18-06): «Удалить протокол» now opens the component-selection dialog
  // (UninstallDialog) instead of the plain useConfirm. The dialog owns the invoke +
  // the confirm-button/backdrop lock; DangerZone supplies sshParams + the success /
  // error handlers and mirrors the section-button loader via onLoadingChange.
  const [uninstallDialogOpen, setUninstallDialogOpen] = useState(false);

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

  // UN-1 (18-06): success/error handlers passed to UninstallDialog. The dialog owns the
  // invoke + the confirm-button/backdrop lock (INSTALL-LOCK); here we only clear the
  // server info + push the snackbar, exactly as the prior useConfirm flow did.
  const handleUninstallSuccess = () => {
    state.setServerInfo({ installed: false, version: "", serviceActive: false, users: [] });
    state.pushSuccess(t("server.danger.uninstalled", "TrustTunnel удалён"));
  };

  const handleUninstallError = (message: string) => {
    // R-11 (fix-all-paths): surface the (already translated) failure in the snackbar
    // so a failed uninstall is never silent.
    setActionResult({ type: "error", message });
    state.pushSuccess(message, "error");
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
            onClick={() => setUninstallDialogOpen(true)}
          >
            {t("server.danger.uninstall")}
          </Button>
        </div>
      </div>

      <UninstallDialog
        open={uninstallDialogOpen}
        sshParams={sshParams}
        onClose={() => setUninstallDialogOpen(false)}
        onSuccess={handleUninstallSuccess}
        onError={handleUninstallError}
        onLoadingChange={setUninstallLoading}
      />
    </>
  );
}
