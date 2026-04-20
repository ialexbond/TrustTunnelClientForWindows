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
      // eslint-disable-next-line react-hooks/set-state-in-effect -- highlight must be ready before keyboard navigation; defer would let first ArrowDown skip the initial item
      setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : 0);
    } else {
      setHighlightedIndex(-1);
    }
  }, [open, selectedIndex]);

  // FIX-D: scroll selected option into view when the dropdown opens.
  // Default browser behavior of a custom listbox is to stay scrolled to the
  // top, which is jarring when the picker has many options (e.g. CIDR
  // prefix 0..32 — selecting "32" then reopening would hide it below scroll).
  // We wait one frame so the portal has mounted and layout is finalized,
  // then scroll the matching `data-selected` item into the listbox viewport.
  useEffect(() => {
    if (!open || selectedIndex < 0) return;
    const raf = requestAnimationFrame(() => {
      const portal = portalRef.current;
      if (!portal) return;
      const item = portal.querySelector<HTMLElement>(
        `[role="option"][data-selected="true"]`,
      );
      // jsdom doesn't implement scrollIntoView — guard so tests don't throw.
      // FIX-G: "center" instead of "nearest" — when selected option is at the
      // edge of the list (e.g. last choice "32") the nearest-block heuristic
      // keeps it at the viewport edge and it reads as "the last item" rather
      // than "my selection". Centering makes it feel like it IS the focus.
      if (item && typeof item.scrollIntoView === "function") {
        item.scrollIntoView({ block: "center", inline: "nearest" });
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [open, selectedIndex, portalRef]);

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
          className="block text-xs font-medium mb-1.5"
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
            triggerRef.current = node;
            if (typeof ref === "function") ref(node);
            else if (ref) ref.current = node;
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
                // dropdownStyle sets width=triggerRect.width so the listbox
                // always matches the trigger. WR-14.1-UAT-05: removed the
                // 120px minWidth floor that made the dropdown wider than
                // narrow triggers (CIDR prefix picker) — now strictly
                // consistent with the trigger width in all cases.
                ...dropdownStyle,
                zIndex: "var(--z-dropdown)",
                backgroundColor: "var(--color-bg-elevated)",
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius-md)",
                boxShadow: "var(--shadow-md)",
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
                      data-selected={isSelected || undefined}
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
