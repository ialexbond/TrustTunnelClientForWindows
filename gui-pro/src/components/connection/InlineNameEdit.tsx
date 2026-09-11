/**
 * InlineNameEdit.tsx — production inline name editor for the «Подключение» config card
 * (promoted from story-tier in Phase 11 Plan 11-06). Rendered by the resting `ConfigCard`
 * rename sub-state and by the Connection *.stories.tsx demos. Assembled only from
 * `shared/ui` tokens + the shared `CharCounter`.
 *
 * Design contract (owner review, Phase-10 design-fix):
 * - The control is ONE bordered box that looks like an input; the text input and the
 *   character counter live INSIDE it as flex siblings, so the counter can never
 *   detach from the field.
 * - The input hugs its text EXACTLY: its width is measured from a hidden mirror span
 *   (same font), so there is no slack gap between the text and the counter. A small
 *   floor keeps an empty field clickable.
 * - MAX width = the full name column (`max-w-full`), responsive on resize; past that the
 *   input shrinks and scrolls while the counter stays pinned to the right.
 * - `invalid` only reddens the border; the validation MESSAGE is the caller's job
 *   (shared FieldError, rendered BELOW the field).
 */
import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "../../shared/lib/cn";
import { CharCounter } from "../../shared/ui/CharCounter";

export interface InlineNameEditProps {
  value: string;
  onChange: (value: string) => void;
  /** Enter commits the rename. The caller's handler should no-op when invalid. */
  onCommit?: () => void;
  /** Escape cancels the rename (discard draft). */
  onCancel?: () => void;
  /** Hard character cap; the counter reads value.length / maxLength. */
  maxLength?: number;
  ariaLabel: string;
  /** Redden the border for the empty/duplicate error sub-state. */
  invalid?: boolean;
  autoFocus?: boolean;
}

/** Floor so an empty field stays clickable even with no text to measure. */
const MIN_INPUT_PX = 24;

export function InlineNameEdit({
  value,
  onChange,
  onCommit,
  onCancel,
  maxLength = 64,
  ariaLabel,
  invalid,
  autoFocus,
}: InlineNameEditProps) {
  const mirrorRef = useRef<HTMLSpanElement>(null);
  const [inputWidth, setInputWidth] = useState<number>(MIN_INPUT_PX);

  // Measure the actual rendered text width via a hidden mirror that carries the same
  // typography as the input, so the field hugs the text with no slack before the
  // counter. +1px cushion stops the caret / last glyph from being clipped.
  useLayoutEffect(() => {
    const mirror = mirrorRef.current;
    if (mirror) setInputWidth(Math.max(mirror.offsetWidth + 1, MIN_INPUT_PX));
  }, [value]);

  return (
    <div
      className={cn(
        // max-w-full (not 50%): the field hugs its text and can grow across the WHOLE name
        // column, which itself ends ≈ at the card's horizontal middle — so the field reaches
        // «до середины». min-w-0 + the ✓/✗ siblings (shrink-0) cap it: when text + buttons
        // would exceed that, the box shrinks and the input scrolls (max-w-[50%] capped it at
        // half the COLUMN ≈ a quarter of the card, far too early).
        "relative inline-flex h-8 max-w-full min-w-0 items-center gap-[var(--space-2)]",
        "rounded-[var(--radius-md)] border bg-[var(--color-input-bg)]",
        "pl-[var(--space-3)] pr-[var(--space-2)] transition-colors",
        "focus-within:shadow-[var(--focus-ring)]",
        invalid
          ? "border-[var(--color-danger-fg)]"
          : "border-[var(--color-input-border)]",
      )}
    >
      {/* Borderless input — the box carries the chrome. Width is measured to hug the
          text; min-w-0 + max-w-full let it shrink and scroll when the box hits 50%. */}
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value.slice(0, maxLength))}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            // «empty never saves» (D-14): guard Enter inside the component so an empty /
            // whitespace-only or `invalid` value can never commit, even if a caller forgets
            // to disable its ✓ — matches the reference's commitNameEdit early-return.
            if (invalid || value.trim() === "") return;
            onCommit?.();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel?.();
          }
        }}
        maxLength={maxLength}
        aria-label={ariaLabel}
        // Focus the field the moment rename opens — the pencil click is explicit
        // intent, so this is not a surprise focus steal.
        autoFocus={autoFocus}
        style={{ width: `${inputWidth}px` }}
        className="min-w-0 max-w-full shrink border-0 bg-transparent p-0 text-sm text-[var(--color-text-primary)] outline-none"
      />
      {/* Counter is a flex sibling INSIDE the box — always pinned right of the text,
          never overlapping it. */}
      <CharCounter value={value.length} max={maxLength} className="shrink-0" />
      {/* Hidden width mirror — same font (text-sm) + whitespace-pre so spaces count. */}
      <span
        ref={mirrorRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute left-0 top-0 whitespace-pre text-sm"
      >
        {value || " "}
      </span>
    </div>
  );
}
