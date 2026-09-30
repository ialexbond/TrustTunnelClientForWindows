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
      // STATUS-03 / D-07: status is NO LONGER inferred from log text here. The backend (sidecar.rs)
      // emits the authoritative VpnStatus::Error event, so the error STATUS and its reason arrive
      // via the "vpn-status" listener (CORE_MESSAGE_I18N) — the single source of truth. This
      // listener only enriches the user-facing MESSAGE (setError) and appends the raw line to the
      // log buffer; it must never call setStatus (that would re-introduce a parallel status owner).
      //
      // G-03.1-7: only the auth and connection-refused markers stay here. The WinTUN adapter
      // failure (WintunCreateAdapter …) and «Failed to create listener» lines used to raise a
      // message from this listener, but the backend now retries an adapter failure by itself
      // (plan 03.1-10), so the same lines show up while «Подключение...» is still honestly in
      // progress — a message raised from the log would flash an error the retry is about to
      // fix. Their final reason arrives through vpn-status only, after the backend gives up.
      // The old «Failed to setup adapter … Timed out» branch is gone too: that line is not
      // printed anywhere in the core sources, so the branch could never fire.
      if (msg.includes("Authorization Required")) {
        setError(i18n.t("errors.auth_required", "Ошибка авторизации: логин или пароль неверны. Обновите конфиг с сервера через Панель управления."));
      } else if (msg.includes("Connection refused") || msg.includes("connection refused")) {
        setError(i18n.t("errors.connection_refused", "Сервер отклонил подключение. Проверьте, запущен ли VPN-сервис на сервере."));
      }
    });
    return () => { unlisten.then((f) => f()); };
    // setStatus intentionally absent: the vpn-log listener no longer sets status (STATUS-03 / D-07)
    // — it only sets the error message + log buffer.
  }, [i18n, setError, setVpnLogs]);
}
