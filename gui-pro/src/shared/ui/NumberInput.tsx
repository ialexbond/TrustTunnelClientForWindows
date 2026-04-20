import {
  useState,
  useCallback,
  useEffect,
  forwardRef,
  type ChangeEvent,
  type ClipboardEvent,
  type FocusEvent,
  type KeyboardEvent,
} from "react";
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
  /** Hard cap on number of digits accepted (physical input guard). */
  maxLength?: number;
  /** Called when the displayed error state flips. Lets parents aggregate
      validation across multiple fields (e.g. CIDRPicker reserving space
      under the row only when at least one octet has an inline error). */
  onErrorChange?: (hasError: boolean) => void;
  /** Passthrough: custom paste handler. CIDRPicker uses it to intercept
      `109.194.163.8` / `10.0.0.0/24` strings and fan them out across all
      four octet inputs + the prefix Select. Call preventDefault in your
      handler to stop the default single-field paste. */
  onPaste?: (e: ClipboardEvent<HTMLInputElement>) => void;
  /** Passthrough: custom key handler. CIDRPicker использует для
      backspace-переключения между октетами. */
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  /**
   * How to render the inline error/helper text beneath the input.
   * - "block" (default): renders <p> under the input (parent container grows).
   * - "none": parent handles error display externally — component stays a
   *   single-row input so stacking with dots/labels does not jitter when an
   *   error appears (WR-14.1-UAT-06 CIDRPicker layout).
   */
  errorDisplay?: "block" | "none";
  "aria-label"?: string;
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
      maxLength,
      errorDisplay = "block",
      onErrorChange,
      onPaste,
      onKeyDown,
      "aria-label": ariaLabel,
    },
    ref
  ) => {
    const [internalError, setInternalError] = useState("");

    // FIX-F: notify parent whenever the displayed error state flips. Parent
    // aggregates per-field errors to decide things like whether to reserve
    // layout space. No-op when `onErrorChange` is not passed.
    useEffect(() => {
      onErrorChange?.(Boolean(externalError) || internalError !== "");
    }, [externalError, internalError, onErrorChange]);

    const handleChange = useCallback(
      (e: ChangeEvent<HTMLInputElement>) => {
        const raw = e.target.value;
        // Filter to digits only
        let digits = raw.replace(/\D/g, "");
        // WR-14.1-UAT-06: physical input guard — truncate rather than accept
        // and flag as error on blur. Matches HTML <input maxlength> semantics.
        if (maxLength !== undefined && digits.length > maxLength) {
          digits = digits.slice(0, maxLength);
        }
        onChange(digits);
        // Clear error when user is typing
        if (internalError) setInternalError("");
      },
      [onChange, internalError, maxLength]
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
      <div className="w-full relative">
        {label && (
          <label className="block text-sm font-medium mb-1.5 text-[var(--color-text-secondary)]">
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
          onPaste={onPaste}
          onKeyDown={onKeyDown}
          disabled={disabled}
          placeholder={placeholder}
          aria-label={ariaLabel}
          aria-invalid={displayError ? true : undefined}
          maxLength={maxLength}
          className={cn(
            "h-8 w-full rounded-[var(--radius-md)]",
            "border border-[var(--color-input-border)]",
            "bg-[var(--color-input-bg)]",
            "px-[var(--space-3)]",
            "text-sm text-[var(--color-text-primary)]",
            "placeholder:text-[var(--color-text-muted)]",
            "outline-none",
            "transition-all duration-[var(--transition-fast)]",
            "focus-visible:border-[var(--color-input-focus)] focus-visible:shadow-[var(--focus-ring)]",
            "disabled:opacity-[var(--opacity-disabled)] disabled:cursor-not-allowed",
            // FIX-E: only color the border red — dropping the red bg because it
            // was visually heavy for a simple "Max: 255" hint and fought with
            // tokens-based theming in dark mode.
            displayError && "border-[var(--color-danger-500)]",
            className
          )}
        />
        {/* FIX-E: error/helper absolutely positioned below the input so adding
            or removing them never pushes the input up or down (matters when
            a NumberInput sits in a flex row with siblings like the CIDR dot
            separators). The parent `div` is `relative` to anchor the message. */}
        {errorDisplay === "block" && displayError && (
          <p className="absolute top-full left-0 mt-1 text-xs text-[var(--color-status-error)] whitespace-nowrap pointer-events-none">
            {displayError}
          </p>
        )}
        {errorDisplay === "block" && !displayError && helperText && (
          <p className="absolute top-full left-0 mt-1 text-xs text-[var(--color-text-muted)] whitespace-nowrap pointer-events-none">
            {helperText}
          </p>
        )}
      </div>
    );
  }
);

NumberInput.displayName = "NumberInput";
