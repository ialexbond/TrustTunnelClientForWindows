import { HelpCircle } from "lucide-react";
import { Tooltip } from "./Tooltip";

export interface HelpHintProps {
  /** The explanation itself. Shown on hover AND on keyboard focus. */
  text: string;
  /**
   * The finished accessible name of the trigger, e.g. «Подробнее: Авто-режим».
   *
   * REQUIRED, and deliberately not optional. An unnamed icon button announces as «кнопка» and is
   * worse than no button at all: a screen-reader user is told there is something here and not what
   * it is. The next author's instinct will be to relax this to `label?` for the one call site that
   * has no obvious wording — resist it, and give that call site wording instead.
   *
   * The caller passes the FINISHED string. The primitive must not build it, because building it
   * means hard-coding a language: see `helpHintLabel` below.
   */
  label: string;
}

/**
 * The «?» affordance of the «Настройки» tab.
 *
 * Extra detail lives on hover/focus, never as a third muted line under the row: a settings row
 * that carries a label, a description AND a hint line collapses into one grey block, which is the
 * legibility defect this redesign exists to undo.
 *
 * THE TRIGGER MUST BE A REAL FOCUSABLE CONTROL. `Tooltip`'s own wrapper is a plain `<div>` with no
 * tabIndex and no role; it opens on focus and forwards `aria-describedby` to its CHILD. A bare
 * `aria-hidden` `<svg>` child therefore produced a hint that neither the keyboard (nothing to
 * focus, so the tip never opened) nor a screen reader (the description hung on a hidden node)
 * could reach — while the hint carried load-bearing sentences that live nowhere else: that
 * failover does not measure ping, and that ↑ / ↓ reorder the queue. A `<button>` gives focus,
 * Enter/Space parity and an accessible name; the glyph stays decorative inside it.
 *
 * `type="button"` is load-bearing too: several of these sit inside forms, and the default
 * `type="submit"` would turn a request for help into a submit.
 *
 * Lifted from the Phase-27 story tier (`components/_story/settingsDemos.tsx`).
 */
export function HelpHint({ text, label }: HelpHintProps) {
  return (
    <Tooltip text={text}>
      <button
        type="button"
        aria-label={label}
        className="inline-flex cursor-help items-center rounded-[var(--radius-sm)] focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none"
      >
        <HelpCircle
          className="h-3 w-3"
          style={{ color: "var(--color-text-muted)" }}
          aria-hidden="true"
        />
      </button>
    </Tooltip>
  );
}

/**
 * «Подробнее: {{label}}» — the accessible name of a row's «?» trigger, composed from the row label.
 *
 * A CONVENIENCE FOR STORIES AND TESTS, NOT THE PRODUCTION PATH. Production sections build the same
 * name from i18n — `t("settings.help_more_about", { label })` — because a hard-coded Russian
 * aria-label inside `shared/ui/` is invisible to the i18n dead-key gate and silently un-mirrorable
 * into en.json. That trap is exactly what Phase 21 fell into, which is why the primitive takes the
 * finished label as a prop instead of building it.
 */
// The label composer is co-located with the component on purpose: the wording and the control it
// names must not drift apart. Same precedent as StatusBadge.tsx, which keeps its variant map beside
// its component for the same reason.
// eslint-disable-next-line react-refresh/only-export-components
export const helpHintLabel = (rowLabel: string) => `Подробнее: ${rowLabel}`;
