import { useState, useCallback, type ChangeEvent, type FocusEvent } from "react";

interface NumberInputProps {
  value: string;
  onChange: (value: string) => void;
  min?: number;
  max?: number;
  label?: string;
  error?: string;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  label,
  error: externalError,
  disabled = false,
  placeholder,
  className = "",
}: NumberInputProps) {
  const [internalError, setInternalError] = useState("");

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value;
      // Filter to digits only
      const digits = raw.replace(/\D/g, "");
      onChange(digits);
      // Clear error when user is typing
      if (internalError) setInternalError("");
    },
    [onChange, internalError],
  );

  const handleBlur = useCallback(
    (_e: FocusEvent<HTMLInputElement>) => {
      if (!value) {
        setInternalError("");
        return;
      }
      const num = parseInt(value, 10);
      if (min !== undefined && num < min) {
        setInternalError(`Min: ${min}`);
        return;
      }
      if (max !== undefined && num > max) {
        setInternalError(`Max: ${max}`);
        return;
      }
      setInternalError("");
    },
    [value, min, max],
  );

  const displayError = externalError || internalError;

  return (
    <div className="w-full">
      {label && (
        <label
          className="block text-xs font-medium mb-1.5"
          style={{ color: "var(--color-text-secondary)" }}
        >
          {label}
        </label>
      )}
      <input
        type="text"
        inputMode="numeric"
        value={value}
        onChange={handleChange}
        onBlur={handleBlur}
        disabled={disabled}
        placeholder={placeholder}
        className={`
          w-full rounded-[var(--radius-lg)] px-3 h-8 text-xs
          transition-colors outline-none
          placeholder:opacity-40
          disabled:opacity-50 disabled:cursor-not-allowed
          ${displayError ? "ring-1 ring-[var(--color-danger-500)]" : ""}
          ${className}
        `}
        style={{
          backgroundColor: "var(--color-input-bg)",
          border: `1px solid ${displayError ? "var(--color-danger-500)" : "var(--color-input-border)"}`,
          color: "var(--color-text-primary)",
        }}
      />
      {displayError && (
        <p className="text-[11px] mt-1" style={{ color: "var(--color-danger-400)" }}>
          {displayError}
        </p>
      )}
    </div>
  );
}
