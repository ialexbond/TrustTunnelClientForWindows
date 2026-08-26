import { useRef, type ReactNode } from "react";

export interface SegmentedOption {
  value: string;
  label: string;
  /** Optional leading Lucide glyph at 14px. Decorative — it must not reach the accessible name. */
  icon?: ReactNode;
}

export interface SegmentedControlProps {
  options: SegmentedOption[];
  value: string;
  onChange: (value: string) => void;
  /** Names the group for assistive technology — usually the visible row label. */
  "aria-label": string;
  disabled?: boolean;
}

/**
 * A radiogroup of 2–3 options laid out on one line, replacing a dropdown.
 *
 * The app had no segmented group before this: `shared/ui` carried `Select`, `TabsInline`, `Radio`,
 * `Checkbox` and `Toggle`, none of which is «choose one of three, on one line, in one press».
 * Lifted from the Phase-27 story tier (`components/_story/settingsDemos.tsx`), where it was authored
 * once precisely so the two surfaces that consume it could not drift apart.
 *
 * SEMANTICS, NOT JUST LOOKS. The container is a `radiogroup`, each option is a `radio` with
 * `aria-checked`, and ← / → move between options over a roving tabindex, so the group is a single
 * Tab stop: Tab enters it once and a second Tab leaves it.
 *
 * DOM FOCUS TRAVELS WITH THE SELECTION — see `move()`. This is the part that was broken in Phase 27
 * and shipped past 3410 tests: a roving tabindex that moves only `aria-checked` strands focus on a
 * button that is no longer the tab stop, so the group puts two «this is current» pointers on screen
 * and the SECOND press of the same arrow does nothing.
 *
 * VERTICAL ARROWS ARE LEFT ALONE on purpose. The group sits in a vertically scrolling tab; if it
 * swallowed ↑ / ↓ the whole application would re-theme itself while the user was only scrolling.
 *
 * The selected option carries the accent fill and `--color-on-accent` for its text — the
 * theme-scoped token, never a literal white. In dark it resolves to `--color-accent-900` (#0b2221),
 * because white on the dark-theme teal fails contrast; in light that same token IS #ffffff. Which
 * is exactly why the token has to be what is written here.
 *
 * There is NO sliding pill under the selection: the pill is the bottom tab bar's signature, and
 * repeating it in a settings row would blur what a pill means in this app.
 *
 * Every visible string arrives as a prop. No Russian is baked in — `shared/ui` is invisible to the
 * i18n dead-key gate, so a hard-coded label here could never be mirrored into `en.json`.
 */
export function SegmentedControl({
  options,
  value,
  onChange,
  "aria-label": ariaLabel,
  disabled = false,
}: SegmentedControlProps) {
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // The tab stop is derived from the SELECTED option, with a fallback to the first one. If `value`
  // matches nothing (a stale persisted theme, an option renamed out of the list) then no option
  // would carry tabIndex={0}, and the whole group would silently leave the tab order with nothing
  // on screen to say so (review WR-11).
  const selectedIndex = options.findIndex((option) => option.value === value);
  const tabStop = selectedIndex === -1 ? 0 : selectedIndex;

  // Report only a REAL change. A controlled parent that re-renders with the same `value` would
  // otherwise see a second «the user chose dark» for a press that chose nothing, and a save-
  // confirmation wired to this callback would announce a save that never happened.
  const select = (next: string) => {
    if (disabled || next === value) return;
    onChange(next);
  };

  // Step from the SELECTED index, never from the index of the button that happened to receive the
  // event: after a move that button is no longer selected and no longer the tab stop, so reusing
  // its index re-fires the same transition and the group dead-ends on the second arrow press.
  const move = (step: number) => {
    if (disabled || options.length === 0) return;
    const next = (tabStop + step + options.length) % options.length;
    select(options[next].value);
    // Roving tabindex is only half a pattern without this line: the newly selected option becomes
    // the single tab stop, so DOM focus MUST follow it (review CR-01).
    buttonRefs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={`flex gap-[var(--space-1)] rounded-[var(--radius-md)] bg-[var(--color-bg-elevated)] p-[var(--space-1)] ${
        disabled ? "opacity-[var(--opacity-disabled)]" : ""
      }`}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            ref={(element) => {
              buttonRefs.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            // Roving tabindex: only ONE option is in the tab order, so Tab enters and leaves the
            // group once and the arrows do the choosing inside it.
            tabIndex={index === tabStop ? 0 : -1}
            onClick={() => select(option.value)}
            onKeyDown={(event) => {
              // Horizontal arrows ONLY — see the vertical-arrow note in the component doc.
              if (event.key === "ArrowRight") {
                event.preventDefault();
                move(1);
              } else if (event.key === "ArrowLeft") {
                event.preventDefault();
                move(-1);
              }
            }}
            style={
              selected
                ? {
                    backgroundColor: "var(--color-accent-interactive)",
                    color: "var(--color-on-accent)",
                  }
                : { color: "var(--color-text-secondary)" }
            }
            className={`flex min-h-[32px] flex-1 items-center justify-center gap-[var(--space-1-5)] rounded-[var(--radius-sm)] px-[var(--space-3)] text-sm font-medium transition-colors duration-[var(--transition-fast)] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none ${
              selected ? "" : "hover:bg-[var(--color-bg-hover)]"
            }`}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
