import { useTranslation } from "react-i18next";
import { UserPlus, Shuffle } from "lucide-react";
import { Button } from "../../shared/ui/Button";
import { Tooltip } from "../../shared/ui/Tooltip";
import { ActionInput } from "../../shared/ui/ActionInput";
import { ActionPasswordInput } from "../../shared/ui/ActionPasswordInput";
import { generateUsername, generatePassword } from "../../shared/utils/credentialGenerator";
import type { WizardState } from "./useWizardState";

interface AddUserFormProps {
  w: WizardState;
  onUserAdded: () => void;
}

export function AddUserForm({ w, onUserAdded }: AddUserFormProps) {
  const { t } = useTranslation();

  return (
    <div className="text-left space-y-2 p-3 rounded-xl" style={{ backgroundColor: "var(--color-bg-surface)", border: "1px solid var(--color-border)" }}>
      <p className="text-[11px] font-medium flex items-center gap-1.5" style={{ color: "var(--color-text-primary)" }}>
        <UserPlus className="w-3.5 h-3.5" />
        {t('wizard.found.add_user')}
      </p>
      <p className="text-[10px] leading-relaxed" style={{ color: "var(--color-text-muted)" }}>
        {t('wizard.found.add_user_description')}
      </p>
      <div className="space-y-1.5">
        <div>
          <ActionInput
            type="text"
            placeholder={t('wizard.found.username_placeholder')}
            value={w.newUsername}
            onChange={(e) => w.setNewUsername(e.target.value.replace(/\s/g, ""))}
            disabled={w.addingUser}
            error={w.newUsername.trim() && w.serverInfo?.users?.includes(w.newUsername.trim()) ? t('wizard.found.user_already_exists') : undefined}
            actions={[
              <Tooltip key="gen" text={t("common.generate_username")}>
                <button
                  type="button"
                  onClick={() => w.setNewUsername(generateUsername())}
                  disabled={w.addingUser}
                  className="transition-colors hover:opacity-70 disabled:opacity-30 disabled:cursor-not-allowed"
                  style={{ color: "var(--color-text-muted)" }}
                >
                  <Shuffle className="w-3 h-3" />
                </button>
              </Tooltip>,
            ]}
          />
        </div>
        <ActionPasswordInput
          placeholder={t('wizard.found.password_placeholder')}
          value={w.newPassword}
          onChange={(e) => w.setNewPassword(e.target.value)}
          disabled={w.addingUser}
          showLockIcon={false}
          actions={[
            <Tooltip key="gen" text={t("common.generate_password")}>
              <button
                type="button"
                onClick={() => w.setNewPassword(generatePassword())}
                disabled={w.addingUser}
                className="transition-colors hover:opacity-70 disabled:opacity-30 disabled:cursor-not-allowed"
                style={{ color: "var(--color-text-muted)" }}
              >
                <Shuffle className="w-3 h-3" />
              </button>
            </Tooltip>,
          ]}
        />
        <Button
          variant="primary"
          size="sm"
          fullWidth
          onClick={async () => { await w.handleAddUser(); onUserAdded(); }}
          disabled={w.addingUser || !w.newUsername.trim() || !w.newPassword.trim() || !!w.serverInfo?.users?.includes(w.newUsername.trim())}
          loading={w.addingUser}
          icon={<UserPlus className="w-3.5 h-3.5" />}
        >
          {w.addingUser ? t('wizard.found.adding_user') : t('wizard.found.add_btn')}
        </Button>
      </div>
    </div>
  );
}
