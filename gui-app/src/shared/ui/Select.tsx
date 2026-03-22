import { forwardRef, type SelectHTMLAttributes, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "children"> {
  label?: string;
  description?: string;
  icon?: ReactNode;
  options: SelectOption[];
  fullWidth?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, description, icon, options, fullWidth = true, className = "", ...props }, ref) => {
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
          <select
            ref={ref}
            className={`
              w-full rounded-[var(--radius-lg)] px-3 py-2.5 text-sm
              appearance-none cursor-pointer
              transition-colors outline-none
              disabled:opacity-50 disabled:cursor-not-allowed
              ${icon ? "pl-9" : ""} pr-8
              ${className}
            `}
            style={{
              backgroundColor: "var(--color-input-bg)",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: "var(--color-input-border)",
              color: "var(--color-text-primary)",
            }}
            {...props}
          >
            {options.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <ChevronDown
            className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none"
            style={{ color: "var(--color-text-muted)" }}
          />
        </div>
      </div>
    );
  }
);

Select.displayName = "Select";
