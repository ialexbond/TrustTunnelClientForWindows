import type { ReactNode } from "react";
import { Shield } from "lucide-react";

interface TitleBarProps {
  children?: ReactNode;
}

/**
 * Compact title bar — brand on the left, spacer (draggable), window controls on the right.
 * 32px height, seamless design.
 */
export function TitleBar({ children }: TitleBarProps) {
  return (
    <div
      className="flex items-center shrink-0"
      data-tauri-drag-region
      style={{ height: 32 }}
    >
      {/* Brand — compact */}
      <div
        className="flex items-center gap-1.5 pl-3"
        data-tauri-drag-region
      >
        <Shield
          size={15}
          style={{ color: "var(--color-accent-interactive)" }}
        />
        <span
          className="text-[12px] font-medium"
          style={{
            letterSpacing: "-0.01em",
            color: "var(--color-text-primary)",
          }}
          data-tauri-drag-region
        >
          TrustTunnel
        </span>
        <span
          className="text-[9px] font-semibold px-1.5 py-[1px] rounded-[var(--radius-sm)]"
          style={{
            backgroundColor: "var(--color-bg-elevated)",
            color: "var(--color-accent-interactive)",
          }}
        >
          PRO
        </span>
      </div>

      {/* Spacer — draggable */}
      <div className="flex-1" data-tauri-drag-region />

      {/* Window controls slot */}
      {children}
    </div>
  );
}
