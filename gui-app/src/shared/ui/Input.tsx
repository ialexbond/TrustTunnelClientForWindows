import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "../lib/cn";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  description?: string;
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
      description,
      icon,
      error,
      helperText,
      clearable,
      fullWidth = true,
      className,
      value,
      onChange,
      ...rest
    },
    ref
  ) => {
    const hasAdornment = !!icon || !!clearable;
    const showClear = clearable && value !== undefined && value !== "";

    const handleClear = () => {
      if (onChange) {
        const event = { target: { value: "" } } as React.ChangeEvent<HTMLInputElement>;
        onChange(event);
      }
    };

    return (
      <div className={fullWidth ? "w-full" : ""}>
        {label && (
          <label
            className="block text-[var(--font-size-sm)] font-medium mb-1.5 text-[var(--color-text-secondary)]"
          >
            {label}
          </label>
        )}
        {description && (
          <p className="text-[var(--font-size-xs)] mb-1.5 text-[var(--color-text-muted)]">
            {description}
          </p>
        )}
        <div className={cn(hasAdornment ? "relative" : "")}>
          {icon && (
            <span className="absolute left-[var(--space-3)] top-1/2 -translate-y-1/2 pointer-events-none text-[var(--color-text-muted)]">
              {icon}
            </span>
          )}
          <input
            ref={ref}
            value={value}
            onChange={onChange}
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
              error && "border-[var(--color-danger-500)] bg-[var(--color-status-error-bg)]",
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
              aria-label="Clear"
              className={cn(
                "absolute right-2 top-1/2 -translate-y-1/2",
                "p-0.5 rounded",
                "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]",
                "transition-colors duration-[var(--transition-fast)]"
              )}
            >
              <X size={14} />
            </button>
          )}
        </div>
        {error && (
          <p className="text-[var(--font-size-xs)] mt-1 text-[var(--color-status-error)]">
            {error}
          </p>
        )}
        {!error && helperText && (
          <p className="text-[var(--font-size-xs)] mt-1 text-[var(--color-text-muted)]">
            {helperText}
          </p>
        )}
      </div>
    );
  }
);

Input.displayName = "Input";
