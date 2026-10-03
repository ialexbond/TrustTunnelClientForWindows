import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";

const trackVariants = cva(
  ["w-full rounded-full bg-[var(--color-bg-elevated)] overflow-hidden"],
  {
    variants: {
      size: {
        sm: "h-1.5",
        md: "h-2.5",
        lg: "h-3.5",
      },
    },
    defaultVariants: {
      size: "md",
    },
  }
);

const fillVariants = cva(["h-full rounded-full transition-all duration-[var(--transition-fast)]"], {
  variants: {
    color: {
      accent: "bg-[var(--color-accent-interactive)]",
      success: "bg-[var(--color-success-500)]",
      warning: "bg-[var(--color-warning-500)]",
      danger: "bg-[var(--color-danger-500)]",
    },
  },
  defaultVariants: {
    color: "accent",
  },
});

export interface ProgressBarProps extends VariantProps<typeof trackVariants>, VariantProps<typeof fillVariants> {
  value: number;
  max?: number;
  label?: string;
  className?: string;
}

export function ProgressBar({
  value,
  max = 100,
  size,
  color,
  label,
  className,
}: ProgressBarProps) {
  const safeMax = max > 0 ? max : 100;
  const clampedValue = Math.min(safeMax, Math.max(0, value));
  const percentage = (clampedValue / safeMax) * 100;

  return (
    <div
      className={cn(trackVariants({ size }), className)}
      role="progressbar"
      aria-valuenow={clampedValue}
      aria-valuemin={0}
      aria-valuemax={safeMax}
      aria-label={label}
    >
      <div
        className={cn(fillVariants({ color }))}
        style={{ width: `${percentage}%` }}
      />
    </div>
  );
}
