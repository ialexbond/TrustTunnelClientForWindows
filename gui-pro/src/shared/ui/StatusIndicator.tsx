import { forwardRef, type HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";

const statusIndicatorVariants = cva(
  "rounded-full shrink-0 inline-block",
  {
    variants: {
      status: {
        success: "bg-[var(--color-status-connected)]",
        warning: "bg-[var(--color-status-connecting)]",
        danger:  "bg-[var(--color-status-error)]",
        neutral: "bg-[var(--color-text-muted)]",
        info:    "bg-[var(--color-status-info)]",
      },
      size: {
        sm: "w-1.5 h-1.5",
        md: "w-2 h-2",
        lg: "w-2.5 h-2.5",
      },
    },
    defaultVariants: { status: "neutral", size: "md" },
  }
);

export interface StatusIndicatorProps
  extends Omit<HTMLAttributes<HTMLSpanElement>, "color">,
    VariantProps<typeof statusIndicatorVariants> {
  pulse?: boolean;
  label?: string;
}

export const StatusIndicator = forwardRef<HTMLSpanElement, StatusIndicatorProps>(
  ({ status, size, pulse, label, className, ...props }, ref) => (
    <span
      ref={ref}
      role="img"
      aria-label={label ?? (status as string) ?? "neutral"}
      className={cn(
        statusIndicatorVariants({ status, size }),
        pulse && "animate-pulse",
        className
      )}
      {...props}
    />
  )
);
StatusIndicator.displayName = "StatusIndicator";
