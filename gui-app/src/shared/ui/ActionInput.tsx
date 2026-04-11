import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";

interface ActionInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  description?: string;
  leftIcon?: ReactNode;
  actions?: ReactNode[];
  error?: string;
  fullWidth?: boolean;
}

export const ActionInput = forwardRef<HTMLInputElement, ActionInputProps>(
  ({ label, description, leftIcon, actions, error, fullWidth = true, className = "", style, ...rest }, ref) => {
    const actionCount = actions?.length ?? 0;
    // Each action ~28px (icon 14px + gap 4px + padding), base right padding 8px
    const rightPadding = actionCount > 0 ? `${8 + actionCount * 28}px` : undefined;

    return (
      <div className={fullWidth ? "w-full" : ""}>
        {label && (
          <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--color-text-secondary)" }}>
            {label}
          </label>
        )}
        {description && (
          <p className="text-[10px] mb-1.5" style={{ color: "var(--color-text-muted)" }}>
            {description}
          </p>
        )}
        <div className="relative">
          {leftIcon && (
            <span
              className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
              style={{ color: "var(--color-text-muted)" }}
            >
              {leftIcon}
            </span>
          )}
          <input
            ref={ref}
            className={`
              w-full rounded-[var(--radius-lg)] px-3 h-8 text-xs
              transition-colors outline-none
              placeholder:opacity-40
              disabled:opacity-50 disabled:cursor-not-allowed
              ${leftIcon ? "pl-9" : ""}
              ${error ? "ring-1 ring-[var(--color-danger-500)]" : ""}
              ${className}
            `}
            style={{
              backgroundColor: "var(--color-input-bg)",
              border: `1px solid ${error ? "var(--color-danger-500)" : "var(--color-input-border)"}`,
              color: "var(--color-text-primary)",
              paddingRight: rightPadding,
              ...style,
            }}
            {...rest}
          />
          {actionCount > 0 && (
            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
              {actions!.map((action, i) => (
                <span key={i} className="flex items-center">
                  {action}
                </span>
              ))}
            </div>
          )}
        </div>
        {error && (
          <p className="text-[11px] mt-1" style={{ color: "var(--color-danger-400)" }}>
            {error}
          </p>
        )}
      </div>
    );
  }
);

ActionInput.displayName = "ActionInput";
