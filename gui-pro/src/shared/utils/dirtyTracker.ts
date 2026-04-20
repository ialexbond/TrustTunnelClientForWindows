/**
 * dirtyTracker — pure utility for detecting dirty-state in nested form sections.
 *
 * Compares two plain-object snapshots and returns true when any field value
 * differs (shallow equality for primitives, deep equality for arrays).
 *
 * Usage:
 *   const initial = { anti_dpi: true, custom_sni: "" };
 *   const current = { anti_dpi: false, custom_sni: "" };
 *   isDirty(initial, current) // → true
 *
 * Designed for Phase 14.1 UserModal D-9 warning banner (deeplink section
 * dirty tracking). Generic enough to use for any form section.
 */

export type DirtySnapshot = Record<string, string | boolean | string[] | null | undefined>;

/**
 * Returns true if `current` differs from `initial` in any field.
 *
 * Comparison rules:
 * - Primitive (string, boolean, null, undefined): strict equality (===)
 * - Array: compared by JSON.stringify (order-sensitive, deep)
 * - Unknown types: JSON.stringify fallback
 *
 * Fields present in `current` but absent in `initial` count as dirty.
 * Fields present in `initial` but absent in `current` count as dirty.
 */
export function isDirty(initial: DirtySnapshot, current: DirtySnapshot): boolean {
  const allKeys = new Set([...Object.keys(initial), ...Object.keys(current)]);
  for (const key of allKeys) {
    const a = initial[key];
    const b = current[key];
    if (!valuesEqual(a, b)) return true;
  }
  return false;
}

function valuesEqual(
  a: string | boolean | string[] | null | undefined,
  b: string | boolean | string[] | null | undefined,
): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    // One is array, other is not → not equal
    return false;
  }
  return a === b;
}

/**
 * Creates a snapshot of a subset of form fields for dirty tracking.
 * Filters undefined values so comparison ignores missing optional fields.
 *
 * @param fields - Object containing only the fields to track
 */
export function createSnapshot(fields: DirtySnapshot): DirtySnapshot {
  const snap: DirtySnapshot = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      snap[key] = value;
    }
  }
  return snap;
}
