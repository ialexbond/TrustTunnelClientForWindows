import { useState, forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import { Eye, EyeOff, Lock } from "lucide-react";

interface ActionPasswordInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: string;
  error?: string;
  showLockIcon?: boolean;
  actions?: ReactNode[];
}

export const ActionPasswordInput = forwardRef<HTMLInputElement, ActionPasswordInputProps>(
  ({ label, error, showLockIcon = true, actions, className = "", style, ...rest }, ref) => {
    const [visible, setVisible] = useState(false);
    const actionCount = actions?.length ?? 0;
    // Eye button ~28px, each action ~28px, base right padding 8px
    const rightPadding = `${8 + 28 + actionCount * 28}px`;

    return (
      <div className="w-full">
        {label && (
          <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--color-text-secondary)" }}>
            {label}
          </label>
        )}
        <div className="relative">
          {showLockIcon && (
            <Lock
              className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 pointer-events-none"
              style={{ color: "var(--color-text-muted)" }}
            />
          )}
          <input
            ref={ref}
            type={visible ? "text" : "password"}
            className={`
              w-full rounded-[var(--radius-lg)] h-8 text-xs
              transition-colors outline-none
              placeholder:opacity-40
              disabled:opacity-50 disabled:cursor-not-allowed
              ${showLockIcon ? "pl-9" : "px-3"}
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
          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
            {actions?.map((action, i) => (
              <span key={i} className="flex items-center">
                {action}
              </span>
            ))}
            <button
              type="button"
              tabIndex={-1}
              onClick={() => setVisible(!visible)}
              className="p-1 rounded transition-colors"
              style={{ color: "var(--color-text-muted)" }}
            >
              {visible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            </button>
          </div>
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

ActionPasswordInput.displayName = "ActionPasswordInput";
