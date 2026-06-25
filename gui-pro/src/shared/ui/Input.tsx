import React, { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "../lib/cn";
import { FieldError } from "./FieldError";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  // UAT (06-uat fix 1): ReactNode (was string) so a label can carry the required «*»
  // marker element — matching ActionInput/ActionPasswordInput, which already accept
  // ReactNode. The domain + email LE fields render `<>{label} <span>*</span></>`.
  label?: ReactNode;
  icon?: ReactNode;
  error?: string;
  helperText?: string;
  clearable?: boolean;
  fullWidth?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    {
      label,
      icon,
      error,
      helperText,
      clearable,
      fullWidth = true,
      className,
      value,
      onChange,
      id,
      // Destructured out of `...rest` so the clear-× can mirror it: a disabled field keeps
      // the clear button VISIBLE (so the field looks identical enabled vs disabled — no
      // layout shift) but disables it, so a locked field can never be wiped. Re-forwarded
      // to the <input> below since it's no longer in `...rest`.
      disabled,
      ...rest
    },
    ref
  ) => {
    const inputRef = React.useRef<HTMLInputElement | null>(null);
    // A11Y-03: associate the <label> with the <input> via htmlFor/id so screen
    // readers announce the label on focus and getByLabelText resolves them. An
    // explicit `id` prop wins; otherwise a stable useId fallback is generated.
    const generatedId = useId();
    const inputId = id ?? generatedId;
    const hasAdornment = !!icon || !!clearable;
    const showClear = clearable && value !== undefined && value !== "";

    const handleClear = () => {
      if (onChange) {
        const event = { target: { value: "" } } as React.ChangeEvent<HTMLInputElement>;
        onChange(event);
      }
      inputRef.current?.focus();
    };

    return (
      <div className={fullWidth ? "w-full" : ""}>
        {label && (
          <label
            htmlFor={inputId}
            className="block text-sm font-medium mb-1.5 text-[var(--color-text-secondary)]"
          >
            {label}
          </label>
        )}
        <div className={cn(hasAdornment ? "relative" : "")}>
          {icon && (
            <span className="absolute left-[var(--space-3)] top-1/2 -translate-y-1/2 pointer-events-none text-[var(--color-text-muted)]">
              {icon}
            </span>
          )}
          <input
            id={inputId}
            ref={(node) => {
              inputRef.current = node;
              if (typeof ref === "function") ref(node);
              else if (ref) ref.current = node;
            }}
            value={value}
            onChange={onChange}
            disabled={disabled}
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
              // FIX-II: error state = red border only, no tinted background.
              // Red fill felt alarming for routine validation — border speaks
              // just as clearly and keeps the input visually calm.
              error && "border-[var(--color-danger-500)]",
              icon && "pl-9",
              showClear && "pr-8",
              className
            )}
            {...rest}
          />
          {showClear && (
            <button
              type="button"
              tabIndex={-1}
              onClick={handleClear}
              // A disabled field must not be wipeable: the clear-× stays VISIBLE (stable look)
              // but is itself disabled + greyed, so it can't clear a locked field.
              disabled={disabled}
              aria-label="Clear"
              className={cn(
                "absolute right-[var(--space-2)] top-1/2 -translate-y-1/2",
                "p-0.5 rounded",
                "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]",
                "transition-colors duration-[var(--transition-fast)]",
                "disabled:cursor-not-allowed disabled:opacity-[var(--opacity-disabled)] disabled:hover:text-[var(--color-text-muted)]"
              )}
            >
              <X size={14} />
            </button>
          )}
        </div>
        <FieldError>{error}</FieldError>
        {!error && helperText && (
          <p className="text-xs mt-1 text-[var(--color-text-muted)]">
            {helperText}
          </p>
        )}
      </div>
    );
  }
);

Input.displayName = "Input";
