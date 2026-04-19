import { useState, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Tooltip } from "../../shared/ui/Tooltip";

const appWindow = getCurrentWindow();

/**
 * WindowControls — Min / Close (without Maximize).
 *
 * **Design constraint (Phase 13.UAT):** window resize allowed (tauri.conf.json
 * `resizable: true`), maximize disabled (`maximizable: false`). Desktop app UX
 * mirrors the pattern used by Amnezia VPN and other compact single-view apps —
 * window is resizable within reason but never takes over the whole screen.
 * Maximize button removed from the UI to match this OS-level constraint.
 *
 * **Tooltips:** wrapped in shared Tooltip component (custom React portal, 400ms
 * delay) instead of native `title=`. Native tooltips flickered / appeared at the
 * cursor — inconsistent with other buttons in the app. aria-label сохранён для
 * screen readers.
 */
export function WindowControls() {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState<string | null>(null);

  const handleMinimize = useCallback(() => appWindow.minimize(), []);
  const handleClose = useCallback(() => appWindow.close(), []);

  // Сбрасываем hover-state когда окно теряет фокус (например, tray-click
  // спрятал окно через `window.hide()`). React компонент не unmount'ится
  // при hide, поэтому `onMouseLeave` никогда не стреляет — кнопка остаётся
  // визуально подсвеченной до следующего mouseEnter. Слушаем Tauri blur,
  // resetим state → при следующем show-е кнопка в нейтральном состоянии.
  useEffect(() => {
    const unlisten = appWindow.listen("tauri://blur", () => {
      setHovered(null);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  return (
    <div className="flex items-center h-full" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
      {/* Minimize */}
      <Tooltip text={t("window.minimize", "Minimize")} position="bottom">
        <button
          className="window-control-btn"
          style={{
            background: hovered === "min" ? "var(--color-bg-hover)" : "transparent",
            color: "var(--color-text-secondary)",
            transition: "background-color var(--transition-fast) ease",
          }}
          onMouseEnter={() => setHovered("min")}
          onMouseLeave={() => setHovered(null)}
          onClick={handleMinimize}
          aria-label={t("window.minimize", "Minimize")}
        >
          <svg width="12" height="12" viewBox="0 0 12 12">
            <rect x="2" y="5.5" width="8" height="1" rx="0.5" fill="currentColor" />
          </svg>
        </button>
      </Tooltip>

      {/* Close */}
      <Tooltip text={t("window.close", "Close")} position="bottom">
        <button
          className="window-control-btn window-control-close"
          style={{
            background: hovered === "close" ? "var(--color-destructive)" : "transparent",
            color: hovered === "close" ? "var(--color-text-inverse)" : "var(--color-text-secondary)",
            transition: "background-color var(--transition-fast) ease, color var(--transition-fast) ease",
          }}
          onMouseEnter={() => setHovered("close")}
          onMouseLeave={() => setHovered(null)}
          onClick={handleClose}
          aria-label={t("window.close", "Close")}
        >
          <svg width="12" height="12" viewBox="0 0 12 12">
            <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>
      </Tooltip>
    </div>
  );
}
