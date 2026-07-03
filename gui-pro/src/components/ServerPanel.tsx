import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  Download,
  Loader2,
  AlertTriangle,
  LogOut,
} from "lucide-react";
import { Button } from "../shared/ui/Button";
import { useServerState } from "./server/useServerState";
import { ServerTabs } from "./ServerTabs";
import { ServerUnavailablePlate } from "./server/ServerUnavailablePlate";
import { clearEndpointForm } from "./wizard/persist";

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
  /**
   * H-05 — fired right before a user-initiated retry re-runs `loadServerInfo`
   * from the error screen. The parent (`ControlPanelPage`/orchestrator) resets
   * `isFirstConnect` to `true` so the first-connect skeleton RE-SHOWS during the
   * retry instead of latching off after the first connect. Without this the
   * `display:none` skeleton guard is a one-way latch and the retry shows nothing
   * but the inner spinner. See audit 06 H-05.
   */
  onPanelRetry?: () => void;
  /**
   * Phase 19 (UI-SPEC §Block 2+3) cascade — sidecar update info sourced from
   * `useUpdateChecker(sshParams)` in `ControlPanelPage`. Forwards to
   * `ServerTabs` so OverviewSection Card #8 + ServiceTabSection Block 4 +
   * the «Сервис» pill dot all share a single source of truth.
   *
   * `hasSidecarUpdate` is the net visibility (`sidecarAvailable &&
   * !sidecarDismissed` collapsed by the parent). The remaining three carry
   * raw `useUpdateChecker` fields needed by `ProtocolUpdateSection`'s
   * frozen contract (Plan 19-03).
   */
  hasSidecarUpdate?: boolean;
  currentVersion?: string;
  sidecarAvailable?: boolean;
  latestVersion?: string;
  /**
   * Phase 19 cascade fix — fired after `ProtocolUpdateSection` successfully
   * runs `update_sidecar`. Parent (`ControlPanelPage`) re-invokes
   * `checkSidecarForServer` so `useUpdateChecker.sidecarCurrentVersion`
   * picks up the live post-update value via SSH — without this callback the
   * cached pre-update version sticks and all cascade indicators
   * (Overview Card #8 ArrowUp, bottom-tab dots, ServerTabs dot, Badge)
   * keep reflecting the stale comparison.
   */
  onSidecarUpdateApplied?: () => void;
  /**
   * Auto-dismiss дотлет точки на bottom-tab «Панель управления» когда
   * пользователь добрался до Service tab. Один-shot signal — после первого
   * mount Service tab записывается `tt_dismissed_update_<version>=true` и
   * `sidecarUpdateVisible` flip'ается в false. Badge внутри
   * `ProtocolUpdateSection` НЕ зависит от dismissed и продолжает гореть.
   */
  onSidecarUpdateSeen?: () => void;
  /**
   * Phase 19-06 cascade fix — emits `state.serverInfo.version` on mount
   * + every change. Lifts the single source of truth up to ControlPanelPage
   * so the Card #8 ArrowUpCircle, bottom-tab pill dot, and ServerTabs
   * pill dot stop depending on a parallel SSH probe that could fall stale
   * after an in-session sidecar downgrade. See
   * `.planning/phases/19-utilities-service-rename-update-section/19-DIAGNOSIS-card8-arrow.md`.
   */
  onServerInfoVersionChange?: (version: string) => void;
}

// ═══════════════════════════════════════════════════════
// ServerPanel — slim orchestrator
// ═══════════════════════════════════════════════════════

