import {
  forwardRef,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { GripVertical } from "lucide-react";
import { RowToggle } from "./RowToggle";
import { Tooltip } from "./Tooltip";

export interface PriorityRowProps {
  name: string;
  /** Hostname or bare address. Hidden below the `sm` breakpoint (640px). Note that the app window
   *  cannot get there — tauri.conf.json sets minWidth 800 — so in the app the address is always
   *  visible; the hidden variant is reachable only in a narrow Storybook viewport. */
  host?: string;
  /** Position in the queue, counting participating rows only. `null` renders «—»: a row that is out
   *  of the queue has no position, and a number there would lie about where it stands. */
  ordinal: number | null;
  participating: boolean;
  dragging?: boolean;
  /** False when there is nothing to reorder (a one-row list): the grab affordance is not rendered,
   *  because a handle that cannot move anything is a promise the list cannot keep. */
  reorderable?: boolean;
  /** A switch is in flight. The row keeps every control it had — the grip included — but they stop
   *  responding. Removing the handle instead would make the card change shape mid-operation, and a
   *  layout that shifts under a spinner reads as a second, unrelated thing going wrong. */
  locked?: boolean;
  /** The participation switch alone cannot be operated (the single-server case, or in flight). */
  switchDisabled?: boolean;
  onParticipationChange?: (value: boolean) => void;
  /** Accessible name of the participation switch, naming the server explicitly. */
  switchLabel: string;
  /** Accessible name of the row itself. */
  rowLabel: string;
  /** What a screen reader calls this row instead of «list item» — «переставляемая строка».
   *  Required, and built by the calling section with `t()`: see the i18n note below. Applied only
   *  when the row is actually reorderable, because it would otherwise promise a gesture that is
   *  not there. */
  roleDescription: string;
  /** Id of the sr-only element that explains the ↑ / ↓ reorder gesture. Attached to every
   *  reorderable row so a keyboard user hears the gesture when the row takes focus — see
   *  `ReorderInstructions`. */
  instructionsId?: string;
  tabIndex?: number;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLLIElement>) => void;
  onDragStart?: (event: ReactDragEvent<HTMLLIElement>) => void;
  onDragEnter?: (event: ReactDragEvent<HTMLLIElement>) => void;
  onDragOver?: (event: ReactDragEvent<HTMLLIElement>) => void;
  onDragEnd?: (event: ReactDragEvent<HTMLLIElement>) => void;
  onDrop?: (event: ReactDragEvent<HTMLLIElement>) => void;
}

/**
 * One server in the failover queue. Row anatomy, left to right:
 * grip · ordinal · name (clip + tooltip) · host · participation switch.
 *
 * Lifted from the Phase-27 story tier (`components/_story/settingsDemos.tsx`).
 *
 * A `forwardRef<HTMLLIElement>` on purpose: the section holds a ref per row so keyboard reorder can
 * move the DOM focus along WITH the row, which is what lets several presses in a row keep moving
 * the same row instead of the one that slid into its place.
 *
 * NO «Текущий» BADGE. The queue answers «in what order will it switch»; the connected server is
 * already named by the status panel above and by the sentence over the list. Marking it a second
 * time inside the list added the only coloured spot in an otherwise neutral column and drew the eye
 * to the one row the user cannot act on.
 *
 * NO CAPTION over the switch column, and none on a disabled row. An excluded row already says so
 * three times over — the ordinal turns «—», the name goes muted, the switch is off — and a fourth
 * statement in words only added noise to the one row the user is least likely to be reading.
 *
 * AN EXCLUDED ROW IS SET APART BY A BACKGROUND STEP AND A MUTED NAME — deliberately NOT by opacity.
 * `--opacity-disabled` means «you cannot use this»; an excluded row is fully operable and the user
 * must be able to bring it back, so dimming it would state the wrong thing.
 *
 * «A step», not «recessed»: the direction is theme-dependent and saying otherwise is wrong in one of
 * the two themes. Against the panel's `--color-bg-elevated`, a participating row sits on
 * `--color-bg-surface` and an excluded one on `--color-bg-primary` — in dark that is #1c1c1c →
 * #0d0d0d (deeper), in light #f0f0ed → #f9f9f7 (lighter, toward the page). Both read as «a step
 * further out», which is the property to describe.
 *
 * THE SWITCH CELL MUST NOT START A DRAG: it is explicitly not draggable, it stops the drag-start
 * from propagating, and it shows the default cursor instead of the grab cursor. Otherwise reaching
 * for the switch would begin a reorder the user never asked for.
 *
 * I18N. Every string this row renders or announces — `rowLabel`, `switchLabel`, `roleDescription`,
 * and the sentence behind `instructionsId` — arrives as a prop that the calling section builds with
 * `t()`. Nothing Russian is baked in: `shared/ui` is invisible to the i18n dead-key gate, so a
 * hard-coded string here could never be mirrored into `en.json`.
 */
