import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Tooltip } from "../../shared/ui/Tooltip";
import { usePointerContextLoss } from "../../shared/hooks/usePointerPresence";

// Graceful degradation: vitest не имеет Tauri runtime → getCurrentWindow()
// throws на module load, ломая WindowControls+TitleBar unit tests. Оборачиваем
// в try/catch; null-guard в handlers и useEffect предотвращает crash.
const appWindow = (() => {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
})();

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

  const handleMinimize = useCallback(() => appWindow?.minimize(), []);
  const handleClose = useCallback(() => appWindow?.close(), []);

  // Hiding the window to the tray moves no pointer, so `onMouseLeave` never fires and the button
  // stays lit — the highlight comes back with the window, over a webview the pointer has never
  // been in. This is the paired symptom of the stuck tooltip (G-32-16) and the owner reported both
  // together: «это не единственное место».
  //
  // The `tauri://blur` subscription that used to live here is gone. It covered the leaving edge
  // only, and it bound nothing at all under vitest (`appWindow` is null there), so the stuck
  // highlight was untestable and therefore untested. Its replacement, which expired the highlight on
  // a list of DOM events, shipped as build t3ykm8 and did not hold either — none of those events
  // arrives on this machine's close-to-tray path. `usePointerContextLoss` now leans on the gap
  // between two painted frames instead; see usePointerPresence.
  //
  // The second argument says «I currently have a button lit». It is load-bearing twice over: the
  // frame clock does not run at all unless someone is holding something on screen, and it is how an
  // expiry knows whether it took anything down and is therefore worth a line in the activity log.
  usePointerContextLoss(
    useCallback(() => setHovered(null), []),
    hovered !== null,
  );

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
