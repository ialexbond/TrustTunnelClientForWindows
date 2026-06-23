/**
 * LogsSection — Phase 17 Plan 05 Card preview (D-2.4 rewrite).
 *
 * Replaces old inline expand pattern with Card+Modal compound:
 *   — Card shows: icon + title + «Последнее обновление: HH:MM DD.MM.YYYY»
 *     (after first load) OR empty state text + «Открыть логи» button.
 *   — LogsViewerModal opened via button; Modal owns full fetch/search/download flow.
 *
 * R4-F06: the card no longer renders a log-preview line (last journal row). Owner
 * wanted the card calm — only title, last-update timestamp and the open button.
 * R4-F07: the timestamp now uses the shared formatLastUpdated («HH:MM DD.MM.YYYY»)
 * so it matches «Проверка IP сервера» and other Service-tab cards.
 *
 * T-03 invariant: LogsViewerModal is always in the tree — never conditional.
 * No early-return null before <LogsViewerModal>.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollText } from "lucide-react";
import { Card } from "../../shared/ui/Card";
import { Button } from "../../shared/ui/Button";
import { formatLastUpdated } from "../../shared/utils/formatLastUpdated";
import { LogsViewerModal } from "./LogsViewerModal";
import type { ServerState } from "./useServerState";

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  state: ServerState;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function LogsSection({ state }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  // E-9 + E-20 fix: the card's preview and timestamp must reflect a REAL fetch.
  // The modal fetches into its own state and reports success back via
  // `onLogsFetched`; we store that text here (NOT state.serverLogs, which is
  // never written in production — that was the E-9 bug) and derive the preview
  // from it. `lastUpdate` is set ONLY from this callback, never on close (E-20).
  const [fetchedLogs, setFetchedLogs] = useState<string | null>(null);

  const { sshParams } = state;

  // R4-F06: the card no longer shows a log preview line. `fetchedLogs` is still
  // kept — it seeds the modal (`initialLogs`) so re-opening shows the last fetch
  // without re-querying — but it is no longer rendered on the card itself.

  // Real fetch-success callback (E-9 + E-20). D-29: `text` is the logs body and
  // stays in local UI state — it is never forwarded to the activity-log channel.
  const handleLogsFetched = (text: string, timestamp: Date) => {
    setFetchedLogs(text);
    setLastUpdate(timestamp);
  };

  const handleClose = () => {
    setOpen(false);
    // E-20: do NOT set lastUpdate here — it would fabricate "updated now" on
    // every close even when the fetch failed. The timestamp comes only from
    // handleLogsFetched (a real successful fetch).
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
                <p
                  className="text-caption"
                  style={{ color: "var(--color-text-muted)" }}
                >
                  {t("server.logs.card.last_update", {
                    time: formatLastUpdated(lastUpdate),
                  })}
                </p>
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
        initialLogs={fetchedLogs || undefined}
        onLogsFetched={handleLogsFetched}
      />
    </>
  );
}
