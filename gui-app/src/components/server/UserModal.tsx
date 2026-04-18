import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { X, Loader2, Shuffle } from "lucide-react";
import { Modal } from "../../shared/ui/Modal";
import { Button } from "../../shared/ui/Button";
import { Input } from "../../shared/ui/Input";
import { Toggle } from "../../shared/ui/Toggle";
import { Select } from "../../shared/ui/Select";
import { ErrorBanner } from "../../shared/ui/ErrorBanner";
import { CIDRPicker } from "../../shared/ui/CIDRPicker";
import { Tooltip } from "../../shared/ui/Tooltip";
import { ActionInput } from "../../shared/ui/ActionInput";
import { ActionPasswordInput } from "../../shared/ui/ActionPasswordInput";
import { useSnackBar } from "../../shared/ui/SnackBarContext";
import { useActivityLog } from "../../shared/hooks/useActivityLog";
import { formatError } from "../../shared/utils/formatError";
import { isDirty, createSnapshot, type DirtySnapshot } from "../../shared/utils/dirtyTracker";
import { generateUsername, generatePassword } from "../../shared/utils/credentialGenerator";
import { PasswordRotationPrompt } from "./PasswordRotationPrompt";
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
  dnsUpstreams: string[];
  cidr: string;
}

/** Config loaded from server for Edit mode via server_get_user_config. */
interface UserConfig {
  cidr: string;
  has_prefix: boolean;
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
  onClose: () => void;
  /** Called after successful add with the new username. */
  onUserAdded?: (username: string) => void;
  /** Called after successful edit. */
  onUserUpdated?: (username: string) => void;
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

/** Default deeplink fields for a new user (D-5: anti_dpi ON by default). */
const DEFAULT_DEEPLINK: DeeplinkFields = {
  antiDpi: true,
  displayName: "",
  customSni: "",
  upstreamProtocol: "auto",
  skipVerification: false,
  pinCert: false,
  certDerB64: null,
  certFingerprint: null,
  dnsUpstreams: [],
  cidr: "",
};

const UPSTREAM_OPTIONS = [
  { value: "auto", labelKey: "server.users.upstream_auto" },
  { value: "h2", labelKey: "server.users.upstream_h2" },
  { value: "h3", labelKey: "server.users.upstream_h3" },
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
  onClose,
  onUserAdded,
  onUserUpdated,
  _storybook,
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

  // ── Server config load (Edit mode) ────────────────────────────────────
  const [configLoading, setConfigLoading] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);

  // ── Submit state ──────────────────────────────────────────────────────
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // ── Password rotation (Edit mode, D-7) ───────────────────────────────
  const [showRotation, setShowRotation] = useState(false);
  const [rotationLoading, setRotationLoading] = useState(false);
  const [rotationError, setRotationError] = useState<string | null>(null);

  // ── DNS upstreams error ───────────────────────────────────────────────
  const [dnsError, setDnsError] = useState(false);

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

