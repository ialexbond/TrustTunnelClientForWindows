import type { ReactNode } from "react";

interface ToggleProps {
  value: boolean;
  onChange: (value: boolean) => void;
  label: string;
  description?: string;
  icon?: ReactNode;
  disabled?: boolean;
}

export function Toggle({ value, onChange, label, description, icon, disabled }: ToggleProps) {
  return (
    <div
      className={`flex items-center justify-between py-2 group ${
        disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
      }`}
      onClick={() => !disabled && onChange(!value)}
    >
      <div className="min-w-0 flex items-start gap-2">
        {icon && <span className="shrink-0 mt-0.5" style={{ color: "var(--color-text-muted)" }}>{icon}</span>}
        <div>
          <span
            className="text-xs font-medium transition-colors"
            style={{ color: "var(--color-text-primary)" }}
          >
            {label}
          </span>
          {description && (
            <p className="text-[10px] mt-0.5" style={{ color: "var(--color-text-muted)" }}>
              {description}
            </p>
          )}
        </div>
      </div>
      <div
        className="relative w-9 h-5 rounded-full shrink-0 ml-3 transition-colors"
        style={{ backgroundColor: value ? "var(--color-toggle-on)" : "var(--color-toggle-off)" }}
      >
        <div
          className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
            value ? "translate-x-[18px]" : "translate-x-0.5"
          }`}
        />
      </div>
    </div>
  );
}
