import { cn } from "../lib/cn";

interface ProgressBarProps {
  value: number;
  label?: string;
  showValue?: boolean;
  className?: string;
}

export function ProgressBar({
  value,
  label,
  showValue,
  className,
}: ProgressBarProps) {
  // Clamp value to [0, 100] to prevent overflow (T-02-06-01)
  const clampedValue = Math.min(100, Math.max(0, value));

  return (
    <div className={cn("w-full", className)}>
      {(label || showValue) && (
        <div className="flex justify-between items-center mb-1.5">
          {label && (
            <span
              className="text-[var(--color-text-secondary)]"
              style={{ fontSize: "var(--font-size-sm)" }}
            >
              {label}
            </span>
          )}
          {showValue && (
            <span
              className="text-[var(--color-text-muted)]"
              style={{ fontSize: "var(--font-size-xs)" }}
            >
              {clampedValue}%
            </span>
          )}
        </div>
      )}
      <div
        className="h-2 w-full rounded-[var(--radius-full)] bg-[var(--color-bg-hover)] overflow-hidden"
        role="progressbar"
        aria-valuenow={clampedValue}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full rounded-[var(--radius-full)] bg-[var(--color-accent-interactive)] transition-all"
          style={{
            width: `${clampedValue}%`,
            transitionDuration: "var(--transition-fast)",
          }}
        />
      </div>
    </div>
  );
}
