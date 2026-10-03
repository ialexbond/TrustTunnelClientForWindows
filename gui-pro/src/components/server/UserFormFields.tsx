import { useTranslation } from "react-i18next";
import { Shuffle } from "lucide-react";
import { Button } from "../../shared/ui/Button";
import { Tooltip } from "../../shared/ui/Tooltip";
import { ActionInput } from "../../shared/ui/ActionInput";
import { ActionPasswordInput } from "../../shared/ui/ActionPasswordInput";
import { generatePassword } from "../../shared/utils/credentialGenerator";
import { cn } from "../../shared/lib/cn";

/**
 * UserFormFields — the «Учётные данные» (credentials) section of UserModal,
 * extracted Phase 04 Plan 10 (PANEL-03, D-04, one sub-component per commit).
 *
 * Props-only presentational component (mirrors CertificateFingerprintCard):
 * all values + handlers arrive from `useUserFormState` (threaded by UserModal).
 * This is a PURE JSX move — the rendered DOM, testids and aria are byte-identical
 * to the in-place section so the Phase 3 characterization net passes unedited
 * (Pitfall 1). It renders `useTranslation` internally like the other extracted
 * server sub-components; no extra wrapping element was introduced.
 */
export interface UserFormFieldsProps {
  /** Whether the modal is in Edit mode (username readonly, password rotator). */
  isEditMode: boolean;
  /** Global disabled flag (true while a submit is in flight). */
  isDisabled: boolean;

  // Username
  username: string;
  setUsername: (value: string) => void;
  setUsernameError: (value: string) => void;
  /** i18n key from the inline validator, or "" when valid. */
  localUsernameError: string;
  /** i18n key from a backend collision check, or "" when none. */
  usernameError: string;
  generateUniqueUsername: () => string;

  // Password (Add mode)
  password: string;
  setPassword: (value: string) => void;
  /** i18n key from the inline validator, or "" when valid. */
  localPasswordError: string;

  // Password rotation (Edit mode, FIX-OO-11c)
  passwordEditing: boolean;
  setPasswordEditing: (value: boolean) => void;
  newPassword: string;
  setNewPassword: (value: string) => void;
  /** i18n key for the in-place rotation input, or "" when valid/idle. */
  localNewPasswordError: string;
}

export function UserFormFields({
  isEditMode,
  isDisabled,
  username,
  setUsername,
  setUsernameError,
  localUsernameError,
  usernameError,
  generateUniqueUsername,
  password,
  setPassword,
  localPasswordError,
  passwordEditing,
  setPasswordEditing,
  newPassword,
  setNewPassword,
  localNewPasswordError,
}: UserFormFieldsProps) {
  const { t } = useTranslation();

  return (
    <section aria-labelledby="section-credentials" className="mb-[var(--space-5)]">
      <p
        id="section-credentials"
        className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide mb-[var(--space-3)]"
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
                      className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors disabled:opacity-[var(--opacity-disabled)] disabled:cursor-not-allowed"
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
              className="block text-sm font-medium text-[var(--color-text-secondary)]"
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
                          className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors disabled:opacity-[var(--opacity-disabled)] disabled:cursor-not-allowed"
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
                  className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors disabled:opacity-[var(--opacity-disabled)] disabled:cursor-not-allowed"
                >
                  <Shuffle className="w-3.5 h-3.5" />
                </button>
              </Tooltip>,
            ]}
          />
        )}
      </div>
    </section>
  );
}
