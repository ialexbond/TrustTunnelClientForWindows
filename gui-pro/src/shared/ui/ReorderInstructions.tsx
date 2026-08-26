// No test file of its own: this component has no behaviour and no operable surface — a unit test
// could only restate its own markup. Its one contract, «a reorderable row's aria-describedby
// resolves to this sentence», is a property of the PAIR, so it is asserted from PriorityRow.test.tsx.

export interface ReorderInstructionsProps {
  /** The id every reorderable row points `aria-describedby` at. Rendered once per list. */
  id: string;
  /** The sentence itself, built by the calling section with `t()` — «Стрелки вверх и вниз
   *  переставляют выбранную строку на одну позицию.» It is a required prop rather than a baked-in
   *  string because `shared/ui` is invisible to the i18n dead-key gate, so Russian written here
   *  could never be mirrored into `en.json`. */
  text: string;
}

/**
 * The screen-reader-only sentence every reorderable `PriorityRow` points at.
 *
 * It exists because the reorder gesture was otherwise documented ONLY inside the hover «?» hint
 * (Phase-27 review WR-12): a keyboard-only affordance explained exclusively on a mouse-only surface
 * is not explained at all.
 *
 * Rendered once per list, next to it — not once per row. One node, many describers.
 */
export function ReorderInstructions({ id, text }: ReorderInstructionsProps) {
  return (
    <span id={id} className="sr-only">
      {text}
    </span>
  );
}
