import { useState, forwardRef, type InputHTMLAttributes } from "react";
import { Eye, EyeOff, Lock } from "lucide-react";

interface PasswordInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: string;
  error?: string;
  showIcon?: boolean;
}

export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  ({ label, error, showIcon = true, className = "", ...props }, ref) => {
    const [visible, setVisible] = useState(false);

    return (
      <div className="w-full">
        {label && (
          <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--color-text-secondary)" }}>
            {label}
          </label>
        )}
        <div className="relative">
          {showIcon && (
            <Lock
              className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 pointer-events-none"
              style={{ color: "var(--color-text-muted)" }}
            />
          )}
          <input
            ref={ref}
            type={visible ? "text" : "password"}
            className={`
              w-full rounded-[var(--radius-lg)] py-2.5 text-sm pr-10
              transition-colors outline-none
              placeholder:opacity-40
              ${showIcon ? "pl-9" : "px-3"}
              ${error ? "ring-1 ring-[var(--color-danger-500)]" : ""}
              ${className}
            `}
            style={{
              backgroundColor: "var(--color-input-bg)",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: error ? "var(--color-danger-500)" : "var(--color-input-border)",
              color: "var(--color-text-primary)",
            }}
            {...props}
          />
          <button
            type="button"
            tabIndex={-1}
            onClick={() => setVisible(!visible)}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded transition-colors"
            style={{ color: "var(--color-text-muted)" }}
          >
            {visible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
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

PasswordInput.displayName = "PasswordInput";