    if (mode === "add") {
      // Pre-fill credentials on Add open (D-13, D-14 collision-check)
      setUsername(generateUniqueUsername());
      setPassword(generatePassword());
      setDeeplink(DEFAULT_DEEPLINK);
      initialDeeplinkRef.current = toSnapshot(DEFAULT_DEEPLINK);
      setUsernameError("");
      setSubmitError(null);
      setShowRotation(false);
      setRotationError(null);
    } else if (mode === "edit" && editUsername) {
      // Load current config from server
      setUsername(editUsername);
      setPassword(""); // placeholder — readonly in Edit
      setDeeplink(DEFAULT_DEEPLINK);
      initialDeeplinkRef.current = toSnapshot(DEFAULT_DEEPLINK);
      setUsernameError("");
      setSubmitError(null);
      setShowRotation(false);
      setRotationError(null);

      if (!_storybook) {
        setConfigLoading(true);
        setConfigError(null);
        void invoke<UserConfig>("server_get_user_config", {
          ...sshParams,
          vpnUsername: editUsername,
        })
          .then((cfg) => {
            setDeeplink((prev) => ({
              ...prev,
              cidr: cfg.cidr ?? "",
              antiDpi: cfg.has_prefix ?? true,
            }));
            // Update initial snapshot after config loaded (so initial state = server state)
            initialDeeplinkRef.current = toSnapshot({
              ...DEFAULT_DEEPLINK,
              cidr: cfg.cidr ?? "",
              antiDpi: cfg.has_prefix ?? true,
            });
          })
          .catch((e) => {
            setConfigError(formatError(e));
          })
          .finally(() => {
            setConfigLoading(false);
          });
      }
    }
    // Auto-focus close button
    const t2 = setTimeout(() => closeButtonRef.current?.focus(), 250);
    return () => clearTimeout(t2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, mode, editUsername]);

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
      setShowRotation(false);
      setRotationError(null);
      setDnsError(false);
    }, 200);
    return () => clearTimeout(timer);
  }, [isOpen]);

  // ── Validation helpers ─────────────────────────────────────────────────
  const localUsernameError = validateUsername(username);
  const localPasswordError = !isEditMode ? validatePassword(password) : "";

  const canSubmit = useMemo(() => {
    if (isSubmitting || dnsError) return false;
    if (localUsernameError) return false;
    if (!username.trim()) return false;
    if (!isEditMode) {
      if (localPasswordError) return false;
      if (!password.trim()) return false;
    }
    return true;
  }, [isSubmitting, dnsError, localUsernameError, localPasswordError, username, password, isEditMode]);

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
    activityLog("USER", "user.add_advanced.clicked");
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      await invoke("server_add_user_advanced", {
        ...sshParams,
        vpnUsername: trimmedUsername,
        vpnPassword: trimmedPassword,
        antiDpi: deeplink.antiDpi,
        cidr: deeplink.cidr || null,
        // Deeplink TLV params
        displayName: deeplink.displayName || null,
        customSni: deeplink.customSni || null,
        upstreamProtocol: deeplink.upstreamProtocol !== "auto" ? deeplink.upstreamProtocol : null,
        skipVerification: deeplink.skipVerification,
        certDerB64: deeplink.pinCert ? deeplink.certDerB64 : null,
        dnsUpstreams: deeplink.dnsUpstreams.length > 0 ? deeplink.dnsUpstreams : null,
      });
      activityLog("STATE", `user.add_advanced.completed user=${trimmedUsername}`);
      pushSuccess(t("server.users.user_added_advanced", { user: trimmedUsername }));
      onUserAdded?.(trimmedUsername);
      onClose();
    } catch (e) {
      activityLog("ERROR", `user.add_advanced.failed err=${formatError(e)}`);
      setSubmitError(formatError(e));
    } finally {
      setIsSubmitting(false);
    }
  }, [canSubmit, isSubmitting, username, password, deeplink, sshParams, activityLog, pushSuccess, t, onUserAdded, onClose]);

  // ── Edit/save handler ─────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!canSubmit || isSubmitting || !editUsername) return;
    activityLog("USER", `user.update.clicked user=${editUsername}`);
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      await invoke("server_update_user_config", {
        ...sshParams,
        vpnUsername: editUsername,
        antiDpi: deeplink.antiDpi,
        cidr: deeplink.cidr || null,
      });
      activityLog("STATE", `user.update.completed user=${editUsername}`);
      pushSuccess(t("server.users.user_updated", { user: editUsername }));
      onUserUpdated?.(editUsername);
      onClose();
    } catch (e) {
      activityLog("ERROR", `user.update.failed err=${formatError(e)}`);
      setSubmitError(formatError(e));
    } finally {
      setIsSubmitting(false);
    }
  }, [canSubmit, isSubmitting, editUsername, deeplink, sshParams, activityLog, pushSuccess, t, onUserUpdated, onClose]);

  // ── Password rotation handler (D-7) ───────────────────────────────────
  const handleRotatePassword = useCallback(async (newPassword: string) => {
    if (!editUsername) return;
    activityLog("USER", `user.password.rotate_initiated user=${editUsername}`);
    setRotationLoading(true);
    setRotationError(null);
    try {
      await invoke("server_rotate_user_password", {
        ...sshParams,
        vpnUsername: editUsername,
        newPassword,
      });
      activityLog("STATE", `user.password.rotated user=${editUsername}`);
      pushSuccess(t("server.users.rotate_password_success", { user: editUsername }));
      setShowRotation(false);
    } catch (e) {
      activityLog("ERROR", `user.password.rotate_failed err=${formatError(e)}`);
      setRotationError(formatError(e));
    } finally {
      setRotationLoading(false);
    }
  }, [editUsername, sshParams, activityLog, pushSuccess, t]);

  // ── Upstream protocol options with translated labels ───────────────────
  const upstreamOptions = useMemo(
    () => UPSTREAM_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) })),
    [t],
  );

  const isDisabled = isSubmitting || rotationLoading;

  // ── No early return null (Modal lifecycle contract) ───────────────────
  // Modal primitive manages its own mounted/animating state (200ms exit anim).
  // Returning null here would unmount the tree instantly and kill exit transition.
  return (
    <Modal
      isOpen={isOpen}
      onClose={isDisabled ? undefined : onClose}
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
        onClick={onClose}
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

      {/* D-9 dirty-state warning banner (Edit mode only) */}
      {isEditMode && isDeeplinkDirty && (
        <ErrorBanner
          severity="warning"
          message={t("server.users.regenerate_deeplink_warning")}
          className="mb-[var(--space-4)]"
          data-testid="deeplink-dirty-banner"
        />
      )}

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
          {/* Username */}
          <ActionInput
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              setUsernameError("");
            }}
            placeholder={t("server.users.username_placeholder")}
            aria-label={t("server.users.username_placeholder")}
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

          {/* Password — editable in Add, read-only in Edit */}
          {isEditMode ? (
            <div>
              <div className="flex items-center justify-between gap-[var(--space-3)]">
                <div className="relative flex-1">
                  <input
                    type="password"
                    value="••••••••••••••••"
                    readOnly
                    aria-label={t("server.users.password_placeholder")}
                    className={cn(
                      "h-9 w-full px-3 text-sm rounded-[var(--radius-md)] border",
                      "border-[var(--color-input-border)] bg-[var(--color-input-bg)]",
                      "text-[var(--color-text-muted)] outline-none",
                      "opacity-[var(--opacity-disabled)]",
                    )}
                    data-testid="password-readonly"
                  />
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setShowRotation((v) => !v)}
                  disabled={isDisabled}
                  className="shrink-0"
                  data-testid="rotate-password-btn"
                >
                  {t("server.users.rotate_password")}
                </Button>
              </div>
              {/* Password rotation prompt (D-7) */}
              <PasswordRotationPrompt
                isOpen={showRotation}
                isLoading={rotationLoading}
                error={rotationError}
                onConfirm={(newPw) => void handleRotatePassword(newPw)}
                onCancel={() => { setShowRotation(false); setRotationError(null); }}
                disabled={isDisabled}
              />
            </div>
          ) : (
            <ActionPasswordInput
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("server.users.password_placeholder")}
              aria-label={t("server.users.password_placeholder")}
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

          {/* Display name */}
          <Input
            label={t("server.users.field_display_name")}
            value={deeplink.displayName}
            onChange={(e) => updateDeeplink("displayName", e.target.value.slice(0, 64))}
            placeholder={t("server.users.field_display_name_hint")}
            aria-label={t("server.users.field_display_name")}
            disabled={isDisabled}
            helperText={t("server.users.field_display_name_hint")}
          />

          {/* Custom SNI */}
          <Input
            label={t("server.users.field_custom_sni")}
            value={deeplink.customSni}
            onChange={(e) => updateDeeplink("customSni", e.target.value)}
            placeholder="cdn.example.com"
            aria-label={t("server.users.field_custom_sni")}
            disabled={isDisabled}
            helperText={t("server.users.field_custom_sni_hint")}
          />

          {/* Upstream protocol */}
          <Select
            label={t("server.users.field_upstream_protocol")}
            options={upstreamOptions}
            value={deeplink.upstreamProtocol}
            onChange={(e) => updateDeeplink("upstreamProtocol", e.target.value as UpstreamProtocol)}
            disabled={isDisabled}
            aria-label={t("server.users.field_upstream_protocol")}
          />

          {/* Skip verification toggle */}
          <Toggle
            checked={deeplink.skipVerification}
            onChange={(v) => updateDeeplink("skipVerification", v)}
            label={t("server.users.toggle_skip_verify")}
            description={t("server.users.toggle_skip_verify_warning")}
            disabled={isDisabled}
          />

          {/* Certificate pinning (D-6) */}
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
              disabled={isDisabled}
            />
            {deeplink.pinCert && (
              <div className="mt-2 ml-0">
                <CertificateFingerprintCard
                  sshParams={sshParams}
                  onFingerprintLoaded={(derB64, fingerprint) => {
                    updateDeeplink("certDerB64", derB64);
                    updateDeeplink("certFingerprint", fingerprint);
                  }}
                  onClear={() => {
                    updateDeeplink("certDerB64", null);
                    updateDeeplink("certFingerprint", null);
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

          {/* CIDR restriction (D-8) */}
          <CIDRPicker
            label={t("server.users.cidr_label")}
            value={deeplink.cidr}
            onChange={(v) => updateDeeplink("cidr", v)}
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

      {/* ── Actions ───────────────────────────────────────────────────── */}
      <div className="flex gap-[var(--space-3)] mt-[var(--space-5)]">
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
