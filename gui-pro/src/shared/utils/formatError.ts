/**
 * The string `formatError` returns for a thrown value that is neither an `Error`
 * nor a string (a plain object, a number, `null`).
 *
 * T-41(b): this literal stays ENGLISH on purpose. `formatError` feeds both the
 * activity log (`activityLog`, `console.warn`, `sanitizeLogMessage`) and the UI,
 * and the log half is a diagnostic channel that must stay stable and greppable —
 * the same reasoning phase 25 wrote down for the raw `COPY_*` / `SSH_*` codes.
 * Translating here would localize log lines too.
 *
 * It is exported so the presentation boundary (`translatePathError`,
 * `translateSshError`) can recognise it by identity instead of re-typing the
 * literal. Reword the sentence and the translators keep working; before this,
 * a rename would have silently un-localized the snackbar.
 */
export const UNKNOWN_ERROR_FALLBACK = "Unknown error";

/**
 * Consistent error formatting for catch blocks.
 * Handles Error objects, strings, and unknown types.
 */
export function formatError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return UNKNOWN_ERROR_FALLBACK;
}
