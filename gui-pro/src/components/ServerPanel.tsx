import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  RefreshCw,
  Download,
  XCircle,
  Loader2,
  AlertTriangle,
  LogOut,
} from "lucide-react";
import { Button } from "../shared/ui/Button";
import { useServerState } from "./server/useServerState";
import { ServerTabs } from "./ServerTabs";

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
  onPortChanged?: (newPort: number) => void;
  onPanelReady?: () => void;  // called when panelDataLoaded becomes true
}

// ═══════════════════════════════════════════════════════
// ServerPanel — slim orchestrator
// ═══════════════════════════════════════════════════════

export function ServerPanel(props: ServerPanelProps) {
  const { t } = useTranslation();
  const state = useServerState(props);
  const { onPanelReady } = props;

  // Signal to parent when panel data is loaded (for skeleton dismissal)
  useEffect(() => {
    if (state.panelDataLoaded && onPanelReady) {
      onPanelReady();
    }
  }, [state.panelDataLoaded, onPanelReady]);

  // Reboot polling is handled by OverviewSection (inside the Overview tab) —
  // see `useEffect` keyed on `rebooting` there for the 10s poll + 2min timeout.
  // ServerStatusSection is legacy (kept for backward-compat tests only);
  // ServerTabs renders OverviewSection instead.

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
            style={{ backgroundColor: "var(--color-status-error-bg)" }}
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
              variant="ghost"
              size="sm"
              icon={<RefreshCw className="w-3.5 h-3.5" />}
              onClick={() => state.loadServerInfo()}
            >
              {t("server.actions.retry")}
            </Button>
            {/* Phase 13.UAT G-04: Disconnect → возврат на SshConnectForm login.
                Раньше был только "Configure SSH" (→ wizard), но это не экран
                логина, а полноценный мастер настройки. Disconnect = чистый exit. */}
            <Button
              variant="ghost"
              size="sm"
              icon={<LogOut className="w-3.5 h-3.5" />}
              onClick={state.onDisconnect}
            >
              {t("control.disconnect")}
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
            style={{ backgroundColor: "var(--color-status-connecting-bg)" }}
          >
            <AlertTriangle className="w-6 h-6" style={{ color: "var(--color-warning-500)" }} />
          </div>
          <h2 className="text-lg font-semibold" style={{ color: "var(--color-text-primary)" }}>
            {t("server.status.not_installed")}
          </h2>
          <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
            {t("server.status.not_installed_desc", { host: state.host })}
          </p>
          <div className="flex items-center justify-center gap-2">
            <Button
              variant="primary"
              icon={<Download className="w-4 h-4" />}
              onClick={() => {
                // Pre-fill wizard with current SSH and skip to endpoint
                try {
                  const existing = localStorage.getItem("trusttunnel_wizard");
                  const obj = existing ? JSON.parse(existing) : {};
                  obj.host = state.host;
                  obj.port = state.sshParams.port.toString();
                  obj.sshUser = state.sshParams.user;
                  obj.sshPassword = state.sshParams.password || "";
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
            {/* Phase 13.UAT G-04: Disconnect button для выхода на SshConnectForm
                (ранее с этого экрана не было как уйти, только force-kill app). */}
            <Button
              variant="secondary"
              icon={<LogOut className="w-4 h-4" />}
              onClick={state.onDisconnect}
            >
              {t("control.disconnect")}
            </Button>
          </div>
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
      </>
    );
  }

  // ─── Main panel — tabbed layout ───
  return <ServerTabs state={state} />;
}
