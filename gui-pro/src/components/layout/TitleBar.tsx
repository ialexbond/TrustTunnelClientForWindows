import type { ReactNode } from "react";

interface TitleBarProps {
  children?: ReactNode;
}

/**
 * Compact title bar — brand on the left, spacer (draggable), window controls on the right.
 * 32px height, seamless design.
 *
 * Drag восстановлен через нативный `data-tauri-drag-region` — он
 * хорошо работает со snap'ами Windows и не конфликтует с click'ами на
 * WindowControls. Dblclick-to-maximize блокируется на Rust-слое
 * (см. lib.rs on_window_event → Maximized → set_maximized(false)).
 */
export function TitleBar({ children }: TitleBarProps) {
  return (
    <div
      className="flex items-center shrink-0"
      data-tauri-drag-region
      style={{ height: 32 }}
    >
      {/* Brand — compact. Outfit для wordmark + theme-swapped SVG логотип.
          CSS-only swap через .only-dark / .only-light (см. index.css). */}
      <div
        className="flex items-center gap-1.5 pl-3"
        data-tauri-drag-region
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
          className="text-sm font-semibold"
          style={{
            letterSpacing: "-0.01em",
            fontFamily: "var(--font-family-display)",
          }}
        >
          <span style={{ color: "var(--color-text-primary)" }}>Trust</span>
          <span style={{ color: "var(--color-accent-interactive)" }}>Tunnel</span>
        </span>
        <span
          // PRO badge — тот же stylistic pattern что и AboutPanel:
          // accent-tint-10 фон + accent-interactive текст + rounded-sm +
          // font-bold. Масштаб подогнан под 32px TitleBar height:
          // text-xs (12px, strict compliance) + padding pt-[3px]/pb-[2px].
          className="text-xs font-bold px-1.5 pt-[3px] pb-[2px] rounded-[var(--radius-sm)] leading-none"
          style={{
            backgroundColor: "var(--color-accent-tint-10)",
            color: "var(--color-accent-interactive)",
          }}
        >
          PRO
        </span>
      </div>

      {/* Spacer — draggable, между brand'ом и WindowControls */}
      <div className="flex-1" data-tauri-drag-region />

      {/* Window controls slot — HAS own click handlers, drag НЕ навешиваем */}
      {children}
    </div>
  );
}
