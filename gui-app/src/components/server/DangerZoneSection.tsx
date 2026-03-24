import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  RefreshCw,
  Trash2,
  Settings,
} from "lucide-react";
import { CardHeader } from "../../shared/ui/Card";
import { Button } from "../../shared/ui/Button";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import type { ServerState } from "./useServerState";

interface Props {
  state: ServerState;
}

export function DangerZoneSection({ state }: Props) {
  const { t } = useTranslation();
  const {
    confirmUninstall,
    setConfirmUninstall,
    uninstallLoading,
    setUninstallLoading,
    sshParams,
    onSwitchToSetup,
    onClearConfig,
    setActionResult,
  } = state;

  const handleUninstall = async () => {
    setUninstallLoading(true);
    try {
      await invoke("uninstall_server", sshParams);
      setConfirmUninstall(false);
      onClearConfig();
      onSwitchToSetup();
    } catch (e) {
      setActionResult({ type: "error", message: String(e) });
      setConfirmUninstall(false);
    } finally {
      setUninstallLoading(false);
    }
  };

  return (
    <>
      <div
        className="rounded-[var(--radius-xl)] p-4 border transition-colors"
        style={{
          backgroundColor: "rgba(239, 68, 68, 0.03)",
          borderColor: "rgba(239, 68, 68, 0.25)",
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
          <Button
            variant="danger-outline"
            size="sm"
            icon={<RefreshCw className="w-3.5 h-3.5" />}
            onClick={onSwitchToSetup}
          >
            {t("server.danger.reinstall")}
          </Button>
          <Button
            variant="danger"
            size="sm"
            icon={<Trash2 className="w-3.5 h-3.5" />}
            loading={uninstallLoading}
            onClick={() => setConfirmUninstall(true)}
          >
            {t("server.danger.uninstall")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<Settings className="w-3.5 h-3.5" />}
            onClick={() => {
              onClearConfig();
              onSwitchToSetup();
            }}
          >
            {t("server.danger.reconfigure")}
          </Button>
        </div>
      </div>

      {/* Uninstall confirmation */}
      <ConfirmDialog
        open={confirmUninstall}
        title={t("server.danger.confirm_uninstall_title")}
        message={t("server.danger.confirm_uninstall_message")}
        confirmLabel={t("server.danger.confirm_delete_btn")}
        cancelLabel={t("buttons.cancel")}
        variant="danger"
        loading={uninstallLoading}
        onCancel={() => setConfirmUninstall(false)}
        onConfirm={handleUninstall}
      />
    </>
  );
}
