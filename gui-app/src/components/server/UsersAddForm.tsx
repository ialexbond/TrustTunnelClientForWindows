import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { UserPlus, Loader2, Shuffle } from "lucide-react";
import { ActionInput } from "../../shared/ui/ActionInput";
import { ActionPasswordInput } from "../../shared/ui/ActionPasswordInput";
import { Button } from "../../shared/ui/Button";
import { Tooltip } from "../../shared/ui/Tooltip";
import { useActivityLog } from "../../shared/hooks/useActivityLog";
import { generateUsername, generatePassword } from "../../shared/utils/credentialGenerator";

/**
 * Client-side validation (matches Linux useradd constraints).
 * Returns i18n key for error, or empty string if valid.
 * Empty input is considered valid (submit is gated by `newUsername.trim().length > 0` separately).
 */
function validateUsername(v: string): string {
  if (!v) return "";
  if (/\s/.test(v)) return "server.users.username_spaces";
  // ASCII-only: letters, digits, `. _ -` — matches the char set the backend accepts (useradd NAME_REGEX).
  if (!/^[a-zA-Z0-9._-]+$/.test(v)) return "server.users.username_ascii_only";
  if (v.length > 32) return "server.users.username_too_long";
  return "";
}

/**
 * Password client-side validation. Linux passwords can contain almost anything;
 * we only reject leading/trailing spaces (often invisible, cause login failures)
 * and non-ASCII (SSH deploy pipeline struggles with UTF-8 in some shells).
 */
function validatePassword(v: string): string {
  if (!v) return "";
  if (v !== v.trim()) return "server.users.password_no_edge_spaces";
  // eslint-disable-next-line no-control-regex -- we explicitly want \x00-\x7F boundary
  if (/[^\x00-\x7F]/.test(v)) return "server.users.password_ascii_only";
  return "";
}

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

  // ── Client-side validation (logs transitions, gates submit) ──
  const localUsernameError = validateUsername(newUsername);
  const localPasswordError = validatePassword(newPassword);
  const prevUsernameError = useRef(localUsernameError);
  const prevPasswordError = useRef(localPasswordError);
  useEffect(() => {
    // Log when a new validation error appears (transition empty → error or error → different error).
    // D-29: do NOT include the value itself — only the error type.
    if (localUsernameError && localUsernameError !== prevUsernameError.current) {
      const type = localUsernameError.split(".").pop();
      activityLog("USER", `user.form.validation_error field=username type=${type}`);
    }
    prevUsernameError.current = localUsernameError;
  }, [localUsernameError, activityLog]);
  useEffect(() => {
    if (localPasswordError && localPasswordError !== prevPasswordError.current) {
      const type = localPasswordError.split(".").pop();
      activityLog("USER", `user.form.validation_error field=password type=${type}`);
    }
    prevPasswordError.current = localPasswordError;
  }, [localPasswordError, activityLog]);

  // Merge local validation with parent's error (backend-reported errors like `username_exists`).
  const displayedUsernameError = localUsernameError || usernameError;

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
    !isAdding &&
    newUsername.trim().length > 0 &&
    newPassword.trim().length > 0 &&
    !displayedUsernameError &&
    !localPasswordError;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) {
      // Log blocked submit so user can see in activity log WHY nothing happened.
      if (displayedUsernameError || localPasswordError) {
        activityLog(
          "USER",
          `user.add.blocked reason=${displayedUsernameError ? "username" : "password"}`,
        );
      }
      return;
    }
    onAdd();
  };

  return (
    <form onSubmit={handleSubmit}>
      <div className="flex gap-[var(--space-3)]">
        {/* Name input: Regenerate action + clearable X (appears when value.length > 0) */}
        <div className="flex-1">
          <ActionInput
            value={newUsername}
            onChange={(e) => setNewUsername(e.target.value)}
            placeholder={t("server.users.username_placeholder")}
            aria-label={t("server.users.username_placeholder")}
            error={displayedUsernameError ? t(displayedUsernameError) : undefined}
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
                  className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
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
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder={t("server.users.password_placeholder")}
            aria-label={t("server.users.password_placeholder")}
            error={localPasswordError ? t(localPasswordError) : undefined}
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
                  className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
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
