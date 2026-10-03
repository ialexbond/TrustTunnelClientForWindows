/* eslint-disable react-refresh/only-export-components -- CVA variants are co-located with the component by design */
import { forwardRef, type HTMLAttributes } from "react";
import { useTranslation } from "react-i18next";
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
      variant: {
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
      variant: "error",
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
  ({ variant, message, onDismiss, className, ...props }, ref) => {
    const { t } = useTranslation();
    const Icon = variant === "info" ? Info : AlertTriangle;

    // F10 — ARIA live role by severity, mirroring SnackBar (src/shared/ui/SnackBar.tsx):
    // error + warning interrupt assertively (role="alert"), info announces politely
    // (role="status"). Computed as defaults, then `{...props}` is spread AFTER so a caller
    // can pass an explicit role / aria-live and win (overridable per the plan).
    const isInfo = variant === "info";
    const defaultRole = isInfo ? "status" : "alert";
    const defaultAriaLive = isInfo ? "polite" : "assertive";

    return (
      <div
        ref={ref}
        role={defaultRole}
        aria-live={defaultAriaLive}
        className={cn(errorBannerVariants({ variant }), className)}
        {...props}
      >
        <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
        <span className="flex-1 break-words">{message}</span>
        {onDismiss && (
          <button
            onClick={onDismiss}
            className="shrink-0 p-0.5 rounded transition-opacity hover:opacity-70"
            // F09 — localized dismiss label «Закрыть» (t("buttons.close")), reusing the
            // canonical close key that Modal's corner-× button already consumes (no new key).
            aria-label={t("buttons.close")}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    );
  }
);

ErrorBanner.displayName = "ErrorBanner";
