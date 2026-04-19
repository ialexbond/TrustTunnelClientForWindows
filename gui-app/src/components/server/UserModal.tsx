import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { X, Loader2, Shuffle, Check, AlertTriangle } from "lucide-react";
import { Modal } from "../../shared/ui/Modal";
import { Button } from "../../shared/ui/Button";
import { Input } from "../../shared/ui/Input";
import { Toggle } from "../../shared/ui/Toggle";
import { ErrorBanner } from "../../shared/ui/ErrorBanner";
import { CIDRPicker } from "../../shared/ui/CIDRPicker";
import { Tooltip } from "../../shared/ui/Tooltip";
import { ActionInput } from "../../shared/ui/ActionInput";
import { ActionPasswordInput } from "../../shared/ui/ActionPasswordInput";
import { CharCounter } from "../../shared/ui/CharCounter";
import { useSnackBar } from "../../shared/ui/SnackBarContext";
import { useActivityLog } from "../../shared/hooks/useActivityLog";
import { formatError } from "../../shared/utils/formatError";
import { isDirty, createSnapshot, type DirtySnapshot } from "../../shared/utils/dirtyTracker";
import { generateUsername, generatePassword } from "../../shared/utils/credentialGenerator";
import {
  fromServerResponse as advancedFromServer,
  toServerPayload as advancedToPayload,
  isLikelyCaChain,
  deriveFingerprintFromDerB64,
} from "../../shared/utils/userAdvanced";
import { CertificateFingerprintCard } from "./CertificateFingerprintCard";
import { DnsUpstreamsInput } from "./DnsUpstreamsInput";
import { cn } from "../../shared/lib/cn";

// ── Validation helpers ──────────────────────────────────────────────────────

function validateUsername(v: string): string {
  if (!v) return "";
  if (/\s/.test(v)) return "server.users.username_spaces";
  if (!/^[a-zA-Z0-9._-]+$/.test(v)) return "server.users.username_ascii_only";
  if (v.length > 32) return "server.users.username_too_long";
  return "";
}

function validatePassword(v: string): string {
  if (!v) return "";
  if (v !== v.trim()) return "server.users.password_no_edge_spaces";
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7F]/.test(v)) return "server.users.password_ascii_only";
  // CR-03: backend validate_vpn_password rejects ' " \. Mirror it on the frontend so
  // users see the error before hitting the SSH roundtrip.
  if (/["'\\]/.test(v)) return "server.users.password_no_quotes_backslash";
  return "";
}

/**
 * Display name (TLV 0x0C) — mirrors backend `validate_display_name` so the user
 * sees the error before the SSH roundtrip.
 *
 * Allowed: any printable character (Cyrillic + spaces + emoji all OK).
 * Rejected: control characters, quotes, backticks, `$`, `\`, shell meta
 * `; | & ( ) < > \n \r \0`. Empty = valid (field omitted from deeplink).
 */
function validateDisplayName(v: string): string {
  if (!v) return "";
  if (v.length > 64) return "server.users.display_name_too_long";
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(v)) return "server.users.display_name_control_chars";
  if (/["'`$\\;|&()<>]/.test(v)) return "server.users.display_name_bad_chars";
  return "";
}

/**
 * FQDN / hostname validation per CONTEXT.md D-4 (Custom SNI TLV 0x03).
 * RFC 1035 basic: ASCII alphanumeric + dots + hyphens, total <= 253 chars,
 * each label 1-63 chars, label doesn't start/end with hyphen. Empty = valid
 * (field is optional — omitted from deeplink).
 */
function validateCustomSni(v: string): string {
  if (!v) return "";
  if (/\s/.test(v)) return "server.users.custom_sni_spaces";
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7F]/.test(v)) return "server.users.custom_sni_ascii_only";
  if (v.length > 253) return "server.users.custom_sni_too_long";
  if (v.startsWith(".") || v.endsWith(".") || v.includes(".."))
    return "server.users.custom_sni_invalid_fqdn";
  const labels = v.split(".");
  for (const label of labels) {
    if (label.length === 0 || label.length > 63)
      return "server.users.custom_sni_invalid_fqdn";
    if (label.startsWith("-") || label.endsWith("-"))
      return "server.users.custom_sni_invalid_fqdn";
    if (!/^[a-zA-Z0-9-]+$/.test(label))
      return "server.users.custom_sni_invalid_fqdn";
  }
  return "";
}

