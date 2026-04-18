import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Shuffle, Loader2, AlertTriangle } from "lucide-react";
import { Button } from "../../shared/ui/Button";
import { ActionPasswordInput } from "../../shared/ui/ActionPasswordInput";
import { ErrorBanner } from "../../shared/ui/ErrorBanner";
import { Tooltip } from "../../shared/ui/Tooltip";
import { cn } from "../../shared/lib/cn";
import { generatePassword } from "../../shared/utils/credentialGenerator";

/**
 * PasswordRotationPrompt — D-7 password rotation sub-flow.
 *
 * Shown inside UserModal Edit mode when user clicks «Сменить пароль».
 *
 * Flow:
 *   1. User clicks «Сменить пароль» → this component appears inline.
 *   2. User enters a new password (or uses Shuffle to generate).
 *   3. User clicks «Подтвердить» → onConfirm(newPassword) is called.
 *   4. Caller invokes backend server_rotate_user_password and closes/resets.
 *   5. User clicks «Отмена» or the X → onCancel() collapses the prompt.
 *
 * Warning: «Старые deeplink'и перестанут работать» is always shown (D-7).
 *
 * Security: password is never included in any activity-log payload (D-29).
 */
export interface PasswordRotationPromptProps {
  /** Whether the prompt is visible (controlled externally). */
  isOpen: boolean;
  /** Whether the rotation request is in-flight. */
  isLoading: boolean;
  /** Backend error message if rotation failed. */
  error: string | null;
  /** Called with the new plaintext password when user confirms. */
  onConfirm: (newPassword: string) => void;
  /** Called when user cancels / collapses the prompt. */
  onCancel: () => void;
  disabled?: boolean;
}

/**
 * Client-side password validation (identical rules to UsersAddForm).
 * Returns i18n key or "" if valid.
 */
function validatePassword(v: string): string {
  if (!v) return "";
  if (v !== v.trim()) return "server.users.password_no_edge_spaces";
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7F]/.test(v)) return "server.users.password_ascii_only";
  return "";
}

export function PasswordRotationPrompt({
  isOpen,
  isLoading,
  error,
  onConfirm,
  onCancel,
  disabled = false,
}: PasswordRotationPromptProps) {
  const { t } = useTranslation();
  const [newPassword, setNewPassword] = useState("");

  const validationError = validatePassword(newPassword);
  const canConfirm =
    !isLoading && !disabled && newPassword.trim().length > 0 && !validationError;

  const handleGeneratePassword = useCallback(() => {
    setNewPassword(generatePassword());
  }, []);

  const handleClearPassword = useCallback(() => {
    setNewPassword("");
  }, []);

  const handleConfirm = useCallback(() => {
    if (!canConfirm) return;
    onConfirm(newPassword.trim());
  }, [canConfirm, newPassword, onConfirm]);

  const handleCancel = useCallback(() => {
    setNewPassword("");
    onCancel();
  }, [onCancel]);

  if (!isOpen) return null;

  return (
    <div
      className={cn(
        "mt-3 rounded-[var(--radius-md)] border border-[var(--color-border)]",
        "p-[var(--space-4)] bg-[var(--color-bg-surface)]",
        "flex flex-col gap-[var(--space-3)]",
      )}
      data-testid="password-rotation-prompt"
    >
      {/* Title */}
      <p className="text-sm font-[var(--font-weight-semibold)] text-[var(--color-text-primary)]">
        {t("server.users.rotate_password_title")}
      </p>

      {/* Warning banner — always shown (D-7) */}
      <div
        className={cn(
          "flex items-start gap-2 px-[var(--space-3)] py-[var(--space-2)]",
          "rounded-[var(--radius-md)] border",
          "bg-[var(--color-status-connecting-bg)]",
          "border-[var(--color-status-connecting-border)]",
          "text-[var(--color-status-connecting)] text-sm",
        )}
      >
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
        <span>{t("server.users.rotate_password_warning")}</span>
      </div>

      {/* New password input */}
      <ActionPasswordInput
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
        placeholder={t("server.users.rotate_new_password_placeholder")}
        aria-label={t("server.users.rotate_new_password_placeholder")}
        error={validationError ? t(validationError) : undefined}
        disabled={isLoading || disabled}
        showLockIcon={false}
        clearable
        onClear={handleClearPassword}
        clearAriaLabel={t("common.clear_field")}
        showPasswordAriaLabel={t("common.show_password")}
        hidePasswordAriaLabel={t("common.hide_password")}
        actions={[
          <Tooltip key="gen" text={t("common.generate_password")}>
            <button
              type="button"
              onClick={handleGeneratePassword}
              disabled={isLoading || disabled}
              aria-label={t("common.generate_password")}
              className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <Shuffle className="w-3.5 h-3.5" />
            </button>
          </Tooltip>,
        ]}
      />

      {/* Backend error (if rotation failed) */}
      {error && (
        <ErrorBanner severity="error" message={error} />
      )}

      {/* Action buttons */}
      <div className="flex gap-[var(--space-2)]">
        <Button
          type="button"
          variant="danger"
          size="sm"
          disabled={!canConfirm}
          loading={isLoading}
          icon={isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : undefined}
          onClick={handleConfirm}
          className="flex-1"
        >
          {t("server.users.rotate_password_confirm")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={isLoading}
          onClick={handleCancel}
          className="flex-1"
        >
          {t("buttons.cancel")}
        </Button>
      </div>
    </div>
  );
}
