import { cn } from "../lib/cn";

export interface CharCounterProps {
  /** Current character count. */
  value: number;
  /** Maximum allowed characters. */
  max: number;
  /**
   * Visual emphasis when approaching/over limit.
   * - "warning": when value/max ≥ 0.85
   * - "error": when value > max (caller is responsible for soft-clipping content)
   * - "default": neutral muted color
   */
  className?: string;
}

/**
 * CharCounter — minimal text-input character counter.
 *
 * Convention: `N/M` (no parentheses) in muted color.
 * - Warning amber at ≥85% capacity
 * - Error red when over max
 *
 * Position: caller chooses placement. Common pattern:
 *   - Above input, right-aligned (next to label)
 *   - Below input, right-aligned (in helperText slot)
 *
 * Example:
 *   <div className="flex items-baseline justify-between mb-1.5">
 *     <label>{t("server.users.field_display_name")}</label>
 *     <CharCounter value={value.length} max={64} />
 *   </div>
 */
export function CharCounter({ value, max, className }: CharCounterProps) {
  const pct = max > 0 ? value / max : 0;
  const isOver = value > max;
  const isNearLimit = pct >= 0.85;

  return (
    <span
      aria-live="polite"
      className={cn(
        "text-xs tabular-nums select-none",
        isOver
          ? "text-[var(--color-status-error)]"
          : isNearLimit
            ? "text-[var(--color-status-warning)]"
            : "text-[var(--color-text-muted)]",
        className,
      )}
    >
      {value}/{max}
    </span>
  );
}