// ── Types ───────────────────────────────────────────────────────────────────

type UpstreamProtocol = "auto" | "h2" | "h3";

interface DeeplinkFields {
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
 * Data is kept in `sessionStorage` so it survives an accidental close
 * (drag-select that slipped outside, Escape, backdrop click) but is wiped
 * when the app window closes — matching the "current session only" mental
 * model. Password is included so the user doesn't have to re-roll it; this
 * does NOT widen the existing security surface because sessionStorage is
 * already used for other per-session state (see CLAUDE.md localStorage keys).
 */
const ADD_DRAFT_KEY = "tt_user_modal_add_draft";

interface AddDraft {
  username: string;
  password: string;
  deeplink: DeeplinkFields;
}

function loadAddDraft(): AddDraft | null {
  try {
    const raw = sessionStorage.getItem(ADD_DRAFT_KEY);
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
      return parsed as AddDraft;
    }
  } catch {
    // sessionStorage disabled / invalid JSON — fall through to fresh defaults.
  }
  return null;
}

function saveAddDraft(d: AddDraft): void {
  try {
    sessionStorage.setItem(ADD_DRAFT_KEY, JSON.stringify(d));
  } catch {
    /* ignore quota / disabled */
  }
}

function clearAddDraft(): void {
  try {
    sessionStorage.removeItem(ADD_DRAFT_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * UX-upstream-remove-auto: default switched from "auto" → "h2". Upstream
 * TrustTunnel CLI defaulted `auto` to http/2 anyway, and exposing the
 * indirection made the final client config match the UI less obviously.
 * "auto" stays in the UserAdvancedParams TS union for back-compat — old
 * users-advanced.toml entries with `upstream_protocol="auto"` still load,
 * they just normalize to `"h2"` in state (see Edit-load path below).
 */
const DEFAULT_DEEPLINK: DeeplinkFields = {
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

const UPSTREAM_SEGMENTS: { value: "h2" | "h3"; label: string }[] = [
  { value: "h2", label: "HTTP/2" },
  { value: "h3", label: "HTTP/3" },
];

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
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // ── Derived dirty state (D-9) ─────────────────────────────────────────
  const isDeeplinkDirty = useMemo(
    () => isDirty(initialDeeplinkRef.current, toSnapshot(deeplink)),
    [deeplink],
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
      const draft = loadAddDraft();
      if (draft) {
        setUsername(draft.username);
        setPassword(draft.password);
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
                    `user.edit.cert_fp_derive_failed user=${editUsername} err=${formatError(err).slice(0, 80)}`,
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
    // Auto-focus close button
    const t2 = setTimeout(() => closeButtonRef.current?.focus(), 250);
    return () => {
      cancelled = true;
      clearTimeout(t2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, mode, editUsername]);

  // FIX-K: persist draft on every change while the Add modal is open. Cheap
  // sync write — sessionStorage at ~kB scale is near-instant and spares us
  // adding a debouncer for a rarely-edited form.
  useEffect(() => {
    if (!isOpen || mode !== "add") return;
    saveAddDraft({ username, password, deeplink });
  }, [isOpen, mode, username, password, deeplink]);

  // Cleanup after close (200ms delay matches Modal exit animation)
  useEffect(() => {
    if (isOpen) return;
    const timer = setTimeout(() => {
      setUsername("");
      setPassword("");
      setDeeplink(DEFAULT_DEEPLINK);
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
      const generatedDeeplink = await invoke<string>("server_add_user_advanced", {
        ...sshParams,
        vpnUsername: trimmedUsername,
        vpnPassword: trimmedPassword,
        antiDpi: deeplink.antiDpi,
        // WR-02: anti-DPI prefix length / freq% are still backend defaults (4 bytes / 70%)
        // until UI controls land. Pass null so the Rust side keeps using its defaults.
        prefixLength: null,
        prefixPercent: null,
        cidr: deeplink.cidr || null,
        // Deeplink TLV params
        // WR-01: backend parameter is `name` (not `display_name`). Tauri rewrites the
        // camelCase value to snake_case, but the snake_case key MUST match the Rust arg.
        // Sending `displayName` produced `display_name`, which Rust ignored entirely.
        name: deeplink.displayName || null,
        customSni: deeplink.customSni || null,
        upstreamProtocol: deeplink.upstreamProtocol !== "auto" ? deeplink.upstreamProtocol : null,
        skipVerification: deeplink.skipVerification,
        // CR-01: backend now expects pinCertificateDer (Base64 string), not certDerB64.
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
      // `Promise.resolve(...)` wraps the invoke return so `.catch` is
      // always safe to chain — in Vitest mocks `invoke` can return a plain
      // non-Promise value and bare `.catch` would throw synchronously,
      // breaking the rest of handleAdd.
      Promise.resolve(
        invoke("server_set_user_advanced", {
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
        }),
      ).catch((err) => {
        activityLog(
          "ERROR",
          `user.advanced.persist_failed user=${trimmedUsername} err=${formatError(err)}`,
        );
      });
      // FIX-R: parent (UsersSection.handleUserAdded) already fires the success
      // snack-bar via state.pushSuccess with the same i18n key. Firing it
      // again here produced two identical toasts back-to-back — drop the
      // duplicate and let the owning container handle user-facing feedback.
      clearAddDraft();
      onUserAdded?.(trimmedUsername, generatedDeeplink);
      onClose();
    } catch (e) {
      const raw = formatError(e);
      const lower = raw.toLowerCase();
      activityLog("ERROR", `user.add_advanced.failed err=${raw}`);
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
  }, [canSubmit, isSubmitting, username, password, deeplink, sshParams, activityLog, t, onUserAdded, onClose]);

  // UX-revert-removed: handleRevert удалён вместе с кнопкой — Cancel
  // закрывает modal целиком, отдельный Revert без закрытия был избыточен.

  // UX-clear-removed: handleClear + Очистить кнопка удалены по фидбеку.
  // clearAddDraft() всё ещё вызывается внутри handleAdd после успешного
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
          `user.advanced.persist_failed user=${editUsername} err=${formatError(persistErr)}`,
        );
      }
      activityLog("STATE", `user.update.completed user=${editUsername}`);
      pushSuccess(t("server.users.user_updated", { user: editUsername }));
      onUserUpdated?.(editUsername, regeneratedDeeplink);
      onClose();
    } catch (e) {
      const raw = formatError(e);
      const lower = raw.toLowerCase();
      activityLog("ERROR", `user.update.failed err=${raw}`);
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
  }, [canSubmit, isSubmitting, editUsername, deeplink, isDeeplinkDirty, isPasswordDirty, newPassword, sshParams, activityLog, pushSuccess, t, onUserUpdated, onClose]);

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
      onClose={isDisabled ? undefined : () => handleCloseWithSource("backdrop_or_escape")}
      closeOnBackdrop={!isDisabled}
      closeOnEscape={!isDisabled}
      size="lg"
      className="relative max-h-[90vh] overflow-y-auto"
    >
      {/* X close button */}
      <button
        ref={closeButtonRef}
        type="button"
        aria-label={t("buttons.close")}
        onClick={() => handleCloseWithSource("x")}
        disabled={isDisabled}
        className={cn(
          "absolute top-3 right-3 p-1 rounded",
          "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]",
          "focus-visible:shadow-[var(--focus-ring)] outline-none",
          "transition-colors",
          "disabled:opacity-[var(--opacity-disabled)] disabled:cursor-not-allowed",
        )}
        data-testid="user-modal-close"
      >
        <X className="w-4 h-4" />
      </button>

      {/* Title */}
      <h2 className="text-lg font-[var(--font-weight-semibold)] text-[var(--color-text-primary)] mb-[var(--space-5)] pr-8">
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
          severity="error"
          message={configError}
          className="mb-[var(--space-4)]"
        />
      )}

      {/* ── Section 1: Учётные данные ──────────────────────────────────── */}
      <section aria-labelledby="section-credentials" className="mb-[var(--space-5)]">
        <p
          id="section-credentials"
          className="text-xs font-[var(--font-weight-semibold)] text-[var(--color-text-muted)] uppercase tracking-wide mb-[var(--space-3)]"
        >
          {t("server.users.section_credentials")}
        </p>

        <div className="flex flex-col gap-[var(--space-3)]">
          {/* Username (required) */}
          <ActionInput
            label={
              <>
                {t("server.users.username_label")}
                <span aria-hidden="true" className="ml-1 text-[var(--color-status-error)]">*</span>
              </>
            }
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              setUsernameError("");
            }}
            placeholder={t("server.users.username_placeholder")}
            aria-label={t("server.users.username_placeholder")}
            aria-required="true"
            disabled={isEditMode || isDisabled}
            error={localUsernameError ? t(localUsernameError) : (usernameError ? t(usernameError) : undefined)}
            clearable={!isEditMode}
            onClear={() => setUsername("")}
            clearAriaLabel={t("common.clear_field")}
            actions={
              !isEditMode
                ? [
                    <Tooltip key="gen" text={t("common.generate_username")}>
                      <button
                        type="button"
                        onClick={() => setUsername(generateUniqueUsername())}
                        disabled={isDisabled}
                        aria-label={t("common.generate_username")}
                        className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <Shuffle className="w-3.5 h-3.5" />
                      </button>
                    </Tooltip>,
                  ]
                : undefined
            }
          />

          {/* Password — editable in Add, read-only in Edit until user opens
              the inline editor by clicking «Сменить пароль» (FIX-OO-11c). */}
          {isEditMode ? (
            /* UX-E (button-height): label вынесен наверх общим блоком.
               Input + Button лежат в одной row с align-items: center; при
               появлении/исчезновении helperText/error под input высота row
               НЕ меняется — Button всегда на одной линии с полем.
               UX-F (required-asterisk): `*` показывается когда rotator
               открыт (обязательное поле), скрыт в readonly режиме. */
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="user-modal-rotate-password-input"
                className="block text-sm font-[var(--font-weight-semibold)] text-[var(--color-text-secondary)]"
              >
                {passwordEditing
                  ? t("server.users.rotate_password_title")
                  : t("server.users.password_label")}
                {/* `*` всегда — чтобы не мигало при переключении
                    readonly ↔ rotator. Username тоже всегда с `*`,
                    визуальная симметрия сохранилась. */}
                <span aria-hidden="true" className="ml-1 text-[var(--color-status-error)]">
                  *
                </span>
              </label>
              <div className="flex items-center gap-[var(--space-3)]">
                <div className="flex-1 min-w-0">
                  {passwordEditing ? (
                    <ActionPasswordInput
                      id="user-modal-rotate-password-input"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder={t("server.users.rotate_new_password_placeholder")}
                      aria-label={t("server.users.rotate_new_password_placeholder")}
                      aria-required="true"
                      disabled={isDisabled}
                      showLockIcon={false}
                      clearable
                      onClear={() => setNewPassword("")}
                      clearAriaLabel={t("common.clear_field")}
                      showPasswordAriaLabel={t("common.show_password")}
                      hidePasswordAriaLabel={t("common.hide_password")}
                      actions={[
                        <Tooltip key="gen" text={t("common.generate_password")}>
                          <button
                            type="button"
                            onClick={() => setNewPassword(generatePassword())}
                            disabled={isDisabled}
                            aria-label={t("common.generate_password")}
                            className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                          >
                            <Shuffle className="w-3.5 h-3.5" />
                          </button>
                        </Tooltip>,
                      ]}
                    />
                  ) : (
                    <input
                      type="password"
                      value="••••••••••••••••"
                      readOnly
                      aria-label={t("server.users.password_placeholder")}
                      className={cn(
                        // Unified with ActionPasswordInput's h-8 — previously
                        // `h-9` here made the readonly preview 4px taller
                        // than the active rotator input, shifting the
                        // Cancel/Rotate button on mode switch.
                        "h-8 w-full px-3 text-sm rounded-[var(--radius-md)] border",
                        "border-[var(--color-input-border)] bg-[var(--color-input-bg)]",
                        "text-[var(--color-text-muted)] outline-none",
                        "opacity-[var(--opacity-disabled)]",
                      )}
                      data-testid="password-readonly"
                    />
                  )}
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    if (passwordEditing) {
                      setPasswordEditing(false);
                      setNewPassword("");
                    } else {
                      setPasswordEditing(true);
                    }
                  }}
                  disabled={isDisabled}
                  className="shrink-0"
                  data-testid={passwordEditing ? "cancel-rotate-password-btn" : "rotate-password-btn"}
                >
                  {passwordEditing
                    ? t("buttons.cancel")
                    : t("server.users.rotate_password")}
                </Button>
              </div>
              {/* Error / helperText показывается ПОД row, чтобы не тянуть
                  высоту inputa и не смещать Button. */}
              {passwordEditing && localNewPasswordError && (
                <p className="text-xs text-[var(--color-status-error)]">
                  {t(localNewPasswordError)}
                </p>
              )}
              {passwordEditing && !localNewPasswordError && (
                <p className="text-xs text-[var(--color-text-muted)]">
                  {t("server.users.rotate_password_warning")}
                </p>
              )}
            </div>
          ) : (
            <ActionPasswordInput
              label={
                <>
                  {t("server.users.password_label")}
                  <span aria-hidden="true" className="ml-1 text-[var(--color-status-error)]">*</span>
                </>
              }
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("server.users.password_placeholder")}
              aria-label={t("server.users.password_placeholder")}
              aria-required="true"
              disabled={isDisabled}
              error={localPasswordError ? t(localPasswordError) : undefined}
              showLockIcon={false}
              clearable
              onClear={() => setPassword("")}
              clearAriaLabel={t("common.clear_field")}
              showPasswordAriaLabel={t("common.show_password")}
              hidePasswordAriaLabel={t("common.hide_password")}
              actions={[
                <Tooltip key="gen" text={t("common.generate_password")}>
                  <button
                    type="button"
                    onClick={() => setPassword(generatePassword())}
                    disabled={isDisabled}
                    aria-label={t("common.generate_password")}
                    className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <Shuffle className="w-3.5 h-3.5" />
                  </button>
                </Tooltip>,
              ]}
            />
          )}
        </div>
      </section>

      {/* ── Section 2: Параметры deeplink ─────────────────────────────── */}
      <section aria-labelledby="section-deeplink">
        <p
          id="section-deeplink"
          className="text-xs font-[var(--font-weight-semibold)] text-[var(--color-text-muted)] uppercase tracking-wide mb-[var(--space-3)]"
        >
          {t("server.users.section_deeplink")}
        </p>

        <div className="flex flex-col gap-[var(--space-4)]">
          {/* Anti-DPI toggle (D-5: ON by default) */}
          <Toggle
            checked={deeplink.antiDpi}
            onChange={(v) => updateDeeplink("antiDpi", v)}
            label={t("server.users.toggle_anti_dpi")}
            description={t("server.users.toggle_anti_dpi_help")}
            disabled={isDisabled || configLoading}
          />

          {/* Display name with CharCounter aligned right above the field (matches Input label styling: text-sm semibold) */}
          <div>
            <div className="flex items-baseline justify-between mb-1.5">
              <label
                htmlFor="user-modal-display-name"
                className="block text-sm font-[var(--font-weight-semibold)] text-[var(--color-text-secondary)]"
              >
                {t("server.users.field_display_name")}
              </label>
              <CharCounter value={deeplink.displayName.length} max={64} />
            </div>
            <Input
              id="user-modal-display-name"
              value={deeplink.displayName}
              onChange={(e) => updateDeeplink("displayName", e.target.value.slice(0, 64))}
              placeholder={t("server.users.field_display_name_placeholder")}
              aria-label={t("server.users.field_display_name")}
              disabled={isDisabled}
              // Chrome autofill heuristics залапали поле как «имя» —
              // всплывало «Сохранённые сведения». autoComplete="off" +
              // отсутствие name-атрибута даёт браузеру сигнал что
              // tracking/предложения не нужны. Для password-менеджеров
              // (1Password/LastPass) — спец data-атрибуты.
              autoComplete="off"
              data-lpignore="true"
              data-1p-ignore="true"
              data-form-type="other"
              helperText={
                localDisplayNameError ? undefined : t("server.users.field_display_name_hint")
              }
              error={localDisplayNameError ? t(localDisplayNameError) : undefined}
            />
          </div>

          {/* Custom SNI — WR-14.1-UAT-09: FQDN validation per D-4.
              M-01: plus inline check against `allowed_sni` in hosts.toml and
              a clickable suggestion chip rail so the user doesn't have to
              guess what the server will accept and hit the FIX-OO-14 rollback. */}
          <div>
            <Input
              label={t("server.users.field_custom_sni")}
              value={deeplink.customSni}
              onChange={(e) => updateDeeplink("customSni", e.target.value)}
              placeholder="cdn.example.com"
              aria-label={t("server.users.field_custom_sni")}
              disabled={isDisabled}
              // Та же причина что и у displayName — блокировать Chrome
              // autofill и password-менеджеры от предложения значений.
              autoComplete="off"
              data-lpignore="true"
              data-1p-ignore="true"
              data-form-type="other"
              helperText={
                localCustomSniError ? undefined : t("server.users.field_custom_sni_hint")
              }
              error={localCustomSniError ? t(localCustomSniError) : undefined}
            />

            {/* M-01: allowlist state — shown only when we actually have a list
                to compare against AND the format is valid (no point saying
                "not on the list" when the string isn't even a valid FQDN). */}
            {customSniAllowlistState === "ok" && (
              <p
                // CRIT-3: --color-status-success / --color-status-warning
                // don't exist in tokens.css — the colour fell through to
                // inherited text (white in dark theme, broken in light).
                // Use the canonical status tokens that auto-swap with theme.
                className="mt-1.5 text-xs flex items-center gap-1 text-[var(--color-status-connected)]"
                data-testid="sni-allowlist-ok"
              >
                <Check className="w-3 h-3" aria-hidden="true" />
                {t("server.users.custom_sni_allowed_ok")}
              </p>
            )}
            {customSniAllowlistState === "warn" && (
              <p
                // CRIT-4: same token-miss story — warning fell back to
                // inherited colour so the triangle and copy were invisible.
                className="mt-1.5 text-xs flex items-start gap-1 text-[var(--color-status-connecting)]"
                data-testid="sni-allowlist-warn"
              >
                <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" aria-hidden="true" />
                <span>{t("server.users.custom_sni_not_in_allowlist")}</span>
              </p>
            )}

            {/* M-01: suggestion chips — hostname + allowed_sni flattened.
                Rendered only when we actually fetched some; keeps the modal
                clean on fresh deploys where hosts.toml has only the main
                hostname and no allowed_sni entries yet. */}
            {sniSuggestions.length > 0 && (
              <div className="mt-2" data-testid="sni-suggestions">
                <p className="text-xs text-[var(--color-text-muted)] mb-1.5">
                  {t("server.users.custom_sni_suggestions_label")}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {sniSuggestions.map((sni) => {
                    const isActive = sni === trimmedCustomSni;
                    return (
                      <button
                        key={sni}
                        type="button"
                        onClick={() => updateDeeplink("customSni", sni)}
                        disabled={isDisabled}
                        aria-pressed={isActive}
                        className={cn(
                          "px-2 py-0.5 text-xs rounded-full border transition-colors",
                          "focus-visible:shadow-[var(--focus-ring)] outline-none",
                          "disabled:opacity-[var(--opacity-disabled)] disabled:cursor-not-allowed",
                          // CRIT-5: `--color-accent` and `--color-surface`
                          // don't exist in tokens.css — the active chip lost
                          // its background in both themes, and the inactive
                          // chip had no surface colour in light mode. Switch
                          // to the canonical token names that actually resolve.
                          isActive
                            ? "bg-[var(--color-accent-interactive)] text-white border-[var(--color-accent-interactive)]"
                            : "bg-[var(--color-bg-elevated)] text-[var(--color-text-secondary)] border-[var(--color-input-border)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-text-muted)]",
                        )}
                        data-testid={`sni-chip-${sni}`}
                      >
                        {sni}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* UX-upstream-segmented: 2-way toggle (HTTP/2 / HTTP/3) instead
              of a dropdown with «Авто» that mapped to the same h2 anyway.
              Pattern copied from SshConnectForm's auth-method picker. */}
          <div>
            <label className="block text-sm font-[var(--font-weight-semibold)] mb-1.5 text-[var(--color-text-secondary)]">
              {t("server.users.field_upstream_protocol")}
            </label>
            <div className="flex rounded-[var(--radius-md)] border border-[var(--color-border)] overflow-hidden">
              {UPSTREAM_SEGMENTS.map((seg) => {
                const active = deeplink.upstreamProtocol === seg.value;
                return (
                  <button
                    key={seg.value}
                    type="button"
                    onClick={() => updateDeeplink("upstreamProtocol", seg.value)}
                    disabled={isDisabled}
                    aria-pressed={active}
                    className={cn(
                      "flex-1 flex items-center justify-center py-1.5 text-xs font-[var(--font-weight-semibold)] transition-colors",
                      "border-r border-[var(--color-border)] last:border-r-0",
                      "focus-visible:shadow-[var(--focus-ring)] outline-none",
                      "disabled:opacity-[var(--opacity-disabled)] disabled:cursor-not-allowed",
                      active
                        ? "bg-[var(--color-accent-interactive)] text-white"
                        : "bg-[var(--color-input-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]",
                    )}
                    data-testid={`upstream-${seg.value}`}
                  >
                    {seg.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Skip verification toggle.
              UX-le-disable: если сервер на Let's Encrypt — disable вместе с
              Pin Certificate, т.к. system trust store и так валидирует chain
              (DEEP_LINK.md §Security Considerations). Для self-signed /
              provided / unknown — toggle остаётся активным. */}
          <Toggle
            checked={deeplink.skipVerification}
            onChange={(v) => updateDeeplink("skipVerification", v)}
            label={t("server.users.toggle_skip_verify")}
            description={
              serverCertType === "lets_encrypt"
                ? t("server.users.toggle_le_not_needed")
                : t("server.users.toggle_skip_verify_warning")
            }
            disabled={isDisabled || serverCertType === "lets_encrypt"}
          />

          {/* Certificate pinning (D-6).
              FIX-AA: pinning requires a TLS handshake whose SNI matches the
              server cert's CN. If Custom SNI is empty and the connection
              host is an IP, the probe always fails — so we gate the toggle
              behind a non-empty Custom SNI rather than letting the user
              click into a dead-end error. Invalid SNI (validator reports
              error) also gates the toggle. */}
          <div>
            <Toggle
              checked={deeplink.pinCert}
              onChange={(v) => {
                updateDeeplink("pinCert", v);
                if (!v) {
                  updateDeeplink("certDerB64", null);
                  updateDeeplink("certFingerprint", null);
                }
              }}
              label={t("server.users.toggle_pin_cert")}
              description={
                serverCertType === "lets_encrypt"
                  ? t("server.users.toggle_le_not_needed")
                  : !deeplink.customSni.trim() || localCustomSniError
                  ? t("server.users.toggle_pin_cert_needs_sni")
                  : undefined
              }
              disabled={
                isDisabled ||
                serverCertType === "lets_encrypt" ||
                !deeplink.customSni.trim() ||
                Boolean(localCustomSniError)
              }
            />
            {deeplink.pinCert && (
              <div className="mt-2 ml-0">
                <CertificateFingerprintCard
                  sshParams={sshParams}
                  customSni={deeplink.customSni}
                  // CRIT-2: hydrate the card's success-state from the saved
                  // pin so Edit reopen shows the SHA-256 + Отвязать/Обновить
                  // straight away, instead of «Загрузить endpoint» that made
                  // the user re-probe every time.
                  initialFingerprint={deeplink.certFingerprint}
                  initialDerB64={deeplink.certDerB64}
                  initialIsSystemVerifiable={deeplink.certIsSystemVerifiable}
                  onFingerprintLoaded={(derB64, fingerprint, isSystemVerifiable) => {
                    updateDeeplink("certDerB64", derB64);
                    updateDeeplink("certFingerprint", fingerprint);
                    updateDeeplink("certIsSystemVerifiable", isSystemVerifiable);
                  }}
                  onClear={() => {
                    // FIX-BB: full unpin — drop the pinned bytes/fingerprint
                    // AND flip the toggle OFF, so the deeplink goes back to
                    // "no certificate pinning" instead of sitting in a
                    // pinCert=true + empty-cert limbo.
                    updateDeeplink("certDerB64", null);
                    updateDeeplink("certFingerprint", null);
                    updateDeeplink("certIsSystemVerifiable", false);
                    updateDeeplink("pinCert", false);
                  }}
                  disabled={isDisabled}
                />
              </div>
            )}
          </div>

          {/* DNS upstreams (D-4: dns_upstreams 0x0D) */}
          <DnsUpstreamsInput
            label={t("server.users.field_dns_upstreams")}
            value={deeplink.dnsUpstreams}
            onChange={(entries) => updateDeeplink("dnsUpstreams", entries)}
            onError={setDnsError}
            disabled={isDisabled}
          />

          {/* CIDR restriction (D-8). WR-14.1-UAT-08: propagate error → canSubmit. */}
          <CIDRPicker
            label={t("server.users.cidr_label")}
            value={deeplink.cidr}
            onChange={(v) => updateDeeplink("cidr", v)}
            onError={(errKey) => setCidrError(errKey.length > 0)}
            disabled={isDisabled || configLoading}
          />
        </div>
      </section>

      {/* Submit error */}
      {submitError && (
        <ErrorBanner
          severity="error"
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
          severity="warning"
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
      <div className="flex gap-[var(--space-3)] mt-[var(--space-5)]">
        {!(isEditMode && (configLoading || _forceConfigLoading)) && (
          <>
            {/* UX-clear-removed: «Очистить» убрана по фидбеку. Отмена
                закрывает modal целиком, перегенерация креденшалов не
                стоит отдельной кнопки. handleClear остался неиспользуемым
                на случай будущей accordion-Advanced. */}
            <Button
              type="button"
              variant="primary"
              fullWidth
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
        <Button
          type="button"
          variant="secondary"
          fullWidth
          disabled={isDisabled}
          onClick={onClose}
        >
          {t("buttons.cancel")}
        </Button>
      </div>
    </Modal>
  );
}
