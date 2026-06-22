import { useTranslation } from "react-i18next";
import { ServerOff } from "lucide-react";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Button } from "../../shared/ui/Button";

interface ServerUnavailablePlateProps {
  onRetry: () => void;
}

/**
 * D-05 — the single, reusable "сервер недоступен" plate.
 *
 * WHY a full-tab plate (not greyed cards): when the managed server is
 * unreachable the per-tab metric cards are REMOVED for the duration, never
 * greyed-out. Greyed cards still read as live data ("работает" / a last-known
 * ping) and would lie about the connection. Replacing the whole tab body with
 * this plate invalidates that stale data outright (D-05/D-06).
 *
 * Consumed once at the `ServerTabs` `state.error` chokepoint, so every sub-tab
 * (Обзор / Пользователи / Конфигурация / Безопасность / Сервис) shows the SAME
 * plate. The icon stays muted (via EmptyState) for a calm "просто недоступен"
 * read rather than an alarming hard-error tone (UI-SPEC §D-05).
 */
export function ServerUnavailablePlate({ onRetry }: ServerUnavailablePlateProps) {
  const { t } = useTranslation();
  return (
    // max-w-md so the plate stays centered and does not stretch across the
    // 1000px-capped shell (UI-SPEC §D-05).
    <div className="max-w-md mx-auto">
      <EmptyState
        icon={<ServerOff className="w-8 h-8" />}
        heading={t("server.unavailable.heading")}
        body={t("server.unavailable.body")}
        action={
          <Button variant="primary" onClick={onRetry}>
            {t("server.unavailable.retry")}
          </Button>
        }
      />
    </div>
  );
}
