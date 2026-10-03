import { useCallback, useEffect, useMemo, useState } from "react";
import { useUpdateChecker } from "../../shared/hooks/useUpdateChecker";
import { useUpdateProgress } from "../update/useUpdateProgress";
import { useSidecarVersions } from "./useSidecarVersions";
import { compareSemver } from "../../shared/utils/compareSemver";
import { latestSemver } from "../../shared/utils/latestSemver";
import { type SshCredentials } from "./SshConnectForm";

// ═══════════════════════════════════════════════════════
// useSidecarUpdateCascade — SINGLE owner of the sidecar-version /
// update-cascade state (PANEL-02/04, D-05). Pattern 3 — consolidate, never
// re-probe.
// ═══════════════════════════════════════════════════════
//
// Why this hook exists (04-AUDIT §"Cross-cutting themes" 2):
// the cascade used to be driven by dual/triple `useSidecarVersions` +
// `useUpdateProgress` mounts that each opened their own listener and fired
// their own GitHub fetch:
//   - Chrome C-01: dual parallel sidecar version probes.
//   - Service C-01: a dead `void useUpdateProgress()` 2nd `update-protocol-step`
//     listener that lived forever while the Service tab was open.
//
// A custom hook called in N components creates N independent state + listener
// instances. So this hook MUST be instantiated EXACTLY ONCE — inside
// `useControlPanelOrchestrator` (the single owner from Plan 08). Its return
// value is exposed through `ControlPanelState` and drilled to children by
// props. Children NEVER call this hook themselves (calling it in >1 component
// would be >1 probe — exactly the D-05 violation this hook removes).
//
// Container-hook shape mirrors the in-repo `useSecurityState.ts`: depend on
// primitives (the discrete cred fields below) not the object, expose a fat
// return object the orchestrator spreads onto `ControlPanelState`.
//
// D-05 single source: `localSidecarAvailable` is derived ONCE here. It is the
// single source of truth for the bottom-tab dot, Overview Card #8 arrow, and
// ServerTabs «Сервис» dot. No second independent availability probe is added.
//
// Update-progress ownership: this hook also mounts `useUpdateProgress` ONCE so
// the `update-protocol-step` listener has a single, lifecycle-bound owner here
// (the dead `void useUpdateProgress()` in `ProtocolUpdateSection` is removed —
// the `UpdateProgressModal` it renders still owns its own modal-scoped
// instance for the active update flow).

interface CascadeParams {
  /**
   * SSH credentials from the orchestrator. `null` while disconnected — the
   * cascade short-circuits (no probe, no availability).
   */
  creds: SshCredentials | null;
  /**
   * Phase 19 (UI-SPEC §Block 1) — lift the collapsed sidecar-update flag to
   * `App` so the bottom TabNavigation can render the dot on «Панель
   * управления». Receives `sidecarAvailable && !sidecarDismissed`.
   */
  onSidecarUpdateChange?: (hasUpdate: boolean) => void;
}

