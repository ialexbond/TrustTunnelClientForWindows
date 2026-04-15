import { useState, forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import { Eye, EyeOff, Lock } from "lucide-react";
import { cn } from "../lib/cn";

interface ActionPasswordInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: string;
  error?: string;
  helperText?: string;
  showLockIcon?: boolean;
  actions?: ReactNode[];
}

export const ActionPasswordInput = forwardRef<HTMLInputElement, ActionPasswordInputProps>(
  ({ label, error, helperText, showLockIcon = true, actions, className, style, ...rest }, ref) => {
    const [visible, setVisible] = useState(false);
    const actionCount = actions?.length ?? 0;
    // Eye ~22px (14px icon + p-1), each action ~22px, gap-1 (4px), right-2 (8px)
    const rightPadding = `${8 + (1 + actionCount) * 22 + actionCount * 4}px`;

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
            ref={ref}
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
              <span key={i} className="flex items-center p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]">
                {action}
              </span>
            ))}
            <button
              type="button"
              tabIndex={-1}
              onClick={() => setVisible(!visible)}
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
