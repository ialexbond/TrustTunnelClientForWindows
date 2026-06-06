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
   * Explicit a11y name for the role="switch" button. Use this only when the
   * desired accessible name differs from the visible `label` (or when Toggle is
   * rendered without a `label`, e.g. ToggleField wrapping schema-driven layout).
   *
   * D-03.2: when a visible `label` is provided, it is now forwarded to the
   * switch accessible name automatically — so most call sites no longer need a
   * separate `aria-label`. An explicit `aria-label` still overrides the label.
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

    // D-03.2 (Users H-07): forward the visible `label` to the role="switch"
    // accessible name so screen readers announce the toggle and tests can query
    // getByRole("switch", { name }). An explicit `aria-label` prop still wins
    // (used where the visible label differs from the desired a11y name). The
    // visible label DOM below is unchanged — this only adds the accessible name.
    const switchAccessibleName = ariaLabel ?? label;

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
          aria-label={switchAccessibleName}
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
