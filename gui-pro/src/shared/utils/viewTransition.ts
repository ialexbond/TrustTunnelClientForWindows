import { flushSync } from "react-dom";

/**
 * Run a React state update inside a browser View Transition so the resulting DOM change
 * animates instead of snapping. Used so that promoting a config to the active one re-sorts the
 * «Подключение» list with the chosen card gliding to the lead (11-UAT gap D) — each card
 * carries a stable `view-transition-name`, so the browser morphs every card from its old box
 * to its new one.
 *
 * `flushSync` forces the update to commit synchronously inside the transition callback so the
 * API can capture the before/after frames (a plain async setState would commit too late and the
 * transition would see no change). Falls back to a plain synchronous apply when the API is
 * unavailable (older browsers, jsdom) or the user prefers reduced motion.
 *
 * Call ONLY from an event handler — never during render (flushSync throws there).
 */
export function runViewTransition(apply: () => void): void {
  const reduce =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const startVT =
    typeof document !== "undefined"
      ? (document as unknown as { startViewTransition?: (cb: () => void) => void })
          .startViewTransition?.bind(document)
      : undefined;
  if (startVT && !reduce) {
    startVT(() => flushSync(apply));
  } else {
    apply();
  }
}
