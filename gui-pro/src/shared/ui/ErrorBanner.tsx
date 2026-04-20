/* eslint-disable react-refresh/only-export-components -- CVA variants are co-located with the component by design */
import { forwardRef, type HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { AlertTriangle, Info, X } from "lucide-react";
import { cn } from "../lib/cn";

export const errorBannerVariants = cva(
  [
    "flex items-start gap-2",
    "px-[var(--space-3)] py-[var(--space-2)]",
    "rounded-[var(--radius-md)]",
    "text-sm",
    "border",
  ].join(" "),
  {
    variants: {
      severity: {
        error: [
          "bg-[var(--color-status-error-bg)]",
          "text-[var(--color-status-error)]",
          "border-[var(--color-status-error-border)]",
        ].join(" "),
        warning: [
          "bg-[var(--color-status-connecting-bg)]",
          "text-[var(--color-status-connecting)]",
          "border-[var(--color-status-connecting-border)]",
        ].join(" "),
        info: [
          "bg-[var(--color-status-info-bg)]",
          "text-[var(--color-status-info)]",
          "border-[var(--color-status-info-border)]",
        ].join(" "),
      },
    },
    defaultVariants: {
      severity: "error",
    },
  }
);

export interface ErrorBannerProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children">,
    VariantProps<typeof errorBannerVariants> {
  message: string;
  onDismiss?: () => void;
}

export const ErrorBanner = forwardRef<HTMLDivElement, ErrorBannerProps>(
  ({ severity, message, onDismiss, className, ...props }, ref) => {
    const Icon = severity === "info" ? Info : AlertTriangle;

    return (
      <div
        ref={ref}
        className={cn(errorBannerVariants({ severity }), className)}
        {...props}
      >
        <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
        <span className="flex-1 break-words">{message}</span>
        {onDismiss && (
          <button
            onClick={onDismiss}
            className="shrink-0 p-0.5 rounded transition-opacity hover:opacity-70"
            aria-label="Dismiss"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    );
  }
);

ErrorBanner.displayName = "ErrorBanner";
