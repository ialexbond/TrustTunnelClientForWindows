import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import type { LogEntry } from "../types";
import type { i18n as I18nType } from "i18next";

// Phase 17 (17-05, CA-1) — the `vpn-log` collector + error-detection listener, split out of
// useVpnEvents. It appends every sidecar log line to the Log Panel buffer (capped 500), mirrors
// it to the DevTools console in DEV builds only (D-08/D-11), and enriches the user-facing MESSAGE
// for known fatal markers. It must NEVER set status (STATUS-03 / D-07): the error STATUS arrives
// via the vpn-status listener, the single status owner.

interface UseVpnLogListenerParams {
  i18n: I18nType;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setVpnLogs: React.Dispatch<React.SetStateAction<LogEntry[]>>;
}

export function useVpnLogListener({
  i18n,
  setError,
  setVpnLogs,
}: UseVpnLogListenerParams) {
  useEffect(() => {
    const unlisten = listen<{ message: string; level?: string }>("vpn-log", (event) => {
      const msg = event.payload.message.trim();
      if (!msg) return;
      const now = new Date();
      const ts = `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}`;
      // WR-04: the backend emits `{ message, level }` (level computed by parse_log_level in
      // sidecar.rs) — there is NO `source` field. Read the field the backend actually sends so
      // error log lines colour correctly.
      const level = event.payload.level ?? "info";
      setVpnLogs(prev => {
        const next = [...prev, { timestamp: ts, level, message: msg }];
        return next.length > 500 ? next.slice(-500) : next;
      });

      // ── DEV-only F12 console mirror (D-08 / D-11) ──
      //
      // D-08: stream every `vpn-log` line to the browser DevTools (F12) console so the user can
      // watch the connection live and paste the logs straight back. D-11 (user decision
      // 2026-06-04): the F12 mirror is a DEV-BUILD-ONLY aid — gate it behind `import.meta.env.DEV`
      // so a production/release build NEVER streams the verbose `vpn-log` channel to `console`.
      // The trace-log append above + setError below run in ALL builds; ONLY this console mirror is
      // dev-gated.
      if (import.meta.env.DEV) {
        const mirror =
          level === "error" ? console.error
          : level === "warn" ? console.warn
          // eslint-disable-next-line no-console -- DEV-only F12 mirror (D-08/D-11); gated off in release
          : console.log;
        mirror(`[vpn] ${msg}`);
      }

      // ── Detect known errors and show user-friendly messages ──
      //
      // STATUS-03 / D-07: status is NO LONGER inferred from log text here. The backend (sidecar.rs,
      // plan 01-01) emits an authoritative VpnStatus::Error event for these same 4 fatal markers, so
      // the error STATUS arrives via the "vpn-status" listener — the single source of truth. This
      // listener only enriches the user-facing MESSAGE (setError) and appends the raw line to the
      // log buffer; it must never call setStatus (that would re-introduce a parallel status owner).
      if (msg.includes("Authorization Required")) {
        setError(i18n.t("errors.auth_required", "Ошибка авторизации: логин или пароль неверны. Обновите конфиг с сервера через Панель управления."));
      } else if (msg.includes("WintunCreateAdapter") && msg.includes("cannot find")) {
        setError(i18n.t("errors.wintun_missing", "Не удалось создать VPN-адаптер. Запустите приложение от имени администратора."));
      } else if (msg.includes("Failed to create listener")) {
        setError(i18n.t("errors.listener_failed", "Не удалось запустить VPN-туннель. Проверьте права администратора и наличие wintun.dll."));
      } else if (msg.includes("Connection refused") || msg.includes("connection refused")) {
        setError(i18n.t("errors.connection_refused", "Сервер отклонил подключение. Проверьте, запущен ли VPN-сервис на сервере."));
      } else if (msg.includes("timed out") || msg.includes("Timed out")) {
        // Show a hint for the fatal adapter-setup timeout, but (like the markers above) do NOT set
        // status — the backend owns that now.
        if (msg.includes("Failed to setup adapter")) {
          setError(i18n.t("errors.adapter_timeout", "Таймаут создания VPN-адаптера. Перезапустите приложение от имени администратора."));
        }
      }
    });
    return () => { unlisten.then((f) => f()); };
    // setStatus intentionally absent: the vpn-log listener no longer sets status (STATUS-03 / D-07)
    // — it only sets the error message + log buffer.
  }, [i18n, setError, setVpnLogs]);
}