export function ServerPanel(props: ServerPanelProps) {
  const { t } = useTranslation();
  const state = useServerState(props);
  const { onPanelReady, onServerInfoVersionChange } = props;

  // Phase 19-06 cascade fix — lift state.serverInfo.version to ControlPanelPage.
  // Fires on mount and every time state.serverInfo.version changes (e.g. after
  // ServiceTabSection.handleAppliedWithRefresh calls state.loadServerInfo(true)
  // post-update). ControlPanelPage uses the lifted value to derive
  // localSidecarAvailable (the single source of truth for ArrowUpCircle,
  // bottom-tab dot, ServerTabs pill dot).
  useEffect(() => {
    onServerInfoVersionChange?.(state.serverInfo?.version ?? "");
  }, [state.serverInfo?.version, onServerInfoVersionChange]);

  // Signal to parent when panel data is loaded (for skeleton dismissal).
  //
  // H-05 (resettable): the parent's skeleton latch (`isFirstConnect`) is reset
  // to `true` on retry, so `onPanelReady` must be able to fire AGAIN once the
  // retry settles — otherwise the re-shown skeleton would never be dismissed.
  // `loadServerInfo` does NOT flip `panelDataLoaded` back to false on a retry
  // (it was already true from the error path), so an effect keyed purely on the
  // `panelDataLoaded` edge would latch after the first fire. Instead we fire on
  // each load-settled transition: arm while a load is in-flight (`loading`),
  // then fire once it completes with data loaded. On a fresh mount that is
  // already settled (loading=false, panelDataLoaded=true) we still fire once.
  const readyArmedRef = useRef(true);
  useEffect(() => {
    if (state.loading) {
      // A (re)load is running — arm so the NEXT settle fires onPanelReady again.
      readyArmedRef.current = true;
      return;
    }
    if (state.panelDataLoaded && readyArmedRef.current) {
      readyArmedRef.current = false;
      onPanelReady?.();
    }
  }, [state.panelDataLoaded, state.loading, onPanelReady]);

  // Reboot polling is handled by OverviewSection (inside the Overview tab) —
  // see `useEffect` keyed on `rebooting` there for the 10s poll + 2min timeout.

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

  // ─── Error / No connection — calm «Сервер недоступен» plate (E-11) ───
  //
  // Plan 09-13: this branch used to render its OWN raw-error screen (XCircle +
  // `server.status.connection_failed` + the bare `state.error` string) and it
  // fired BEFORE ServerTabs' calm ServerUnavailablePlate could ever show. A
  // non-technical user must NOT see the raw SSH/russh error text (D-05/EW-02 —
  // information-exposure-lite: "Connection refused", "SSH_CHANNEL_FAILURE", …).
  // We now route this branch to the SAME ServerUnavailablePlate ServerTabs uses,
  // so the unreachable state is calm and consistent everywhere. «Повторить» runs
  // the SAME retry as before (onPanelRetry re-arms the H-05 skeleton, then
  // loadServerInfo) and Disconnect stays — but the retry NEVER clears creds
  // (D-05/D-06: clearing lives only in handleDisconnect). The distinct
  // not-installed / rebooting / loading screens below are unchanged.
  if (state.error || !state.serverInfo) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-md w-full">
          {/* R-5: «Отключиться от сервера» + «Повторить» now render in ONE equal-width row
              INSIDE the plate (was: «Повторить» in the plate + a separate small ghost
              «Отключиться» below, at different sizes/places). «Повторить» re-arms the H-05
              skeleton then reloads and NEVER clears creds; Disconnect returns to the login
              form and is the ONLY path that clears creds (D-05/D-06). */}
          <ServerUnavailablePlate
            onRetry={() => {
              props.onPanelRetry?.();
              void state.loadServerInfo();
            }}
            onDisconnect={state.onDisconnect}
          />
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
          <div className="flex items-center justify-center gap-2 whitespace-nowrap">
            <Button
              variant="primary"
              icon={<Download className="w-4 h-4" />}
              onClick={() => {
                // The Control Panel already connected + verified this server, so the
                // install wizard opens STRAIGHT on the Settings (endpoint) screen — no
                // server-connect form, no «проверка» step (that all happened here).
                try {
                  const existing = localStorage.getItem("trusttunnel_wizard");
                  const obj = existing ? JSON.parse(existing) : {};
                  obj.host = state.host;
                  obj.port = state.sshParams.port.toString();
                  obj.sshUser = state.sshParams.user;
                  obj.sshPassword = state.sshParams.password || "";
                  if (state.sshParams.keyPath) obj.sshKeyPath = state.sshParams.keyPath;
                  // UAT (06-uat fix 3): the persisted blob is REUSED for the NEXT install on
                  // this server. The earlier fix only dropped domain/email/vpnUsername + the
                  // provided-cert paths — but the ADVANCED settings (the 407/405 chooser),
                  // written via saveField, STAYED behind across installs. clearEndpointForm
                  // drops the FULL endpoint+advanced key set and resets certType to the default,
                  // so a fresh install starts blank: each cleared key falls back to its
                  // useWizardState loadSaved default on the fresh mount
                  // (authFailureStatusCode→407, vpnUsername→"" regenerates).
                  // NOTE (06-uat install-wizard slimming): the old Metrics/SOCKS5/Allow-private/ICMP
                  // settings, and the reverse-proxy / camouflage settings, were removed from the
                  // wizard entirely, so they are no longer in this clear set.
                  // host/port/sshUser are KEPT — the panel just connected to THIS server.
                  // (These are NON-secret, safe to clear; D-29 only governs passwords.) The
                  // Phase-5 server-verified resume routes by installEntry/server-probe booleans,
                  // not by these fields, and never calls this, so clearing them is safe.
                  clearEndpointForm(obj);
                  // CANONICAL `step` — persist.ts reads `step`, NOT the legacy `wizardStep`,
                  // so the old key was silently ignored and a stale persisted step (e.g.
                  // "done" from a prior install) flashed server/«проверка»/«Всё готово».
                  obj.step = "endpoint";
                  delete obj.wizardStep;
                  // One-shot marker: the wizard consumes it on mount to LOAD the SSH secret
                  // (from Credential Manager) without re-probing the server — so it lands
                  // directly on Settings instead of running the resume probe («проверка»).
                  obj.installEntry = true;
                  obj.wizardMode = "deploy";
                  localStorage.setItem("trusttunnel_wizard", JSON.stringify(obj));
                } catch { /* ignore */ }
                state.onSwitchToSetup();
              }}
            >
              {t("buttons.install")}
            </Button>
            {/* Phase 13.UAT G-04: «Выйти» — disconnect back to SshConnectForm.
                (UAT 2026-05-20: tighter copy + nowrap container to keep 1 line). */}
            <Button
              variant="secondary"
              icon={<LogOut className="w-4 h-4" />}
              onClick={state.onDisconnect}
            >
              {t("control.exit")}
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
  return (
    <ServerTabs
      state={state}
      hasSidecarUpdate={props.hasSidecarUpdate}
      currentVersion={props.currentVersion}
      sidecarAvailable={props.sidecarAvailable}
      latestVersion={props.latestVersion}
      onSidecarUpdateApplied={props.onSidecarUpdateApplied}
      onSidecarUpdateSeen={props.onSidecarUpdateSeen}
    />
  );
}
