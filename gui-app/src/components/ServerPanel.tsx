import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  Server,
  RefreshCw,
  Download,
  XCircle,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  X,
} from "lucide-react";
import { Button } from "../shared/ui/Button";
import { ConfirmDialog } from "../shared/ui/ConfirmDialog";
import { useServerState } from "./server/useServerState";
import { ServerStatusSection } from "./server/ServerStatusSection";
import { VersionSection } from "./server/VersionSection";
import { ConfigSection } from "./server/ConfigSection";
import { CertSection } from "./server/CertSection";
import { UsersSection } from "./server/UsersSection";
import { ExportSection } from "./server/ExportSection";
import { LogsSection } from "./server/LogsSection";
import { DiagnosticsSection } from "./server/DiagnosticsSection";
import { DangerZoneSection } from "./server/DangerZoneSection";

// ═══════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════

interface ServerPanelProps {
  host: string;
  port: string;
  sshUser: string;
  sshPassword: string;
  sshKeyPath?: string;
  onSwitchToSetup: () => void;
  onClearConfig: () => void;
  onConfigExported: (configPath: string) => void;
}

// ═══════════════════════════════════════════════════════
// ServerPanel — slim orchestrator
// ═══════════════════════════════════════════════════════

export function ServerPanel(props: ServerPanelProps) {
  const { t } = useTranslation();
  const state = useServerState(props);

  // ─── Loading state ───
  if (state.loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex items-center gap-3" style={{ color: "var(--color-text-muted)" }}>
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-sm">{t("server.status.checking")}</span>
        </div>
      </div>
    );
  }

  // ─── Error / No connection ───
  if (state.error || !state.serverInfo) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-sm w-full text-center space-y-4">
          <div
            className="mx-auto w-12 h-12 rounded-xl flex items-center justify-center"
            style={{ backgroundColor: "rgba(239, 68, 68, 0.1)" }}
          >
            <XCircle className="w-6 h-6" style={{ color: "var(--color-danger-500)" }} />
          </div>
          <h2 className="text-lg font-semibold" style={{ color: "var(--color-text-primary)" }}>
            {t("server.status.connection_failed")}
          </h2>
          <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
            {state.error || t("server.status.check_ssh")}
          </p>
          <div className="flex gap-2 justify-center">
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw className="w-3.5 h-3.5" />}
              onClick={state.loadServerInfo}
            >
              {t("server.actions.retry")}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<Server className="w-3.5 h-3.5" />}
              onClick={state.onSwitchToSetup}
            >
              {t("server.actions.configure_ssh")}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Not installed ───
  if (!state.serverInfo.installed) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-sm w-full text-center space-y-4">
          <div
            className="mx-auto w-12 h-12 rounded-xl flex items-center justify-center"
            style={{ backgroundColor: "rgba(245, 158, 11, 0.1)" }}
          >
            <AlertTriangle className="w-6 h-6" style={{ color: "var(--color-warning-500)" }} />
          </div>
          <h2 className="text-lg font-semibold" style={{ color: "var(--color-text-primary)" }}>
            {t("server.status.not_installed")}
          </h2>
          <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
            {t("server.status.not_installed_desc", { host: state.host })}
          </p>
          <Button
            variant="success"
            icon={<Download className="w-4 h-4" />}
            onClick={state.onSwitchToSetup}
          >
            {t("server.actions.install")}
          </Button>
        </div>
      </div>
    );
  }

  // ─── Main panel ───
  return (
    <div className="flex-1 overflow-y-auto py-3 pr-4 pl-1 space-y-4">
      {/* Action result banner with auto-dismiss */}
      {state.actionResult && (
        <div
          className="flex items-center gap-2 px-3 py-2 rounded-[var(--radius-lg)] text-xs animate-in fade-in duration-200"
          style={{
            backgroundColor:
              state.actionResult.type === "ok"
                ? "rgba(16, 185, 129, 0.08)"
                : "rgba(239, 68, 68, 0.08)",
            border: `1px solid ${
              state.actionResult.type === "ok"
                ? "rgba(16, 185, 129, 0.2)"
                : "rgba(239, 68, 68, 0.2)"
            }`,
            color:
              state.actionResult.type === "ok"
                ? "var(--color-success-500)"
                : "var(--color-danger-500)",
          }}
        >
          {state.actionResult.type === "ok" ? (
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
          ) : (
            <XCircle className="w-3.5 h-3.5 shrink-0" />
          )}
          <span className="flex-1">{state.actionResult.message}</span>
          <button
            onClick={() => state.setActionResult(null)}
            className="shrink-0 opacity-60 hover:opacity-100 transition-opacity"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <ServerStatusSection state={state} />
      <VersionSection state={state} />
      <ConfigSection state={state} />
      <CertSection state={state} />
      <UsersSection state={state} />
      <ExportSection state={state} />
      <LogsSection state={state} />
      <DiagnosticsSection state={state} />
      <DangerZoneSection state={state} />

      {/* Reboot server confirmation */}
      <ConfirmDialog
        open={state.confirmReboot}
        title={t("server.danger.confirm_reboot_title")}
        message={t("server.danger.confirm_reboot_message")}
        confirmLabel={t("server.danger.confirm_reboot_btn")}
        cancelLabel={t("buttons.cancel")}
        variant="warning"
        onCancel={() => state.setConfirmReboot(false)}
        onConfirm={() => {
          state.setConfirmReboot(false);
          state.runAction("Перезагрузка сервера", () =>
            invoke("server_reboot", state.sshParams)
          );
        }}
      />
    </div>
  );
}
