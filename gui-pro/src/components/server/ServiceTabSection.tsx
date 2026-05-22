/**
 * ServiceTabSection — Phase 19 Plan 19-04 rename (formerly UtilitiesTabSection).
 *
 * 5-block layout (per CONTROL-PANEL-SPEC.md §4.6 + UI-SPEC §Mount Location):
 *   1. BBR Toggle Card             (D-4.2 — plain Card, no Modal)
 *   2. MTProto Card+Modal          (Plan 17-04 — Card preview + MtProtoModal trigger)
 *   3. Benchmark Card+Modal        (Plan 17-03 — Card preview + BenchmarkModal trigger)
 *   4. ProtocolUpdateSection Card  (Phase 19 Plan 19-03 — dropdown + Install + Refresh)
 *   5. Logs Card+Modal             (Plan 17-05 — Card preview + LogsViewerModal trigger)
 *   6. Danger Zone Accordion       (D-4.3 — closed by default, DangerZoneSection inside)
 *
 * Service Controls Card REMOVED (B6/SSOT): Restart lives in OverviewSection «Сервер»
 * card per CONTROL-PANEL-SPEC.md §4.1 (Phase 17 D-3.1). W5 test-id anti-presence:
 * data-testid="overview-restart-service-button" MUST NOT appear here.
 *
 * Phase 19 rename:
 *   - File `UtilitiesTabSection.tsx` → `ServiceTabSection.tsx` (via `git mv`,
 *     preserves history per researcher §Open Decision §6).
 *   - Component export `UtilitiesTabSection` → `ServiceTabSection`.
 *   - i18n namespace `server.utilities.*` → `server.service.*` (Wave 1 Plan 19-02).
 *   - Tab id `"utilities"` → `"service"` (ServerTabId in shared/types.ts).
 *
 * Block 4 (ProtocolUpdateSection) requires `sidecarInfo` from
 * `useUpdateChecker(sshParams)` — passed down from `ControlPanelPage` via
 * `ServerPanel` → `ServerTabs`. When `sshParams` is unavailable (extremely rare —
 * worktree mount race), ProtocolUpdateSection still mounts but its internal
 * useSidecarVersions hook short-circuits (null params).
 */
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Zap, Loader2 } from "lucide-react";
import { Card } from "../../shared/ui/Card";
import { Toggle } from "../../shared/ui/Toggle";
import { Accordion } from "../../shared/ui/Accordion";
import type { ServerState } from "./useServerState";
import { useBbrState } from "./useBbrState";
import { useMtProtoState } from "./useMtProtoState";
import { MtProtoSection } from "./MtProtoSection";
import { BenchmarkSection } from "./BenchmarkSection";
import { LogsSection } from "./LogsSection";
import { DangerZoneSection } from "./DangerZoneSection";
import { ProtocolUpdateSection } from "./ProtocolUpdateSection";
import { useSidecarVersions } from "./useSidecarVersions";

/**
 * Compare semver-ish strings descending. Negative when `a` > `b`, positive
 * when `a` < `b`, zero when equal. Duplicated locally (same shape lives
 * inside `ProtocolUpdateSection`) so this file has no fragile cross-import
 * dependency on the dropdown component for a 4-line numeric comparison.
 */
