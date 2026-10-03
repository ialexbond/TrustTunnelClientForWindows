import { useTranslation } from "react-i18next";
import { ServerOff } from "lucide-react";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Button } from "../../shared/ui/Button";

interface ServerUnavailablePlateProps {
  onRetry: () => void;
  /**
   * R-5: when provided, the plate shows BOTH actions in ONE row of equal width —
   * «Отключиться от сервера» (secondary, LEFT) + «Повторить» (primary, RIGHT). The
   * full-tab stub (ServerPanel) passes this; the per-sub-tab stub (ServerTabs) omits it
   * and gets just the centered «Повторить».
   */
  onDisconnect?: () => void;
  /** Label for the disconnect button (defaults to «Отключиться от сервера»). */
  disconnectLabel?: string;
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
 * R-5: the «Повторить» and «Отключиться от сервера» actions used to sit in two
 * different places at two different sizes (Повторить inside the plate, Отключиться
 * as a separate small ghost button below). They now render in ONE row, equal
 * width, «Отключиться» left / «Повторить» right, when `onDisconnect` is supplied.
 */
export function ServerUnavailablePlate({
  onRetry,
  onDisconnect,
  disconnectLabel,
}: ServerUnavailablePlateProps) {
  const { t } = useTranslation();
  return (
    // max-w-md so the plate stays centered and does not stretch across the
    // 1000px-capped shell (UI-SPEC §D-05).
    <div className="max-w-md mx-auto">
      <EmptyState
        icon={<ServerOff className="w-8 h-8" />}
        heading={t("server.unavailable.heading")}
        body={t("server.unavailable.body")}
      />
      {onDisconnect ? (
        // Two equal-width halves (grid-cols-2): «Отключиться» LEFT (secondary),
        // «Повторить» RIGHT (primary). Both `fullWidth` fill their half → equal size.
        <div className="grid grid-cols-2 gap-2 w-full">
          <Button variant="secondary" fullWidth onClick={onDisconnect}>
            {disconnectLabel ?? t("control.disconnect")}
          </Button>
          <Button variant="primary" fullWidth onClick={onRetry}>
            {t("server.unavailable.retry")}
          </Button>
        </div>
      ) : (
        <div className="flex justify-center">
          <Button variant="primary" onClick={onRetry}>
            {t("server.unavailable.retry")}
          </Button>
        </div>
      )}
    </div>
  );
}
