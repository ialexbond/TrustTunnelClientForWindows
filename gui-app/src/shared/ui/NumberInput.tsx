import { useState, useCallback, forwardRef, type ChangeEvent, type FocusEvent } from "react";
import { cn } from "../lib/cn";

interface NumberInputProps {
  value: string;
  onChange: (value: string) => void;
  min?: number;
  max?: number;
  label?: string;
  error?: string;
  helperText?: string;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(
  (
    {
      value,
      onChange,
      min,
      max,
      label,
      error: externalError,
      helperText,
      disabled = false,
      placeholder,
      className,
    },
    ref
  ) => {
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
      [onChange, internalError]
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
      [value, min, max]
    );

    const displayError = externalError || internalError;

    return (
      <div className="w-full">
        {label && (
          <label className="block text-[var(--font-size-sm)] font-medium mb-1.5 text-[var(--color-text-secondary)]">
            {label}
          </label>
        )}
        <input
          ref={ref}
          type="text"
          inputMode="numeric"
          value={value}
          onChange={handleChange}
          onBlur={handleBlur}
          disabled={disabled}
          placeholder={placeholder}
          className={cn(
            "h-8 w-full rounded-[var(--radius-md)]",
            "border border-[var(--color-input-border)]",
            "bg-[var(--color-input-bg)]",
            "px-[var(--space-3)]",
            "text-[var(--font-size-md)] text-[var(--color-text-primary)]",
            "placeholder:text-[var(--color-text-muted)]",
            "outline-none",
            "transition-all duration-[var(--transition-fast)]",
            "focus-visible:border-[var(--color-input-focus)] focus-visible:shadow-[var(--focus-ring)]",
            "disabled:opacity-[var(--opacity-disabled)] disabled:cursor-not-allowed",
            displayError && "border-[var(--color-danger-500)] bg-[var(--color-status-error-bg)]",
            className
          )}
        />
        {displayError && (
          <p className="text-[var(--font-size-xs)] mt-1 text-[var(--color-status-error)]">
            {displayError}
          </p>
        )}
        {!displayError && helperText && (
          <p className="text-[var(--font-size-xs)] mt-1 text-[var(--color-text-muted)]">
            {helperText}
          </p>
        )}
      </div>
    );
  }
);

NumberInput.displayName = "NumberInput";