function compareSemverDesc(a: string, b: string): number {
  const parts = (s: string): number[] =>
    s.replace(/^v/, "").split("-")[0].split(".").map((p) => parseInt(p, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return nb - na;
  }
  return 0;
}

interface Props {
  state: ServerState;
  /**
   * Sidecar version info from `useUpdateChecker(sshParams)` in `ControlPanelPage`
   * (Phase 19 cascade prop drill). All four fields needed for
   * `ProtocolUpdateSection` per its frozen `ProtocolUpdateSectionProps` contract
   * (Plan 19-03).
   *
   * `currentVersion` — `"unknown"` when protocol is not yet installed (State G).
   * `sidecarAvailable` — drives the «Доступно новое обновление» Badge + Card #8 ArrowUp.
   * `latestVersion` — top of `useSidecarVersions` dropdown when available.
   */
  currentVersion?: string;
  sidecarAvailable?: boolean;
  latestVersion?: string;
  /**
   * Phase 19 cascade fix — invoked by `ProtocolUpdateSection` after a
   * successful `update_sidecar`. `ControlPanelPage` then re-runs
   * `checkSidecarForServer({...})` so `sidecarCurrentVersion` reflects the
   * post-update value pulled via SSH.
   */
  onSidecarUpdateApplied?: () => void;
  /**
   * One-shot mount-time signal — fired on the first render of the Service tab
   * whenever a sidecar update is available, so the parent can dismiss the
   * bottom-tab «Панель управления» pill dot. Logic lives in
   * `ControlPanelPage.handleSidecarUpdateSeen` (writes
   * `tt_dismissed_update_<version>=true` via `dismissSidecarUpdate`). Badge
   * inside `ProtocolUpdateSection` is NOT affected (it ignores dismissed).
   */
  onSidecarUpdateSeen?: () => void;
}

export function ServiceTabSection({
  state,
  currentVersion: _propCurrentVersion,
  sidecarAvailable: _propSidecarAvailable,
  latestVersion: _propLatestVersion,
  onSidecarUpdateApplied,
  onSidecarUpdateSeen,
}: Props) {
  const { t } = useTranslation();
  const { sshParams, pushSuccess } = state;

  const bbr = useBbrState(sshParams, pushSuccess);
  const mtproto = useMtProtoState(sshParams, pushSuccess);

  // ─── Sidecar version — local source of truth ────────────────────────────
  //
  // The old wiring pulled `currentVersion / sidecarAvailable / latestVersion`
  // from `useUpdateChecker.checkSidecarForServer` via `ControlPanelPage` props.
  // That path was unreliable in production — when the SSH probe inside
  // `check_sidecar_version` failed or never completed, every consumer below
  // stayed pinned to the initial empty string. UI symptoms: bottomless
  // Skeleton, dropdown without «(установлена)» suffix, every option labelled
  // «(новая)» (because `compareSemverDesc(anything, "")` is always negative),
  // bare Install button.
  //
  // Switch: read the installed version straight from `state.serverInfo.version`
  // (already populated by `check_server_installation` — the same call that
  // drives Overview Card #8, which always works) and pull the GitHub releases
  // list locally via `useSidecarVersions(sshParams)`. Compute `available`
  // here too. Props from `ControlPanelPage` are kept on the interface for
  // backwards compatibility but ignored — the underscore prefix marks intent.
  const serverInfoVersion = state.serverInfo?.version ?? "";
  const { versions: githubReleases } = useSidecarVersions(sshParams);
  const latestFromGitHub = githubReleases[0]?.version ?? "";
  const computedCurrentVersion = serverInfoVersion || "unknown";
  const computedSidecarAvailable =
    !!serverInfoVersion &&
    !!latestFromGitHub &&
    compareSemverDesc(serverInfoVersion, latestFromGitHub) > 0;

  // One-shot signal к parent: пользователь добрался до Service tab и видит
  // карточку с Badge + dropdown. Bottom-tab pill dot на «Панель управления»
  // можно гасить (parent перевернёт `tt_dismissed_update_<version>=true`).
  // Fires только если есть available + valid latestVersion — иначе нечего
  // dismiss'ить. Re-fires при изменении latestVersion (новый release вышел).
  useEffect(() => {
    if (computedSidecarAvailable && latestFromGitHub) {
      onSidecarUpdateSeen?.();
    }
  }, [computedSidecarAvailable, latestFromGitHub, onSidecarUpdateSeen]);

  return (
    <div aria-live="polite" className="space-y-4">
      {/* Block 1 — BBR Toggle Card (D-4.2: single boolean switch, no Modal) */}
      <Card data-testid="bbr-card">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <Zap
              className="w-5 h-5 shrink-0"
              style={{ color: "var(--color-accent-interactive)" }}
              aria-hidden="true"
            />
            <div className="flex-1 min-w-0">
              <h3 className="text-subtitle">{t("server.service.bbr.label")}</h3>
              <p className="text-caption" style={{ color: "var(--color-text-muted)" }}>
                {bbr.loading
                  ? t("server.service.bbr.detecting")
                  : t("server.service.bbr.description")}
              </p>
            </div>
          </div>
          {bbr.loading ? (
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
          ) : (
            <Toggle
              checked={bbr.enabled}
              onChange={() => void bbr.toggle()}
              aria-label={t("server.service.bbr.label")}
            />
          )}
        </div>
      </Card>

      {/* Block 2 — MTProto Card+Modal (Plan 17-04, D-4.1) */}
      <MtProtoSection state={mtproto} sshParams={sshParams} />

      {/* Block 3 — Benchmark Card+Modal (Plan 17-03) */}
      <BenchmarkSection sshParams={sshParams} />

      {/* Block 4 — ProtocolUpdateSection (Phase 19 Plan 19-03 + 19-04 wire-up).
          Mounted between Benchmark and Logs per UI-SPEC §Mount Location.
          Falls back to empty/safe placeholders when cascade props are undefined
          (defensive — should not occur in production wiring). */}
      <ProtocolUpdateSection
        sshParams={sshParams}
        currentVersion={computedCurrentVersion}
        sidecarAvailable={computedSidecarAvailable}
        latestVersion={latestFromGitHub}
        onSidecarUpdateApplied={onSidecarUpdateApplied}
      />

      {/* Block 5 — Logs Card+Modal (Plan 17-05, D-2.4) */}
      <LogsSection state={state} />

      {/* Block 6 — Danger Zone Accordion (D-4.3: closed by default) */}
      <Accordion
        defaultOpen={[]}
        items={[
          {
            id: "danger-zone",
            title: (
              <span
                className="flex items-center gap-2 text-sm font-semibold"
                style={{ color: "var(--color-danger-500)" }}
              >
                <AlertTriangle className="w-3.5 h-3.5" />
                {t("server.danger.title")}
              </span>
            ),
            content: <DangerZoneSection state={state} />,
          },
        ]}
      />
    </div>
  );
}
