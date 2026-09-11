import { Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tooltip } from "../../../../shared/ui/Tooltip";

/**
 * Phase 15.1 D-12.1 — Info icon trigger + Tooltip с RU description.
 *
 * Behaviour:
 *   - tooltipKey absent → renders nothing (forward-compat for D-16.1 unknown fields)
 *   - tooltipKey present но i18n returns empty → renders nothing (graceful)
 *   - tooltipKey resolves к non-empty RU string → Info icon + Tooltip
 *
 * Pattern: использует existing Tooltip primitive (Phase 14 blur-reset fix).
 * Tooltip API contract: prop is `text` (NOT `content`).
 */
export interface InfoTooltipLabelProps {
  /** i18n key для RU description (e.g. "server.config.field_desc.vpn.listen_address"). */
  tooltipKey?: string;
  /** Field key (raw English TOML) — used in aria-label. */
  fieldKey: string;
}

export function InfoTooltipLabel({ tooltipKey, fieldKey }: InfoTooltipLabelProps) {
  const { t } = useTranslation();

  if (!tooltipKey) return null;

  // Resolve i18n; defaultValue: "" guards if key missing
  const description = t(tooltipKey, { defaultValue: "" });
  if (!description) return null;

  return (
    <Tooltip text={description} delay={300} position="top">
      <button
        type="button"
        aria-label={t("server.config.info_for", {
          key: fieldKey,
          defaultValue: `Описание поля ${fieldKey}`,
        })}
        className="inline-flex items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] focus-visible:shadow-[var(--focus-ring)] outline-none rounded-sm transition-colors"
        tabIndex={0}
      >
        <Info size={14} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}
