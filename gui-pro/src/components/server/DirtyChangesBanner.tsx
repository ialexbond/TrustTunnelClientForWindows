import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { Button } from "../../shared/ui/Button";
import { cn } from "../../shared/lib/cn";

export interface DirtyChangesBannerProps {
  /** Total dirty field count. Banner hidden when 0. */
  changeCount: number;
  /** «Применить» button handler. Hidden if not provided. */
  onApply?: () => void;
  /** «Отменить» button handler. Hidden if not provided. */
  onDiscard?: () => void;
  className?: string;
}

/**
 * Phase 15 banner shown above Quick Settings when user has unsaved changes.
 *
 * Self-rendered warning chrome (AlertTriangle icon + dirty count + inline
 * Apply / Discard buttons). The shared severity="warning" banner primitive
 * does not expose action / secondaryAction props, so this component builds
 * its own chrome with `<Button>` elements next to the message instead of
 * wrapping it.
 *
 * Token map (Phase 15 UI-SPEC §Color):
 *   - background  → `--color-warning-tint-08` (theme-aware yellow tint)
 *   - border      → `--color-warning-500` (midpoint, readable on both themes)
 *   - icon colour → `--color-warning-500`
 *
 * Returns null when there are no changes — hides itself entirely.
 */
export function DirtyChangesBanner({
  changeCount,
  onApply,
  onDiscard,
  className,
}: DirtyChangesBannerProps) {
  const { t } = useTranslation();
  if (changeCount === 0) return null;

  return (
    <div
      role="status"
      className={cn(
        "flex items-center justify-between gap-3 rounded-[var(--radius-md)] p-3",
        "bg-[var(--color-warning-tint-08)] border border-[var(--color-warning-500)]",
        className,
      )}
    >
      <div className="flex items-center gap-2 text-body-sm">
        <AlertTriangle
          size={16}
          className="text-[var(--color-warning-500)] shrink-0"
          aria-hidden="true"
        />
        <span>
          {t("server.config.dirty_banner_label", { count: changeCount })}
        </span>
      </div>
      <div className="flex items-center gap-2">
        {onDiscard && (
          <Button variant="ghost" size="sm" onClick={onDiscard}>
            {t("server.config.discard_changes")}
          </Button>
        )}
        {onApply && (
          <Button variant="primary" size="sm" onClick={onApply}>
            {t("server.config.apply_settings")}
          </Button>
        )}
      </div>
    </div>
  );
}
