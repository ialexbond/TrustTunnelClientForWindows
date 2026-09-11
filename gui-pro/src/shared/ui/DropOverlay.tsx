import { useTranslation } from "react-i18next";
import { cn } from "../lib/cn";

interface DropOverlayProps {
  isDragging: boolean;
  /**
   * Optional context-specific overlay copy. Defaults to the global drop i18n
   * («Перетащите файл сюда» + the .toml/.json dual-format hint used app-wide for
   * the window-level drop). A surface that accepts ONLY a config — the config
   * import modal — passes a TOML-only hint here (no routing .json).
   */
  text?: string;
  hint?: string;
}

export function DropOverlay({ isDragging, text, hint }: DropOverlayProps) {
  const { t } = useTranslation();

  if (!isDragging) return null;

  return (
    <div
      className={cn(
        "fixed inset-0 flex items-center justify-center",
      )}
      style={{
        zIndex: "var(--z-modal)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        backgroundColor: "var(--color-glass-bg)",
        // WR-05 (10.1 review): removed a dead `transition: opacity` — the overlay
        // mounts/unmounts on isDragging (returns null when not dragging), so opacity
        // never animates and the declaration was misleading. (No fade is shown today;
        // a real fade would require keeping it mounted and animating — deferred.)
        pointerEvents: "none",
      }}
    >
      <div
        className={cn(
          "flex flex-col items-center gap-3",
          "text-lg",
          "font-semibold",
        )}
        style={{
          // Theme-aware, NOT hardcoded text-white. The glass backdrop is a
          // translucent tint of the theme bg (dark rgba in dark, light rgba in
          // light), so white text vanished on the LIGHT glass. text-primary is
          // #f2f2f2 (dark theme) / #161616 (light theme) — high contrast on both.
          // The SVG icon uses stroke="currentColor", so it inherits this colour.
          color: "var(--color-text-primary)",
          textShadow: "0 1px 4px var(--color-glass-bg)",
        }}
      >
        <svg
          width="48"
          height="48"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        <span>{text ?? t("drop.overlay_text")}</span>
        <span
          className="text-xs font-normal opacity-70"
        >
          {hint ?? t("drop.overlay_hint")}
        </span>
      </div>
    </div>
  );
}
