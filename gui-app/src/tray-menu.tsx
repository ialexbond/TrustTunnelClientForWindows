/* eslint-disable react-refresh/only-export-components --
   entry file: mounts its own React root via ReactDOM.createRoot below.
   Fast-refresh doesn't apply to entry-point files. */
import React, { useEffect, useState, useCallback } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./shared/styles/tokens.css";
import "./index.css";

/**
 * Кастомное контекстное меню трея — отдельное frameless-окно, рендерится
 * при правом клике на tray icon (см. lib.rs on_tray_icon_event Right →
 * position_and_show_tray_menu).
 *
 * Дизайн: rounded card с тонким бордером, без разделителей, иконка +
 * лейбл + accent при hover. Размер подгоняется по VPN-status (connect /
 * disconnect label меняется динамически).
 *
 * Window закрывается:
 *   - clicked item (после dispatch action)
 *   - window lost focus (blur event)
 *   - Escape
 */

type VpnStatus =
  | "connected"
  | "connecting"
  | "recovering"
  | "disconnecting"
  | "disconnected"
  | "error"
  | "unknown";

interface MenuItem {
  id: string;
  label: string;
  action: () => void;
  variant?: "default" | "danger";
  disabled?: boolean;
}

function hideSelf() {
  void getCurrentWindow().hide();
}

async function tray(action: string) {
  try {
    await invoke("tray_menu_action", { action });
  } finally {
    hideSelf();
  }
}

function TrayMenu() {
  const [status, setStatus] = useState<VpnStatus>("unknown");
  const [locale, setLocale] = useState<"ru" | "en">("ru");

  // Subscribe to vpn-status events + fetch initial state.
  useEffect(() => {
    void invoke<VpnStatus>("tray_menu_current_status").then((s) => {
      if (s) setStatus(s);
    });
    void invoke<string>("tray_menu_current_locale").then((l) => {
      if (l === "ru" || l === "en") setLocale(l);
    });
    const unlistenStatus = listen<{ status: VpnStatus }>("vpn-status", (e) => {
      if (e.payload?.status) setStatus(e.payload.status);
    });
    return () => {
      void unlistenStatus.then((fn) => fn());
    };
  }, []);

  // Auto-hide on blur или Escape.
  useEffect(() => {
    const w = getCurrentWindow();
    const unlistenBlur = w.listen("tauri://blur", () => {
      void w.hide();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        void w.hide();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      void unlistenBlur.then((fn) => fn());
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const ru = locale === "ru";
  const t = useCallback(
    (r: string, en: string) => (ru ? r : en),
    [ru],
  );

  const isConnected = status === "connected";
  const isBusy =
    status === "connecting" || status === "recovering" || status === "disconnecting";

  const items: MenuItem[] = [
    isConnected || isBusy
      ? {
          id: "disconnect",
          label: isBusy ? t("Отмена", "Cancel") : t("Отключиться", "Disconnect"),
          action: () => void tray("disconnect"),
        }
      : {
          id: "connect",
          label: t("Подключиться", "Connect"),
          action: () => void tray("connect"),
        },
    {
      id: "show",
      label: t("Показать окно", "Show window"),
      action: () => void tray("show"),
    },
    {
      id: "quit",
      label: t("Выход", "Quit"),
      action: () => void tray("quit"),
      variant: "danger",
    },
  ];

  return (
    <div
      data-theme="dark"
      // Root контейнер — прозрачный margin 8px (чтобы shadow не
      // обрезался windowом). Реальный визуал — card внутри.
      style={{
        padding: 6,
        height: "100vh",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          background: "var(--color-bg-elevated)",
          border: "1px solid var(--color-border)",
          borderRadius: 12,
          padding: 4,
          boxShadow: "0 10px 30px rgba(0,0,0,0.45)",
          display: "flex",
          flexDirection: "column",
          gap: 2,
        }}
      >
        {items.map((item) => (
          <TrayMenuButton key={item.id} item={item} />
        ))}
      </div>
    </div>
  );
}

function TrayMenuButton({ item }: { item: MenuItem }) {
  const [hover, setHover] = useState(false);
  const bg = hover
    ? item.variant === "danger"
      ? "var(--color-status-error-bg)"
      : "var(--color-bg-hover)"
    : "transparent";
  const color =
    item.variant === "danger"
      ? "var(--color-status-error)"
      : hover
        ? "var(--color-text-primary)"
        : "var(--color-text-secondary)";

  return (
    <button
      type="button"
      disabled={item.disabled}
      onClick={item.action}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 12px",
        borderRadius: 8,
        background: bg,
        color,
        border: "none",
        outline: "none",
        cursor: item.disabled ? "not-allowed" : "pointer",
        fontSize: 13,
        fontFamily: "inherit",
        textAlign: "left",
        transition: "background-color 120ms ease, color 120ms ease",
        opacity: item.disabled ? 0.4 : 1,
      }}
    >
      <span>{item.label}</span>
    </button>
  );
}

ReactDOM.createRoot(document.getElementById("tray-menu-root") as HTMLElement).render(
  <React.StrictMode>
    <TrayMenu />
  </React.StrictMode>,
);
