import { useState, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const appWindow = getCurrentWindow();

export function WindowControls() {
  const [hovered, setHovered] = useState<string | null>(null);

  const handleMinimize = useCallback(() => appWindow.minimize(), []);
  const handleMaximize = useCallback(() => appWindow.toggleMaximize(), []);
  const handleClose = useCallback(() => appWindow.close(), []);

  return (
    <div className="flex items-center h-full" style={{ WebkitAppRegion: "no-drag" as never }}>
      {/* Minimize */}
      <button
        className="window-control-btn"
        style={{
          background: hovered === "min" ? "rgba(255,255,255,0.08)" : "transparent",
        }}
        onMouseEnter={() => setHovered("min")}
        onMouseLeave={() => setHovered(null)}
        onClick={handleMinimize}
        aria-label="Minimize"
      >
        <svg width="12" height="12" viewBox="0 0 12 12">
          <rect x="2" y="5.5" width="8" height="1" rx="0.5" fill="currentColor" />
        </svg>
      </button>

      {/* Maximize */}
      <button
        className="window-control-btn"
        style={{
          background: hovered === "max" ? "rgba(255,255,255,0.08)" : "transparent",
        }}
        onMouseEnter={() => setHovered("max")}
        onMouseLeave={() => setHovered(null)}
        onClick={handleMaximize}
        aria-label="Maximize"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <rect x="2.5" y="2.5" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>

      {/* Close */}
      <button
        className="window-control-btn window-control-close"
        style={{
          background: hovered === "close" ? "#e81123" : "transparent",
          color: hovered === "close" ? "#fff" : undefined,
        }}
        onMouseEnter={() => setHovered("close")}
        onMouseLeave={() => setHovered(null)}
        onClick={handleClose}
        aria-label="Close"
      >
        <svg width="12" height="12" viewBox="0 0 12 12">
          <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
