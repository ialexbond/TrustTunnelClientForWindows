/**
 * addUserDraft — the Add-user form's draft autosave, extracted VERBATIM from
 * `UserModal.tsx` (FIX-K). Phase 04 Plan 06 (PANEL-02 data layer).
 *
 * Data is kept in `sessionStorage` so it survives an accidental close
 * (drag-select that slipped outside, Escape, backdrop click) but is wiped
 * when the app window closes — matching the "current session only" mental
 * model.
 *
 * This file is the pure I/O leaf for the draft. UserModal imports
 * `readAddUserDraft` / `writeAddUserDraft` / `clearAddUserDraft` and keeps the
 * React state/effects. Extracting the storage logic makes it unit-testable and
 * lets the Wave-3/4 UserModal decomposition reuse it.
 *
 * The draft is scoped per FULL SERVER IDENTITY (Users C-03 + review LOW) so
 * credentials never bleed across servers or collide on a shared hostname, and
 * the password is EXCLUDED from what is persisted (secret-at-rest, SAFETY-02).
 * Each fix rode its own regression-test-first commit on top of the verbatim
 * extraction (Pitfall-2 / D-02 rail).
 */

/**
 * The draft is generic over the deeplink shape so this leaf util does not have
 * to import `DeeplinkFields` from `UserModal.tsx` (which would create a cycle).
 * UserModal supplies its own `DeeplinkFields` as the type argument.
 */
export interface AddDraft<TDeeplink = unknown> {
  username: string;
  password: string;
  deeplink: TDeeplink;
}

/**
 * sessionStorage key PREFIX for the Add-user draft.
 *
 * C-03 (Users audit) + review LOW: the draft is scoped per FULL SERVER IDENTITY
 * — the real key is `tt_user_modal_add_draft:<serverId>` where `serverId` is the
 * identity the app uses to tell server records apart (host:port:user), NOT the
 * bare hostname. This way:
 *   - login/password/deeplink entered for server A never restore on server B
 *     (no cross-server bleed), and
 *   - two server records that share a bare hostname but differ in port/user do
 *     not collide on one global draft (review LOW).
 */
const ADD_DRAFT_KEY_PREFIX = "tt_user_modal_add_draft";

/** Compose the per-server-identity sessionStorage key. */
function draftKey(serverId: string): string {
  return `${ADD_DRAFT_KEY_PREFIX}:${serverId}`;
}

/**
 * Read the persisted Add-user draft for `serverId`, or null when absent /
 * malformed / sessionStorage-disabled. The shape guard mirrors the original
 * inline `loadAddDraft` exactly.
 */
export function readAddUserDraft<TDeeplink = unknown>(
  serverId: string,
): AddDraft<TDeeplink> | null {
  try {
    const raw = sessionStorage.getItem(draftKey(serverId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      "username" in parsed &&
      "password" in parsed &&
      "deeplink" in parsed &&
      typeof (parsed as { username: unknown }).username === "string" &&
      typeof (parsed as { password: unknown }).password === "string" &&
      (parsed as { deeplink: unknown }).deeplink &&
      typeof (parsed as { deeplink: unknown }).deeplink === "object"
    ) {
      return parsed as AddDraft<TDeeplink>;
    }
  } catch {
    // sessionStorage disabled / invalid JSON — fall through to fresh defaults.
  }
  return null;
}

/**
 * Persist the Add-user draft for `serverId`. Quota / disabled storage failures
 * are ignored.
 *
 * SAFETY-02 (secret-at-rest): the VPN password is EXCLUDED from what is written
 * to sessionStorage. The draft exists so an accidental close doesn't wipe the
 * form, but a plaintext secret has no business sitting in browser storage. We
 * persist `password: ""` (not the real value) so:
 *   - the read-side shape guard (which requires a string `password`) still
 *     passes, and
 *   - on restore the password field comes back empty — the user re-rolls or
 *     re-types it, which is the right secret-handling default.
 * The real password stays only in the in-memory React form state.
 */
export function writeAddUserDraft<TDeeplink = unknown>(
  serverId: string,
  d: AddDraft<TDeeplink>,
): void {
  try {
    const safe: AddDraft<TDeeplink> = { ...d, password: "" };
    sessionStorage.setItem(draftKey(serverId), JSON.stringify(safe));
  } catch {
    /* ignore quota / disabled */
  }
}

/** Remove the Add-user draft for `serverId` (called after a successful add). */
export function clearAddUserDraft(serverId: string): void {
  try {
    sessionStorage.removeItem(draftKey(serverId));
  } catch {
    /* ignore */
  }
}
