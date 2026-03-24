import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  description?: string;
  icon?: ReactNode;
  error?: string;
  fullWidth?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, description, icon, error, fullWidth = true, className = "", style, ...rest }, ref) => {
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
          {icon && (
            <span
              className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
              style={{ color: "var(--color-text-muted)" }}
            >
              {icon}
            </span>
          )}
          <input
            ref={ref}
            className={`
              w-full rounded-[var(--radius-lg)] px-3 py-2.5 text-sm
              transition-colors outline-none
              placeholder:opacity-40
              disabled:opacity-50 disabled:cursor-not-allowed
              ${icon ? "pl-9" : ""}
              ${error ? "ring-1 ring-[var(--color-danger-500)]" : ""}
              ${className}
            `}
            style={{
              backgroundColor: "var(--color-input-bg)",
              border: `1px solid ${error ? "var(--color-danger-500)" : "var(--color-input-border)"}`,
              color: "var(--color-text-primary)",
              ...style,
            }}
            {...rest}
          />
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

Input.displayName = "Input";
