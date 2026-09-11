import type { TFunction } from "i18next";
import { formatError, UNKNOWN_ERROR_FALLBACK } from "./formatError";
import { SAVE_DIALOG_FAILED } from "./saveFileDialog";

/**
 * Translates the path-validation / file-copy error codes the Rust backend emits
 * into localized text. Modelled on `translateSshError` — same `CODE|detail`
 * convention, same switch shape, same raw-string fallthrough — so a reader who
 * knows one knows the other.
 *
 * Why a separate function instead of more cases in `translateSshError`: these
 * codes come from `commands/paths.rs` (local filesystem validation), not from an
 * SSH session. Mixing them into the SSH switch would imply a relationship that
 * does not exist and would put local-disk copy in the "server said no" bucket.
 *
 * Codes handled (introduced by phase 25 plan 01):
 *   - COPY_SOURCE_OUTSIDE_ROOTS   — source resolved outside every allowed root
 *   - COPY_SOURCE_REPARSE_POINT   — source (or its parent) is a symlink/junction
 *   - COPY_SOURCE_UNRESOLVABLE    — source could not be canonicalized  (`|{io}`)
 *   - COPY_FAILED                 — fs::copy itself failed             (`|{io}`)
 *
 * Plus two codes that do NOT come from Rust (T-41). They live here because this is
 * already the translator every "save a file to disk" door runs its catch through,
 * and a second translator for two cases would only make the doors harder to read:
 *   - SAVE_DIALOG_FAILED          — the native Save-As dialog itself refused to
 *                                   open; stamped by `saveFileDialog`   (`|{plugin}`)
 *   - UNKNOWN_ERROR_FALLBACK      — `formatError` got a value that was neither an
 *                                   Error nor a string, so there is no message at all
 *
 * D-05: the mapping is by stable CODE, never by matching the English prose the
 * backend used to return. Renaming a Rust message can therefore never silently
 * un-localize the UI.
 *
 * None of these codes echoes the caller-supplied path back (T-25-01-05), so
 * rendering them cannot turn a snackbar into a filesystem-layout oracle. Only
 * COPY_FAILED carries a detail, and that detail is the io error, not a path.
 *
 * Accepts `unknown` because catch blocks receive `unknown`. Normalizing through
 * `formatError` first buys the `Error.message` unwrapping for free and guarantees
 * this can never hand `undefined` to a snackbar. `formatError`'s BEHAVIOUR is
 * untouched — it stays the dumb shared passthrough that dozens of other catch
 * blocks (log ones included) rely on; only its fallback string is now recognised
 * and localized on the way out, here at the presentation boundary.
 */
export function translatePathError(error: unknown, t: TFunction): string {
  const raw = formatError(error);
  const code = raw.split("|")[0];
  // IN-03: the detail is EVERYTHING after the first separator, not `split("|")[1]`. The Rust
  // side formats `CODE|{io error}` with an io string it does not control, so a detail that
  // itself contains a `|` was silently truncated at the pipe and the user lost the tail of the
  // very sentence that tells them what went wrong. Slicing past the code keeps it whole.
  // When there is no separator at all, `slice` runs past the end and yields "" — the same
  // empty-detail behaviour the previous `parts[1] || ""` produced.
  const detail = raw.slice(code.length + 1);

  switch (code) {
    // ─── Source-side refusals (security, not bugs) ───
    case "COPY_SOURCE_OUTSIDE_ROOTS":
      return t("pathErrors.sourceOutsideRoots");
    case "COPY_SOURCE_REPARSE_POINT":
      return t("pathErrors.sourceReparsePoint");

    // Carries an io detail on the wire, but the user-facing sentence deliberately
    // drops it: "the staged file is gone, download again" is the whole actionable
    // content, and an io string would be noise to a non-technical reader.
    case "COPY_SOURCE_UNRESOLVABLE":
      return t("pathErrors.sourceUnresolvable");

    // ─── The copy itself failed (disk full, destination locked, ACL) ───
    // The only case with a detail worth surfacing: it names WHY the write failed,
    // which is what the user has to act on. Rendered as React text content, never
    // as HTML, so the backend-controlled tail cannot inject markup (T-25-02-03).
    case "COPY_FAILED":
      return t("pathErrors.copyFailed", { detail });

    // ─── The save dialog never even opened (T-41a) ───
    // Carries the plugin's own English sentence as the detail; the user-facing copy
    // drops it, same as COPY_SOURCE_UNRESOLVABLE. "The Save-As window would not open"
    // is the whole actionable content, and the plugin's wording ("dialog plugin
    // unavailable") means nothing to a non-technical reader. Callers log the raw
    // string before translating, so the plugin's text survives for diagnosis.
    case SAVE_DIALOG_FAILED:
      return t("pathErrors.saveDialogFailed");

    // ─── No message existed in the first place (T-41b) ───
    // Not a code — it is what `formatError` produces for a thrown value that is
    // neither an Error nor a string, and it reached snackbars as bare English.
    // Matched by identity against the exported constant so rewording the English
    // fallback cannot silently un-localize this. Translating it HERE rather than
    // inside `formatError` is deliberate: `formatError` also feeds the activity log,
    // which must stay English and greppable.
    case UNKNOWN_ERROR_FALLBACK:
      return t("commonErrors.unknown");

    default:
      // Dev-warn on an unmapped code that still carries the family prefix, so a
      // future backend code nobody wired up is noticed in development instead of
      // shipping to the user as raw machine text.
      if (import.meta.env.DEV && code.startsWith("COPY_")) {
        console.warn(
          `[translatePathError] Unknown path error code: ${code}, raw: ${raw}`,
        );
      }
      // Fallthrough keeps today's behaviour for everything unmapped — better a raw
      // string than a blank snackbar or a rendered i18n key.
      return raw;
  }
}
