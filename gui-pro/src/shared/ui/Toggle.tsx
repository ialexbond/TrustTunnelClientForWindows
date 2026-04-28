import { forwardRef, type ReactNode } from "react";

interface ToggleProps {
  checked?: boolean;
  /** @deprecated Use checked */
  value?: boolean;
  onChange: (value: boolean) => void;
  label?: string;
  description?: string;
  icon?: ReactNode;
  labelExtra?: ReactNode;
  disabled?: boolean;
  className?: string;
  /**
   * Phase 15.1: a11y label для случаев когда Toggle используется без
   * внутреннего `label` prop (e.g. ToggleField wrapping schema-driven layout).
   * Renders на role="switch" button. Без него screen-reader полагается на
   * соседний визуальный текст — приемлемо, но явный label предпочтительнее.
   */
  "aria-label"?: string;
}

export const Toggle = forwardRef<HTMLButtonElement, ToggleProps>(
  (
    {
      checked,
      value,
      onChange,
      label,
      description,
      icon,
      labelExtra,
      disabled,
      className = "",
      "aria-label": ariaLabel,
    },
    ref
  ) => {
    const isChecked = checked ?? value ?? false;

    return (
      <div
        className={`flex items-center justify-between py-2 ${
          disabled ? "opacity-[var(--opacity-disabled)]" : ""
        } ${className}`}
      >
        {(label || icon) && (
          <div className="min-w-0 flex items-center gap-2">
            {icon && (
              <span
                className="shrink-0"
                style={{ color: "var(--color-text-muted)" }}
              >
                {icon}
              </span>
            )}
            <div>
              {label && (
                <span className="flex items-center gap-1">
                  <span
                    className="text-xs font-semibold"
                    style={{ color: "var(--color-text-primary)" }}
                  >
                    {label}
                  </span>
                  {labelExtra}
                </span>
              )}
              {description && (
                <p
                  className="text-xs mt-0.5"
                  style={{ color: "var(--color-text-muted)" }}
                >
                  {description}
                </p>
              )}
            </div>
          </div>
        )}
        <button
          ref={ref}
          type="button"
          role="switch"
          aria-checked={isChecked}
          aria-label={ariaLabel}
          onClick={() => !disabled && onChange(!isChecked)}
          disabled={disabled}
          className={`
            relative w-9 h-5 rounded-full shrink-0 ml-3
            transition-colors duration-[var(--transition-fast)]
            focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]
            ${disabled ? "cursor-not-allowed" : "cursor-pointer"}
          `}
          style={{
            backgroundColor: isChecked
              ? "var(--color-toggle-on)"
              : "var(--color-toggle-off)",
          }}
        >
          <div
            className={`
              absolute top-0.5 w-4 h-4 rounded-full bg-[var(--color-toggle-thumb)] shadow
              transition-transform duration-[var(--transition-fast)]
              ${isChecked ? "translate-x-[18px]" : "translate-x-0.5"}
            `}
          />
        </button>
      </div>
    );
  }
);

Toggle.displayName = "Toggle";
