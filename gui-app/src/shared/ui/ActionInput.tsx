import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import { cn } from "../lib/cn";

interface ActionInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  description?: string;
  leftIcon?: ReactNode;
  actions?: ReactNode[];
  error?: string;
  helperText?: string;
  fullWidth?: boolean;
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
      ...rest
    },
    ref
  ) => {
    const actionCount = actions?.length ?? 0;
    // Each action ~28px (icon 14px + gap 4px + padding), base right padding 8px
    const rightPadding = actionCount > 0 ? `${8 + actionCount * 28}px` : undefined;

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
            ref={ref}
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
          {actionCount > 0 && (
            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
              {actions!.map((action, i) => (
                <span key={i} className="flex items-center p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]">
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
