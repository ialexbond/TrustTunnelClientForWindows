import { forwardRef, type HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";

export const badgeVariants = cva(
  [
    "inline-flex items-center gap-1.5",
    "px-2 py-0.5",
    "rounded-[var(--radius-full)]",
    "text-[var(--font-size-xs)]",
    "font-[var(--font-weight-semibold)]",
    "uppercase tracking-[var(--tracking-wide)]",
  ].join(" "),
  {
    variants: {
      variant: {
        success: [
          "bg-[var(--color-status-connected-bg)]",
          "text-[var(--color-status-connected)]",
          "border border-[var(--color-status-connected-border)]",
        ].join(" "),
        warning: [
          "bg-[var(--color-status-connecting-bg)]",
          "text-[var(--color-status-connecting)]",
          "border border-[var(--color-status-connecting-border)]",
        ].join(" "),
        danger: [
          "bg-[var(--color-status-error-bg)]",
          "text-[var(--color-status-error)]",
          "border border-[var(--color-status-error-border)]",
        ].join(" "),
        neutral: [
          "bg-[var(--color-bg-elevated)]",
          "text-[var(--color-text-secondary)]",
          "border border-[var(--color-border)]",
        ].join(" "),
        dot: [
          "bg-transparent",
          "text-[var(--color-text-secondary)]",
          "border border-transparent",
        ].join(" "),
      },
    },
    defaultVariants: {
      variant: "neutral",
    },
  }
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  pulse?: boolean;
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  ({ variant, pulse, className, children, ...props }, ref) => {
    return (
      <span
        ref={ref}
        className={cn(
          badgeVariants({ variant }),
          pulse && "animate-pulse",
          className
        )}
        {...props}
      >
        {variant === "dot" && (
          <span
            className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-muted)] shrink-0"
            aria-hidden="true"
          />
        )}
        {children}
      </span>
    );
  }
);

Badge.displayName = "Badge";
