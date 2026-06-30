import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Clock, Power } from "lucide-react";
import type { VpnStatus, ReconnectProgress } from "../shared/types";
import { Button } from "../shared/ui/Button";
import { StatusBadge } from "../shared/ui/StatusBadge";
import { ErrorBanner } from "../shared/ui/ErrorBanner";
import { formatUptime } from "../shared/utils/uptime";
import { statusBadgeVariant } from "../shared/lib/statusBadgeVariant";

interface StatusPanelProps {
  status: VpnStatus;
  error: string | null;
  connectedSince: Date | null;
  onConnect: () => void;
  onDisconnect: () => void;
  // 02-20: per-attempt «Попытка N/N» progress, present only during a server-lost
  // `reconnecting` retry (the backend attaches attempt/max to that vpn-status event).
  // null whenever no counter is live.
  reconnectProgress?: ReconnectProgress | null;
}

function UptimeCounter({ since }: { since: Date }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);
  return <span>{formatUptime(since)}</span>;
}

// statusBadgeVariant moved to shared/lib/statusBadgeVariant.ts (imported above) so the
// Phase-11 ConfigCard lead card reuses the EXACT SAME mapping without StatusPanel having to
// export a non-component (which would break react-refresh). The colour logic is unchanged.

function StatusPanel({
  status,
  error,
  connectedSince,
  onConnect,
  onDisconnect,
  reconnectProgress = null,
}: StatusPanelProps) {
  const { t } = useTranslation();
  const [errorDismissed, setErrorDismissed] = useState(false);

  useEffect(() => {
    // F2: reset the dismissal when the error MESSAGE changes, NOT on every status tick.
    // Keying on [status] re-showed a banner the user had just dismissed on the very next
    // status event (e.g. a reconnecting tick) — clear_vpn_error no-ops while the live
    // status isn't Error, so the message stayed non-null and the banner popped back (the
    // "крестик не закрывает ошибку" bug). Keying on [error] keeps a dismiss sticky until
    // a genuinely NEW message arrives.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a new error message must reset the dismissal so the new banner renders on the same frame
    setErrorDismissed(false);
  }, [error]);

  // 02-09 (UAT Gap #3): dismissing the error banner must clear it in ALL windows, not
  // just this one. We invoke the backend `clear_vpn_error` command — it routes the
  // clear through the single status writer, which fans a `vpn-status` (disconnected /
  // null) event out to every window AND wipes the snapshot, so the error can no longer
  // linger on another window or re-surface on the next mount. The local
  // `setErrorDismissed(true)` is kept ONLY as an optimistic hide for THIS frame; the
  // IPC call is the source of truth (a local-only dismiss path is intentionally gone).
  const handleDismiss = () => {
    setErrorDismissed(true); // optimistic local hide
    void invoke("clear_vpn_error").catch(() => {
      // Backend unavailable (should not happen in-app) — the optimistic hide above
      // already removed the banner locally; the next vpn-status event reconciles state.
    });
  };

  // F2: a LOCAL-only dismiss for the recovering/reconnecting banner. The backend
  // `clear_vpn_error` deliberately no-ops while the live status isn't Error (the system
  // message self-clears on the next transition), so calling it there would be a dead
  // affordance. A local hide lets the user close the banner; a genuinely NEW error
  // message re-shows it (errorDismissed resets on [error]). This replaces the old
  // behavior where these states showed NO X at all — the user reported wanting to close it.
  const handleDismissLocal = () => {
    setErrorDismissed(true);
  };

  const isConnected = status === "connected";

  const statusLabel = isConnected
    ? t("status.connected")
    : status === "connecting"
      ? t("status.connecting_short")
      : status === "reconnecting"
        ? t("status.reconnecting_short")
        : status === "disconnecting"
          ? t("status.disconnecting_short")
          : status === "recovering"
            ? t("status.recovering_short")
            : status === "error"
              ? t("status.error")
              : t("status.disconnected");

  // 02-20: a descriptive sub-text under the badge clarifies what the app is doing.
  // - recovering (local net gone): «Соединение с интернетом потеряно. Восстановление…»
  //
  // WR-01: the «Связь с сервером потеряна» line is NO LONGER shown here. It now lives
  // SOLELY in the error BANNER (useVpnEvents sets errors.server_connection_lost on a
  // `tunnel-lost` drop). Rendering it both here and in the banner produced two copies
  // of the same sentence on screen during a server-lost retry. The StatusPanel
  // sub-text for a `reconnecting` retry is now JUST the «Попытка N/N» counter (rendered
  // separately below); the headline + banner carry the "what happened" message.
  const statusDetail =
    status === "recovering" ? t("status.recovering_detail") : null;

  return (
    <div
      className="border-b border-[var(--color-border)]"
      style={{ boxShadow: "var(--shadow-sm)" }}
    >
      <div className="px-[var(--space-4)] flex items-center justify-between min-h-[52px] py-[var(--space-1)]">
        <div className="flex items-center gap-[var(--space-3)] min-w-0">
          <StatusBadge variant={statusBadgeVariant(status)} label={statusLabel} />

          {isConnected && connectedSince && (
            <div className="flex items-center gap-[var(--space-1)] text-xs font-mono tabular-nums text-[var(--color-text-muted)]">
              <Clock className="w-3.5 h-3.5" aria-hidden="true" />
              <UptimeCounter since={connectedSince} />
            </div>
          )}

          {/* 02-20: descriptive sub-text + «Попытка N/N» counter (recovering /
              server-lost reconnecting). Truncates so a long line never pushes the
              toggle button off the row. */}
          {(statusDetail || reconnectProgress) && (
            <div className="flex flex-col min-w-0 text-xs leading-tight text-[var(--color-text-muted)]">
              {statusDetail && <span className="truncate">{statusDetail}</span>}
              {status === "reconnecting" && reconnectProgress && (
                <span className="tabular-nums">
                  {t("status.reconnect_attempt", {
                    attempt: reconnectProgress.attempt,
                    max: reconnectProgress.max,
                  })}
                </span>
              )}
            </div>
          )}
        </div>

        <div className="shrink-0">
          {status === "connected" && (
            <Button variant="danger" size="sm" onClick={onDisconnect} aria-label={t("buttons.disconnect")}>
              <Power className="w-3.5 h-3.5" />
              {t("buttons.disconnect")}
            </Button>
          )}
          {/* 02-20 SPEC §4: «Отмена» (ENABLED) during every actively-trying state so the
              user can abort the wait/retry. The action is the same disconnect/cancel
              handler — stopping a connecting, reconnecting, OR recovering attempt tears
              the (re)connect down. */}
          {(status === "connecting" || status === "reconnecting" || status === "recovering") && (
            <Button variant="ghost" size="sm" onClick={onDisconnect}>
              <Power className="w-3.5 h-3.5" />
              {t("buttons.cancel")}
            </Button>
          )}
          {/* Only the in-flight teardown («Отключение») is non-cancelable. */}
          {status === "disconnecting" && (
            <Button variant="ghost" size="sm" disabled loading>
              {statusLabel}
            </Button>
          )}
          {(status === "error" || status === "disconnected") && (
            <Button variant="ghost" size="sm" onClick={onConnect}>
              {t("buttons.connect")}
            </Button>
          )}
        </div>
      </div>

      {error && !errorDismissed && (
        <ErrorBanner
          variant="error"
          message={error}
          // F2: offer the dismiss (X) in EVERY banner state. `status === "error"` is the
          // authoritative dismiss (routes through `clear_vpn_error` so it clears across
          // windows + the snapshot). `recovering`/`reconnecting` carry a system message
          // that `clear_vpn_error` would no-op on, so they get a LOCAL-only hide — the
          // user can still close the banner (previously these showed NO X, which the user
          // reported as "крестик не закрывает"), and a genuinely new message re-shows it.
          onDismiss={
            status === "error"
              ? handleDismiss
              : status === "recovering" || status === "reconnecting"
                ? handleDismissLocal
                : undefined
          }
          className="mx-[var(--space-4)] mb-[var(--space-2)]"
        />
      )}
    </div>
  );
}

export default StatusPanel;
