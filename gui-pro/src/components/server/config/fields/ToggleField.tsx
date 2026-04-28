import { useTranslation } from "react-i18next";
import { Toggle } from "../../../../shared/ui/Toggle";
import { InfoTooltipLabel } from "./InfoTooltipLabel";
import type { TomlFieldSchema } from "../types";

/**
 * Phase 15.1 — bool field renderer.
 *
 * Layout (UI-SPEC §Layout — Quick Settings + accordion field rows):
 *   [TOML key] [Info icon]                                      [Toggle]
 *     Helper text (RU description from tooltipKey, if present)
 *
 * Notes:
 *   - Wraps shared Toggle primitive (которая имеет внутренний layout) —
 *     передаём label/description пустыми, layout рисуем сами для
 *     Phase 15.1 schema renderer (Info icon рядом с raw mono key).
 *   - text-mono для TOML keys (D-3.1 raw English labels).
 *   - text-caption для helper text (Phase 14.2 typography).
 *   - aria-label на Toggle (a11y).
 */
export interface ToggleFieldProps {
  schema: TomlFieldSchema;
  onChange: (path: string[], value: boolean) => void;
  disabled?: boolean;
}

export function ToggleField({ schema, onChange, disabled }: ToggleFieldProps) {
  const { t } = useTranslation();

  if (schema.type.kind !== "boolean") {
    // Defensive — should never happen if SchemaFieldRenderer dispatches correctly
    return null;
  }

  const checked = schema.type.value;
  const helperText = schema.tooltipKey
    ? t(schema.tooltipKey, { defaultValue: "" })
    : "";

  return (
    <div className="flex items-center justify-between gap-2 py-2">
      <div className="flex flex-col gap-1 min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-mono text-[var(--color-text-secondary)] truncate">
            {schema.key}
          </span>
          <InfoTooltipLabel tooltipKey={schema.tooltipKey} fieldKey={schema.key} />
        </div>
        {helperText && (
          <span className="text-caption text-[var(--color-text-muted)]">
            {helperText}
          </span>
        )}
      </div>
      <Toggle
        checked={checked}
        onChange={(next) => onChange(schema.path, next)}
        disabled={disabled}
        aria-label={schema.key}
      />
    </div>
  );
}
