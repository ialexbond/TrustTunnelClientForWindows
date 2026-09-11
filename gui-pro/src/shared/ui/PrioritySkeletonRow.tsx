import { Skeleton } from "./Skeleton";

/**
 * The loading placeholder for a `PriorityRow`, in the SAME geometry: grip · ordinal · name · switch,
 * at the real row's exact metrics — same box, same border, same radius, same padding.
 *
 * The geometry is copied on purpose: a skeleton in a different shape makes the panel jump the moment
 * real data lands, which is the one thing a skeleton exists to prevent.
 *
 * There is NO address placeholder. The address arrives with the data, and a fifth block reserving
 * width for a value that may not exist would move the switch when the real rows appear.
 *
 * Presentational only, so it takes no props and needs no test of its own beyond the column-count
 * assertion in `PriorityRow.test.tsx`.
 */
export function PrioritySkeletonRow() {
  return (
    <li className="flex items-center gap-[var(--space-2)] rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-[var(--space-2)] py-[var(--space-2)]">
      <Skeleton variant="line" className="h-4 w-4 shrink-0" />
      <Skeleton variant="line" className="h-3 w-5 shrink-0" />
      <Skeleton variant="line" className="h-3 min-w-0 flex-1" />
      <Skeleton variant="line" className="h-5 w-9 shrink-0 rounded-full" />
    </li>
  );
}
