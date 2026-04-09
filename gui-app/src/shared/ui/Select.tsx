import { type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Check } from "lucide-react";
import { useDropdownPortal } from "../hooks/useDropdownPortal";
import { colors } from "./colors";

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
  const { open, style: dropdownStyle, containerRef, triggerRef, portalRef, toggle, close } = useDropdownPortal();

  const selectedLabel = options.find((o) => o.value === value)?.label ?? "";

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
      <div className={`relative ${className}`} ref={containerRef}>
        <button
          ref={triggerRef}
          type="button"
          onClick={() => { if (!disabled) toggle(); }}
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

        {open && createPortal(
          <div
            ref={portalRef}
            style={{
              ...dropdownStyle,
              zIndex: 9500,
              backgroundColor: "var(--color-bg-elevated)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-lg)",
              boxShadow: colors.dropdownShadow,
              minWidth: 120,
              overflow: "hidden",
            }}
          >
            <div className="max-h-48 overflow-y-auto space-y-0.5" style={{ padding: "4px" }}>
              {options.map((opt) => {
                const isSelected = opt.value === value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => {
                      onChange?.({ target: { value: opt.value } });
                      close();
                    }}
                    className="w-full flex items-center justify-between px-2.5 py-1.5 text-xs transition-colors rounded-[var(--radius-md)]"
                    style={{
                      backgroundColor: isSelected ? colors.accentBg : "transparent",
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
          </div>,
          document.body
        )}
      </div>
    </div>
  );
}

Select.displayName = "Select";
