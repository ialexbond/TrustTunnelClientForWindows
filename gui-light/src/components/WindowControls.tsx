import { useState, useCallback, type CSSProperties } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Tooltip } from "../shared/ui/Tooltip";

const appWindow = getCurrentWindow();

/**
 * WindowControls (Light) — Min / Close, без Maximize.
 *
 * Окно Light-клиента фиксировано по форм-фактору (компактное), не должно
 * разворачиваться на fullscreen. Maximize заблокирован на уровне OS через
 * tauri.conf.json `maximizable: false`, а соответствующая кнопка удалена из UI.
 * Тултипы через shared Tooltip (portal, 400ms delay) вместо нативного `title=`.
 */
export function WindowControls() {
  const [hovered, setHovered] = useState<string | null>(null);

  const handleMinimize = useCallback(() => appWindow.minimize(), []);
  const handleClose = useCallback(() => appWindow.close(), []);

  return (
    <div className="flex items-center h-full" style={{ WebkitAppRegion: "no-drag" } as unknown as CSSProperties}>
      {/* Minimize */}
      <Tooltip text="Свернуть" position="bottom">
        <button
          className="window-control-btn"
          style={{
            background: hovered === "min" ? "rgba(255,255,255,0.08)" : "transparent",
          }}
          onMouseEnter={() => setHovered("min")}
          onMouseLeave={() => setHovered(null)}
          onClick={handleMinimize}
          aria-label="Свернуть"
        >
          <svg width="12" height="12" viewBox="0 0 12 12">
            <rect x="2" y="5.5" width="8" height="1" rx="0.5" fill="currentColor" />
          </svg>
        </button>
      </Tooltip>

      {/* Close */}
      <Tooltip text="Закрыть" position="bottom">
        <button
          className="window-control-btn window-control-close"
          style={{
            background: hovered === "close" ? "#e81123" : "transparent",
            color: hovered === "close" ? "#fff" : undefined,
          }}
          onMouseEnter={() => setHovered("close")}
          onMouseLeave={() => setHovered(null)}
          onClick={handleClose}
          aria-label="Закрыть"
        >
          <svg width="12" height="12" viewBox="0 0 12 12">
            <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>
      </Tooltip>
    </div>
  );
}
