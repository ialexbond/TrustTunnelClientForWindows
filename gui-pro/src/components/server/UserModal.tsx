import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Loader2 } from "lucide-react";
import { Modal } from "../../shared/ui/Modal";
import { Button } from "../../shared/ui/Button";
import { ErrorBanner } from "../../shared/ui/ErrorBanner";
import { useSnackBar } from "../../shared/ui/SnackBarContext";
import { useActivityLog } from "../../shared/hooks/useActivityLog";
import { formatError } from "../../shared/utils/formatError";
import { sanitizeLogMessage } from "../../shared/utils/sanitizeLogMessage";
import { toServerPayload as advancedToPayload } from "../../shared/utils/userAdvanced";
// Phase 04 Plan 10 (PANEL-03, D-04): the «Учётные данные» credentials section
// is now a props-only presentational sub-component (pure JSX move).
import { UserFormFields } from "./UserFormFields";
// Phase 04 Plan 11 (PANEL-03, D-04): the «Параметры deeplink» section (7 TLV
// fields + CIDR + cert card) is now a props-only presentational sub-component
// too (pure JSX move). The UPSTREAM_SEGMENTS constant moved with it.
import { DeeplinkSection } from "./DeeplinkSection";
// Phase 04 Plan 06 (PANEL-02): the Add-form draft sessionStorage I/O was
// extracted VERBATIM into a pure leaf util. clearAddUserDraft fires from
// handleAdd after a successful submit (the read/write effects now live in the
// useUserFormState hook).
import { clearAddUserDraft } from "./addUserDraft";
// Phase 04 Plan 10 (PANEL-02, D-04): all form-state, effects, dirty-tracking
// and `canSubmit` were lifted VERBATIM into the useUserFormState container
// hook (mirrors useSecurityState). UserModal keeps handleAdd/handleSave (they
// orchestrate Tauri + parent callbacks) and the rendering. The DeeplinkFields
// shape + DEFAULT_DEEPLINK are re-exported from the hook so this file stays the
// public surface for them.
import { useUserFormState } from "./useUserFormState";

// ── Types ───────────────────────────────────────────────────────────────────
//
// Phase 04 Plan 10 (PANEL-02, D-04): DeeplinkFields / UpstreamProtocol /
// AllowedSniHost + DEFAULT_DEEPLINK + toSnapshot moved into useUserFormState
// (the lifted form-state container hook). DeeplinkFields is re-imported above
// so the handlers below keep their types. UserRuleResponse stays here because
// handleSave's pre-save existence check (server_get_user_config) is the one
// remaining consumer that lives in this file.

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

export interface UserModalProps {
  /** Whether the modal is open. Modal owns its exit animation — never pass null here. */
  isOpen: boolean;
  /**
   * Mode: "add" opens a blank form; "edit" pre-loads config for `editUsername`.
   */
  mode: "add" | "edit";
  /** Username to edit — required when mode="edit". */
  editUsername?: string;
  /** Existing users list — used for collision-check on add. */
  existingUsers: string[];
  sshParams: {
    host: string;
    port: number;
    user: string;
    password: string;
    keyPath?: string;
  };
  /**
   * Cert type detected for the endpoint (from server_get_cert_info). Used to
   * disable Pin Certificate / Skip Verification toggles when the server runs
   * Let's Encrypt — DEEP_LINK.md says both fields should be omitted when the
   * chain verifies via system CAs. `undefined` / `"unknown"` keep the toggles
   * active so users on custom setups retain control.
   */
  serverCertType?: "self_signed" | "lets_encrypt" | "unknown";
  onClose: () => void;
  /**
   * Called after successful add. `generatedDeeplink` is the deeplink returned
   * by `server_add_user_advanced` — it contains ALL TLV fields (display_name,
   * SNI, DNS, anti-DPI prefix, cert pin, etc.) baked in. Parent MUST preload
   * this into UserConfigModal — re-fetching via basic
   * `server_export_config_deeplink` strips the TLVs because the server
   * doesn't persist them (see CONTEXT.md D-1 footnote).
   */
  onUserAdded?: (username: string, generatedDeeplink: string) => void;
  /**
   * Called after successful edit. `regeneratedDeeplink` is non-null when the
   * deeplink section was edited and a fresh deeplink was produced in Step 2
   * of handleSave (FIX-W). Parent components should auto-open UserConfigModal
   * with the preloaded deeplink so the user actually receives it — server
   * doesn't persist TLV params so this is the ONLY moment the deeplink exists.
   */
  onUserUpdated?: (username: string, regeneratedDeeplink: string | null) => void;
  /** Storybook-only: skip backend calls. */
  _storybook?: boolean;
  /** Storybook-only: force the Edit-mode Loader overlay (FIX-T). */
  _forceConfigLoading?: boolean;
}

