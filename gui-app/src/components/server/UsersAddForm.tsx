import { useTranslation } from "react-i18next";
import { UserPlus, Loader2, Shuffle } from "lucide-react";
import { ActionInput } from "../../shared/ui/ActionInput";
import { ActionPasswordInput } from "../../shared/ui/ActionPasswordInput";
import { Button } from "../../shared/ui/Button";
import { Tooltip } from "../../shared/ui/Tooltip";
import { useActivityLog } from "../../shared/hooks/useActivityLog";
import { generateUsername, generatePassword } from "../../shared/utils/credentialGenerator";

interface UsersAddFormProps {
  newUsername: string;
  setNewUsername: (v: string) => void;
  newPassword: string;
  setNewPassword: (v: string) => void;
  isAdding: boolean;
  /** i18n key or "" — parent owns translation of the error key. */
  usernameError: string;
  onAdd: () => void;
  /**
   * Optional parent-delegated name generator with collision-check (D-14).
   * When provided — invoked in handleRegenerateName instead of generateUsername().
   * Parent (UsersSection) passes `() => generateUniqueUsername(existing, 10)`.
   * When NOT provided — fallback to direct generateUsername() without collision-check
   * (useful for standalone Storybook usage where there's no serverInfo.users context).
   */
  onRegenerateName?: () => string;
}

/**
 * Inline add-user form for the Users tab (D-20).
 *
 * - Pre-fill owned by parent: parent seeds `newUsername`/`newPassword` on mount
 *   (D-13) and re-seeds after successful add.
 * - Uses `clearable` + action-icon primitives from Plan 03 (Shuffle regen,
 *   eye-toggle, clear).
 * - Activity log: 5 events via useActivityLog — name_generated, password_generated,
 *   field_cleared×2, password_visibility_toggled (D-28). Passwords are NEVER
 *   included in payloads (D-29).
 * - D-16: no min-length validation — backend accepts any non-empty password.
 * - D-17: regenerate icons are independent — name-regen only sets newUsername,
 *   password-regen only sets newPassword.
 * - Form wraps inputs + button in `<form>` so Enter from either input submits.
 */
export function UsersAddForm({
  newUsername,
  setNewUsername,
  newPassword,
  setNewPassword,
  isAdding,
  usernameError,
  onAdd,
  onRegenerateName,
}: UsersAddFormProps) {
  const { t } = useTranslation();
  const { log: activityLog } = useActivityLog();

  const handleRegenerateName = () => {
    activityLog("USER", "user.form.name_generated");
    // D-14: parent-delegated generator with collision-check when provided,
    // else fallback to plain generateUsername() for standalone use.
    const nextName = onRegenerateName ? onRegenerateName() : generateUsername();
    setNewUsername(nextName);
  };

  const handleRegeneratePassword = () => {
    activityLog("USER", "user.form.password_generated");
    setNewPassword(generatePassword());
  };

  const handleClearName = () => {
    activityLog("USER", "user.form.field_cleared field=name");
    setNewUsername("");
  };

  const handleClearPassword = () => {
    activityLog("USER", "user.form.field_cleared field=password");
    setNewPassword("");
  };

  const handleVisibilityToggle = () => {
    activityLog("USER", "user.form.password_visibility_toggled");
  };

  const canSubmit =
    !isAdding && newUsername.trim().length > 0 && newPassword.trim().length > 0 && !usernameError;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (canSubmit) {
      onAdd();
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <div className="flex gap-[var(--space-3)]">
        {/* Name input: Regenerate action + clearable X (appears when value.length > 0) */}
        <div className="flex-1">
          <ActionInput
            value={newUsername}
            onChange={(e) =>
              setNewUsername(e.target.value.replace(/[^a-zA-Z0-9._-]/g, ""))
            }
            placeholder={t("server.users.username_placeholder")}
            aria-label={t("server.users.username_placeholder")}
            error={usernameError ? t(usernameError) : undefined}
            disabled={isAdding}
            clearable
            onClear={handleClearName}
            clearAriaLabel={t("common.clear_field")}
            actions={[
              <Tooltip key="gen" text={t("common.generate_username")}>
                <button
                  type="button"
                  onClick={handleRegenerateName}
                  disabled={isAdding}
                  className="text-[var(--color-text-muted)] transition-opacity hover:opacity-70 disabled:opacity-30 disabled:cursor-not-allowed"
                  aria-label={t("common.generate_username")}
                >
                  <Shuffle className="w-3.5 h-3.5" />
                </button>
              </Tooltip>,
            ]}
          />
        </div>

        {/* Password input: Regenerate + eye-toggle (built-in) + clearable X */}
        <div className="flex-1">
          <ActionPasswordInput
            value={newPassword}
            onChange={(e) =>
              setNewPassword(
                e.target.value.replace(/[^a-zA-Z0-9!@#$%^&*()_+\-=[\]{};':"|,./<>?`~\\]/g, "")
              )
            }
            placeholder={t("server.users.password_placeholder")}
            aria-label={t("server.users.password_placeholder")}
            disabled={isAdding}
            showLockIcon={false}
            clearable
            onClear={handleClearPassword}
            onVisibilityToggle={handleVisibilityToggle}
            clearAriaLabel={t("common.clear_field")}
            showPasswordAriaLabel={t("common.show_password")}
            hidePasswordAriaLabel={t("common.hide_password")}
            actions={[
              <Tooltip key="gen" text={t("common.generate_password")}>
                <button
                  type="button"
                  onClick={handleRegeneratePassword}
                  disabled={isAdding}
                  className="text-[var(--color-text-muted)] transition-opacity hover:opacity-70 disabled:opacity-30 disabled:cursor-not-allowed"
                  aria-label={t("common.generate_password")}
                >
                  <Shuffle className="w-3.5 h-3.5" />
                </button>
              </Tooltip>,
            ]}
          />
        </div>

        {/* Primary Add CTA — disabled when fields empty or usernameError set.
             D-16: no min-length — single-char password is allowed. */}
        <Button
          type="submit"
          variant="primary"
          size="sm"
          icon={
            isAdding ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <UserPlus className="w-3.5 h-3.5" />
            )
          }
          loading={isAdding}
          disabled={!canSubmit}
          className="shrink-0"
        >
          {t("server.users.add_user")}
        </Button>
      </div>
    </form>
  );
}
