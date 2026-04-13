import type { ReactNode } from "react";

type BadgeVariant = "default" | "success" | "warning" | "danger" | "accent";
type BadgeSize = "sm" | "md";

interface BadgeProps {
  children: ReactNode;
  variant?: BadgeVariant;
  size?: BadgeSize;
  icon?: ReactNode;
  pulse?: boolean;
}

const variantColors: Record<BadgeVariant, { bg: string; text: string }> = {
  default: { bg: "var(--color-bg-hover)", text: "var(--color-text-secondary)" },
  success: { bg: "rgba(16, 185, 129, 0.15)", text: "var(--color-success-400)" },
  warning: { bg: "rgba(245, 158, 11, 0.15)", text: "var(--color-warning-400)" },
  danger:  { bg: "rgba(239, 68, 68, 0.15)", text: "var(--color-danger-400)" },
  accent:  { bg: "rgba(99, 102, 241, 0.15)", text: "var(--color-accent-400)" },
};

const sizeStyles: Record<BadgeSize, string> = {
  sm: "px-1.5 py-0.5 text-[10px] gap-1",
  md: "px-2 py-0.5 text-[11px] gap-1.5",
};

export function Badge({ children, variant = "default", size = "sm", icon, pulse }: BadgeProps) {
  const variantStyle = variantColors[variant];

  return (
    <span
      className={`
        inline-flex items-center font-semibold rounded-[var(--radius-md)] uppercase tracking-wide
        ${sizeStyles[size]}
        ${pulse ? "animate-pulse" : ""}
      `}
      style={{ backgroundColor: variantStyle.bg, color: variantStyle.text }}
    >
      {icon && <span className="shrink-0">{icon}</span>}
      {children}
    </span>
  );
}
