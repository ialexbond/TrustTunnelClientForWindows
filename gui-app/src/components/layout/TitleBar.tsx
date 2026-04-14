import type { ReactNode } from "react";

interface TitleBarProps {
  children?: ReactNode;
}

/**
 * Custom title bar for Tauri window.
 * Uses data-tauri-drag-region for drag behavior.
 * All colors from CSS token variables — no hardcoded values.
 */
export function TitleBar({ children }: TitleBarProps) {
  return (
    <div
      className="flex items-center shrink-0"
      data-tauri-drag-region
      style={{
        height: "32px",
        backgroundColor: "var(--color-bg-secondary)",
        borderBottom: "1px solid var(--color-border)",
      }}
    >
      {/* Brand */}
      <div
        className="flex items-center gap-1.5 pl-3"
        data-tauri-drag-region
      >
        <span
          className="text-xs font-bold tracking-wide"
          style={{ color: "var(--color-text-secondary)" }}
          data-tauri-drag-region
        >
          TrustTunnel
        </span>
        <span
          className="text-[9px] font-bold px-1.5 py-0.5 rounded"
          style={{
            backgroundColor: "rgba(45, 122, 118, 0.12)",
            color: "var(--color-accent-interactive)",
          }}
        >
          PRO
        </span>
      </div>

      {/* Spacer */}
      <div className="flex-1" data-tauri-drag-region />

      {/* Window controls slot (no-drag region) */}
      {children}
    </div>
  );
}
