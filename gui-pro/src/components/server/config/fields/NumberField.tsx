import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { NumberInput } from "../../../../shared/ui/NumberInput";
import { InfoTooltipLabel } from "./InfoTooltipLabel";
import type { TomlFieldSchema } from "../types";

/**
 * Phase 15.1 — integer field renderer.
 *
 * Note: TrustTunnel upstream CONFIGURATION.md schema treats all numeric
 * fields as integer (timeouts, ports, status codes, max_concurrent_streams).
 * Float not used in any field. types.ts inferTomlFieldType returns "integer"
 * for all numbers (Phase 15.1 design decision).
 *
 * NumberInput primitive API contract:
 *   value: string  — digits-only filter happens internally
 *   onChange: (string) => void
 *   No onBlur prop — Phase 15.1 wraps NumberInput с onBlurCapture на
 *   parent <div> для D-7.1 validation gate.
 *
 * Validator contract: receives parsed number, returns i18n key ("" = valid).
 */
export interface NumberFieldProps {
  schema: TomlFieldSchema;
  validator?: (value: number) => string;
  onChange: (path: string[], value: number) => void;
  disabled?: boolean;
}

export function NumberField({ schema, validator, onChange, disabled }: NumberFieldProps) {
  const { t } = useTranslation();

  if (schema.type.kind !== "integer") return null;

  const initialValue = schema.type.value;

  const [localValue, setLocalValue] = useState<string>(String(initialValue));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLocalValue(
      schema.type.kind === "integer" ? String(schema.type.value) : ""
    );
    setError(null);
  }, [schema.type]);

  const handleBlur = () => {
    const parsed = parseInt(localValue, 10);
    if (Number.isNaN(parsed)) {
      // Empty / non-numeric input — silently ignore (NumberInput filters digits only)
      return;
    }
    const errorKey = validator ? validator(parsed) : "";
    if (errorKey) {
      setError(t(errorKey, { defaultValue: errorKey }));
      return;
    }
    setError(null);
    if (parsed !== initialValue) {
      onChange(schema.path, parsed);
    }
  };

  return (
    // onBlurCapture intercepts blur event bubbling from NumberInput's <input>
    // (D-7.1 validation gate без модификации NumberInput primitive API)
    <div className="flex flex-col gap-1" onBlurCapture={handleBlur}>
      <label className="flex items-center gap-2">
        <span className="text-mono text-[var(--color-text-secondary)]">{schema.key}</span>
        <InfoTooltipLabel tooltipKey={schema.tooltipKey} fieldKey={schema.key} />
      </label>
      <NumberInput
        value={localValue}
        onChange={(next) => setLocalValue(next)}
        disabled={disabled}
        aria-label={schema.key}
      />
      {error && (
        <span
          id={`error-${schema.path.join("-")}`}
          className="text-body-sm text-[var(--color-danger-500)]"
          role="alert"
          aria-live="polite"
        >
          {error}
        </span>
      )}
    </div>
  );
}
