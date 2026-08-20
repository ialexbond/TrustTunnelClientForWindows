import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { type SshCredentials } from "./SshConnectForm";
import { useSidecarUpdateCascade } from "./useSidecarUpdateCascade";
import { readStoredCredentials } from "./readStoredCredentials";
import { credentialsMatchTarget } from "../wizard/useWizardState";

// ═══════════════════════════════════════════════════════
// useControlPanelOrchestrator — container hook (PANEL-02/03, D-04/D-05)
// ═══════════════════════════════════════════════════════
//
// Mirrors the in-repo `useSecurityState.ts` container-hook analog: owns ALL of
// ControlPanelPage's state (creds / loading / refreshKey / lastHost-User-Port /
// isFirstConnect / serverInfoVersion), the effects (initial creds load, the
// `trusttunnel_control_refresh` 2s polling tick, sidecar update detection), and
// the connect / disconnect / port-changed callbacks.
//
// State + effects were lifted VERBATIM from ControlPanelPage (same effect
// bodies, same dependency arrays, same closure capture — nothing reordered or
// "fixed"; the stale-closure / double-fire fixes are the Plan-12 split,
// Pitfall 2: never combine lift + fix).
//
// D-05 single source: the sidecar-version / update cascade is owned by ONE
// hook — `useSidecarUpdateCascade`, instantiated exactly once below. No second
// independent version/availability probe is introduced. `localSidecarAvailable`
// is the single source of truth for the bottom-tab dot, Overview Card #8 arrow,
// and ServerTabs dot; its value is drilled to the tab sections by props.

interface OrchestratorParams {
  onConfigExported: (configPath: string) => void;
  onSwitchToSetup: () => void;
  onNavigateToSettings?: () => void;
  /**
   * Phase 19 (UI-SPEC §Block 1) — lift sidecar-update flag to `App` so the
   * bottom TabNavigation can render the dot on «Панель управления».
   *
   * Receives `sidecarAvailable && !sidecarDismissed` (already collapsed —
   * caller does not need to apply dismissal logic itself).
   */
  onSidecarUpdateChange?: (hasUpdate: boolean) => void;
}

