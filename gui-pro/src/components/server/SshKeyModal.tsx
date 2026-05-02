import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { X, KeyRound, Download, ShieldAlert, Unlock } from "lucide-react";
import { Modal } from "../../shared/ui/Modal";
import { Button } from "../../shared/ui/Button";
import { ErrorBanner } from "../../shared/ui/ErrorBanner";
import { useSnackBar } from "../../shared/ui/SnackBarContext";
import { useConfirm } from "../../shared/ui/useConfirm";
import { useActivityLog } from "../../shared/hooks/useActivityLog";
import { formatError } from "../../shared/utils/formatError";
import { cn } from "../../shared/lib/cn";
import type { SshKeyStatus } from "./useSecurityState";

/**
 * SshKeyModal — Phase 16 Plan 03 flagship Modal.
 *
 * Three sections:
 *   1. Status + Generate/Regenerate (Section 1).
 *   2. Disable PasswordAuth — 2-step state machine (Section 2):
 *      - Step 1: forced backup export via dialog.save() — sets exportPath
 *        on success.
 *      - Step 2: ConfirmDialog warning + invoke security_disable_password_auth.
 *        "Continue" button disabled until Step 1 succeeds (D-2.1 invariant).
 *   3. Visible "password disabled" indicator when status.password_auth_disabled.
 *
 * Modal lifecycle (T-03):
 *   - NEVER `if (!isOpen) return null` — Modal primitive owns 200ms exit anim.
 *   - Cleanup state via setTimeout(200) in useEffect — keeps content rendered
 *     during fade-out.
 *
 * Security invariants:
 *   - D-29: activityLog NEVER receives PEM body or strings containing
 *     "BEGIN OPENSSH PRIVATE KEY". Only fingerprint/path/host (public).
 *   - D-1.4: localStorage tt_auth_method_<host> = "key" set on successful
 *     generation, allowing SshConnectForm auto-detect on next mount.
 *   - D-2.1: forced backup export gates Step 2 — exportPath required.
 *
 * Storybook escape hatches `_forceStatus`/`_forceLoading`/`_forceError`/
 * `_forceExportPath` bypass the backend so stories demonstrate every state
 * without an SSH session. Production call sites never pass these.
 */
export interface SshKeyModalProps {
  isOpen: boolean;
  onClose: () => void;
  sshParams: {
    host: string;
    port: number;
    user: string;
    password: string;
    keyPath?: string;
    keyData?: string;
  };
  /** Storybook-only: bypass `security_get_ssh_key_status` invoke. `null` = explicit empty status. */
  _forceStatus?: SshKeyStatus | null;
  /** Storybook-only: pin loading state. */
  _forceLoading?: boolean;
  /** Storybook-only: pin error state with provided message. */
  _forceError?: string;
  /** Storybook-only: pre-set exportPath so Step 2 button is enabled. */
  _forceExportPath?: string;
}

