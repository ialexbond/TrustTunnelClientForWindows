import React, { useState, useRef, forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import { Eye, EyeOff, Lock, X } from "lucide-react";
import { cn } from "../lib/cn";

interface ActionPasswordInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: string;
  error?: string;
  helperText?: string;
  showLockIcon?: boolean;
  actions?: ReactNode[];
  /** When true, X icon appears when value.length > 0 (positioned left of eye-toggle). */
  clearable?: boolean;
  /** Called when Clear (X) icon clicked. Defaults to onChange('') if not provided. */
  onClear?: () => void;
  /** Called when eye-toggle clicked (for activity logging — D-28). */
  onVisibilityToggle?: () => void;
}

export const ActionPasswordInput = forwardRef<HTMLInputElement, ActionPasswordInputProps>(
  (
    {
      label,
      error,
      helperText,
      showLockIcon = true,
      actions,
      className,
      style,
      clearable,
      onClear,
      onVisibilityToggle,
      ...rest
    },
    ref
  ) => {
    const [visible, setVisible] = useState(false);

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

    const handleVisibilityClick = () => {
      setVisible(!visible);
      onVisibilityToggle?.();
    };

    const actionCount = actions?.length ?? 0;
    const clearCount = showClear ? 1 : 0;
    // Eye always present (1), plus actions, plus optional clear.
    // Each icon ~22px (14px glyph + p-1), gap-1 (4px), base right-2 (8px).
    const totalIconCount = 1 + actionCount + clearCount;
    const rightPadding = `${8 + totalIconCount * 22 + Math.max(0, totalIconCount - 1) * 4}px`;

    return (
      <div className="w-full">
        {label && (
          <label className="block text-sm font-[var(--font-weight-semibold)] mb-1.5 text-[var(--color-text-secondary)]">
            {label}
          </label>
        )}
        <div className="relative">
          {showLockIcon && (
            <Lock className="absolute left-[var(--space-3)] top-1/2 -translate-y-1/2 w-3.5 h-3.5 pointer-events-none text-[var(--color-text-muted)]" />
          )}
          <input
            ref={setRefs}
            type={visible ? "text" : "password"}
            className={cn(
              "h-8 w-full rounded-[var(--radius-md)]",
              "border border-[var(--color-input-border)]",
              "bg-[var(--color-input-bg)]",
              "text-sm text-[var(--color-text-primary)]",
              "placeholder:text-[var(--color-text-muted)]",
              "outline-none",
              "transition-all duration-[var(--transition-fast)]",
              "focus-visible:border-[var(--color-input-focus)] focus-visible:shadow-[var(--focus-ring)]",
              "disabled:opacity-[var(--opacity-disabled)] disabled:cursor-not-allowed",
              error && "border-[var(--color-danger-500)] bg-[var(--color-status-error-bg)]",
              showLockIcon ? "pl-9" : "px-[var(--space-3)]",
              className
            )}
            style={{
              paddingRight: rightPadding,
              ...style,
            }}
            {...rest}
          />
          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
            {actions?.map((action, i) => (
              <span
                key={i}
                className="flex items-center p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
              >
                {action}
              </span>
            ))}
            {showClear && (
              <button
                type="button"
                tabIndex={-1}
                onClick={handleClear}
                aria-label="Clear field"
                className={cn(
                  "p-1 rounded",
                  "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]",
                  "transition-colors duration-[var(--transition-fast)]"
                )}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              type="button"
              tabIndex={-1}
              onClick={handleVisibilityClick}
              className={cn(
                "p-1 rounded",
                "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]",
                "transition-colors duration-[var(--transition-fast)]"
              )}
            >
              {visible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            </button>
          </div>
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

ActionPasswordInput.displayName = "ActionPasswordInput";
