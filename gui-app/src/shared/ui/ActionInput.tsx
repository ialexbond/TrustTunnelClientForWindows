import React, { forwardRef, useRef, type InputHTMLAttributes, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "../lib/cn";

interface ActionInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  description?: string;
  leftIcon?: ReactNode;
  actions?: ReactNode[];
  error?: string;
  helperText?: string;
  fullWidth?: boolean;
  /** When true, X icon appears when value.length > 0. Clicking clears the field. */
  clearable?: boolean;
  /** Called when Clear (X) icon clicked. If not provided, onChange is called with empty value. */
  onClear?: () => void;
}

export const ActionInput = forwardRef<HTMLInputElement, ActionInputProps>(
  (
    {
      label,
      description,
      leftIcon,
      actions,
      error,
      helperText,
      fullWidth = true,
      className,
      style,
      clearable,
      onClear,
      ...rest
    },
    ref
  ) => {
    const internalRef = useRef<HTMLInputElement | null>(null);
    const setRefs = (node: HTMLInputElement | null) => {
      internalRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    };

    const value = rest.value;
    const showClear =
      clearable !== undefined &&
      clearable &&
      value !== undefined &&
      String(value).length > 0;

    const handleClear = () => {
      if (onClear) {
        onClear();
      } else if (rest.onChange) {
        const event = {
          target: { value: "" },
        } as React.ChangeEvent<HTMLInputElement>;
        rest.onChange(event);
      }
      internalRef.current?.focus();
    };

    const actionCount = actions?.length ?? 0;
    const clearCount = showClear ? 1 : 0;
    const effectiveActionCount = actionCount + clearCount;
    // Each action ~28px (icon 14px + gap 4px + padding), base right padding 8px
    const rightPadding =
      effectiveActionCount > 0 ? `${8 + effectiveActionCount * 28}px` : undefined;

    return (
      <div className={fullWidth ? "w-full" : ""}>
        {label && (
          <label className="block text-sm font-[var(--font-weight-semibold)] mb-1.5 text-[var(--color-text-secondary)]">
            {label}
          </label>
        )}
        {description && (
          <p className="text-xs mb-1.5 text-[var(--color-text-muted)]">
            {description}
          </p>
        )}
        <div className="relative">
          {leftIcon && (
            <span className="absolute left-[var(--space-3)] top-1/2 -translate-y-1/2 pointer-events-none text-[var(--color-text-muted)]">
              {leftIcon}
            </span>
          )}
          <input
            ref={setRefs}
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
              error && "border-[var(--color-danger-500)] bg-[var(--color-status-error-bg)]",
              leftIcon && "pl-9",
              className
            )}
            style={{
              paddingRight: rightPadding,
              ...style,
            }}
            {...rest}
          />
          {(actionCount > 0 || showClear) && (
            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
              {showClear && (
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={handleClear}
                  aria-label="Clear field"
                  className={cn(
                    "flex items-center p-1 rounded",
                    "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]",
                    "transition-colors duration-[var(--transition-fast)]"
                  )}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
              {actions?.map((action, i) => (
                <span
                  key={i}
                  className="flex items-center p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                >
                  {action}
                </span>
              ))}
            </div>
          )}
        </div>
        {error && (
          <p className="text-xs mt-1 text-[var(--color-status-error)]">
            {error}
          </p>
        )}
        {!error && helperText && (
          <p className="text-xs mt-1 text-[var(--color-text-muted)]">
            {helperText}
          </p>
        )}
      </div>
    );
  }
);

ActionInput.displayName = "ActionInput";
