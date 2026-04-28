import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "../../../../shared/ui/Input";
import { InfoTooltipLabel } from "./InfoTooltipLabel";
import type { TomlFieldSchema } from "../types";

/**
 * Phase 15.1 — string field renderer.
 *
 * D-7.1 onBlur validation:
 *   - onChange updates LOCAL state only (no dirty marker yet)
 *   - onBlur runs synchronous validator (≤ 5ms)
 *   - If valid: parent onChange called → dirty marker
 *   - If invalid: error rendered под полем; parent onChange NOT called
 *
 * Validator contract: returns i18n KEY ("" = valid, non-empty = error key).
 * Mirrors gui-pro/src/shared/utils/validators.ts (Plan 15-03 shipped).
 */
export interface StringFieldProps {
  schema: TomlFieldSchema;
  /** Validator returning i18n key on error, "" on valid. Optional. */
  validator?: (value: string) => string;
  /** Called only when value changes AND passes validation. */
  onChange: (path: string[], value: string) => void;
  disabled?: boolean;
}

export function StringField({ schema, validator, onChange, disabled }: StringFieldProps) {
  const { t } = useTranslation();

  if (schema.type.kind !== "string") return null;

  const initialValue = schema.type.value;

  const [localValue, setLocalValue] = useState<string>(initialValue);
  const [error, setError] = useState<string | null>(null);

  // Re-sync local state when schema value changes externally
  // (e.g., bundle reload, discardAll). Reset error on each external change.
  useEffect(() => {
    setLocalValue(schema.type.kind === "string" ? schema.type.value : "");
    setError(null);
  }, [schema.type]);

  const handleBlur = () => {
    const errorKey = validator ? validator(localValue) : "";
    if (errorKey) {
      setError(t(errorKey, { defaultValue: errorKey }));
      return;
    }
    setError(null);
    // Only emit change if differs from original schema value
    if (localValue !== initialValue) {
      onChange(schema.path, localValue);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2">
        <span className="text-mono text-[var(--color-text-secondary)]">{schema.key}</span>
        <InfoTooltipLabel tooltipKey={schema.tooltipKey} fieldKey={schema.key} />
      </label>
      <Input
        value={localValue}
        onChange={(e) => setLocalValue(e.target.value)}
        onBlur={handleBlur}
        disabled={disabled}
        aria-invalid={!!error}
        aria-describedby={error ? `error-${schema.path.join("-")}` : undefined}
      />
      {error && (
        <span
          id={`error-${schema.path.join("-")}`}
          className="text-body-sm text-[var(--color-danger-500)]"
          role="alert"
        >
          {error}
        </span>
      )}
    </div>
  );
}
