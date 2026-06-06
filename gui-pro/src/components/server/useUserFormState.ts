import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isDirty, createSnapshot, type DirtySnapshot } from "../../shared/utils/dirtyTracker";
import { generateUsername, generatePassword } from "../../shared/utils/credentialGenerator";
import {
  fromServerResponse as advancedFromServer,
  isLikelyCaChain,
  deriveFingerprintFromDerB64,
} from "../../shared/utils/userAdvanced";
import { formatError } from "../../shared/utils/formatError";
import { sanitizeLogMessage } from "../../shared/utils/sanitizeLogMessage";
import type { ActivityTag } from "../../shared/hooks/useActivityLog";
import {
  readAddUserDraft,
  writeAddUserDraft,
} from "./addUserDraft";
import {
  validateUsername,
  validatePassword,
  validateDisplayName,
  validateCustomSni,
} from "../../shared/utils/userValidators";

// ── Types ───────────────────────────────────────────────────────────────────

export type UpstreamProtocol = "auto" | "h2" | "h3";

export interface DeeplinkFields {
  antiDpi: boolean;
  displayName: string;
  customSni: string;
  upstreamProtocol: UpstreamProtocol;
  skipVerification: boolean;
  pinCert: boolean;
  certDerB64: string | null;
  certFingerprint: string | null;
  /**
   * FIX-OO-7: set by the cert probe response. When true, the chain is
   * already trusted by the OS root store (Let's Encrypt, commercial CA,
   * etc.) and we MUST NOT embed `certDerB64` in the deeplink payload —
   * a ~3 KB chain overflows QR code capacity (binary-mode ECC-M maxes
   * out near 2.3 KB). The sidecar's own platform verifier picks up the
   * handshake at connect time and trusts the chain.
   */
  certIsSystemVerifiable: boolean;
  dnsUpstreams: string[];
  cidr: string;
}

/**
 * Config loaded from server for Edit mode via server_get_user_config.
 *
 * CR-05: backend returns `Result<Option<UserRule>, String>` where UserRule is
 * `{ client_random_prefix: Option<String>, cidr: Option<String> }`. Earlier
 * frontend declared `{ cidr: string; has_prefix: boolean }` which was always
 * undefined → anti-DPI toggle stuck ON and a missing rule (`null`) crashed the
 * `.cidr` read. Now we mirror the actual backend shape and derive `has_prefix`
 * from the optional prefix string.
 */
interface UserRuleResponse {
  client_random_prefix: string | null;
  cidr: string | null;
}

/**
 * M-01: one `[[main_hosts]]` entry from `/opt/trusttunnel/hosts.toml`, trimmed
 * to what the autocomplete needs. The backend CLI accepts a Custom SNI iff it
 * matches the main host's `hostname` OR appears in `allowed_sni` (see upstream
 * `endpoint/src/main.rs:234`). We surface both as suggestion chips so the user
 * doesn't guess blindly and trigger the FIX-OO-14 rollback.
 *
 * Tauri's snake_case → camelCase rewrite maps the Rust `allowed_sni` field to
 * `allowedSni` on the JS side.
 */
interface AllowedSniHost {
  hostname: string;
  allowedSni: string[];
}

interface SshParams {
  host: string;
  port: number;
  user: string;
  password: string;
  keyPath?: string;
  // Index signature so the object is accepted as Tauri InvokeArgs (the
  // server_get_allowed_sni_list call spreads it directly). Matches the
  // useSecurityState.SshParams shape.
  [key: string]: unknown;
}

/**
 * Inputs the form-state hook needs from `UserModal`. These mirror the
 * UserModal props that drive the form lifecycle — the hook owns the React
 * state + effects, UserModal owns the rendering + the Tauri submit handlers
 * (handleAdd / handleSave stay there, PANEL-03 D-04).
 */
export interface UseUserFormStateArgs {
  isOpen: boolean;
  mode: "add" | "edit";
  editUsername?: string;
  existingUsers: string[];
  sshParams: SshParams;
  /** Structured activity-log sink (passed in so the hook stays UI-agnostic). */
  activityLog: (tag: ActivityTag, message: string, details?: string) => void;
  /** Storybook-only: skip backend calls. */
  _storybook?: boolean;
}

