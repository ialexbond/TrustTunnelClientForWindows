/* eslint-disable react-refresh/only-export-components -- CVA variants are co-located with the component by design */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "../lib/cn";

export const buttonVariants = cva(
  [
    "inline-flex items-center justify-center",
    "font-[var(--font-weight-semibold)]",
    "rounded-[var(--radius-md)]",
    "transition-all duration-[var(--transition-fast)] ease-[var(--ease-out)]",
    "active:scale-[0.97]",
    "disabled:opacity-[var(--opacity-disabled)] disabled:cursor-not-allowed disabled:pointer-events-none",
    "focus-visible:shadow-[var(--focus-ring)] outline-none",
  ].join(" "),
  {
    variants: {
      variant: {
        primary: [
          "bg-[var(--color-accent-interactive)]",
          "hover:bg-[var(--color-accent-hover)]",
          "active:bg-[var(--color-accent-active)]",
          "text-white",
          "border border-transparent",
        ].join(" "),
        secondary: [
          "bg-[var(--color-bg-elevated)]",
          "hover:bg-[var(--color-bg-hover)]",
          "active:bg-[var(--color-bg-active)]",
          "text-[var(--color-text-primary)]",
          "border border-[var(--color-border)]",
        ].join(" "),
        danger: [
          "bg-[var(--color-destructive)]",
          "hover:opacity-90",
          "text-white",
          "border border-transparent",
        ].join(" "),
        "danger-outline": [
          "bg-transparent",
          "hover:bg-[var(--color-destructive)] hover:text-white",
          "text-[var(--color-destructive)]",
          "border border-[var(--color-destructive)]",
        ].join(" "),
        ghost: [
          "bg-transparent",
          "hover:bg-[var(--color-bg-hover)]",
          "active:bg-[var(--color-bg-active)]",
          "text-[var(--color-text-secondary)]",
          "border border-transparent",
        ].join(" "),
        icon: [
          "bg-transparent",
          "hover:bg-[var(--color-bg-hover)]",
          "active:bg-[var(--color-bg-active)]",
          "text-[var(--color-text-muted)]",
          "border border-transparent",
        ].join(" "),
      },
      size: {
        sm: "h-8 px-3 text-sm gap-1.5",
        md: "h-9 px-4 text-sm gap-2",
        lg: "h-10 px-5 text-base gap-2",
      },
      fullWidth: {
        true: "w-full",
        false: "",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
      fullWidth: false,
    },
  }
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  loading?: boolean;
  fullWidth?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { variant, size, fullWidth, loading, icon, className, children, disabled, ...props },
    ref
  ) => {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={cn(buttonVariants({ variant, size, fullWidth }), className)}
        {...props}
      >
        {loading && <Loader2 className="w-4 h-4 animate-spin" />}
        {!loading && icon}
        {children}
      </button>
    );
  }
);

Button.displayName = "Button";
