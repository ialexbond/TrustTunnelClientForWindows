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
          return event.payload.status;
        });
        if (event.payload.error) {
          setError(event.payload.error);
        }
        if (event.payload.status === "connected") {
          setConnectedSince(new Date());
          pushSuccess?.(i18n.t("messages.vpn_connected", "VPN connected"));
        } else if (event.payload.status === "disconnected") {
          setConnectedSince(null);
          pushSuccess?.(i18n.t("messages.vpn_disconnected", "VPN disconnected"));
        }
      },
    );
    return () => { unlistenStatus.then((f) => f()); };
  }, [setStatus, setError, setConnectedSince]);

  // ─── Auto-reconnect on internet loss ───
  useEffect(() => {
    const unlistenInternet = listen<{ online: boolean; action?: string }>(
      "internet-status",
      async (event) => {
        const { online, action } = event.payload;
        traceLog(`event: online=${online}, action=${action ?? "none"}`);

        if (!online && action === "disconnect") {
          traceLog("Internet lost — disconnecting VPN, waiting for adapter...");
          setStatus("recovering");
          setError(i18n.t("errors.internet_lost_disconnecting"));
          try {
            await invoke("vpn_disconnect");
            traceLog("VPN disconnected successfully");
          } catch (e) {
            traceLog(`Disconnect failed: ${e}`);
          }
        } else if (online && action === "reconnect") {
          traceLog("Adapter back online — reconnecting VPN");
          setError(i18n.t("messages.network_restored_reconnecting"));
          const savedPath = localStorage.getItem("tt_config_path");
          const savedLevel = localStorage.getItem("tt_log_level") || "info";
          if (savedPath) {
            try {
              setStatus("connecting");
              await invoke("vpn_connect", { configPath: savedPath, logLevel: savedLevel });
              traceLog("VPN reconnected successfully");
              setError(null);
            } catch (e) {
              traceLog(`Reconnect failed: ${e}`);
              setError(i18n.t("errors.reconnection_failed", { error: String(e) }));
              setStatus("error");
            }
          } else {
            traceLog("No saved config path — cannot reconnect");
          }
        } else if (!online && action === "give_up") {
          traceLog("Gave up waiting for network recovery");
          setError(i18n.t("errors.network_recovery_timeout"));
          setStatus("disconnected");
        }
      },
    );
    return () => { unlistenInternet.then((f) => f()); };
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
  }, []);

  // ─── VPN log collector + error detection ───
  useEffect(() => {
    const unlisten = listen<{ message: string; source: string }>("vpn-log", (event) => {
      const msg = event.payload.message.trim();
      if (!msg) return;
      const now = new Date();
      const ts = `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}`;
      const level = event.payload.source === "stderr" ? "error" : "info";
      setVpnLogs(prev => {
        const next = [...prev, { timestamp: ts, level, message: msg }];
        return next.length > 500 ? next.slice(-500) : next;
      });

      // ── Detect known errors and show user-friendly messages ──
      if (msg.includes("Authorization Required")) {
        setError(i18n.t("errors.auth_required", "Ошибка авторизации: логин или пароль неверны. Обновите конфиг с сервера через Панель управления."));
        setStatus("error");
      } else if (msg.includes("WintunCreateAdapter") && msg.includes("cannot find")) {
        setError(i18n.t("errors.wintun_missing", "Не удалось создать VPN-адаптер. Запустите приложение от имени администратора."));
        setStatus("error");
      } else if (msg.includes("Failed to create listener")) {
        setError(i18n.t("errors.listener_failed", "Не удалось запустить VPN-туннель. Проверьте права администратора и наличие wintun.dll."));
        setStatus("error");
      } else if (msg.includes("Connection refused") || msg.includes("connection refused")) {
        setError(i18n.t("errors.connection_refused", "Сервер отклонил подключение. Проверьте, запущен ли VPN-сервис на сервере."));
        setStatus("error");
      } else if (msg.includes("timed out") || msg.includes("Timed out")) {
        // Don't override status for non-fatal timeouts (like wintun device query)
        if (msg.includes("Failed to setup adapter")) {
          setError(i18n.t("errors.adapter_timeout", "Таймаут создания VPN-адаптера. Перезапустите приложение от имени администратора."));
          setStatus("error");
        }
      }
    });
    return () => { unlisten.then((f) => f()); };
  }, [i18n, setStatus, setError, setVpnLogs]);
}
