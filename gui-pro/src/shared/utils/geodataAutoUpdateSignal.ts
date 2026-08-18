/**
 * Cross-component signal for the geodata auto-update setting (Phase 23, D-05/D-12).
 *
 * CR-03: the Routing card reads `get_geodata_auto_update` to decide whether an available release is
 * still "a task for the user" (the amber badge). It used to read it in a mount-only effect — but
 * `RoutingPanel` is NEVER unmounted: App.tsx renders every tab panel at once and hides the inactive
 * ones with `opacity: 0` / `visibility: hidden`. So the read happened once per app launch, and the
 * moment the user flipped the switch in Settings the card's copy went stale for the rest of the
 * session. Turning auto-update OFF then suppressed the badge forever — precisely the case D-05 says
 * the badge exists for.
 *
 * The setting is persisted on the RUST side (D-12), so `useFeatureToggles`' localStorage +
 * `storage`-event sync is unusable here. What carries over is its window-CustomEvent idiom: the
 * writer announces the change, every live reader re-reads from the backend (the command stays the
 * single source of truth — the event carries no payload deliberately, so a listener can never end
 * up trusting a value the backend refused to persist).
 *
 * The name lives here rather than as a literal in both files because a typo on one side would fail
 * silently — the exact failure mode being fixed.
 */
export const GEODATA_AUTO_UPDATE_CHANGED = "geodata-auto-update-changed";

/** Announce that the persisted toggle changed. Call AFTER the backend write succeeded. */
export function emitGeodataAutoUpdateChanged(): void {
  window.dispatchEvent(new Event(GEODATA_AUTO_UPDATE_CHANGED));
}

/** Subscribe to toggle changes. Returns the unsubscribe function for an effect cleanup. */
export function onGeodataAutoUpdateChanged(handler: () => void): () => void {
  window.addEventListener(GEODATA_AUTO_UPDATE_CHANGED, handler);
  return () => window.removeEventListener(GEODATA_AUTO_UPDATE_CHANGED, handler);
}
