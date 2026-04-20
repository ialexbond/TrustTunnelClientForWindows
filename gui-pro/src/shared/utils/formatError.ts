/**
 * Consistent error formatting for catch blocks.
 * Handles Error objects, strings, and unknown types.
 */
export function formatError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Unknown error";
}
