/* eslint-disable react-refresh/only-export-components -- CVA variants are co-located with the component by design */
import { cva, type VariantProps } from "class-variance-authority";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/cn";

export const statusBadgeVariants = cva(
  // Semantic composite: text-caption = 12px / medium / 1.35 / sans.
  // Badge-specific transform + tracking applied on top.
  "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[var(--radius-full)] uppercase text-caption tracking-[var(--tracking-wide)]",
  {
    variants: {
      variant: {
        connected:
          "bg-[var(--color-status-connected-bg)] text-[var(--color-status-connected)] border border-[var(--color-status-connected-border)]",
        connecting:
          "bg-[var(--color-status-connecting-bg)] text-[var(--color-status-connecting)] border border-[var(--color-status-connecting-border)]",
        error:
          "bg-[var(--color-status-error-bg)] text-[var(--color-status-error)] border border-[var(--color-status-error-border)]",
        disconnected:
          "bg-transparent text-[var(--color-status-disconnected)] border border-[var(--color-border)]",
      },
    },
    defaultVariants: {
      variant: "disconnected",
    },
  }
);

const dotStyles: Record<NonNullable<VariantProps<typeof statusBadgeVariants>["variant"]>, string> = {
  connected: "bg-[var(--color-status-connected)]",
  connecting: "bg-[var(--color-status-connecting)] animate-pulse",
  error: "bg-[var(--color-status-error)]",
  disconnected: "bg-[var(--color-text-muted)]",
};

interface StatusBadgeProps extends VariantProps<typeof statusBadgeVariants> {
  label?: string;
  className?: string;
}

export function StatusBadge({ variant = "disconnected", label, className }: StatusBadgeProps) {
  const { t } = useTranslation();
  const resolvedVariant = (variant ?? "disconnected") as NonNullable<typeof variant>;
  const displayLabel = label ?? t(`status.${resolvedVariant}`);

  return (
    <span
      className={cn(statusBadgeVariants({ variant }), className)}
    >
      <span
        data-testid="status-dot"
        className={cn("w-1.5 h-1.5 rounded-full shrink-0", dotStyles[resolvedVariant])}
      />
      {displayLabel}
    </span>
  );
}