// ── Deeplink params snapshot for dirty-tracking ─────────────────────────────

function toSnapshot(f: DeeplinkFields): DirtySnapshot {
  return createSnapshot({
    antiDpi: f.antiDpi,
    displayName: f.displayName,
    customSni: f.customSni,
    upstreamProtocol: f.upstreamProtocol,
    skipVerification: f.skipVerification,
    pinCert: f.pinCert,
    certDerB64: f.certDerB64 ?? null,
    dnsUpstreams: f.dnsUpstreams,
    cidr: f.cidr,
  });
}

/**
 * FIX-K: Draft autosave for the Add-mode form.
 *
 * The read/write/clear logic was extracted VERBATIM into `addUserDraft.ts`
 * (Phase 04 Plan 06, PANEL-02 data layer) so it is unit-testable and reusable
 * by the Wave-3/4 decomposition. This hook keeps only the React state + effects
 * that drive it (the open-restore effect, the per-change persist effect, and
 * the post-submit clear).
 *
 * Data is kept in `sessionStorage` so it survives an accidental close
 * (drag-select that slipped outside, Escape, backdrop click) but is wiped
 * when the app window closes — matching the "current session only" mental
 * model. SAFETY-02: the password is NOT persisted (secret-at-rest) — on
 * restore the form re-rolls a fresh one so it stays submittable, and no
 * plaintext secret ever sits in browser storage.
 */

/**
 * UX-upstream-remove-auto: default switched from "auto" → "h2". Upstream
 * TrustTunnel CLI defaulted `auto` to http/2 anyway, and exposing the
 * indirection made the final client config match the UI less obviously.
 * "auto" stays in the UserAdvancedParams TS union for back-compat — old
 * users-advanced.toml entries with `upstream_protocol="auto"` still load,
 * they just normalize to `"h2"` in state (see Edit-load path below).
 */
export const DEFAULT_DEEPLINK: DeeplinkFields = {
  antiDpi: true,
  displayName: "",
  customSni: "",
  upstreamProtocol: "h2",
  skipVerification: false,
  pinCert: false,
  certDerB64: null,
  certFingerprint: null,
  certIsSystemVerifiable: false,
  dnsUpstreams: [],
  cidr: "",
};

/**
 * useUserFormState — the lifted form-state layer of UserModal (PANEL-02, D-04).
 *
 * Owns all credentials/deeplink/submit/rotation state, the open-restore +
 * per-change-persist + cleanup effects, the dirty-tracking refs, the inline
 * validators, and the `canSubmit` gate. Extracted VERBATIM from UserModal
 * (same effect bodies, deps, refs, closure capture) — mirrors the
 * `useSecurityState.ts` container-hook shape (depend-on-primitives, fat
 * return, `export type ... = ReturnType<...>`). handleAdd/handleSave remain in
 * UserModal (they orchestrate Tauri calls + parent callbacks).
 *
 * Security (D-29): passwords are NEVER logged in activity-log payloads.
 */
