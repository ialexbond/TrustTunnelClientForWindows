import type { ReactNode } from "react";

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
  return (
    <div
      className="flex items-center shrink-0"
      data-tauri-drag-region
      onDoubleClick={(e) => e.preventDefault()}
      style={{ height: 32 }}
    >
      {/* Brand — compact. Outfit для wordmark + theme-swapped SVG логотип.
          CSS-only swap через .only-dark / .only-light (см. index.css).
          useTheme() хранил local state per-component, так что при
          переключении темы в Settings — TitleBar не re-rendered и логотип
          оставался чёрным на светлой теме. CSS решает это атомарно через
          `data-theme` на <html>. */}
      <div
        className="flex items-center gap-1.5 pl-3"
        data-tauri-drag-region
        onDoubleClick={(e) => e.preventDefault()}
      >
        <img
          src="/logo/shield-dark.svg"
          alt=""
          width={18}
          height={18}
          draggable={false}
          className="only-dark shrink-0 pointer-events-none"
        />
        <img
          src="/logo/shield-light.svg"
          alt=""
          width={18}
          height={18}
          draggable={false}
          className="only-light shrink-0 pointer-events-none"
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
          className="text-[9px] font-[var(--font-weight-semibold)] px-1.5 py-[1px] rounded-[var(--radius-sm)]"
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
