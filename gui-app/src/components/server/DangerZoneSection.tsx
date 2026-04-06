import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { CardHeader } from "../../shared/ui/Card";
import { Button } from "../../shared/ui/Button";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { formatError } from "../../shared/utils/formatError";
import type { ServerState } from "./useServerState";

interface Props {
  state: ServerState;
}

function obfuscate(value: string): string {
  try {
    return "b64:" + btoa(unescape(encodeURIComponent(value)));
  } catch {
    return value;
  }
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
    onClearConfig: _onClearConfig,
    setActionResult,
  } = state;

  const handleUninstall = async () => {
    setUninstallLoading(true);
    try {
      await invoke("uninstall_server", sshParams);
      setConfirmUninstall(false);
      state.setServerInfo({ installed: false, version: "", serviceActive: false, users: [] });
      state.pushSuccess(t("server.danger.uninstalled", "VPN удалён с сервера"));
    } catch (e) {
      setActionResult({ type: "error", message: formatError(e) });
      setConfirmUninstall(false);
    } finally {
      setUninstallLoading(false);
    }
  };

  const handleReinstall = () => {
    // Pre-fill wizard with current SSH credentials and skip to endpoint step
    try {
      const existing = localStorage.getItem("trusttunnel_wizard");
      const obj = existing ? JSON.parse(existing) : {};
      obj.host = state.host;
      obj.port = sshParams.port.toString();
      obj.sshUser = sshParams.user;
      obj.sshPassword = obfuscate(sshParams.password);
      if (sshParams.keyPath) obj.sshKeyPath = sshParams.keyPath;
      obj.wizardStep = "endpoint";
      obj.wizardMode = "deploy";
      localStorage.setItem("trusttunnel_wizard", JSON.stringify(obj));
    } catch { /* ignore */ }
    onSwitchToSetup();
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
            onClick={handleReinstall}
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
        </div>
      </div>

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
