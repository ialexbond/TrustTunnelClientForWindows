import type { ReactNode } from "react";
import { useTheme } from "../../shared/hooks/useTheme";

interface TitleBarProps {
  children?: ReactNode;
}

/**
 * Compact title bar — brand on the left, spacer (draggable), window controls on the right.
 * 32px height, seamless design.
 *
 * Double-click на drag-region нативно Tauri 2 вызывает maximize/fullscreen
 * window. Даже при `maximizable: false` в config эта шорткат срабатывает.
 * preventDefault на onDoubleClick блокирует это поведение на JS-слое.
 */
export function TitleBar({ children }: TitleBarProps) {
  const { theme } = useTheme();
  const logoSrc =
    theme === "dark" ? "/logo/shield-dark.svg" : "/logo/shield-light.svg";
  return (
    <div
      className="flex items-center shrink-0"
      data-tauri-drag-region
      onDoubleClick={(e) => e.preventDefault()}
      style={{ height: 32 }}
    >
      {/* Brand — compact. Outfit для wordmark + theme-swapped SVG логотип. */}
      <div
        className="flex items-center gap-1.5 pl-3"
        data-tauri-drag-region
        onDoubleClick={(e) => e.preventDefault()}
      >
        <img
          src={logoSrc}
          alt=""
          width={18}
          height={18}
          draggable={false}
          className="shrink-0 pointer-events-none"
        />
        <span
          className="text-[13px] font-[var(--font-weight-semibold)]"
          style={{
            letterSpacing: "-0.01em",
            color: "var(--color-text-primary)",
            fontFamily: "var(--font-family-display)",
          }}
          data-tauri-drag-region
          onDoubleClick={(e) => e.preventDefault()}
        >
          TrustTunnel
        </span>
        <span
          // PRO badge. line-height калибрется `leading-none` + `pb-[1px]`
          // чтобы текст не сидел ниже визуального центра (h-8 бейджа при
          // text-[9px] давал оптическое смещение вниз — FIX выравнивает
          // глиф ровно по центру box'а).
          className="text-[9px] font-[var(--font-weight-semibold)] px-1.5 py-[1px] rounded-[var(--radius-sm)] leading-none inline-flex items-center"
          style={{
            backgroundColor: "var(--color-bg-elevated)",
            color: "var(--color-accent-interactive)",
          }}
        >
          PRO
        </span>
      </div>

      {/* Spacer — draggable */}
      <div
        className="flex-1"
        data-tauri-drag-region
        onDoubleClick={(e) => e.preventDefault()}
      />

      {/* Window controls slot */}
      {children}
    </div>
  );
}
