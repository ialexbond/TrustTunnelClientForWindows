/**
 * UtilitiesTabSection — Phase 17 Plan 06 rewrite (D-4.3 canonical order).
 *
 * 5-block layout (per CONTROL-PANEL-SPEC.md §4.6):
 *   1. BBR Toggle Card         (D-4.2 — plain Card, no Modal)
 *   2. MTProto Card+Modal      (Plan 17-04 — Card preview + MtProtoModal trigger)
 *   3. Benchmark Card+Modal    (Plan 17-03 — Card preview + BenchmarkModal trigger)
 *   4. Logs Card+Modal         (Plan 17-05 — Card preview + LogsViewerModal trigger)
 *   5. Danger Zone Accordion   (D-4.3 — closed by default, DangerZoneSection inside)
 *
 * Service Controls Card REMOVED (B6/SSOT): Restart lives in OverviewSection «Сервер»
 * card per CONTROL-PANEL-SPEC.md §4.1 (Phase 17 D-3.1). W5 test-id anti-presence:
 * data-testid="overview-restart-service-button" MUST NOT appear here.
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

interface Props {
  state: ServerState;
}

export function UtilitiesTabSection({ state }: Props) {
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
              <h3 className="text-subtitle">{t("server.utilities.bbr.label")}</h3>
              <p className="text-caption" style={{ color: "var(--color-text-muted)" }}>
                {bbr.loading
                  ? t("server.utilities.bbr.detecting")
                  : t("server.utilities.bbr.description")}
              </p>
            </div>
          </div>
          {bbr.loading ? (
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
          ) : (
            <Toggle
              checked={bbr.enabled}
              onChange={() => void bbr.toggle()}
              aria-label={t("server.utilities.bbr.label")}
            />
          )}
        </div>
      </Card>

      {/* Block 2 — MTProto Card+Modal (Plan 17-04, D-4.1) */}
      <MtProtoSection state={mtproto} sshParams={sshParams} />

      {/* Block 3 — Benchmark Card+Modal (Plan 17-03) */}
      <BenchmarkSection sshParams={sshParams} />

      {/* Block 4 — Logs Card+Modal (Plan 17-05, D-2.4) */}
      <LogsSection state={state} />

      {/* Block 5 — Danger Zone Accordion (D-4.3: closed by default) */}
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