// UX-upstream-segmented: the HTTP/2 / HTTP/3 picker constant moved into
// <DeeplinkSection> (Phase 04 Plan 11) alongside the section it drives.

// ── Component ────────────────────────────────────────────────────────────────

/**
 * UserModal — D-1 through D-9 unified Add/Edit modal.
 *
 * Two always-visible sections:
 *   1. «Учётные данные» — username + password (credentials.toml)
 *   2. «Параметры deeplink» — all 7 TLV fields + CIDR + anti-DPI prefix (D-4)
 *
 * Add mode: submits server_add_user_advanced → onUserAdded callback.
 * Edit mode: loads server_get_user_config → shows dirty-state warning (D-9)
 *            → submits server_update_user_config + (if dirty deeplink) re-generates.
 *
 * Modal lifecycle contract: NO early `if (!isOpen) return null` — Modal
 * primitive owns the 200ms exit animation. State cleanup uses setTimeout(200).
 *
 * Security (D-29): passwords are NEVER logged in activity-log payloads.
 */
export function UserModal({
  isOpen,
  mode,
  editUsername,
  existingUsers,
  sshParams,
  serverCertType,
  onClose,
  onUserAdded,
  onUserUpdated,
  _storybook,
  _forceConfigLoading,
}: UserModalProps) {
  const { t } = useTranslation();
  const pushSuccess = useSnackBar();
  const { log: activityLog } = useActivityLog();

  // ── Lifted form state (Phase 04 Plan 10, PANEL-02 / D-04) ────────────────
  // All credentials/deeplink/submit/rotation state, the open-restore +
  // per-change-persist + cleanup effects, the dirty-tracking refs, the inline
  // validators and `canSubmit` now live in useUserFormState (extracted
  // VERBATIM, mirrors useSecurityState). UserModal keeps handleAdd/handleSave
  // (they orchestrate Tauri + parent callbacks) and the rendering. We
  // destructure the hook surface to the same local names the handlers + JSX
  // already use, so the move is observably transparent (Pitfall 1).
  const {
    username, setUsername,
    password, setPassword,
    usernameError, setUsernameError,
    deeplink,
    initialDeeplinkFieldsRef,
    isDeeplinkDirty,
    configLoading,
    configError,
    sniSuggestions,
    customSniAllowlistState,
    trimmedCustomSni,
    isSubmitting, setIsSubmitting,
    submitError, setSubmitError,
    passwordEditing, setPasswordEditing,
    newPassword, setNewPassword,
    setDnsError,
    setCidrError,
    isEditMode,
    serverId,
    localUsernameError,
    localPasswordError,
    localCustomSniError,
    localDisplayNameError,
    localNewPasswordError,
    isPasswordDirty,
    canSubmit,
    generateUniqueUsername,
    updateDeeplink,
    refreshInitialDeeplink,
  } = useUserFormState({
    isOpen,
    mode,
    editUsername,
    existingUsers,
    sshParams,
    activityLog,
    _storybook,
  });

  // Initial focus is now owned by the Modal primitive (09-05): on open it
  // focuses the first focusable inside the content box (the canonical close
  // button). The hand-rolled auto-focus effect + ref were removed in 09-23 when
  // this modal adopted Modal's showCloseButton.

  // ── Add user handler ──────────────────────────────────────────────────
  const handleAdd = useCallback(async () => {
    if (!canSubmit || isSubmitting) return;
    const trimmedUsername = username.trim();
    const trimmedPassword = password.trim();
    // FIX-LOG2: include the shape of the submitted deeplink config so failed
    // submits are easier to diagnose from the log alone. Payload contents
    // (raw values) stay out — only counts and booleans.
    activityLog(
      "USER",
      `user.add_advanced.clicked name_len=${deeplink.displayName.length}` +
        ` sni_len=${deeplink.customSni.length}` +
        ` proto=${deeplink.upstreamProtocol}` +
        ` anti_dpi=${deeplink.antiDpi}` +
        ` skip_verify=${deeplink.skipVerification}` +
        ` pin_cert=${deeplink.pinCert}` +
        ` cidr=${deeplink.cidr ? "set" : "none"}` +
        ` dns_count=${deeplink.dnsUpstreams.length}`,
    );
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      // FIX-KK: CAPTURE the generated deeplink. Backend baked every TLV param
      // into this string — if we throw it away and let UserConfigModal re-fetch
      // via basic `server_export_config_deeplink`, all those fields (display
      // name, SNI, DNS, anti-DPI prefix, cert, etc.) are SILENTLY stripped
      // because server doesn't persist them. That's exactly what happened:
      // user filled every field, got back a deeplink with only username +
      // password. Propagate the string through onUserAdded so UsersSection
      // can preload UserConfigModal with the REAL thing.
      // Audit CQ-4 (ln-624): the 12 business-logic fields are wrapped into
      // a single `req` object matching the Rust `AddUserRequest` struct
      // (serde rename_all = camelCase). SSH params remain top-level extras
      // consumed by the ssh_pool_command macro.
      const generatedDeeplink = await invoke<string>("server_add_user_advanced", {
        ...sshParams,
        req: {
          vpnUsername: trimmedUsername,
          vpnPassword: trimmedPassword,
          antiDpi: deeplink.antiDpi,
          // WR-02: anti-DPI prefix length / freq% are still backend defaults (4 bytes / 70%)
          // until UI controls land. Pass null so the Rust side keeps using its defaults.
          prefixLength: null,
          prefixPercent: null,
          cidr: deeplink.cidr || null,
          // Deeplink TLV params
          // WR-01: the Rust field is `name` (not `display_name`). With serde
          // rename_all = camelCase the JS key stays `name`. Sending `displayName`
          // would land on a missing field and serde-default to None.
          name: deeplink.displayName || null,
          customSni: deeplink.customSni || null,
          upstreamProtocol: deeplink.upstreamProtocol !== "auto" ? deeplink.upstreamProtocol : null,
          skipVerification: deeplink.skipVerification,
          // CR-01: backend expects pinCertificateDer (Base64 string), not certDerB64.
          // FIX-OO-7: skip embedding the cert when the platform verifier
          // already trusts the chain (Let's Encrypt etc.). A 3 KB chain
          // blows past QR code binary-mode capacity (~2.3 KB at ECC-M) and
          // qrcode.react throws "Data too long". The sidecar's own
          // platform verifier picks up the handshake anyway — no security
          // lost, just no TLV 0x08 payload.
          pinCertificateDer:
            deeplink.pinCert && !deeplink.certIsSystemVerifiable
              ? deeplink.certDerB64
              : null,
          // Backend signature is Vec<String> — empty array on no DNS, NOT null.
          dnsUpstreams: deeplink.dnsUpstreams,
        },
      });
      activityLog(
        "STATE",
        `user.add_advanced.completed user=${trimmedUsername} deeplink_len=${generatedDeeplink.length}`,
      );
      // FIX-NN: backend `server_add_user_advanced` already runs the upsert
      // internally (Step 4). This second invoke is belt-and-braces in case
      // the backend's best-effort write was skipped — but because it's an
      // extra SSH roundtrip, we catch-and-log rather than blocking the
      // success path. Deeplink is already generated and in the user's hand.
      //
      // WR-01 (14.1-REVIEW deep pass): previously wrapped in
      // `Promise.resolve(invoke(...)).catch(...)` to defend against Vitest
      // mocks that return undefined (bare `.catch` would throw sync).
      // Swapped to an async IIFE — `await invoke(...)` works for both real
      // Promises and mock-undefined, and the try/catch surfaces SSH write
      // failures via activity log instead of silently dropping them.
      void (async () => {
        try {
          await invoke("server_set_user_advanced", {
            ...sshParams,
            params: advancedToPayload(
              {
                displayName: deeplink.displayName,
                customSni: deeplink.customSni,
                upstreamProtocol: deeplink.upstreamProtocol,
                skipVerification: deeplink.skipVerification,
                pinCert: deeplink.pinCert,
                certDerB64: deeplink.certDerB64,
                certFingerprint: deeplink.certFingerprint,
                dnsUpstreams: deeplink.dnsUpstreams,
                antiDpi: deeplink.antiDpi,
              },
              trimmedUsername,
              // FIX-OO-12: persist the cert bytes unconditionally. The
              // deeplink-encoder gate above and the overlay's multi-block
              // heuristic in Rust both decide whether to EMBED the chain at
              // export time — storage should just retain the user's choice
              // so the Edit toggle stays ON when reopened.
            ),
          });
        } catch (err) {
          activityLog(
            "ERROR",
            // SAFETY-02/D-29: route the backend error through the shared
            // sanitizer (strips credential-shaped substrings + truncates)
            // before it reaches the log channel.
            `user.advanced.persist_failed user=${trimmedUsername} err=${sanitizeLogMessage(formatError(err))}`,
          );
        }
      })();
      // FIX-R: parent (UsersSection.handleUserAdded) already fires the success
      // snack-bar via state.pushSuccess with the same i18n key. Firing it
      // again here produced two identical toasts back-to-back — drop the
      // duplicate and let the owning container handle user-facing feedback.
      clearAddUserDraft(serverId);
      onUserAdded?.(trimmedUsername, generatedDeeplink);
      onClose();
    } catch (e) {
      const raw = formatError(e);
      const lower = raw.toLowerCase();
      // SAFETY-02/D-29: only the LOGGED string is sanitized; `raw` stays intact
      // below for the user-facing error message (a backend error may legitimately
      // need to show the offending value on screen, but must never hit the log).
      activityLog("ERROR", `user.add_advanced.failed err=${sanitizeLogMessage(raw)}`);
      // FIX-Q: map common backend error strings to localized, actionable messages.
      // Always APPEND the raw detail so the user still sees the exit code /
      // CLI output snippet — without it «SSH-команда завершилась с ошибкой»
      // is a dead-end message (user asked "что именно пошло не так").
      //
      // FIX-OO-14 changed the error shape:
      //   - `ADD_USER_ROLLED_BACK|<inner>` wraps the original error when the
      //     rollback path ran, signalling a clean retry-from-zero state.
      //     Check this BEFORE the inner patterns so the user doesn't see
      //     the scary "partial create" wording when there's actually
      //     nothing left to clean up.
      //   - "custom SNI 'X' does not match any hostname or allowed_sni"
      //     is the specific error we want to surface inline with the
      //     offending SNI value, not as a generic SSH_EXPORT_FAILED.
      let mapped: string | null = null;
      const sniMatch = raw.match(
        /custom SNI '([^']+)' does not match any hostname or allowed_sni/i,
      );
      const wasRolledBack = lower.includes("add_user_rolled_back");
      if (sniMatch) {
        mapped = t("server.users.add_error_sni_not_allowed", { sni: sniMatch[1] });
      } else if (lower.includes("already exists")) {
        mapped = t("server.users.add_error_already_exists", { user: trimmedUsername });
      } else if (wasRolledBack) {
        // Generic rollback (non-SNI causes) — still cleaner than the
        // pre-FIX "partial create" wording because nothing orphan remains.
        mapped = t("server.users.add_error_rolled_back", {
          detail: raw.replace(/^ADD_USER_ROLLED_BACK\|/i, ""),
        });
      } else if (lower.includes("empty or malformed deeplink")) {
        mapped = t("server.users.add_error_deeplink_empty");
      } else if (lower.includes("ssh_export_failed")) {
        mapped = t("server.users.add_error_ssh_export_failed");
      } else if (lower.includes("hostname contains invalid") || lower.includes("hostname is an ip")) {
        mapped = t("server.users.add_error_hostname_invalid");
      }
      // For mapped SNI/rollback messages the detail is already embedded
      // in the template via {{sni}}/{{detail}}, so skip the redundant raw
      // suffix — keeps the banner tight.
      const suffix = sniMatch || wasRolledBack ? "" : `\n\n${t("common.details")}: ${raw}`;
      setSubmitError(mapped ? `${mapped}${suffix}` : raw);
    } finally {
      setIsSubmitting(false);
    }
    // setIsSubmitting/setSubmitError now come from useUserFormState; React
    // guarantees state setters are referentially stable, so listing them is a
    // no-op for memoization but satisfies exhaustive-deps after the extraction.
  }, [canSubmit, isSubmitting, username, password, deeplink, sshParams, serverId, activityLog, t, onUserAdded, onClose, setIsSubmitting, setSubmitError]);

  // UX-revert-removed: handleRevert удалён вместе с кнопкой — Cancel
  // закрывает modal целиком, отдельный Revert без закрытия был избыточен.

  // UX-clear-removed: handleClear + Очистить кнопка удалены по фидбеку.
  // clearAddUserDraft() всё ещё вызывается внутри handleAdd после успешного
  // submit (sessionStorage cleanup) — это часть FIX-K flow и НЕ связана с
  // кнопкой.

  // ── Edit/save handler ─────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!canSubmit || isSubmitting || !editUsername) return;
    // FIX-X: log full field summary (counts + booleans only — sensitive
    // contents stay out). Mirrors the add_advanced.clicked event so edits
    // are equally traceable from activity.log.
    activityLog(
      "USER",
      `user.update.clicked user=${editUsername}` +
        ` name_len=${deeplink.displayName.length}` +
        ` sni_len=${deeplink.customSni.length}` +
        ` proto=${deeplink.upstreamProtocol}` +
        ` anti_dpi=${deeplink.antiDpi}` +
        ` skip_verify=${deeplink.skipVerification}` +
        ` pin_cert=${deeplink.pinCert}` +
        ` cidr=${deeplink.cidr ? "set" : "none"}` +
        ` dns_count=${deeplink.dnsUpstreams.length}` +
        ` deeplink_dirty=${isDeeplinkDirty}`,
    );
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      // M-04 pre-Save check: подтверждаем что юзер всё ещё существует на
      // сервере перед тем как писать в rules.toml / users-advanced.toml.
      // Если админ удалил его через SSH напрямую пока modal был открыт,
      // server_get_user_config вернёт null — показываем actionable
      // banner вместо cryptic ошибки от backend'а, куда бы запись
      // упала дальше по цепочке.
      const preSave = await invoke<UserRuleResponse | null>("server_get_user_config", {
        ...sshParams,
        vpnUsername: editUsername,
      });
      if (preSave === null) {
        activityLog(
          "ERROR",
          `user.update.precheck_missing user=${editUsername}`,
        );
        setSubmitError(t("server.users.user_removed_externally", { user: editUsername }));
        setIsSubmitting(false);
        return;
      }

      // Users H-02 (Plan 15): the pre-save check re-reads the CURRENT server rule.
      // If an admin changed cidr / anti-DPI on the server while this modal was
      // open, the open-time dirty baseline is now stale and a later re-open would
      // flash a false dirty banner against values that no longer match the server.
      // Re-anchor the baseline's server-owned fields (cidr + antiDpi) to the fresh
      // read so dirty-tracking compares against reality. We keep the user's own
      // in-flight edits to those fields (deeplink) — only the BASELINE moves, so
      // the actual save below still writes the user's intended values. Guard on a
      // real object: the existence pre-check only treats a strict `null` as
      // "removed", so a non-object (older backend / partial mock) skips the
      // refresh rather than dereferencing a missing rule.
      if (typeof preSave === "object") {
        const serverCidr = preSave.cidr ?? "";
        const serverAntiDpi = !!preSave.client_random_prefix;
        if (
          serverCidr !== initialDeeplinkFieldsRef.current.cidr ||
          serverAntiDpi !== initialDeeplinkFieldsRef.current.antiDpi
        ) {
          refreshInitialDeeplink({
            ...initialDeeplinkFieldsRef.current,
            cidr: serverCidr,
            antiDpi: serverAntiDpi,
          });
        }
      }

      // FIX-OO-11c Step 0: password rotation (if the user opened the
      // inline editor and typed a valid new password). Must run FIRST so
      // that if it fails we surface the error before touching rules.toml
      // or users-advanced.toml — partial success is confusing.
      if (isPasswordDirty) {
        activityLog("USER", `user.password.rotate_initiated user=${editUsername}`);
        await invoke("server_rotate_user_password", {
          ...sshParams,
          vpnUsername: editUsername,
          newPassword: newPassword.trim(),
        });
        activityLog("STATE", `user.password.rotated user=${editUsername}`);
      }

      // Step 1 — apply rules.toml updates (CIDR + anti-DPI) only when the
      // deeplink section changed. If only the password changed, skip the
      // rules.toml roundtrip entirely — it would be a no-op write and an
      // unnecessary SSH hop.
      if (isDeeplinkDirty) {
        await invoke("server_update_user_config", {
          ...sshParams,
          // Backend signature uses `username` (not `vpn_username`) — Tauri rewrites
          // camelCase to snake_case but the snake_case key MUST match the Rust arg.
          username: editUsername,
          cidr: deeplink.cidr || null,
          antiDpi: deeplink.antiDpi,
          // Keep the existing prefix unless the user toggled anti_dpi off (rule below).
          // Backend regenerates whenever the rule entry is missing.
          regeneratePrefix: false,
        });
      }

      // FIX-W: Step 2 — regenerate deeplink if the deeplink section was
      // edited. Server doesn't persist deeplink TLV params (D-1 footnote),
      // so we bake the new values into a fresh deeplink here and surface
      // it via onUserUpdated so the parent can auto-open UserConfigModal
      // with the new QR. Without this the user clicked Save, saw the
      // success toast, and never got the updated deeplink — everything
      // they typed was silently thrown away.
      let regeneratedDeeplink: string | null = null;
      if (isDeeplinkDirty) {
        activityLog("USER", `user.update.regenerating_deeplink user=${editUsername}`);
        regeneratedDeeplink = await invoke<string>(
          "server_export_config_deeplink_advanced",
          {
            ...sshParams,
            clientName: editUsername,
            customSni: deeplink.customSni || null,
            name: deeplink.displayName || null,
            upstreamProtocol:
              deeplink.upstreamProtocol !== "auto" ? deeplink.upstreamProtocol : null,
            antiDpi: deeplink.antiDpi,
            skipVerification: deeplink.skipVerification,
            // FIX-OO-7: skip embedding the cert when the platform verifier
        // already trusts the chain (Let's Encrypt etc.). A 3 KB chain
        // blows past QR code binary-mode capacity (~2.3 KB at ECC-M) and
        // qrcode.react throws "Data too long". The sidecar's own
        // platform verifier picks up the handshake anyway — no security
        // lost, just no TLV 0x08 payload.
        pinCertificateDer:
          deeplink.pinCert && !deeplink.certIsSystemVerifiable
            ? deeplink.certDerB64
            : null,
            dnsUpstreams: deeplink.dnsUpstreams,
          },
        );
        activityLog("STATE", `user.update.deeplink_regenerated user=${editUsername}`);
      }

      // FIX-NN: persist TLV params so the next Edit / FileText / Download
      // round-trip reflects what the user just saved. Without this, Edit
      // re-opens with defaults again and the user can't tell what was
      // actually stored. Awaited (unlike the handleAdd variant) because
      // Save is the explicit commit moment — but surface failures via
      // activity log rather than blocking onUserUpdated, since the rules
      // and deeplink have already been written to the server.
      try {
        await invoke("server_set_user_advanced", {
          ...sshParams,
          params: advancedToPayload(
            {
              displayName: deeplink.displayName,
              customSni: deeplink.customSni,
              upstreamProtocol: deeplink.upstreamProtocol,
              skipVerification: deeplink.skipVerification,
              pinCert: deeplink.pinCert,
              certDerB64: deeplink.certDerB64,
              certFingerprint: deeplink.certFingerprint,
              dnsUpstreams: deeplink.dnsUpstreams,
              antiDpi: deeplink.antiDpi,
            },
            editUsername,
            // FIX-OO-12: persist cert bytes unconditionally (see handleAdd).
            // Deeplink-encoder gate + Rust overlay decide embed/skip at
            // export time. Storage just keeps the user's toggle intent
            // stable across Edit reopens.
          ),
        });
      } catch (persistErr) {
        activityLog(
          "ERROR",
          // SAFETY-02/D-29: sanitize the backend error before the log channel.
          `user.advanced.persist_failed user=${editUsername} err=${sanitizeLogMessage(formatError(persistErr))}`,
        );
      }
      activityLog("STATE", `user.update.completed user=${editUsername}`);
      pushSuccess(t("server.users.user_updated", { user: editUsername }));
      onUserUpdated?.(editUsername, regeneratedDeeplink);
      onClose();
    } catch (e) {
      const raw = formatError(e);
      const lower = raw.toLowerCase();
      // SAFETY-02/D-29: sanitize only the LOGGED string; `raw` is kept below for
      // the user-facing message (see handleAdd for the same split).
      activityLog("ERROR", `user.update.failed err=${sanitizeLogMessage(raw)}`);
      // Same error-mapping flow as handleAdd (FIX-Q) — localized message +
      // raw technical detail so the user can act on it. FIX-OO-14 adds the
      // SNI / allowed_sni case which surfaces during deeplink re-generation
      // when the user edited Custom SNI to something the server doesn't
      // whitelist in hosts.toml.
      let mapped: string | null = null;
      const sniMatch = raw.match(
        /custom SNI '([^']+)' does not match any hostname or allowed_sni/i,
      );
      if (sniMatch) {
        mapped = t("server.users.add_error_sni_not_allowed", { sni: sniMatch[1] });
      } else if (lower.includes("empty or malformed deeplink")) {
        mapped = t("server.users.add_error_deeplink_empty");
      } else if (lower.includes("ssh_export_failed")) {
        mapped = t("server.users.add_error_ssh_export_failed");
      } else if (lower.includes("hostname contains invalid") || lower.includes("hostname is an ip")) {
        mapped = t("server.users.add_error_hostname_invalid");
      }
      const suffix = sniMatch ? "" : `\n\n${t("common.details")}: ${raw}`;
      setSubmitError(mapped ? `${mapped}${suffix}` : raw);
    } finally {
      setIsSubmitting(false);
    }
    // setIsSubmitting/setSubmitError come from useUserFormState (stable setters)
    // — listed for exhaustive-deps after the extraction, no memoization change.
  }, [canSubmit, isSubmitting, editUsername, deeplink, isDeeplinkDirty, isPasswordDirty, newPassword, sshParams, activityLog, pushSuccess, t, onUserUpdated, onClose, setIsSubmitting, setSubmitError, refreshInitialDeeplink, initialDeeplinkFieldsRef]);

  // FIX-OO-11c: password rotation is now folded into `handleSave`. The
  // old standalone `handleRotatePassword` + `showRotation` sub-modal was
  // replaced by an inline editable password field — see render below.
  // `localNewPasswordError` + `isPasswordDirty` are declared above near
  // the other validation helpers so `canSubmit` can reference them.

  const isDisabled = isSubmitting;

  // ── No early return null (Modal lifecycle contract) ───────────────────
  // Modal primitive manages its own mounted/animating state (200ms exit anim).
  // Returning null here would unmount the tree instantly and kill exit transition.
  // WR-14.1-UAT-10: wrap onClose so every user-initiated close path (X, backdrop,
  // Escape) records a structured activity event.
  const handleCloseWithSource = (source: string) => {
    activityLog("USER", `user.modal.closed source=${source}`);
    onClose();
  };
  return (
    <Modal
      isOpen={isOpen}
      // 09-23: the canonical close button (showCloseButton) wires the <X> to this
      // same onClose. The prior hand-rolled <X> logged source=x while
      // backdrop/escape logged source=backdrop_or_escape; the canonical button
      // shares one onClose, so all user-initiated closes now record the same
      // (non-secret) activity event. No test covered the X-specific source, and
      // the close still logs + fires onClose — the source-string granularity is
      // the only behavioural delta (see 09-23-SUMMARY deviations).
      onClose={isDisabled ? undefined : () => handleCloseWithSource("close")}
      closeOnBackdrop={!isDisabled}
      closeOnEscape={!isDisabled}
      size="lg"
      className="relative max-h-[90vh] overflow-y-auto"
      // Users H-06: make the modal a proper labelled dialog so SR/keyboard users
      // hear the title as the dialog name (aria-labelledby → the visible <h2>).
      role="dialog"
      ariaModal
      ariaLabelledby="user-modal-title"
      showCloseButton
      closeButtonDisabled={isDisabled}
      closeButtonTestId="user-modal-close"
    >
      {/* Title — id target for the dialog's aria-labelledby (Users H-06). */}
      <h2 id="user-modal-title" className="text-lg font-semibold text-[var(--color-text-primary)] mb-[var(--space-5)] pr-8">
        {isEditMode
          ? t("server.users.edit_title", { user: editUsername })
          : t("server.users.add_title")}
      </h2>

      {/* FIX-T: Edit-mode while fetching per-user rule from the server — render
          a centred Loader instead of the form. Previously we showed defaults
          (anti_dpi=true, no CIDR) which then snapped to the server values after
          ~500 ms, and the dirty-state banner briefly flashed too because the
          initial snapshot disagreed with the loaded one. Showing a Loader keeps
          the modal honest: no field values are drawn until we know them. */}
      {isEditMode && (configLoading || _forceConfigLoading) ? (
        <div
          className="flex items-center justify-center gap-[var(--space-2)] py-[var(--space-8)]"
          data-testid="user-modal-loading"
          aria-live="polite"
        >
          <Loader2 className="w-5 h-5 animate-spin text-[var(--color-text-muted)]" aria-hidden="true" />
          <span className="text-sm text-[var(--color-text-muted)]">
            {t("server.users.edit_loading")}
          </span>
        </div>
      ) : (
        <>
      {/* UX-dirty-banner-bottom: dirty warning moved to sit right above
          the Save button (was at the top of the modal, invisible when the
          user scrolled down to change a field). Kept in the conditional
          section so it disappears the moment the form is no longer dirty. */}

      {/* Config load error (Edit mode only) */}
      {configError && (
        <ErrorBanner
          variant="error"
          message={configError}
          className="mb-[var(--space-4)]"
        />
      )}

      {/* ── Section 1: Учётные данные ──────────────────────────────────────
          Phase 04 Plan 10 (PANEL-03, D-04): extracted VERBATIM into a
          props-only <UserFormFields>. Pure JSX move — DOM/testids/aria stay
          byte-identical so the Phase 3 net passes unedited (Pitfall 1). */}
      <UserFormFields
        isEditMode={isEditMode}
        isDisabled={isDisabled}
        username={username}
        setUsername={setUsername}
        setUsernameError={setUsernameError}
        localUsernameError={localUsernameError}
        usernameError={usernameError}
        generateUniqueUsername={generateUniqueUsername}
        password={password}
        setPassword={setPassword}
        localPasswordError={localPasswordError}
        passwordEditing={passwordEditing}
        setPasswordEditing={setPasswordEditing}
        newPassword={newPassword}
        setNewPassword={setNewPassword}
        localNewPasswordError={localNewPasswordError}
      />

      {/* ── Section 2: Параметры deeplink ───────────────────────────────
          Phase 04 Plan 11 (PANEL-03, D-04): extracted VERBATIM into a
          props-only <DeeplinkSection>. Pure JSX move — DOM/testids/aria stay
          byte-identical so the Phase 3 net passes unedited (Pitfall 1). */}
      <DeeplinkSection
        deeplink={deeplink}
        updateDeeplink={updateDeeplink}
        isDisabled={isDisabled}
        configLoading={configLoading}
        serverCertType={serverCertType}
        sshParams={sshParams}
        localDisplayNameError={localDisplayNameError}
        localCustomSniError={localCustomSniError}
        customSniAllowlistState={customSniAllowlistState}
        sniSuggestions={sniSuggestions}
        trimmedCustomSni={trimmedCustomSni}
        setDnsError={setDnsError}
        setCidrError={setCidrError}
      />

      {/* Submit error */}
      {submitError && (
        <ErrorBanner
          variant="error"
          message={submitError}
          className="mt-[var(--space-4)]"
        />
      )}
        </>
      )}

      {/* UX-dirty-banner-bottom: dirty banner rendered right above the
          action row so it's always visible when the user is about to hit
          Save. At the top of the modal it was off-screen during scroll. */}
      {isEditMode && isDeeplinkDirty && !(configLoading || _forceConfigLoading) && (
        <ErrorBanner
          variant="warning"
          message={t("server.users.regenerate_deeplink_warning")}
          className="mt-[var(--space-4)]"
          data-testid="deeplink-dirty-banner"
        />
      )}

      {/* ── Actions ─────────────────────────────────────────────────────
          FIX-Y: while the Edit-mode Loader is showing, Save/Clear are
          meaningless — user hasn't seen the real data yet. Show only
          Cancel so the user can still back out, hide the rest.
          UX-clear-layout: Clear FIRST (leftmost) so users associate it
          with "start over". Order Add-mode:   [Очистить] [Добавить] [Отмена]
          Order Edit-mode: [Сохранить изменения] [Отмена]
      */}
      {/* Footer — modal-footer standard (09-25, owner §6.2): content-width,
          right-aligned, NOT a full-width split. «Отмена» (secondary) LEFT,
          primary submit «Добавить/Сохранить» RIGHT (last child). The corner ×
          (closeButtonTestId user-modal-close, adopted 09-23) is the close
          affordance — «Отмена» here is a real cancel action. Both buttons use
          size="sm" (h-8) — the de-facto modal-footer standard shared with
          Firewall/Cert/MtProto/Benchmark (R2-F02a, 09-35). */}
      <div className="flex justify-end gap-[var(--space-3)] mt-[var(--space-5)]">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={isDisabled}
          onClick={onClose}
        >
          {t("buttons.cancel")}
        </Button>
        {!(isEditMode && (configLoading || _forceConfigLoading)) && (
          <>
            {/* UX-clear-removed: «Очистить» убрана по фидбеку. Отмена
                закрывает modal целиком, перегенерация креденшалов не
                стоит отдельной кнопки. handleClear остался неиспользуемым
                на случай будущей accordion-Advanced. */}
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={!canSubmit}
              loading={isSubmitting}
              icon={isSubmitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : undefined}
              onClick={() => void (isEditMode ? handleSave() : handleAdd())}
              data-testid="user-modal-submit"
            >
              {isEditMode ? t("server.users.save_changes") : t("server.users.add_user_advanced")}
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}
