import React, { forwardRef, useRef, type InputHTMLAttributes, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "../lib/cn";
import { Tooltip } from "./Tooltip";

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
  /**
   * aria-label for the Clear button. i18n is owned by the caller; shared/ui must
   * not import useTranslation directly (layer separation). Defaults to English
   * "Clear field" so Storybook usage without i18n still passes A11y.
   */
  clearAriaLabel?: string;
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
      clearAriaLabel,
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
              "transition-[border-color,box-shadow,background-color] duration-[var(--transition-fast)]",
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
                <Tooltip text={clearAriaLabel ?? "Clear field"}>
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={handleClear}
                    disabled={rest.disabled}
                    aria-label={clearAriaLabel ?? "Clear field"}
                    className={cn(
                      "flex items-center p-1 rounded",
                      "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]",
                      "transition-colors duration-[var(--transition-fast)]",
                      "disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:text-[var(--color-text-muted)]"
                    )}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </Tooltip>
              )}
              {actions?.map((action, i) => (
                <span key={i} className="flex items-center">
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
