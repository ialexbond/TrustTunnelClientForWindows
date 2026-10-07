/**
 * documentLangFor / stampDocumentLang — MR3-03 (D-16, WCAG 3.1.1).
 *
 * The interface's document language must match the copy actually rendered, so
 * screen readers and the WebView's own text handling read Russian as Russian
 * and English as English. `notification.tsx` already does this per-payload for
 * the notification plate window (`document.documentElement.lang = language ?? "ru"`);
 * this is the same rule extracted so the main window and the tray-menu window
 * can share it instead of re-deriving the mapping.
 *
 * The mapping mirrors `useLanguage.ts`'s existing plate-language mirror
 * (`i18n.language.startsWith("en") ? "en" : "ru"`): anything that isn't English
 * maps to Russian, the app's primary language — never the other way around, so
 * an unrecognised/未 (unset) tag never claims English on a Russian interface.
 */
export function documentLangFor(lng: string | undefined): "ru" | "en" {
  return lng?.startsWith("en") ? "en" : "ru";
}

/**
 * Stamps `document.documentElement.lang`. No-op outside a DOM environment
 * (e.g. a non-browser test context) so callers can register this unconditionally.
 */
export function stampDocumentLang(lng: string | undefined): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = documentLangFor(lng);
}
