import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { VpnStatus, LogEntry } from "../types";
import type { i18n as I18nType } from "i18next";

interface UseVpnEventsParams {
  i18n: I18nType;
  setStatus: React.Dispatch<React.SetStateAction<VpnStatus>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setConnectedSince: React.Dispatch<React.SetStateAction<Date | null>>;
  setVpnLogs: React.Dispatch<React.SetStateAction<LogEntry[]>>;
  reconnectResolve: React.MutableRefObject<(() => void) | null>;
  pushSuccess?: (msg: string, type?: "success" | "error") => void;
}

export function useVpnEvents({
  i18n,
  setStatus,
  setError,
  setConnectedSince,
  setVpnLogs,
  reconnectResolve,
  pushSuccess,
}: UseVpnEventsParams) {
  // ─── Helper: map a stable backend reason CODE to a localized display string ───
  //
  // The backend (Light's connect-timeout watchdog + reconnect supervisor, Plan
  // 02-06) sets the Error with a STABLE ASCII reason code — never a user-facing
  // string (CLAUDE.md i18n rule + D-29). We localize it HERE so the user sees the
  // Russian (primary) / English (mirror) message, never the raw `connect-timeout` /
  // `reconnect-gave-up` code. Any error that is NOT a known reason code passes
  // through unchanged (older sanitized backend messages still render verbatim).
  // Mirror of Pro's REASON_CODE_I18N seam.
  const REASON_CODE_I18N: Record<string, string> = {
    "connect-timeout": "errors.connect_timeout",
    "reconnect-gave-up": "errors.reconnect_gave_up",
  };
  const localizeError = (error: string | null | undefined): string | null => {
    if (!error) return error ?? null;
    const key = REASON_CODE_I18N[error];
    return key ? i18n.t(key) : error;
  };
  // ─── Helper: write trace log visible in Log Panel ───
  const traceLog = (msg: string) => {
    const now = new Date();
    const ts = `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}`;
    setVpnLogs(prev => {
      const next = [...prev, { timestamp: ts, level: "info", message: `[connectivity] ${msg}` }];
      return next.length > 500 ? next.slice(-500) : next;
    });
  };
  // ─── VPN status sync on mount ───
  useEffect(() => {
    invoke<string>("check_vpn_status").then((backendStatus) => {
      if (backendStatus === "connected") {
        setStatus("connected");
        setConnectedSince((prev) => prev ?? new Date());
      } else if (backendStatus === "connecting") {
        setStatus("connecting");
        setConnectedSince(null);
      } else {
        setStatus("disconnected");
        setConnectedSince(null);
      }
    }).catch(() => {});
  }, [setStatus, setConnectedSince]);

  // ─── VPN status event listener ───
  useEffect(() => {
    const unlistenStatus = listen<{ status: VpnStatus; error?: string }>(
      "vpn-status",
      (event) => {
        traceLog(`vpn-status: ${event.payload.status}${event.payload.error ? ` error=${event.payload.error}` : ""}`);
        setStatus((prev) => {
          if (prev === "recovering" && event.payload.status === "disconnected") {
            return prev;
          }

          // Show appropriate snackbar based on transition
          if (event.payload.status === "connected") {
            setConnectedSince(new Date());
            // WR-01 (mirror of Pro): clear any prior recovery/error message on a
            // successful (re)connect. The internet-status listener sets
            // setError(...) when connectivity drops, but a Rust-driven
            // auto-reconnect recovers the session via this vpn-status "connected"
            // event WITHOUT going through handleConnect (the only other path that
            // cleared the error). Without this, the stale red "internet lost"
            // banner lingers over the green Connected badge after recovery.
            setError(null);
            pushSuccess?.(i18n.t("messages.vpn_connected", "VPN connected"));
          } else if (event.payload.status === "disconnected") {
            setConnectedSince(null);
            if (prev === "connecting") {
              // Was trying to connect → connection failed
              pushSuccess?.(
                event.payload.error || i18n.t("errors.connection_failed", "Connection failed"),
                "error"
              );
            } else if (prev === "connected" && !reconnectResolve.current) {
              // Was connected → normal disconnect (not part of reconnect)
              pushSuccess?.(i18n.t("messages.vpn_disconnected", "VPN disconnected"));
            }
          }

          return event.payload.status;
        });
        if (event.payload.error) {
          // Localize a stable reason code (e.g. `connect-timeout`,
          // `reconnect-gave-up`) to a friendly message; non-code errors pass
          // through unchanged (CLAUDE.md i18n rule + D-29).
          setError(localizeError(event.payload.error));
        }
      },
    );
    return () => { unlistenStatus.then((f) => f()); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setStatus, setError, setConnectedSince]);

  // ─── Internet-status display (reconnect is now DRIVEN IN RUST) ───
  //
  // STATUS-05 / D-01 (Plan 02-06): the window-independent Rust reconnect supervisor
  // (lib.rs `start_reconnect_supervisor`) is now the SOLE owner of auto-reconnect —
  // triggered by BOTH a sidecar process exit (sidecar.rs Terminated arm) AND a
  // live-sidecar connectivity loss (connectivity.rs monitor). The old
  // `action === "reconnect"` branch here used to drive reconnect from a MOUNTED React
  // effect that invoked vpn_connect with a localStorage path, so recovery only fired
  // while this window was open. It is DELETED in the same plan the Rust supervisor
  // lands so there is never a double-reconnect window. We also no longer call
  // vpn_disconnect on the `disconnect` signal — the supervisor takes over recovery and
  // a frontend disconnect would fight it. This effect now only DISPLAYS status.
  useEffect(() => {
    const unlistenInternet = listen<{ online: boolean; action?: string }>(
      "internet-status",
      async (event) => {
        const { online, action } = event.payload;
        traceLog(`event: online=${online}, action=${action ?? "none"}`);

        if (!online && action === "disconnect") {
          // Connectivity dropped — show the recovering label. Rust drives the real
          // status via the vpn-status event; we no longer invoke vpn_disconnect here.
          traceLog("Internet lost — Rust supervisor is recovering the connection...");
          setStatus("recovering");
          setError(i18n.t("errors.internet_lost_disconnecting"));
        } else if (!online && action === "give_up") {
          traceLog("Gave up waiting for network recovery");
          setError(i18n.t("errors.network_recovery_timeout"));
          setStatus("disconnected");
        }
        // The `reconnect` action is intentionally NOT handled here anymore — Rust owns
        // reconnect. The backend's terminal outcome (recovered / reconnect-gave-up
        // Error) arrives via the vpn-status listener above.
      },
    );
    return () => { unlistenInternet.then((f) => f()); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i18n, setStatus, setError]);

  // ─── Listen for disconnect confirmation to complete reconnect ───
  useEffect(() => {
    const unlisten = listen<{ status: VpnStatus }>("vpn-status", (event) => {
      if (event.payload.status === "disconnected" && reconnectResolve.current) {
        const resolve = reconnectResolve.current;
        reconnectResolve.current = null;
        resolve();
      }
    });
    return () => { unlisten.then((f) => f()); };
  }, [reconnectResolve]);

  // ─── Conflicting VPN adapter warning (log only, non-blocking) ───
  useEffect(() => {
    const unlisten = listen<{ adapters: string[]; message: string }>(
      "vpn-adapter-conflict",
      (event) => {
        const { adapters } = event.payload;
        traceLog(`WARNING: Conflicting adapters detected: ${adapters.join(", ")}. If connection fails, disable them.`);
      },
    );
    return () => { unlisten.then((f) => f()); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── VPN log collector + error detection ───
  useEffect(() => {
    const unlisten = listen<{ message: string; level?: string }>("vpn-log", (event) => {
      const msg = event.payload.message.trim();
      if (!msg) return;
      const now = new Date();
      const ts = `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}`;
      // The backend emits `{ message, level }` (level computed by parse_log_level in
      // sidecar.rs) — there is NO `source` field. Read the field the backend actually
      // sends so error log lines colour correctly.
      const level = event.payload.level ?? "info";
      setVpnLogs(prev => {
        const next = [...prev, { timestamp: ts, level, message: msg }];
        return next.length > 500 ? next.slice(-500) : next;
      });

      // ── DEV-only F12 console mirror (D-08 / D-11) ──
      //
      // D-08: stream every `vpn-log` line to the browser DevTools (F12) console so
      // the user can watch the connection live and paste the logs straight back.
      // D-11: the mirror is a DEV-BUILD-ONLY aid — gated behind `import.meta.env.DEV`
      // so a release build NEVER streams the verbose channel to `console`. The
      // trace-log append above + setError below run in ALL builds; ONLY this mirror is
      // dev-gated. Mirror of Pro's useVpnEvents.
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
      // STATUS-03 / D-07 (CR-04): status is NO LONGER inferred from log text here.
      // The backend (sidecar.rs `handle_fatal_markers`) now emits an authoritative
      // `error` status event for these same fatal markers, so the error STATUS
      // arrives via the "vpn-status" listener above — the single source of truth
      // (Rust → event → frontend). This listener only enriches the user-facing
      // MESSAGE (setError) and appends the raw line to the log buffer; it must
      // never call setStatus, which would re-introduce a parallel status owner and
      // make the status race-prone / order-dependent. Mirror of Pro's useVpnEvents.
      if (msg.includes("Authorization Required")) {
        setError(i18n.t("errors.auth_required", "Ошибка авторизации: логин или пароль неверны. Обновите конфиг с сервера через Панель управления."));
      } else if (msg.includes("WintunCreateAdapter") && msg.includes("cannot find")) {
        setError(i18n.t("errors.wintun_missing", "Не удалось создать VPN-адаптер. Запустите приложение от имени администратора."));
      } else if (msg.includes("Failed to create listener")) {
        setError(i18n.t("errors.listener_failed", "Не удалось запустить VPN-туннель. Проверьте права администратора и наличие wintun.dll."));
      } else if (msg.includes("Connection refused") || msg.includes("connection refused")) {
        setError(i18n.t("errors.connection_refused", "Сервер отклонил подключение. Проверьте, запущен ли VPN-сервис на сервере."));
      } else if (msg.includes("timed out") || msg.includes("Timed out")) {
        // Show a hint for the fatal adapter-setup timeout, but (like the markers
        // above) do NOT set status — the backend owns that now.
        if (msg.includes("Failed to setup adapter")) {
          setError(i18n.t("errors.adapter_timeout", "Таймаут создания VPN-адаптера. Перезапустите приложение от имени администратора."));
        }
      }
    });
    return () => { unlisten.then((f) => f()); };
    // setStatus intentionally absent: the vpn-log listener no longer sets status
    // (STATUS-03 / D-07 / CR-04) — it only sets the error message + log buffer.
  }, [i18n, setError, setVpnLogs]);
}
