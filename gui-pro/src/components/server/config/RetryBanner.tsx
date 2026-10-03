import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { Button } from "../../../shared/ui/Button";
import { cn } from "../../../shared/lib/cn";
import type { ConfigFileName } from "./types";

/**
 * Phase 15.1 D-8.1 — Partial failure retry banner.
 *
 * Shown when last saveAll() returned partial failure. Displays which file failed,
 * count saved/total, and Retry button which triggers saveAll() again on remaining files.
 *
 * Token map (Phase 15.1 UI-SPEC §Color):
 *   - background  → `--color-status-error-bg`
 *   - border      → `--color-danger-fg`
 *   - icon colour → `--color-danger-fg`
 *
 * a11y: `role="alert"` + `aria-live="assertive"` — screen reader announces immediately.
 */
export interface RetryBannerProps {
  /** File that failed in batch. */
  failedFile: ConfigFileName;
  /** How many файлов saved before failure. */
  savedCount: number;
  /** Total files in batch. */
  totalCount: number;
  onRetry: () => void;
  onDismiss?: () => void;
  className?: string;
}

export function RetryBanner({
  failedFile,
  savedCount,
  totalCount,
  onRetry,
  onDismiss,
  className,
}: RetryBannerProps) {
  const { t } = useTranslation();

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={cn(
        "flex items-center justify-between gap-3 rounded-[var(--radius-md)] p-3",
        "bg-[var(--color-status-error-bg)] border border-[var(--color-danger-fg)]",
        className,
      )}
    >
      <div className="flex items-center gap-2 text-body-sm text-[var(--color-text-primary)]">
        <AlertTriangle
          size={16}
          className="text-[var(--color-danger-fg)] shrink-0"
          aria-hidden="true"
        />
        <span>
          {t("server.config.partial_save_error", {
            n: savedCount,
            total: totalCount,
            file: `${failedFile}.toml`,
          })}
        </span>
      </div>
      <div className="flex items-center gap-2">
        {onDismiss && (
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            {t("buttons.cancel", { defaultValue: "Закрыть" })}
          </Button>
        )}
        <Button variant="primary" size="sm" onClick={onRetry}>
          {t("server.config.retry_save")}
        </Button>
      </div>
    </div>
  );
}
