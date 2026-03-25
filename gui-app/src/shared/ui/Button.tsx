import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Loader2 } from "lucide-react";

type ButtonVariant = "primary" | "secondary" | "danger" | "danger-outline" | "success" | "warning" | "ghost";
type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  loading?: boolean;
  fullWidth?: boolean;
}

const variantStyles: Record<ButtonVariant, string> = {
  primary: `
    bg-[var(--color-accent-500)] hover:bg-[var(--color-accent-600)]
    text-white shadow-sm border border-transparent
  `,
  secondary: `
    bg-[var(--color-bg-hover)] hover:bg-[var(--color-bg-active)]
    text-[var(--color-text-primary)] border border-[var(--color-border)]
  `,
  danger: `
    bg-[var(--color-danger-500)] hover:bg-[var(--color-danger-600)]
    text-white shadow-sm border border-transparent
  `,
  "danger-outline": `
    bg-[rgba(239,68,68,0.08)] hover:bg-[rgba(239,68,68,0.15)]
    text-[var(--color-danger-500)] border border-[rgba(239,68,68,0.25)]
  `,
  success: `
    bg-[var(--color-success-500)] hover:bg-[var(--color-success-600)]
    text-white shadow-sm border border-transparent
  `,
  warning: `
    bg-[var(--color-warning-500)] hover:bg-[var(--color-warning-600)]
    text-white shadow-sm border border-transparent
  `,
  ghost: `
    bg-transparent hover:bg-[var(--color-bg-hover)]
    text-[var(--color-text-secondary)] border border-transparent
  `,
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: "px-3 py-1.5 text-xs gap-1.5",
  md: "px-4 py-2 text-sm gap-2",
  lg: "px-5 py-2.5 text-sm gap-2",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "primary", size = "md", icon, loading, fullWidth, className = "", children, disabled, ...props }, ref) => {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={`
          inline-flex items-center justify-center font-medium
          rounded-[var(--radius-lg)] transition-all duration-200
          active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100
          ${variantStyles[variant]}
          ${sizeStyles[size]}
          ${fullWidth ? "w-full" : ""}
          ${className}
        `}
        {...props}
      >
        {loading ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : icon ? (
          <span className="shrink-0">{icon}</span>
        ) : null}
        {children}
      </button>
    );
  }
);

Button.displayName = "Button";
