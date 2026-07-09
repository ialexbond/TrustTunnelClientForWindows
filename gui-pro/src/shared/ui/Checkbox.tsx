import { forwardRef } from "react";
import { Check } from "lucide-react";

interface CheckboxProps {
  /** Current checked state (controlled). */
  checked: boolean;
  /** Called with the NEXT value when the user toggles. */
  onChange: (value: boolean) => void;
  /**
   * Visible, clickable label rendered to the right of the box. When present it
   * also supplies the control's accessible name (the label lives INSIDE the
   * button, so its text content names the role="checkbox").
   */
  label?: string;
  /**
   * Explicit accessible name. Use only when there is no visible `label` (icon-only
   * row) or when the desired a11y name differs from the visible text. Canonical
   * dash-cased prop name per naming.md (N-5) — an explicit value overrides `label`.
   */
  "aria-label"?: string;
  /** Blocks toggling and reports aria-disabled / native disabled. */
  disabled?: boolean;
  className?: string;
}

/**
 * Shared checkbox primitive (Phase 18, plan 18-06). Mirrors `Toggle`'s canonical
 * prop contract (`checked` / `onChange` / `label` / `aria-label` / `disabled`) but
 * renders a role="checkbox" box+glyph instead of a switch. The visual box + on-accent
 * Check glyph is the same token scheme the inline ProcessPickerModal checkbox used —
 * lifted here so it is reusable and a11y-correct (keyboard-toggle via the native
 * button, aria-checked, accessible name). Colours come from tokens only (no hex).
 */
export const Checkbox = forwardRef<HTMLButtonElement, CheckboxProps>(
  (
    { checked, onChange, label, "aria-label": ariaLabel, disabled = false, className = "" },
    ref
  ) => {
    return (
      <button
        ref={ref}
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-disabled={disabled || undefined}
        // When a visible `label` is present its text content names the button, so we
        // only forward an EXPLICIT aria-label (icon-only rows / name override). This
        // keeps `getByRole("checkbox", { name })` working in both cases.
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => {
          if (!disabled) onChange(!checked);
        }}
        className={`
          flex items-center gap-2 text-left rounded
          focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]
          transition-colors
          ${disabled ? "cursor-not-allowed opacity-[var(--opacity-disabled)]" : "cursor-pointer"}
          ${className}
        `}
      >
        <span
          className="w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors"
          style={{
            borderColor: checked ? "var(--color-accent-500)" : "var(--color-border)",
            backgroundColor: checked ? "var(--color-accent-500)" : "var(--color-input-bg)",
          }}
        >
          {/* on-accent token keeps the glyph legible on the accent fill in both themes
              (mirrors ProcessPickerModal — no hardcoded white). */}
          {checked && (
            <Check
              className="w-3 h-3"
              style={{ color: "var(--color-on-accent)" }}
              aria-hidden="true"
            />
          )}
        </span>
        {label && (
          <span className="text-xs" style={{ color: "var(--color-text-primary)" }}>
            {label}
          </span>
        )}
      </button>
    );
  }
);

Checkbox.displayName = "Checkbox";
