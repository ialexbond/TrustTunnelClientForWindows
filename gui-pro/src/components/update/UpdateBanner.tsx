import { Download, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../shared/ui/Button";

/**
 * UpdateBanner — info-banner для уведомления о доступном обновлении протокола
 * (sidecar update). Отображает Download icon + message + version (mono inline) +
 * primary «Обновить» button + X dismiss.
 *
 * Pattern: D-DECISION-UI-3.2 — отдельный компонент, НЕ wrapper над ErrorBanner.
 * ErrorBanner contract: text + X only; UpdateBanner contract: text + action button + X.
 *
 * Pure presentational — `onDismiss` callback вызывается parent'ом, persistence
 * (localStorage `tt_dismissed_update_<version>`) живёт в parent (Plan 18-04
 * useUpdateChecker hook) — separation of concerns (REQ-18-UPDATE-FLOW-02).
 *
 * Trust boundary: `version` приходит из useUpdateChecker hook (Plan 18-04),
 * который, в свою очередь, валидирует строку через backend validate_version
 * (Plan 18-03). React JSX auto-escapes текстовое содержимое внутри `<code>`
 * — T-18-06 mitigated.
 */
export interface UpdateBannerProps {
  version: string;
  onUpdate: () => void;
  onDismiss: () => void;
}

export function UpdateBanner({ version, onUpdate, onDismiss }: UpdateBannerProps) {
  const { t } = useTranslation();
  return (
    <div
      className="flex items-center gap-3 px-[var(--space-4)] py-[var(--space-3)] mx-[var(--space-6)] mt-[var(--space-3)]"
      style={{
        backgroundColor: "var(--color-status-info-bg)",
        border: "1px solid var(--color-status-info-border)",
        borderRadius: "var(--radius-md)",
        color: "var(--color-status-info)",
      }}
      role="region"
      aria-label={t("app.update.banner.aria")}
      data-testid="update-banner"
    >
      <Download className="w-4 h-4 shrink-0" aria-hidden="true" />
      <span className="flex-1 text-body-sm">
        {t("app.update.banner.message")}{" "}
        <code className="text-mono-sm" data-testid="update-banner-version">
          v{version}
        </code>
      </span>
      <Button
        variant="primary"
        size="sm"
        onClick={onUpdate}
        data-testid="update-banner-update"
      >
        {t("app.update.banner.update_button")}
      </Button>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 p-1 rounded transition-opacity hover:opacity-70"
        style={{ color: "inherit" }}
        aria-label={t("app.update.banner.dismiss_aria")}
        data-testid="update-banner-dismiss"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