export function useUserFormState({
  isOpen,
  mode,
  editUsername,
  existingUsers,
  sshParams,
  activityLog,
  _storybook,
}: UseUserFormStateArgs) {
  // ── Credentials state ──────────────────────────────────────────────────
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [usernameError, setUsernameError] = useState("");

  // ── Deeplink fields state ──────────────────────────────────────────────
  const [deeplink, setDeeplink] = useState<DeeplinkFields>(DEFAULT_DEEPLINK);
  // Snapshot of deeplink fields at modal open (for dirty tracking, D-9)
  const initialDeeplinkRef = useRef<DirtySnapshot>(toSnapshot(DEFAULT_DEEPLINK));
  // M-05: flat snapshot of the loaded DeeplinkFields — needed for the
  // «Отменить изменения» button which must restore the original values
  // (the DirtySnapshot above is a string for comparison, not usable for
  // restoration). Kept as a separate ref so setDeeplink never accidentally
  // mutates it.
  const initialDeeplinkFieldsRef = useRef<DeeplinkFields>(DEFAULT_DEEPLINK);

  // ── Server config load (Edit mode) ────────────────────────────────────
  const [configLoading, setConfigLoading] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);

  // M-01: `[[main_hosts]]` entries from hosts.toml — suggestions for Custom
  // SNI. Non-blocking: fetch failure leaves the list empty and the validator
  // silent (hint chips just don't show), keeping the pre-M-01 UX as fallback.
  const [allowedSniHosts, setAllowedSniHosts] = useState<AllowedSniHost[]>([]);

  // ── Submit state ──────────────────────────────────────────────────────
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // ── Password rotation (Edit mode, FIX-OO-11c) ────────────────────────
  // UX pass: instead of a separate sub-modal, clicking «Сменить пароль»
  // converts the readonly password input into an editable ActionPasswordInput
  // in-place. The main «Сохранить изменения» button then saves the rotation
  // alongside rules.toml + users-advanced.toml updates in one Save click.
  //
  // `passwordEditing = true` toggles the password input into edit mode.
  // `newPassword` holds the typed value; empty means user hasn't touched
  // it yet. Dirty-tracking treats (passwordEditing && non-empty) as a
  // change that contributes to enabling the Save button.
  const [passwordEditing, setPasswordEditing] = useState(false);
  const [newPassword, setNewPassword] = useState("");

  // ── DNS upstreams error ───────────────────────────────────────────────
  const [dnsError, setDnsError] = useState(false);
  // ── CIDR error (WR-14.1-UAT-08): propagated from CIDRPicker onErrorChange ─
  const [cidrError, setCidrError] = useState(false);

  const isEditMode = mode === "edit";

  // C-03 (Phase 04 Plan 06): the Add-form draft is scoped to the FULL server
  // identity (host:port:user) so login/password/deeplink entered for one server
  // never restore on another — and so two server records that share a bare
  // hostname but differ in port/user (review LOW) don't collide on a shared
  // draft key. This is the same triple the app uses to tell server records
  // apart; we compose it once here and thread it through read/write/clear.
  const serverId = `${sshParams.host}:${sshParams.port}:${sshParams.user}`;

  // Users H-02 (Plan 15): the dirty baseline lives in a ref (initialDeeplinkRef),
  // so a refresh of that ref does NOT by itself re-run the isDeeplinkDirty memo
  // (refs don't trigger re-render). This monotonic counter is bumped whenever the
  // baseline is re-anchored (refreshInitialDeeplink) and is a memo dependency, so
  // the dirty flag recomputes against the new baseline after an external-change
  // refresh. Cheap integer state — does not change on ordinary typing.
  const [baselineVersion, setBaselineVersion] = useState(0);

  // ── Derived dirty state (D-9) ─────────────────────────────────────────
  const isDeeplinkDirty = useMemo(
    () => isDirty(initialDeeplinkRef.current, toSnapshot(deeplink)),
    // baselineVersion is intentionally a dep so a refreshInitialDeeplink() call
    // re-evaluates dirtiness against the re-anchored ref (H-02). It is not read
    // in the body (the body reads the ref it invalidates), so exhaustive-deps
    // flags it as "unnecessary" — but dropping it would break the H-02 refresh,
    // which is exactly the regression this dep fixes. Disable the rule for this
    // deliberate ref-invalidation dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deeplink, baselineVersion],
  );

  // ── Collision-check unique username generator ─────────────────────────
  const generateUniqueUsername = useCallback((): string => {
    const taken = new Set(existingUsers);
    let name = generateUsername();
    for (let i = 0; i < 10 && taken.has(name); i++) name = generateUsername();
    return name;
  }, [existingUsers]);

  // ── Open/close effects ────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return;

    // WR-14.1-UAT-10: log modal open for observability (mode + user in edit).
    activityLog(
      "USER",
      `user.modal.opened mode=${mode}${mode === "edit" && editUsername ? ` user=${editUsername}` : ""}`,
    );

    // WR-03: track cancellation for the in-flight server_get_user_config invoke
    // so a quick close → re-open with a different user does not let stale data
    // overwrite the freshly-loaded snapshot (false dirty banner).
    let cancelled = false;

    // M-01: fetch allowed_sni suggestions in both Add and Edit. Runs in
    // parallel with any other open-time fetches — best-effort, silent
    // fallback if the server path is unreachable (fresh deploy, stripped
    // hosts.toml, network hiccup).
    setAllowedSniHosts([]);
    if (!_storybook) {
      invoke<AllowedSniHost[]>("server_get_allowed_sni_list", sshParams)
        .then((list) => {
          if (cancelled) return;
          setAllowedSniHosts(Array.isArray(list) ? list : []);
        })
        .catch(() => {
          // Silent fallback — chip rail hidden, inline validator skips the
          // "is it in allowed_sni?" check. Existing FQDN format validator
          // still runs, so the user isn't left with zero feedback.
        });
    }

    if (mode === "add") {
      // FIX-K: restore draft if present (survived accidental close),
      // otherwise generate fresh credentials.
      const draft = readAddUserDraft<DeeplinkFields>(serverId);
      if (draft) {
        setUsername(draft.username);
        // SAFETY-02: the draft no longer persists the password (secret-at-rest),
        // so a restored draft always reads back password="". Re-roll a fresh
        // password so the form stays submittable — the user can regenerate or
        // retype it. This keeps the FIX-K "don't lose my form" intent without
        // leaving a plaintext secret in sessionStorage.
        setPassword(draft.password || generatePassword());
        setDeeplink(draft.deeplink);
      } else {
        setUsername(generateUniqueUsername());
        setPassword(generatePassword());
        setDeeplink(DEFAULT_DEEPLINK);
      }
      initialDeeplinkRef.current = toSnapshot(DEFAULT_DEEPLINK);
      initialDeeplinkFieldsRef.current = DEFAULT_DEEPLINK;
      setUsernameError("");
      setSubmitError(null);
      setPasswordEditing(false);
      setNewPassword("");
    } else if (mode === "edit" && editUsername) {
      // Load current config from server
      setUsername(editUsername);
      setPassword(""); // placeholder — readonly in Edit
      setDeeplink(DEFAULT_DEEPLINK);
      initialDeeplinkRef.current = toSnapshot(DEFAULT_DEEPLINK);
      setUsernameError("");
      setSubmitError(null);
      setPasswordEditing(false);
      setNewPassword("");

      if (!_storybook) {
        setConfigLoading(true);
        setConfigError(null);
        // FIX-NN: fold two parallel fetches into one Promise.all. rules.toml
        // owns cidr + anti-DPI-prefix; users-advanced.toml owns the 6 TLV
        // fields the upstream protocol doesn't persist. Without this the
        // user saw defaults for display_name / custom_sni / upstream /
        // skip_verify / pin_cert / dns every time they hit Edit — exactly
        // the gap FIX-NN targets.
        //
        // CR-05: backend returns UserRuleResponse | null. has_prefix is derived from
        // the optional prefix string — earlier code keyed off `cfg.has_prefix`,
        // which never existed and made anti-DPI toggle stuck ON.
        //
        // `server_get_user_advanced` can soft-fail (file missing, malformed,
        // older server pre-FIX-NN) — we catch-per-promise and fall back to
        // defaults rather than blocking the whole load.
        Promise.all([
          invoke<UserRuleResponse | null>("server_get_user_config", {
            ...sshParams,
            vpnUsername: editUsername,
          }),
          invoke<unknown>("server_get_user_advanced", {
            ...sshParams,
            username: editUsername,
          }).catch(() => null),
        ])
          .then(([cfg, advancedRaw]) => {
            if (cancelled) return;
            const cidr = cfg?.cidr ?? "";
            // `anti_dpi` has two sources of truth: rules.toml (actual prefix)
            // and users-advanced.toml (UI-mirrored boolean). Prefer rules.toml
            // since that's what the upstream endpoint honors at runtime.
            const antiDpi = !!cfg?.client_random_prefix;
            const advanced = advancedFromServer(advancedRaw);
            const next: DeeplinkFields = advanced
              ? {
                  ...DEFAULT_DEEPLINK,
                  cidr,
                  antiDpi,
                  displayName: advanced.displayName,
                  customSni: advanced.customSni,
                  // UX-upstream-remove-auto: legacy entries stored "auto"
                  // which the CLI used to remap to h2. Now UI only offers
                  // h2/h3, so we normalize old "auto" → "h2" on load.
                  upstreamProtocol:
                    advanced.upstreamProtocol === "auto" ? "h2" : advanced.upstreamProtocol,
                  skipVerification: advanced.skipVerification,
                  pinCert: advanced.pinCert,
                  certDerB64: advanced.certDerB64,
                  certFingerprint: advanced.certFingerprint,
                  // FIX-OO-12: the probe-time `is_system_verifiable` flag
                  // isn't persisted directly, but a CA-issued chain ends up
                  // significantly larger than a self-signed leaf. Use that
                  // size heuristic to restore the flag — deeplink regen
                  // + download-.toml overlay both need it to decide
                  // whether to embed or strip the chain on export.
                  certIsSystemVerifiable: isLikelyCaChain(advanced.certDerB64),
                  dnsUpstreams: advanced.dnsUpstreams,
                }
              : { ...DEFAULT_DEEPLINK, cidr, antiDpi };
            setDeeplink(next);
            // Snapshot AFTER both fetches resolve, so isDeeplinkDirty
            // compares against the full server state — not against hardcoded
            // defaults that would flash the dirty banner for a moment.
            initialDeeplinkRef.current = toSnapshot(next);
            // M-05: mirror the flat DeeplinkFields so the Revert button can
            // restore values. Snapshot string above is for dirty-compare only.
            initialDeeplinkFieldsRef.current = next;
            // CRIT-2 follow-up: server doesn't persist SHA-256 — recompute
            // from DER locally so CertificateFingerprintCard can hydrate.
            // Without this the card boots into the idle «Загрузить» state
            // even though the pin is already saved. Log event for
            // traceability but NEVER leak the full fingerprint into the
            // activity log (first 8 hex chars are enough to correlate).
            if (next.certDerB64) {
              deriveFingerprintFromDerB64(next.certDerB64)
                .then((fp) => {
                  if (cancelled) return;
                  setDeeplink((prev) =>
                    prev.certDerB64 === next.certDerB64
                      ? { ...prev, certFingerprint: fp }
                      : prev,
                  );
                  const snapshotWithFp = { ...next, certFingerprint: fp };
                  initialDeeplinkRef.current = toSnapshot(snapshotWithFp);
                  initialDeeplinkFieldsRef.current = snapshotWithFp;
                  activityLog(
                    "STATE",
                    `user.edit.cert_fp_derived user=${editUsername} fp_prefix=${fp.slice(0, 8)}`,
                  );
                })
                .catch((err) => {
                  if (cancelled) return;
                  activityLog(
                    "ERROR",
                    // SAFETY-02/D-29: route through the shared sanitizer (which
                    // also truncates to MAX_LOG_LEN, replacing the bespoke
                    // inline .slice(0, 80) precedent that seeded this helper).
                    `user.edit.cert_fp_derive_failed user=${editUsername} err=${sanitizeLogMessage(formatError(err))}`,
                  );
                });
            }
          })
          .catch((e) => {
            if (cancelled) return;
            setConfigError(formatError(e));
          })
          .finally(() => {
            if (cancelled) return;
            setConfigLoading(false);
          });
      }
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, mode, editUsername]);

  // FIX-K: persist draft on every change while the Add modal is open. Cheap
  // sync write — sessionStorage at ~kB scale is near-instant and spares us
  // adding a debouncer for a rarely-edited form.
  useEffect(() => {
    if (!isOpen || mode !== "add") return;
    writeAddUserDraft<DeeplinkFields>(serverId, { username, password, deeplink });
  }, [isOpen, mode, username, password, deeplink, serverId]);

  // Cleanup after close (200ms delay matches Modal exit animation)
  useEffect(() => {
    if (isOpen) return;
    const timer = setTimeout(() => {
      setUsername("");
      setPassword("");
      setDeeplink(DEFAULT_DEEPLINK);
      // Users H-01 (Plan 15): the cleanup reset the VISIBLE deeplink back to
      // DEFAULT_DEEPLINK but left the dirty-tracking baseline (initialDeeplinkRef
      // / initialDeeplinkFieldsRef) holding the PREVIOUS Edit session's loaded
      // snapshot. During the close→reopen window isDeeplinkDirty then compared a
      // stale snapshot against the just-reset deeplink → a false dirty banner for
      // a closed, edit-free form. Reset the baseline in lock-step with the visible
      // state so the comparison always tracks what the user actually sees.
      initialDeeplinkRef.current = toSnapshot(DEFAULT_DEEPLINK);
      initialDeeplinkFieldsRef.current = DEFAULT_DEEPLINK;
      setUsernameError("");
      setSubmitError(null);
      setConfigError(null);
      setPasswordEditing(false);
      setNewPassword("");
      setDnsError(false);
      setCidrError(false);
    }, 200);
    return () => clearTimeout(timer);
  }, [isOpen]);

  // ── Validation helpers ─────────────────────────────────────────────────
  const localUsernameError = validateUsername(username);
  const localPasswordError = !isEditMode ? validatePassword(password) : "";
  // WR-14.1-UAT-09: FQDN validation for Custom SNI (TLV 0x03) per D-4
  const localCustomSniError = validateCustomSni(deeplink.customSni);

  // M-01: flatten `[[main_hosts]]` entries into suggestion chips. Upstream CLI
  // check (endpoint/src/main.rs:234) accepts a Custom SNI iff it matches the
  // main host's `hostname` OR any value in its `allowed_sni` — so both go in
  // the chip rail. Dedup defensively because a misconfigured hosts.toml could
  // repeat a hostname under allowed_sni.
  const sniSuggestions = useMemo(() => {
    const set = new Set<string>();
    for (const h of allowedSniHosts) {
      if (h.hostname) set.add(h.hostname);
      for (const s of h.allowedSni ?? []) {
        if (s) set.add(s);
      }
    }
    return Array.from(set);
  }, [allowedSniHosts]);

  const trimmedCustomSni = deeplink.customSni.trim();
  // Three states for the inline validator:
  //   - ok:   value present AND known to be whitelisted by the server
  //   - warn: value present, FQDN format valid, but NOT on the server's list
  //           (would trigger FIX-OO-14 rollback on submit)
  //   - idle: empty field, format-invalid, or we have no suggestions to check
  //           against (offline / fresh deploy)
  const customSniAllowlistState: "ok" | "warn" | "idle" = useMemo(() => {
    if (!trimmedCustomSni) return "idle";
    if (localCustomSniError) return "idle";
    if (sniSuggestions.length === 0) return "idle";
    return sniSuggestions.includes(trimmedCustomSni) ? "ok" : "warn";
  }, [trimmedCustomSni, localCustomSniError, sniSuggestions]);
  // FIX-V: display name (TLV 0x0C) mirrors backend `validate_display_name`.
  const localDisplayNameError = validateDisplayName(deeplink.displayName);
  // FIX-OO-11c: validate the in-place password rotation input.
  // UX-rotate-required: when the editor is open, an empty value must
  // surface as an explicit error under the field — without it the user
  // sees a disabled Save button and has no idea why. Format errors
  // (validatePassword) take precedence so the user sees the more
  // specific message first.
  const localNewPasswordError = passwordEditing
    ? validatePassword(newPassword) ||
      (!newPassword.trim() ? "server.users.rotate_password_required" : "")
    : "";
  const isPasswordDirty = passwordEditing && newPassword.trim().length > 0;

  // WR-14.1-UAT-08: aggregate ALL form errors, not just
  // username/password/dnsError. CIDR error comes from CIDRPicker via
  // onErrorChange callback (see cidrError state below).
  //
  // FIX-OO-11b (Edit mode): Save button is a no-op when nothing has
  // changed, so disable it until the user edits SOMETHING — either
  // deeplink params, cidr/anti-DPI, or opens the inline password editor
  // and types a new valid password. Otherwise the button sits "live" and
  // invites accidental re-saves that just round-trip the same rules.toml
  // write for no reason.
  // passwordEditing is referenced here — add to deps below.
  const canSubmit = useMemo(() => {
    if (isSubmitting) return false;
    if (dnsError || cidrError || localCustomSniError || localDisplayNameError)
      return false;
    if (localUsernameError) return false;
    if (!username.trim()) return false;
    if (!isEditMode) {
      if (localPasswordError) return false;
      if (!password.trim()) return false;
      return true;
    }
    // Edit mode: password editor must have no validation error.
    if (passwordEditing && localNewPasswordError) return false;
    // CRIT-1: if the inline password editor is OPEN, the user intends to
    // rotate the password — empty input is not a valid commit state, even
    // if the deeplink section is dirty. Otherwise user could open the
    // rotator, toggle anti-DPI, and hit Save — password rotation would
    // silently skip (isPasswordDirty=false) but the editor stays open and
    // it's confusing. Force them to either type a password or close the
    // editor via the inline Cancel button first.
    if (passwordEditing && !newPassword.trim()) return false;
    // Something must actually have changed. Either the deeplink params, or
    // the inline password editor was opened and a new password typed.
    if (!isDeeplinkDirty && !isPasswordDirty) return false;
    return true;
  }, [
    isSubmitting,
    dnsError,
    cidrError,
    localCustomSniError,
    localDisplayNameError,
    localUsernameError,
    localPasswordError,
    username,
    password,
    isEditMode,
    passwordEditing,
    localNewPasswordError,
    newPassword,
    isDeeplinkDirty,
    isPasswordDirty,
  ]);

  // ── Deeplink updater helper ────────────────────────────────────────────
  const updateDeeplink = useCallback(<K extends keyof DeeplinkFields>(
    key: K,
    value: DeeplinkFields[K],
  ) => {
    setDeeplink((prev) => ({ ...prev, [key]: value }));
  }, []);

  // Users H-02 (Plan 15): refresh the dirty-tracking baseline from an externally
  // re-fetched server state. The Save pre-check (UserModal.handleSave) re-reads
  // the current server rule to detect external edits made while the modal was
  // open. If an admin changed cidr / anti-DPI server-side, the open-time
  // `initialDeeplinkRef` snapshot is stale — a form that now matches the new
  // server state would still read as dirty (or a genuine clobber would go
  // unflagged). Calling this with the freshly-fetched fields re-anchors BOTH the
  // comparison snapshot and the M-05 revert snapshot so dirty-tracking compares
  // against reality, not the moment the modal opened. Kept in the hook (not the
  // modal) because the refs it owns are private to the form-state layer.
  const refreshInitialDeeplink = useCallback((fields: DeeplinkFields) => {
    initialDeeplinkRef.current = toSnapshot(fields);
    initialDeeplinkFieldsRef.current = fields;
    // Force isDeeplinkDirty to recompute against the re-anchored baseline.
    setBaselineVersion((v) => v + 1);
  }, []);

  return {
    // Credentials
    username, setUsername,
    password, setPassword,
    usernameError, setUsernameError,

    // Deeplink fields + dirty-tracking refs
    deeplink, setDeeplink,
    initialDeeplinkRef,
    initialDeeplinkFieldsRef,
    isDeeplinkDirty,

    // Server config load (Edit mode)
    configLoading,
    configError,

    // Custom SNI suggestions / allowlist
    sniSuggestions,
    customSniAllowlistState,
    trimmedCustomSni,

    // Submit state
    isSubmitting, setIsSubmitting,
    submitError, setSubmitError,

    // Password rotation (Edit mode)
    passwordEditing, setPasswordEditing,
    newPassword, setNewPassword,

    // DNS / CIDR errors
    dnsError, setDnsError,
    cidrError, setCidrError,

    // Derived flags / validators
    isEditMode,
    serverId,
    localUsernameError,
    localPasswordError,
    localCustomSniError,
    localDisplayNameError,
    localNewPasswordError,
    isPasswordDirty,
    canSubmit,

    // Helpers
    generateUniqueUsername,
    updateDeeplink,
    refreshInitialDeeplink,
  };
}

export type UserFormState = ReturnType<typeof useUserFormState>;
