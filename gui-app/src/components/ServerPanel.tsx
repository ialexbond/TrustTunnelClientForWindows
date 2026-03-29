import { useTranslation } from "react-i18next";
import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Server,
  RefreshCw,
  Download,
  XCircle,
  Loader2,
  AlertTriangle,
} from "lucide-react";
import { Button } from "../shared/ui/Button";
import { colors } from "../shared/ui/colors";
import { ConfirmDialog } from "../shared/ui/ConfirmDialog";
import { SnackBar } from "../shared/ui/SnackBar";
import { useServerState } from "./server/useServerState";
import { ServerStatusSection } from "./server/ServerStatusSection";
import { VersionSection } from "./server/VersionSection";
import { ConfigSection } from "./server/ConfigSection";
import { CertSection } from "./server/CertSection";
import { UsersSection } from "./server/UsersSection";

import { LogsSection } from "./server/LogsSection";

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
  onDisconnect: () => void;
  onConfigExported: (configPath: string) => void;
}

// ═══════════════════════════════════════════════════════
// ServerPanel — slim orchestrator
// ═══════════════════════════════════════════════════════

export function ServerPanel(props: ServerPanelProps) {
  const { t } = useTranslation();
  const state = useServerState(props);

  // ─── Reboot polling (MUST be before any conditional returns — React hooks rule) ───
  const rebootPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!state.rebooting) {
      if (rebootPollRef.current) clearInterval(rebootPollRef.current);
      return;
    }
    let elapsed = 0;
    let resolved = false;
    rebootPollRef.current = setInterval(async () => {
      if (resolved) return;
      elapsed += 10;
      try {
        const info = await invoke<{ installed: boolean; version: string; serviceActive: boolean; users: string[] }>(
          "check_server_installation", state.sshParams
        );
        if (info && !resolved) {
          resolved = true;
          state.setRebooting(false);
          state.setServerInfo(info);
          state.pushSuccess(t("server.actions.success_reboot_done"));
        }
      } catch {
        if (elapsed >= 120) {
          state.setRebooting(false);
        }
      }
    }, 10000);
    return () => { if (rebootPollRef.current) clearInterval(rebootPollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.rebooting]);

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
              onClick={() => state.loadServerInfo()}
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
            style={{ backgroundColor: colors.warningBg }}
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
            onClick={() => {
              // Pre-fill wizard with current SSH and skip to endpoint
              try {
                const existing = localStorage.getItem("trusttunnel_wizard");
                const obj = existing ? JSON.parse(existing) : {};
                obj.host = state.host;
                obj.port = state.sshParams.port.toString();
                obj.sshUser = state.sshParams.user;
                obj.sshPassword = state.sshParams.password ? "b64:" + btoa(unescape(encodeURIComponent(state.sshParams.password))) : "";
                if (state.sshParams.keyPath) obj.sshKeyPath = state.sshParams.keyPath;
                obj.wizardStep = "endpoint";
                obj.wizardMode = "deploy";
                localStorage.setItem("trusttunnel_wizard", JSON.stringify(obj));
              } catch { /* ignore */ }
              state.onSwitchToSetup();
            }}
          >
            {t("server.actions.install")}
          </Button>
        </div>
      </div>
    );
  }

  // ─── Wait for panel data ───
  if (!state.panelDataLoaded) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex items-center gap-3" style={{ color: "var(--color-text-muted)" }}>
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-sm">{t("server.status.loading_panel")}</span>
        </div>
      </div>
    );
  }

  // ─── Rebooting fullscreen ───
  if (state.rebooting) {
    return (
      <>
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="text-center space-y-4">
            <Loader2 className="w-10 h-10 animate-spin mx-auto" style={{ color: "var(--color-warning-500)" }} />
            <div>
              <h2 className="text-lg font-semibold" style={{ color: "var(--color-text-primary)" }}>
                {t("server.status.rebooting")}
              </h2>
              <p className="text-xs mt-1" style={{ color: "var(--color-text-muted)" }}>
                {t("server.status.rebooting_desc")}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                state.setRebooting(false);
                props.onDisconnect();
              }}
            >
              {t("buttons.cancel")}
            </Button>
          </div>
        </div>
        <SnackBar messages={state.successQueue} onShown={state.shiftSuccess} duration={2500} />
      </>
    );
  }

  // ─── Main panel ───
  return (
    <>
      <div className="flex-1 scroll-overlay py-3 px-4 space-y-4">
          <ServerStatusSection state={state} />
          <UsersSection state={state} />
          <VersionSection state={state} />
          <ConfigSection state={state} />
          <CertSection state={state} />
          <LogsSection state={state} />
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
              state.setRebooting(true);
              invoke("server_reboot", state.sshParams).catch(() => {});
            }}
          />
      </div>

      {/* Success snackbar stack — bottom center, auto-dismiss */}
      <SnackBar
        messages={state.successQueue}
        onShown={state.shiftSuccess}
        duration={2500}
      />
    </>
  );
}
