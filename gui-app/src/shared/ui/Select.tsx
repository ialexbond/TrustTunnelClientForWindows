import { useState, useRef, useEffect, type ReactNode } from "react";
import { ChevronDown, Check } from "lucide-react";

interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  label?: string;
  description?: string;
  icon?: ReactNode;
  options: SelectOption[];
  value?: string;
  onChange?: (e: { target: { value: string } }) => void;
  fullWidth?: boolean;
  disabled?: boolean;
  className?: string;
}

export function Select({
  label,
  description,
  icon,
  options,
  value,
  onChange,
  fullWidth = true,
  disabled = false,
  className = "",
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const selectedLabel = options.find((o) => o.value === value)?.label ?? "";

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

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
      <div className={`relative ${className}`} ref={ref}>
        <button
          type="button"
          onClick={() => !disabled && setOpen(!open)}
          className={`
            flex items-center justify-between gap-2 rounded-[var(--radius-lg)] px-3 h-8 text-xs
            cursor-pointer transition-colors outline-none
            w-full
            ${disabled ? "opacity-50 cursor-not-allowed" : ""}
            ${icon ? "pl-9" : ""}
          `}
          style={{
            backgroundColor: "var(--color-input-bg)",
            border: "1px solid var(--color-input-border)",
            color: "var(--color-text-primary)",
          }}
        >
          {icon && (
            <span
              className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
              style={{ color: "var(--color-text-muted)" }}
            >
              {icon}
            </span>
          )}
          <span className="truncate">{selectedLabel}</span>
          <ChevronDown
            className="w-4 h-4 shrink-0 transition-transform duration-200"
            style={{
              color: "var(--color-text-muted)",
              transform: open ? "rotate(180deg)" : "rotate(0deg)",
            }}
          />
        </button>

        {open && (
          <div
            className="absolute z-50 mt-1 w-full min-w-[120px] overflow-hidden rounded-[var(--radius-lg)] shadow-xl"
            style={{
              backgroundColor: "var(--color-bg-elevated)",
              border: "1px solid var(--color-border)",
              boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
            }}
          >
            <div className="max-h-48 overflow-y-auto" style={{ padding: "4px" }}>
              {options.map((opt) => {
                const isSelected = opt.value === value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => {
                      onChange?.({ target: { value: opt.value } });
                      setOpen(false);
                    }}
                    className="w-full flex items-center justify-between px-2.5 py-1.5 text-xs transition-colors rounded-[var(--radius-md)]"
                    style={{
                      backgroundColor: isSelected ? "rgba(99, 102, 241, 0.1)" : "transparent",
                      color: isSelected ? "var(--color-accent-500)" : "var(--color-text-primary)",
                    }}
                    onMouseEnter={(e) => {
                      if (!isSelected) e.currentTarget.style.backgroundColor = "var(--color-bg-hover)";
                    }}
                    onMouseLeave={(e) => {
                      if (!isSelected) e.currentTarget.style.backgroundColor = "transparent";
                    }}
                  >
                    <span>{opt.label}</span>
                    {isSelected && <Check className="w-3 h-3 shrink-0" />}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

Select.displayName = "Select";
