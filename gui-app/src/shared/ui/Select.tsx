import { forwardRef, type ReactNode, useId, useEffect, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { ChevronDown, Check } from "lucide-react";
import { useDropdownPortal } from "../hooks/useDropdownPortal";
import { cn } from "../lib/cn";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  label?: string;
  description?: string;
  icon?: ReactNode;
  options: SelectOption[];
  value?: string;
  onChange?: (e: { target: { value: string } }) => void;
  placeholder?: string;
  fullWidth?: boolean;
  disabled?: boolean;
  className?: string;
}

export const Select = forwardRef<HTMLButtonElement, SelectProps>(function Select(
  {
    label,
    description,
    icon,
    options,
    value,
    onChange,
    placeholder,
    fullWidth = true,
    disabled = false,
    className,
  },
  ref,
) {
  const { t } = useTranslation();
  const resolvedPlaceholder = placeholder ?? t("select.placeholder");
  const { open, style: dropdownStyle, containerRef, triggerRef, portalRef, toggle, close } =
    useDropdownPortal();

  const listboxId = useId();
  const [highlightedIndex, setHighlightedIndex] = useState<number>(-1);

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selectedLabel = selectedIndex >= 0 ? options[selectedIndex].label : "";

  // Reset highlight when dropdown opens/closes
  useEffect(() => {
    if (open) {
      setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : 0);
    } else {
      setHighlightedIndex(-1);
    }
  }, [open, selectedIndex]);

  const handleSelect = useCallback(
    (optValue: string) => {
      onChange?.({ target: { value: optValue } });
      close();
    },
    [onChange, close],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (disabled) return;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          if (!open) {
            toggle();
          } else {
            setHighlightedIndex((prev) => Math.min(prev + 1, options.length - 1));
          }
          break;
        case "ArrowUp":
          e.preventDefault();
          if (!open) {
            toggle();
          } else {
            setHighlightedIndex((prev) => Math.max(prev - 1, 0));
          }
          break;
        case "Home":
          e.preventDefault();
          if (open) setHighlightedIndex(0);
          break;
        case "End":
          e.preventDefault();
          if (open) setHighlightedIndex(options.length - 1);
          break;
        case "Enter":
          e.preventDefault();
          if (!open) {
            toggle();
          } else if (highlightedIndex >= 0 && highlightedIndex < options.length) {
            handleSelect(options[highlightedIndex].value);
          }
          break;
        case "Escape":
          e.preventDefault();
          close();
          break;
        case "Tab":
          if (open) close();
          break;
      }
    },
    [disabled, open, toggle, close, options, highlightedIndex, handleSelect],
  );

  const activeDescendantId =
    open && highlightedIndex >= 0 ? `${listboxId}-option-${highlightedIndex}` : undefined;

  return (
    <div className={cn(fullWidth ? "w-full" : "")}>
      {label && (
        <label
          className="block text-xs font-[var(--font-weight-semibold)] mb-1.5"
          style={{ color: "var(--color-text-secondary)" }}
        >
          {label}
        </label>
      )}
      {description && (
        <p className="text-[10px] mb-1.5" style={{ color: "var(--color-text-muted)" }}>
          {description}
        </p>
      )}
      <div className={cn("relative", className)} ref={containerRef}>
        <button
          ref={(node) => {
            (triggerRef as React.MutableRefObject<HTMLButtonElement | null>).current = node;
            if (typeof ref === "function") ref(node);
            else if (ref) (ref as React.MutableRefObject<HTMLButtonElement | null>).current = node;
          }}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-activedescendant={activeDescendantId}
          aria-controls={open ? listboxId : undefined}
          onClick={() => {
            if (!disabled) toggle();
          }}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          className={cn(
            "flex items-center justify-between gap-2 w-full",
            "rounded-[var(--radius-md)] px-[var(--space-3)] h-8 text-sm",
            "cursor-pointer transition-colors outline-none",
            "border border-[var(--color-input-border)] bg-[var(--color-input-bg)] text-[var(--color-text-primary)]",
            "focus-visible:shadow-[var(--focus-ring)]",
            disabled && "opacity-[var(--opacity-disabled)] cursor-not-allowed",
            icon && "pl-9",
          )}
        >
          {icon && (
            <span
              className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
              style={{ color: "var(--color-text-muted)" }}
            >
              {icon}
            </span>
          )}
          <span className={cn("truncate", !selectedLabel && "text-[var(--color-text-muted)]")}>
            {selectedLabel || resolvedPlaceholder}
          </span>
          <ChevronDown
            className={cn(
              "w-4 h-4 shrink-0 transition-transform duration-200",
              open && "rotate-180",
            )}
            style={{ color: "var(--color-text-muted)" }}
          />
        </button>

        {open &&
          createPortal(
            <div
              ref={portalRef}
              id={listboxId}
              role="listbox"
              aria-label={label}
              className="animate-[fadeInScale_150ms_ease-out]"
              style={{
                ...dropdownStyle,
                zIndex: "var(--z-dropdown)",
                backgroundColor: "var(--color-bg-elevated)",
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius-md)",
                boxShadow: "var(--shadow-md)",
                minWidth: 120,
                overflow: "hidden",
              }}
            >
              <div className="max-h-48 overflow-y-auto scroll-visible flex flex-col gap-0.5" style={{ padding: "4px" }}>
                {options.map((opt, index) => {
                  const isSelected = opt.value === value;
                  const isHighlighted = index === highlightedIndex;
                  return (
                    <button
                      key={opt.value}
                      id={`${listboxId}-option-${index}`}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => handleSelect(opt.value)}
                      onMouseEnter={() => setHighlightedIndex(index)}
                      className={cn(
                        "w-full flex items-center justify-between gap-2",
                        "px-[var(--space-3)] py-[var(--space-2)] text-xs",
                        "transition-colors rounded-[var(--radius-sm)] cursor-pointer",
                        isSelected
                          ? "bg-[var(--color-bg-active)] text-[var(--color-accent-interactive)]"
                          : isHighlighted
                            ? "bg-[var(--color-bg-hover)] text-[var(--color-text-primary)]"
                            : "bg-transparent text-[var(--color-text-primary)]",
                      )}
                    >
                      <span className="truncate">{opt.label}</span>
                      {isSelected && (
                        <Check className="w-3 h-3 shrink-0 text-[var(--color-accent-interactive)]" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>,
            document.body,
          )}
      </div>
    </div>
  );
});

Select.displayName = "Select";
