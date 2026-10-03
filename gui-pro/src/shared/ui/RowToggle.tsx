import { Toggle } from "./Toggle";

export interface RowToggleProps {
  checked: boolean;
  onChange: (value: boolean) => void;
  /** The setting is unavailable. Dims, and says «сюда нельзя». Not the same thing as `busy`. */
  disabled?: boolean;
  /**
   * A write of THIS setting is in flight.
   *
   * IN-FLIGHT MEANS DISABLE, NEVER REMOVE. The handle stays where the user just moved it, an
   * indicator turns inside it, and the press does not go through. Removing the handle or swapping
   * the control for a standalone spinner makes the control disappear and reappear a moment later,
   * which reads as a second, unrelated thing going wrong. The row around it does NOT dim either: a
   * dimmed row says «сюда нельзя», and here you can — the app is just writing right now.
   */
  busy?: boolean;
  /** Always required here: the visible label lives in another cell of the row. */
  "aria-label": string;
}

/**
 * The shared `Toggle`, sized for a settings row.
 *
 * The primitive bakes in `py-2` because most of its call sites render it as a whole row. Here the
 * ROW owns the vertical rhythm, so the primitive's padding would double it. The padding is
 * neutralised from the outside with a matching negative margin rather than by forking the
 * primitive — a private copy of `Toggle` would be exactly the kind of one-off pattern this redesign
 * refuses to add.
 *
 * `busy` maps onto `Toggle`'s `loading`, not onto `disabled`, and that mapping is the whole point:
 * `loading` locks interaction and spins inside the thumb WITHOUT applying the disabled dimming,
 * while `disabled` dims. The two states mean different things, so they must not share a prop.
 *
 * Lifted from the Phase-27 story tier (`components/_story/settingsDemos.tsx`), which carried the
 * idle and the busy treatment as two separate demo components; here they are one prop.
 */
export function RowToggle({
  checked,
  onChange,
  disabled,
  busy = false,
  "aria-label": ariaLabel,
}: RowToggleProps) {
  return (
    <div className="-my-[var(--space-2)]">
      <Toggle
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        loading={busy}
        aria-label={ariaLabel}
      />
    </div>
  );
}
