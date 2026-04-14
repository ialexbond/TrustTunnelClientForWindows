import { useState, forwardRef, type InputHTMLAttributes } from "react";
import { Eye, EyeOff, Lock } from "lucide-react";
import { cn } from "../lib/cn";

interface PasswordInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: string;
  error?: string;
  helperText?: string;
  showIcon?: boolean;
}

export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  ({ label, error, helperText, showIcon = true, className, ...rest }, ref) => {
    const [visible, setVisible] = useState(false);

    return (
      <div className="w-full">
        {label && (
          <label className="block text-sm font-[var(--font-weight-semibold)] mb-1.5 text-[var(--color-text-secondary)]">
            {label}
          </label>
        )}
        <div className="relative">
          {showIcon && (
            <Lock className="absolute left-[var(--space-3)] top-1/2 -translate-y-1/2 w-3.5 h-3.5 pointer-events-none text-[var(--color-text-muted)]" />
          )}
          <input
            ref={ref}
            type={visible ? "text" : "password"}
            className={cn(
              "h-8 w-full rounded-[var(--radius-md)]",
              "border border-[var(--color-input-border)]",
              "bg-[var(--color-input-bg)]",
              "pr-10",
              "text-sm leading-8 text-[var(--color-text-primary)]",
              "placeholder:text-[var(--color-text-muted)]",
              "outline-none",
              "transition-all duration-[var(--transition-fast)]",
              "focus-visible:border-[var(--color-input-focus)] focus-visible:shadow-[var(--focus-ring)]",
              "disabled:opacity-[var(--opacity-disabled)] disabled:cursor-not-allowed",
              error && "border-[var(--color-danger-500)] bg-[var(--color-status-error-bg)]",
              showIcon ? "pl-9" : "px-[var(--space-3)]",
              className
            )}
            {...rest}
          />
          <button
            type="button"
            tabIndex={-1}
            onClick={() => setVisible(!visible)}
            className={cn(
              "absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded",
              "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]",
              "transition-colors duration-[var(--transition-fast)]"
            )}
          >
            {visible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
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

PasswordInput.displayName = "PasswordInput";
