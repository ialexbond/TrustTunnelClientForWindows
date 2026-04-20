/* eslint-disable react-refresh/only-export-components --
   entry file: mounts its own React root via ReactDOM.createRoot below.
   Fast-refresh doesn't apply to entry-point files. */
import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
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
  const [hasConfig, setHasConfig] = useState<boolean>(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Subscribe to vpn-status events + fetch initial state.
  useEffect(() => {
    void invoke<VpnStatus>("tray_menu_current_status").then((s) => {
      if (s) setStatus(s);
    });
    void invoke<string>("tray_menu_current_locale").then((l) => {
      if (l === "ru" || l === "en") setLocale(l);
    });
    void invoke<boolean>("tray_menu_has_config").then((b) => {
      setHasConfig(Boolean(b));
    });
    const unlistenStatus = listen<{ status: VpnStatus }>("vpn-status", (e) => {
      if (e.payload?.status) setStatus(e.payload.status);
    });
    return () => {
      void unlistenStatus.then((fn) => fn());
    };
  }, []);

  // Re-check config каждый раз когда окно получает focus (пользователь
  // мог импортировать config пока tray menu было hidden).
  useEffect(() => {
    const w = getCurrentWindow();
    const unlisten = w.listen("tauri://focus", () => {
      void invoke<boolean>("tray_menu_has_config").then((b) => {
        setHasConfig(Boolean(b));
      });
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  // Auto-size: замеряем card и просим Rust пересчитать position под
  // новый размер (anchor к правому или левому edge иконки). Re-measure
  // при изменении locale/status/hasConfig — labels меняют ширину,
  // items — count (меняется высота).
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const rafId = requestAnimationFrame(() => {
      const w = Math.ceil(el.offsetWidth);
      const h = Math.ceil(el.offsetHeight);
      if (w > 0 && h > 0) {
        void invoke("tray_menu_reposition", { width: w, height: h });
      }
    });
    return () => cancelAnimationFrame(rafId);
  }, [locale, status, hasConfig]);

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
          // Disable если нет config — нечего подключать. Показываем
          // пункт (не скрываем), чтобы пользователю было понятно что
          // tray-меню в принципе умеет подключать, но сейчас не может.
          disabled: !hasConfig,
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
      ref={rootRef}
      data-theme="dark"
      // inline-flex column → natural size (max child width + padding ×
      // sum children heights + gaps). Окно подстраивается через
      // useLayoutEffect → invoke tray_menu_reposition.
      //
      // Native Win11 rounded corners применяются к самому окну через
      // DwmSetWindowAttribute (см. tray::apply_win11_rounded_corners),
      // работают без transparent (который сломан в dark Win11 —
      // Tauri #13859). Card заполняет окно полностью — никакого gap'а
      // между card bg и rounded edge окна быть не может.
      style={{
        display: "inline-flex",
        flexDirection: "column",
        gap: 2,
        minWidth: 160,
        padding: 6,
        boxSizing: "border-box",
        background: "var(--color-bg-elevated)",
        border: "1px solid var(--color-border)",
        borderRadius: 8,
      }}
    >
      {items.map((item) => (
        <TrayMenuButton key={item.id} item={item} />
      ))}
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