export const PriorityRow = forwardRef<HTMLLIElement, PriorityRowProps>(function PriorityRow(
  {
    name,
    host,
    ordinal,
    participating,
    dragging = false,
    reorderable = true,
    locked = false,
    switchDisabled = false,
    onParticipationChange,
    switchLabel,
    rowLabel,
    roleDescription,
    instructionsId,
    tabIndex = 0,
    onKeyDown,
    onDragStart,
    onDragEnter,
    onDragOver,
    onDragEnd,
    onDrop,
  },
  ref,
) {
  const surface = participating ? "var(--color-bg-surface)" : "var(--color-bg-primary)";
  const nameColour = participating ? "var(--color-text-primary)" : "var(--color-text-muted)";

  return (
    <li
      ref={ref}
      tabIndex={tabIndex}
      draggable={reorderable && !locked}
      onKeyDown={onKeyDown}
      onDragStart={onDragStart}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDrop={onDrop}
      aria-label={rowLabel}
      // The gesture must be discoverable from the row itself. Before Phase 27 the ONLY statement
      // that ↑ / ↓ reorder the queue lived in the «?» hint above the list, so a keyboard user had
      // to find a hover affordance to learn about a keyboard affordance (review WR-12).
      // `aria-roledescription` says the row is movable; `aria-describedby` reads the gesture out
      // when the row takes focus.
      //
      // Deliberately NOT role="listbox" / role="option": an option must not contain interactive
      // descendants, and every row here carries its own participation switch — promoting the list
      // would hide that switch from assistive technology, trading one defect for a worse one.
      aria-roledescription={reorderable ? roleDescription : undefined}
      aria-describedby={reorderable ? instructionsId : undefined}
      style={{ backgroundColor: surface }}
      className={`flex select-none items-center gap-[var(--space-2)] rounded-[var(--radius-md)] border px-[var(--space-2)] py-[var(--space-2)] transition-colors focus-visible:border-[var(--color-input-focus)] focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none ${
        reorderable && !locked ? "cursor-grab active:cursor-grabbing" : "cursor-default"
      } ${
        dragging
          ? "border-[var(--color-input-focus)] opacity-60 shadow-[var(--focus-ring)]"
          : "border-[var(--color-border)] hover:border-[var(--color-border-hover)]"
      }`}
    >
      {reorderable && (
        <GripVertical
          data-testid="priority-row-grip"
          className="h-4 w-4 shrink-0"
          style={{ color: "var(--color-text-muted)" }}
          aria-hidden="true"
        />
      )}
      <span
        className="w-5 shrink-0 text-center text-mono-sm"
        style={{ color: "var(--color-text-muted)" }}
        aria-hidden="true"
      >
        {ordinal === null ? "—" : ordinal}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-[var(--space-2)]">
        <Tooltip text={name} className="flex min-w-0 max-w-full">
          <span className="min-w-0 truncate text-sm font-medium" style={{ color: nameColour }}>
            {name}
          </span>
        </Tooltip>
      </span>
      {host && (
        <span
          className="hidden max-w-[140px] shrink-0 truncate text-mono-sm sm:inline"
          style={{ color: "var(--color-text-muted)" }}
        >
          {host}
        </span>
      )}
      <span
        className="shrink-0 cursor-default"
        draggable={false}
        onDragStart={(event) => event.stopPropagation()}
      >
        <RowToggle
          checked={participating}
          onChange={(value) => onParticipationChange?.(value)}
          disabled={switchDisabled}
          aria-label={switchLabel}
        />
      </span>
    </li>
  );
});
