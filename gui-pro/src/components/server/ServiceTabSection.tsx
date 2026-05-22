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
}

export function ServiceTabSection({
  state,
  currentVersion,
  sidecarAvailable,
  latestVersion,
}: Props) {
  const { t } = useTranslation();
  const { sshParams, pushSuccess } = state;

  const bbr = useBbrState(sshParams, pushSuccess);
  const mtproto = useMtProtoState(sshParams, pushSuccess);

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
        currentVersion={currentVersion ?? "unknown"}
        sidecarAvailable={sidecarAvailable ?? false}
        latestVersion={latestVersion ?? ""}
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
