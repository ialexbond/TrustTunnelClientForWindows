import { save } from "@tauri-apps/plugin-dialog";
import { formatError } from "./formatError";

/**
 * Code emitted when the native Save-As dialog itself refuses to open.
 * Same `CODE|detail` shape the Rust backend uses, so it flows through the
 * existing translator chain untouched — see `translatePathError`.
 */
export const SAVE_DIALOG_FAILED = "SAVE_DIALOG_FAILED";

/**
 * `save()` from `@tauri-apps/plugin-dialog`, wrapped so a REJECTION arrives as a
 * coded error instead of the plugin's own English prose.
 *
 * T-41(a): both Save-As doors (`UserConfigModal` download, wizard `handleSaveAs`)
 * put `save()` inside a catch that then runs the string through
 * `translatePathError` / `translateSshError`. Neither translator claims a dialog
 * rejection — it carries no code — so it fell through their raw-string default and
 * the user read the plugin's English sentence. Stamping a code here is what lets
 * the existing presentation boundary localize it; nothing about the call sites'
 * error handling had to change.
 *
 * Why a wrapper and not a try/catch at each call site: the call site would have to
 * re-establish "the await that just failed was the dialog, not the copy". Here that
 * fact is structural — this function awaits exactly one thing.
 *
 * The plugin's text is kept as the detail, not thrown away: callers log the raw
 * string before translating (UserConfigModal does), so the original diagnostic
 * survives in the activity log even though the user never sees it.
 *
 * CANCELLATION IS NOT A FAILURE. Cancelling resolves with `null`, which passes
 * straight through — callers keep their existing `if (dest)` guard and stay silent.
 */
export async function saveFileDialog(
  options: Parameters<typeof save>[0],
): Promise<string | null> {
  try {
    return await save(options);
  } catch (e) {
    // `cause` keeps the original rejection reachable for a debugger; the MESSAGE is what
    // the translator chain reads, so the code has to live there and not only in `cause`.
    throw new Error(`${SAVE_DIALOG_FAILED}|${formatError(e)}`, { cause: e });
  }
}
