import { normalizePath } from "./samePath";

/**
 * B2 (16-UAT round 2): a self-delete guard shared between the in-app delete initiator
 * (`ConnectionPanel.handleDelete`) and the fs-watcher reaction (`useConfigLifecycle`).
 *
 * Why it exists: the in-app delete removes the `.toml` via `invoke("delete_config")` →
 * Rust `std::fs::remove_file`. The fs-watcher on the ACTIVE config
 * (`watch_config_file`) sees that Remove and emits `config-file-changed {exists:false}`,
 * which `useConfigLifecycle` treats as an EXTERNAL delete → a RED «Конфиг удалён»
 * snackbar ON TOP of the GREEN success the panel already showed. The double snackbar
 * only appears on the active/last-used config (the only file the watcher watches).
 *
 * The fix mirrors the App-level `seamlessSwitchActiveRef`/`switchSupersededRef` transient
 * guards, but the initiator (ConnectionPanel) and the reactor (useConfigLifecycle) are in
 * different components with no shared ref, so the guard lives in this tiny module-level
 * singleton instead. Around an in-app delete the panel MARKS the deleted paths; the watcher
 * SKIPS its external-delete reaction for any marked path; the panel UNMARKS after the
 * reload settles (a short timeout backstop clears a mark even if the reload throws, so a
 * later genuine external delete of the same path is never wrongly suppressed).
 *
 * A genuine external delete (user removes the `.toml` in Explorer) is NEVER marked, so its
 * warning still fires — exactly the behaviour the fix must preserve.
 */

/**
 * The normalized paths the app is currently deleting itself, each mapped to its live TTL
 * backstop timer.
 *
 * #9 (Fable re-review): this used to be a `Set<string>` plus a bare `setTimeout` with no
 * handle to cancel. A re-mark of the SAME path (reachable via the ordinary "delete several
 * configs quickly, active one last" flow — every delete marks activeConfigPath) left the
 * PREVIOUS timer pending, so the stale timer fired mid-flow and deleted the FRESH mark's key
 * early. Keeping the timer per key lets `markSelfDelete` cancel the old timer before arming a
 * new one, so the documented "(re)arms the TTL" contract is actually true.
 */
const selfDeleting = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * The backstop TTL: even if the caller forgets to (or cannot) clear a mark, it auto-expires
 * so a marked path can never permanently suppress a genuine external delete. Comfortably
 * longer than the delete → reload round-trip, short enough that a real external delete moments
 * later is not swallowed.
 */
const SELF_DELETE_TTL_MS = 8000;

/** Mark a path as being deleted by the app itself. Idempotent; (re)arms the TTL backstop. */
export function markSelfDelete(path: string): void {
  if (!path) return;
  const key = normalizePath(path);
  // #9: cancel any pending timer for this key first, so a re-mark truly (re)arms the TTL
  // instead of leaving a stale timer that would expire the fresh mark early.
  const existing = selfDeleting.get(key);
  if (existing) clearTimeout(existing);
  // Backstop: auto-clear so a dropped clearSelfDelete() (e.g. reload threw) never leaves the
  // path permanently guarded. A normal flow clears it explicitly, well before this fires.
  const timer = setTimeout(() => selfDeleting.delete(key), SELF_DELETE_TTL_MS);
  selfDeleting.set(key, timer);
}

/** Clear the app-initiated-delete mark for a path (call after the reload settles). */
export function clearSelfDelete(path: string): void {
  if (!path) return;
  const key = normalizePath(path);
  // #9: cancel the pending backstop timer too, so it cannot fire on a since-removed key.
  const existing = selfDeleting.get(key);
  if (existing) clearTimeout(existing);
  selfDeleting.delete(key);
}

/** True when the given path is currently being deleted by the app itself (skip the watcher reaction). */
export function isSelfDeleting(path: string): boolean {
  if (!path) return false;
  return selfDeleting.has(normalizePath(path));
}

/**
 * TEST-ONLY (TA-8): clear ALL self-delete marks and cancel their live TTL backstop timers.
 *
 * The guard is a module-level singleton shared across the whole app, so its state leaks between
 * tests that exercise the real delete flow: a mark (and its live 8000 ms `setTimeout`) set in one
 * test survives into siblings, causing order-dependent flakiness and a leaked timer. Tests call
 * this in beforeEach/afterEach to start from a clean singleton. It has NO production caller — the
 * app clears marks per-path via `clearSelfDelete`; this is the whole-set reset the tests need.
 */
export function resetSelfDeleteGuard(): void {
  for (const timer of selfDeleting.values()) clearTimeout(timer);
  selfDeleting.clear();
}