export function useSidecarUpdateCascade({
  creds,
  onSidecarUpdateChange,
}: CascadeParams) {
  // ─── Phase 18 server-bound version refresh (Stage 2 detection) ───────────
  //
  // ControlPanelPage owns SSH credentials, so it owns Stage 2 of the dual-
  // detection contract (REQ-18-UPDATE-DETECTION-02). On every `creds` change
  // we re-invoke `checkSidecarForServer` so server-bound version info refreshes
  // when the user reconnects or switches hosts.
  const { checkSidecarForServer, dismissSidecarUpdate } = useUpdateChecker();

  // ─── Update-progress single owner ───────────────────────────────────────
  //
  // Mount `useUpdateProgress` ONCE here so the `update-protocol-step` Tauri
  // listener has a single owner bound to the cascade lifecycle. The previous
  // `void useUpdateProgress()` in `ProtocolUpdateSection` was a dead 2nd
  // listener (Service C-01) — it has been removed; `UpdateProgressModal` keeps
  // its own modal-scoped instance for the live update flow.
  void useUpdateProgress();

  // Depend on primitives, not the creds object — mirrors useSecurityState's
  // load() dependency discipline (avoids the stale-closure family).
  const host = creds?.host;
  const port = creds?.port;
  const user = creds?.user;
  const password = creds?.password;
  const keyPath = creds?.keyPath;

  useEffect(() => {
    if (!host) return;
    void checkSidecarForServer({
      host,
      port: parseInt(port ?? "", 10),
      user: user ?? "",
      password: password ?? "",
      keyPath,
    });
    // Depend on primitives (host/port/user/password/keyPath) not the creds
    // object — mirrors useSecurityState.load()'s dependency discipline so a
    // new creds object identity per render does not re-fire the Stage-2 probe.
  }, [host, port, user, password, keyPath, checkSidecarForServer]);

  // ─── Local sidecar-version probe (the consolidated GitHub fetch) ─────────
  //
  // Phase 18 `useUpdateChecker.checkSidecarForServer` hits `check_sidecar_version`
  // whose SSH-probe step is fragile — on failure it silently keeps
  // `sidecarAvailable=false` forever, so neither the bottom-tab dot nor
  // Overview Card #8 arrow ever light up. This local probe pulls the GitHub
  // releases list via `useSidecarVersions`; combined with the lifted
  // `serverInfoVersion` it derives `localSidecarAvailable` — the source of
  // truth for the dot + arrow.
  const sshParamsForLocal = useMemo(
    () =>
      creds
        ? {
            host: creds.host,
            port: parseInt(creds.port, 10),
            user: creds.user,
            password: creds.password,
            keyPath: creds.keyPath,
          }
        : null,
    [creds],
  );

  // Phase 19-06 cascade fix — lifted from ServerPanel via
  // onServerInfoVersionChange callback. Single source of truth shared with
  // Card #8 text + ProtocolUpdateSection Badge + dropdown «(установлена)»
  // label. Replaces the parallel localInstalledVersion + probeLocalVersion
  // pair (see 19-DIAGNOSIS-card8-arrow.md §4 Option A for rationale).
  const [serverInfoVersion, setServerInfoVersion] = useState("");

  // E-10 (Plan 09-13): reset the lifted serverInfoVersion when creds become
  // null. handleDisconnect (useControlPanelOrchestrator) sets creds=null but
  // never cleared serverInfoVersion, so the «Сервис» pill dot + Card #8 arrow
  // stayed lit for the server the user had just LEFT (the stale comparison kept
  // returning "update available"). Keying the reset on `creds` (not only the
  // disconnect handler) also covers a HOST SWITCH — when the user connects to a
  // different server the old version is cleared until the new probe lands, so a
  // dot never bleeds across servers. Co-located here because this hook owns
  // serverInfoVersion (the single cascade source of truth, D-05).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset-on-prop-edge: serverInfoVersion is lifted state owned here that must be cleared when the creds PROP transitions to null (disconnect / host-switch). There is no render-time derivation available — the value is pushed in asynchronously via setServerInfoVersion from ServerPanel's onServerInfoVersionChange — so an effect keyed on `creds` is the correct reset seam (E-10).
    if (!creds) setServerInfoVersion("");
  }, [creds]);

  const { versions: githubReleasesCP } = useSidecarVersions(sshParamsForLocal);
  // E-17 (Plan 09-13): derive "latest" by semver-max via the shared
  // `latestSemver` helper, NOT `githubReleasesCP[0]` (GitHub PUBLISH order — a
  // hotfix for an older release can be published after a newer one, so [0] is
  // not reliably the highest version). `latestSemver` returns "" for an empty
  // list, matching the prior `?? ""` fallback.
  const latestFromGitHubCP = latestSemver(
    githubReleasesCP?.map((r) => r.version) ?? [],
  );
  const localSidecarAvailable =
    !!serverInfoVersion &&
    !!latestFromGitHubCP &&
    // Direction: shared compareSemver is ASCENDING. The former descending
    // compareSemverDescCP(serverInfo, latest) > 0 meant "serverInfo < latest"
    // (an update is available); the ascending equivalent is `< 0`.
    //
    // WR-04 (04-REVIEW.md): compareSemver drops the pre-release suffix (everything
    // after the first `-`), so a server running a pre-release of the latest version
    // (e.g. serverInfo="1.0.33-rc1", latest="1.0.33") compares EQUAL to the base
    // release → no update dot/arrow surfaces for that pre-release edge case. This is
    // intentional: the team accepts "pre-releases compare as their base version".
    // Do not file it as a bug.
    compareSemver(serverInfoVersion, latestFromGitHubCP) < 0;

  // Phase 19-06 cascade fix — after `update_sidecar` succeeds,
  // `ServiceTabSection.handleAppliedWithRefresh` calls
  // `state.loadServerInfo(true)` (0ms + 2.5s retry) which updates
  // `state.serverInfo.version` in useServerState. ServerPanel's
  // useEffect on `state.serverInfo?.version` then fires our
  // `onServerInfoVersionChange` callback which updates the lifted
  // `serverInfoVersion` here. No parallel probe needed — the same
  // refresh path that updates Card text now also drives every
  // cascade indicator (ArrowUpCircle, bottom-tab dot, ServerTabs dot).
  //
  // `checkSidecarForServer` is kept to refresh Phase 18 AboutPanel
  // slots (`updateInfo.sidecarLatestVersion` etc.) which feed
  // unrelated UI surfaces out of scope here.
  const handleSidecarUpdateApplied = useCallback(() => {
    if (!creds) return;
    const sshParams = {
      host: creds.host,
      port: parseInt(creds.port, 10),
      user: creds.user,
      password: creds.password,
      keyPath: creds.keyPath,
    };
    void checkSidecarForServer(sshParams);
    window.setTimeout(() => {
      void checkSidecarForServer(sshParams);
    }, 2500);
  }, [creds, checkSidecarForServer]);

  // Auto-dismiss точек когда пользователь зашёл на Service tab.
  // UX-логика: точку на bottom-tab «Панель управления» показываем один раз ЗА
  // СЕССИЮ — пользователь увидел, дошёл до Service tab → точку гасим (записываем
  // `tt_dismissed_update_<version>=true` в sessionStorage). UAT-2 / owner 6.8:
  // флаг per-launch, после рестарта приложения точка снова nudge'ит. Бейдж
  // «Доступно новое обновление» внутри карточки `ProtocolUpdateSection` НЕ
  // зависит от dismissed-флага и продолжает гореть пока не нажмут Install.
  // Dismiss key matches what `handleSidecarUpdateSeen` writes — use the
  // GitHub-derived latestFromGitHubCP (local probe), NOT the unreliable
  // useUpdateChecker.sidecarLatestVersion which may stay empty.
  const handleSidecarUpdateSeen = useCallback(() => {
    if (localSidecarAvailable && latestFromGitHubCP) {
      dismissSidecarUpdate(latestFromGitHubCP);
    }
  }, [localSidecarAvailable, latestFromGitHubCP, dismissSidecarUpdate]);

  // UAT-2 / owner 6.8: dismiss-флаг живёт в sessionStorage (per-launch nudge),
  // не в localStorage. Поэтому новый запуск приложения (свежая сессия) снова
  // показывает точку, пока обновление доступно. Внутри сессии visit-dismiss
  // (handleSidecarUpdateSeen → dismissSidecarUpdate) гасит точку как раньше.
  const localDismissed =
    !!latestFromGitHubCP &&
    typeof sessionStorage !== "undefined" &&
    sessionStorage.getItem(`tt_dismissed_update_${latestFromGitHubCP}`) === "true";
  const sidecarUpdateVisible = localSidecarAvailable && !localDismissed;
  useEffect(() => {
    if (onSidecarUpdateChange) onSidecarUpdateChange(sidecarUpdateVisible);
  }, [sidecarUpdateVisible, onSidecarUpdateChange]);

  return {
    serverInfoVersion,
    setServerInfoVersion,
    localSidecarAvailable,
    latestFromGitHubCP,
    sidecarUpdateVisible,
    handleSidecarUpdateApplied,
    handleSidecarUpdateSeen,
  };
}

export type SidecarUpdateCascade = ReturnType<typeof useSidecarUpdateCascade>;