export function useControlPanelOrchestrator({
  onConfigExported,
  onSwitchToSetup,
  onNavigateToSettings,
  onSidecarUpdateChange,
}: OrchestratorParams) {
  const [creds, setCreds] = useState<SshCredentials | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const lastTsRef = useRef<string | null>(null);

  // First-connect skeleton state (D-07/D-08/D-09)
  const [isFirstConnect, setIsFirstConnect] = useState(false);

  // Persisted last SSH host/user/port (D-10/D-11) — restored on next visit
  const [lastHost, setLastHost] = useState<string>(
    () => localStorage.getItem("tt_ssh_last_host") ?? ""
  );
  const [lastUser, setLastUser] = useState<string>(
    () => localStorage.getItem("tt_ssh_last_user") ?? "root"
  );
  const [lastPort, setLastPort] = useState<string>(
    () => localStorage.getItem("tt_ssh_last_port") ?? "22"
  );

  // ─── Sidecar update cascade — SINGLE owner (D-05, PANEL-02/04) ───────────
  //
  // The entire sidecar-version / update-cascade state lives in ONE hook,
  // instantiated EXACTLY ONCE here (the orchestrator is the single owner from
  // Plan 08). It owns: the Stage-2 `checkSidecarForServer` refresh, the
  // `useSidecarVersions` GitHub fetch, the `localSidecarAvailable` derivation
  // (single source of truth for the bottom-tab dot, Overview Card #8 arrow,
  // and ServerTabs «Сервис» dot), the dismiss/seen handlers, and the single
  // `update-protocol-step` listener. Its value is exposed on `ControlPanelState`
  // and drilled to `ServiceTabSection` / `ProtocolUpdateSection` by props —
  // children NEVER call the cascade hook themselves (that would be a 2nd probe,
  // the D-05 violation this consolidation removes). See useSidecarUpdateCascade.ts.
  const {
    serverInfoVersion,
    setServerInfoVersion,
    localSidecarAvailable,
    latestFromGitHubCP,
    sidecarUpdateVisible,
    handleSidecarUpdateApplied,
    handleSidecarUpdateSeen,
  } = useSidecarUpdateCascade({ creds, onSidecarUpdateChange });

  useEffect(() => {
    readStoredCredentials().then((c) => {
      // C-23 / D-15: the no-arg load returns the last-active record, which on a
      // multi-server machine may belong to a DIFFERENT server than the one this
      // panel last connected to. Validate the loaded bundle's host:port:user
      // against the persisted last-target BEFORE trusting it for setCreds /
      // auto-connect — otherwise the panel could install/connect/auto-connect
      // against the WRONG server. Read the target from localStorage directly so
      // the gate uses the same source the state was lazy-initialised from.
      const tgtHost = localStorage.getItem("tt_ssh_last_host") ?? "";
      const tgtPort = localStorage.getItem("tt_ssh_last_port") ?? "22";
      const tgtUser = localStorage.getItem("tt_ssh_last_user") ?? "root";
      // Cold start (no persisted target) → nothing to validate against, the
      // loaded bundle IS the target. Otherwise it must match host:port:user.
      const trusted =
        !tgtHost ||
        credentialsMatchTarget(c, { host: tgtHost, port: tgtPort, user: tgtUser });
      if (c && trusted) {
        setCreds(c);
        // BUG-01: при auto-reconnect показываем skeleton (а не полноэкранный лоадер
        // ServerPanel.state.loading). Сбросится в false по onPanelReady.
        setIsFirstConnect(true);
      } else {
        // Mismatch: a stale last-active record belongs to a different server —
        // never auto-connect on it (the C-23 wrong-server hazard).
        setCreds(null);
      }
      setLoading(false);
    });
  }, []);

  // 2s polling loop that picks up cross-context credential changes (the wizard
  // writes `trusttunnel_control_refresh` after saving creds, in the same WebView).
  //
  // C-02: the old body had a SECOND, unconditional `if (!creds)` branch that
  // called readStoredCredentials EVERY tick while disconnected — double-firing
  // the keyring read in the same tick as the refresh-signal branch. That branch
  // is removed: the mount effect covers cold-start, and the `ts !== lastTs`
  // signal branch covers every wizard/cross-tab-driven update. One read per tick.
  //
  // C-03: with the unconditional `if (!creds)` branch gone, the interval body no
  // longer reads `creds` at all — only `lastTsRef` + the stable setters. So the
  // effect drops its `[creds]` dependency (empty dep array) and the interval is
  // registered exactly ONCE for the hook's lifetime, eliminating the per-creds
  // teardown/re-register churn and the stale-closure window the audit calls out.
  useEffect(() => {
    const interval = setInterval(() => {
      const ts = localStorage.getItem("trusttunnel_control_refresh");
      const lastTs = lastTsRef.current;
      if (ts && ts !== lastTs) {
        lastTsRef.current = ts;
        readStoredCredentials().then((fresh) => {
          // C-23 / D-15: apply the SAME target gate to the refreshed bundle. The
          // refresh signal can fire after the wizard saved creds for a DIFFERENT
          // server; we must never setCreds (and thus auto-connect) on a bundle
          // whose host:port:user differs from this panel's persisted target.
          // localStorage is read directly (this interval has an empty dep array,
          // so closed-over state would be stale).
          const tgtHost = localStorage.getItem("tt_ssh_last_host") ?? "";
          const tgtPort = localStorage.getItem("tt_ssh_last_port") ?? "22";
          const tgtUser = localStorage.getItem("tt_ssh_last_user") ?? "root";
          const trusted =
            !tgtHost ||
            credentialsMatchTarget(fresh, { host: tgtHost, port: tgtPort, user: tgtUser });
          if (fresh && trusted) {
            setCreds(fresh);
            setRefreshKey(k => k + 1);
          } else {
            setCreds(null);
          }
        });
      }
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  const handleConnect = useCallback((newCreds: SshCredentials) => {
    setIsFirstConnect(true);
    setLastHost(newCreds.host);
    setLastUser(newCreds.user);
    setLastPort(newCreds.port);
    localStorage.setItem("tt_ssh_last_host", newCreds.host);
    localStorage.setItem("tt_ssh_last_user", newCreds.user);
    localStorage.setItem("tt_ssh_last_port", newCreds.port);
    setCreds(newCreds);
    setRefreshKey(k => k + 1);
  }, []);

  const handleDisconnect = useCallback(async () => {
    // WR-09 fix: await keyring cleanup before clearing state. Previously the
    // un-awaited invoke could race the 2s polling interval: user clicks
    // Disconnect → setCreds(null) runs → interval fires with !creds → reads
    // ssh_credentials.json which still exists because clear_ssh_credentials
    // hasn't completed yet → resurrects stale creds. Await guarantees the
    // keyring file is gone before we flip local state.
    await invoke("clear_ssh_credentials").catch(() => {});
    localStorage.removeItem("trusttunnel_control_refresh");
    setIsFirstConnect(false);
    // Per D-10: lastHost/lastUser/lastPort are NOT cleared on disconnect
    setCreds(null);
  }, []);

  return {
    // SSH state machine
    creds,
    loading,
    refreshKey,
    isFirstConnect,
    setIsFirstConnect,
    lastHost,
    lastUser,
    lastPort,
    // Sidecar update detection (D-05 single source)
    serverInfoVersion,
    setServerInfoVersion,
    localSidecarAvailable,
    latestFromGitHubCP,
    sidecarUpdateVisible,
    // Callbacks
    handleConnect,
    handleDisconnect,
    handleSidecarUpdateApplied,
    handleSidecarUpdateSeen,
    // Parent callbacks threaded through to the presentation layer
    onConfigExported,
    onSwitchToSetup,
    onNavigateToSettings,
  };
}

export type ControlPanelState = ReturnType<typeof useControlPanelOrchestrator>;
