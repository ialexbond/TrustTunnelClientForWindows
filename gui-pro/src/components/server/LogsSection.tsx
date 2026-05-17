/**
 * LogsSection — Phase 17 Plan 05 Card preview (D-2.4 rewrite).
 *
 * Replaces old inline expand pattern with Card+Modal compound:
 *   — Card shows: icon + title + «Последнее обновление: HH:MM» (after first load)
 *     OR empty state text + 1-2 last lines preview in mono + «Открыть логи» button.
 *   — LogsViewerModal opened via button; Modal owns full fetch/search/download flow.
 *
 * T-03 invariant: LogsViewerModal is always in the tree — never conditional.
 * No early-return null before <LogsViewerModal>.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollText } from "lucide-react";
import { Card } from "../../shared/ui/Card";
import { Button } from "../../shared/ui/Button";
import { LogsViewerModal } from "./LogsViewerModal";
import type { ServerState } from "./useServerState";

// ─── Helper ───────────────────────────────────────────────────────────────────

function formatHHMM(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  state: ServerState;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function LogsSection({ state }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  const { serverLogs, sshParams } = state;

  // Preview: last 2 non-empty lines, each truncated to 80 chars
  const previewLines = serverLogs
    ? serverLogs
        .split("\n")
        .filter(Boolean)
        .slice(-2)
        .map((l) => l.slice(0, 80))
    : [];

  const handleClose = () => {
    setOpen(false);
    setLastUpdate(new Date());
  };

  return (
    <>
      <Card data-testid="logs-section-card">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <ScrollText
              className="w-5 h-5 shrink-0"
              style={{ color: "var(--color-accent-interactive)" }}
              aria-hidden="true"
            />
            <div className="flex-1 min-w-0">
              <h3 className="text-subtitle">{t("server.logs.card.title")}</h3>
              {lastUpdate ? (
                <>
                  <p
                    className="text-caption"
                    style={{ color: "var(--color-text-muted)" }}
                  >
                    {t("server.logs.card.last_update", {
                      time: formatHHMM(lastUpdate),
                    })}
                  </p>
                  {previewLines.length > 0 && (
                    <p
                      className="text-mono-sm truncate"
                      style={{ color: "var(--color-text-muted)" }}
                    >
                      {previewLines.join(" / ")}
                    </p>
                  )}
                </>
              ) : (
                <p
                  className="text-caption"
                  style={{ color: "var(--color-text-muted)" }}
                >
                  {t("server.logs.card.empty")}
                </p>
              )}
            </div>
          </div>
          <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
            {t("server.logs.card.open_button")}
          </Button>
        </div>
      </Card>

      {/* T-03: LogsViewerModal always in tree — never conditional */}
      <LogsViewerModal
        isOpen={open}
        onClose={handleClose}
        sshParams={sshParams}
        initialLogs={serverLogs || undefined}
      />
    </>
  );
}
