import { useState, useEffect, useRef } from "react";
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

  // Hooks must be called unconditionally (react-hooks/rules-of-hooks).
  // Defensive guard для non-string kind рендерится null ниже, ПОСЛЕ всех hooks.
  const initialValue = schema.type.kind === "string" ? schema.type.value : "";

  const [localValue, setLocalValue] = useState<string>(initialValue);
  const [error, setError] = useState<string | null>(null);

  // H-3 (Plan 15): the onBlur commit baseline lives in a ref that is re-anchored
  // in lock-step with the local buffer whenever the schema updates externally
  // (bundle reload, discardAll, or the per-edit tree refresh from
  // useTomlConfigState). The audit flagged comparing the typed value against a
  // value that could drift from the live schema; keeping the baseline in a ref
  // updated by the SAME sync effect guarantees `handleBlur` always compares
  // against the current schema value, never a stale snapshot — so a real edit is
  // never suppressed and a no-op blur after an external update never re-emits.
  const baselineRef = useRef<string>(initialValue);

  // Re-sync local state when schema value changes externally
  // (e.g., bundle reload, discardAll). D-7.1 onBlur pattern needs a local
  // buffer that mirrors parent state when the parent updates externally.
  // Legit "external sync" case per react.dev (resetting on prop change).
  useEffect(() => {
    const next = schema.type.kind === "string" ? schema.type.value : "";
    /* eslint-disable react-hooks/set-state-in-effect */
    setLocalValue(next);
    setError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    // Re-anchor the commit baseline together with the buffer (H-3).
    baselineRef.current = next;
  }, [schema.type]);

  if (schema.type.kind !== "string") return null;

  const handleBlur = () => {
    const errorKey = validator ? validator(localValue) : "";
    if (errorKey) {
      setError(t(errorKey, { defaultValue: errorKey }));
      return;
    }
    setError(null);
    // Only emit change if it differs from the current schema baseline (H-3 ref).
    if (localValue !== baselineRef.current) {
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
          className="text-body-sm text-[var(--color-danger-fg)]"
          role="alert"
        >
          {error}
        </span>
      )}
    </div>
  );
}