export function SshKeyModal(props: SshKeyModalProps) {
  const {
    isOpen,
    onClose,
    sshParams,
    _forceStatus,
    _forceLoading,
    _forceError,
    _forceExportPath,
  } = props;
  const { t } = useTranslation();
  const pushSuccess = useSnackBar();
  const confirm = useConfirm();
  const { log: activityLog } = useActivityLog();
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const [keyStatus, setKeyStatus] = useState<SshKeyStatus | null>(_forceStatus ?? null);
  const [loading, setLoading] = useState<boolean>(_forceLoading ?? false);
  const [error, setError] = useState<string | null>(_forceError ?? null);
  const [exportPath, setExportPath] = useState<string | null>(_forceExportPath ?? null);
  const [generating, setGenerating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [enablingPw, setEnablingPw] = useState(false);

  // T-03 — Load status on open. Storybook escape hatches short-circuit.
  // Depend on primitives (host/port/user) to avoid extra fetches when
  // parents pass non-memoized sshParams refs.
  const { host: sshHost, port: sshPort, user: sshUser, password: sshPassword, keyPath: sshKeyPath, keyData: sshKeyData } = sshParams;
  useEffect(() => {
    if (!isOpen) return;
    if (_forceStatus !== undefined || _forceLoading || _forceError !== undefined) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    invoke<SshKeyStatus>("security_get_ssh_key_status", {
      host: sshHost,
      port: sshPort,
      user: sshUser,
      password: sshPassword,
      keyPath: sshKeyPath,
      keyData: sshKeyData,
      hostArg: sshHost,
    })
      .then((s) => {
        if (!cancelled) setKeyStatus(s);
      })
      .catch((e) => {
        if (!cancelled) setError(formatError(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, sshHost, sshPort, sshUser, sshPassword, sshKeyPath, sshKeyData]);

  // T-03 — Delayed cleanup after close (matches Modal exit animation 200ms).
  useEffect(() => {
    if (isOpen) return;
    const timer = setTimeout(() => {
      if (_forceStatus === undefined) setKeyStatus(null);
      setExportPath(_forceExportPath ?? null);
      if (_forceError === undefined) setError(null);
      setGenerating(false);
      setExporting(false);
      setDisabling(false);
      setEnablingPw(false);
    }, 200);
    return () => clearTimeout(timer);
  }, [isOpen, _forceStatus, _forceError, _forceExportPath]);

  // Auto-focus X button on open (Modal primitive does not trap focus).
  useEffect(() => {
    if (!isOpen) return;
    const timer = setTimeout(() => closeButtonRef.current?.focus(), 250);
    return () => clearTimeout(timer);
  }, [isOpen]);

  const handleGenerate = async () => {
    if (keyStatus?.generated) {
      const ok = await confirm({
        title: t("server.security.ssh_key.regenerate_button"),
        message: t("server.security.ssh_key.generate_warning"),
        variant: "warning",
        confirmText: t("server.security.ssh_key.regenerate_button"),
      });
      if (!ok) return;
    }
    setGenerating(true);
    try {
      const result = await invoke<{ fingerprint: string; generated: boolean }>(
        "security_generate_ssh_key",
        {
          host: sshHost,
          port: sshPort,
          user: sshUser,
          password: sshPassword,
          keyPath: sshKeyPath,
          keyData: sshKeyData,
          hostArg: sshHost,
        },
      );
      // D-1.4: persist localStorage flag so SshConnectForm auto-detects key on next mount.
      localStorage.setItem(`tt_auth_method_${sshHost}`, "key");
      // D-29: log only fingerprint (public, non-secret). NEVER log PEM body.
      activityLog("STATE", `ssh_key.generated host=${sshHost} fingerprint=${result.fingerprint}`);
      pushSuccess(t("server.security.ssh_key.generated_snack", { fingerprint: result.fingerprint }));
      setKeyStatus((prev) => ({
        generated: true,
        authorized_on_server: true,
        pubkey_fingerprint: result.fingerprint,
        password_auth_disabled: prev?.password_auth_disabled ?? false,
      }));
    } catch (e) {
      pushSuccess(formatError(e), "error");
    } finally {
      setGenerating(false);
    }
  };

  const handleExportBackup = async () => {
    const dest = await save({
      defaultPath: `trusttunnel-key-${sshHost}.pem`,
      filters: [{ name: t("server.security.ssh_key.backup_filter_label"), extensions: ["pem"] }],
    });
    if (!dest) return;
    setExporting(true);
    try {
      await invoke("security_export_ssh_key_backup", { host: sshHost, destPath: dest });
      setExportPath(dest); // unlocks Step 2
      // D-29: log path (non-secret), NOT PEM contents.
      activityLog("STATE", `ssh_key.backup_exported host=${sshHost} path=${dest}`);
      pushSuccess(t("server.security.ssh_key.backup_saved", { path: dest }));
    } catch (e) {
      pushSuccess(formatError(e), "error");
    } finally {
      setExporting(false);
    }
  };

  const handleDisablePasswordAuth = async () => {
    const ok = await confirm({
      title: t("server.security.ssh_key.disable_pwauth_title"),
      message: t("server.security.ssh_key.disable_pwauth_warning", { path: exportPath ?? "" }),
      variant: "danger",
      confirmText: t("server.security.ssh_key.disable_pwauth_confirm"),
    });
    if (!ok) return;
    setDisabling(true);
    try {
      await invoke("security_disable_password_auth", {
        host: sshHost,
        port: sshPort,
        user: sshUser,
        password: sshPassword,
        keyPath: sshKeyPath,
        keyData: sshKeyData,
      });
      activityLog("STATE", `ssh_key.pwauth_disabled host=${sshHost}`);
      pushSuccess(t("server.security.ssh_key.pwauth_disabled_snack"));
      setKeyStatus((prev) => (prev ? { ...prev, password_auth_disabled: true } : prev));
    } catch (e) {
      pushSuccess(formatError(e), "error");
    } finally {
      setDisabling(false);
    }
  };

  // P0-3 #E — re-enable PasswordAuthentication (rollback companion).
  // Use case: user disabled PW auth, потом понял что хочет dual-mode (key OR
  // password для recovery scenario, e.g. ключ потерян + backup .pem недоступен).
  const handleEnablePasswordAuth = async () => {
    const ok = await confirm({
      title: t("server.security.ssh_key.enable_pwauth_title"),
      message: t("server.security.ssh_key.enable_pwauth_warning"),
      variant: "warning",
      confirmText: t("server.security.ssh_key.enable_pwauth_confirm"),
    });
    if (!ok) return;
    setEnablingPw(true);
    try {
      await invoke("security_enable_password_auth", {
        host: sshHost,
        port: sshPort,
        user: sshUser,
        password: sshPassword,
        keyPath: sshKeyPath,
        keyData: sshKeyData,
      });
      activityLog("STATE", `ssh_key.pwauth_enabled host=${sshHost}`);
      pushSuccess(t("server.security.ssh_key.pwauth_enabled_snack"));
      setKeyStatus((prev) => (prev ? { ...prev, password_auth_disabled: false } : prev));
    } catch (e) {
      pushSuccess(formatError(e), "error");
    } finally {
      setEnablingPw(false);
    }
  };

  const handleRetry = () => {
    setError(null);
    setLoading(true);
    invoke<SshKeyStatus>("security_get_ssh_key_status", {
      host: sshHost,
      port: sshPort,
      user: sshUser,
      password: sshPassword,
      keyPath: sshKeyPath,
      keyData: sshKeyData,
      hostArg: sshHost,
    })
      .then(setKeyStatus)
      .catch((e) => setError(formatError(e)))
      .finally(() => setLoading(false));
  };

  // Storybook overrides take priority over runtime state.
  const effectiveStatus = _forceStatus !== undefined ? _forceStatus : keyStatus;
  const effectiveLoading = _forceLoading ?? loading;
  const effectiveError = _forceError ?? error;

  // T-03: NEVER early-return null. Modal primitive owns mount/animating.
  return (
    <Modal isOpen={isOpen} onClose={onClose} size="md" className="relative">
      <button
        ref={closeButtonRef}
        type="button"
        aria-label={t("server.security.ssh_key.modal_close_aria")}
        onClick={onClose}
        className={cn(
          "absolute top-3 right-3 p-1 rounded",
          "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]",
          "focus-visible:shadow-[var(--focus-ring)] outline-none",
          "transition-colors",
        )}
      >
        <X className="w-4 h-4" />
      </button>

      <div className="flex items-center gap-2 mb-3">
        <KeyRound
          className="w-5 h-5"
          style={{ color: "var(--color-accent-interactive)" }}
          aria-hidden="true"
        />
        <h2 className="text-title">{t("server.security.ssh_key.title")}</h2>
      </div>
      <p className="text-body-sm" style={{ color: "var(--color-text-secondary)" }}>
        {t("server.security.ssh_key.subtitle")}
      </p>

      <div className="mt-4 space-y-4" data-testid="ssh-key-content">
        {effectiveLoading ? (
          <div
            role="status"
            aria-busy="true"
            className="py-4 text-center text-body-sm"
            style={{ color: "var(--color-text-muted)" }}
          >
            …
          </div>
        ) : effectiveError ? (
          <div className="flex flex-col items-center gap-3 py-4">
            <ErrorBanner severity="error" message={effectiveError} className="w-full" />
            <Button variant="secondary" onClick={handleRetry}>
              {t("buttons.retry")}
            </Button>
          </div>
        ) : (
          <>
            {/* Section 1 — Status + Generate/Regenerate */}
            <section aria-labelledby="ssh-key-status-heading">
              <h3 id="ssh-key-status-heading" className="text-subtitle">
                {effectiveStatus?.generated
                  ? t("server.security.ssh_key.status_generated")
                  : t("server.security.ssh_key.status_not_generated")}
              </h3>
              {effectiveStatus?.generated && effectiveStatus.pubkey_fingerprint && (
                <code
                  className="text-mono-sm block mt-2 break-all"
                  data-testid="ssh-key-fingerprint"
                >
                  {effectiveStatus.pubkey_fingerprint}
                </code>
              )}
              <Button
                onClick={handleGenerate}
                loading={generating}
                disabled={generating}
                variant={effectiveStatus?.generated ? "secondary" : "primary"}
                className="mt-3"
              >
                {effectiveStatus?.generated
                  ? t("server.security.ssh_key.regenerate_button")
                  : t("server.security.ssh_key.generate_button")}
              </Button>
            </section>

            {/* Section 2 — Disable PasswordAuth (gated by exportPath) */}
            {effectiveStatus?.generated && !effectiveStatus.password_auth_disabled && (
              <section
                aria-labelledby="ssh-disable-pw-heading"
                className="border-t pt-4"
                style={{ borderColor: "var(--color-border)" }}
              >
                <h3 id="ssh-disable-pw-heading" className="text-subtitle">
                  {t("server.security.ssh_key.disable_pwauth_section")}
                </h3>

                {/* Step 1 — Forced backup export */}
                <div className="mt-3">
                  <p className="text-body-sm">
                    {t("server.security.ssh_key.disable_pwauth_step1_label")}
                  </p>
                  <p className="text-caption" style={{ color: "var(--color-text-muted)" }}>
                    {t("server.security.ssh_key.disable_pwauth_step1_help")}
                  </p>
                  <Button
                    onClick={handleExportBackup}
                    loading={exporting}
                    disabled={exporting}
                    variant="secondary"
                    icon={<Download className="w-4 h-4" />}
                    className="mt-2"
                  >
                    {t("server.security.ssh_key.export_backup_button")}
                  </Button>
                  {exportPath && (
                    <p
                      className="text-caption mt-1 font-mono"
                      style={{ color: "var(--color-status-connected)" }}
                      data-testid="ssh-key-export-path"
                    >
                      ✓ {exportPath}
                    </p>
                  )}
                </div>

                {/* Step 2 — Disable PW (gated by exportPath, D-2.1 invariant) */}
                <div className="mt-3">
                  <p className="text-body-sm">
                    {t("server.security.ssh_key.disable_pwauth_step2_label")}
                  </p>
                  <Button
                    onClick={handleDisablePasswordAuth}
                    loading={disabling}
                    disabled={!exportPath || disabling}
                    variant="danger"
                    icon={<ShieldAlert className="w-4 h-4" />}
                    className="mt-2"
                    aria-describedby={!exportPath ? "ssh-step2-hint" : undefined}
                  >
                    {t("server.security.ssh_key.disable_pwauth_continue")}
                  </Button>
                  {!exportPath && (
                    <p
                      id="ssh-step2-hint"
                      className="text-caption mt-1"
                      style={{ color: "var(--color-text-muted)" }}
                    >
                      {t("server.security.ssh_key.disable_pwauth_continue_disabled_hint")}
                    </p>
                  )}
                </div>
              </section>
            )}

            {/* Section 3 — P0-3 #E re-enable PasswordAuth (rollback). Renders
                только когда password_auth_disabled === true. Даёт путь обратно
                на dual-mode (key OR password) без необходимости в SSH terminal. */}
            {effectiveStatus?.password_auth_disabled && (
              <section
                aria-labelledby="ssh-enable-pw-heading"
                className="border-t pt-4"
                style={{ borderColor: "var(--color-border)" }}
                data-testid="ssh-key-enable-pw-section"
              >
                <h3 id="ssh-enable-pw-heading" className="text-subtitle">
                  {t("server.security.ssh_key.enable_pwauth_section")}
                </h3>
                <p
                  className="text-body-sm mt-1"
                  style={{ color: "var(--color-status-connected)" }}
                >
                  ✓ {t("server.security.ssh_key.status_pwauth_disabled")}
                </p>
                <p
                  className="text-caption mt-2"
                  style={{ color: "var(--color-text-muted)" }}
                >
                  {t("server.security.ssh_key.enable_pwauth_help")}
                </p>
                <Button
                  onClick={handleEnablePasswordAuth}
                  loading={enablingPw}
                  disabled={enablingPw}
                  variant="secondary"
                  icon={<Unlock className="w-4 h-4" />}
                  className="mt-2"
                  data-testid="enable-pwauth-button"
                >
                  {t("server.security.ssh_key.enable_pwauth_button")}
                </Button>
              </section>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
