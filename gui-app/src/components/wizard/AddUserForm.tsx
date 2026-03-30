import { useTranslation } from "react-i18next";
import { UserPlus, Eye, EyeOff } from "lucide-react";
import { Button } from "../../shared/ui/Button";
import type { WizardState } from "./useWizardState";

interface AddUserFormProps {
  w: WizardState;
  onUserAdded: () => void;
}

export function AddUserForm({ w, onUserAdded }: AddUserFormProps) {
  const { t } = useTranslation();

  return (
    <div className="text-left space-y-2 p-3 rounded-xl" style={{ backgroundColor: "var(--color-bg-surface)", border: "1px solid var(--color-border)" }}>
      <p className="text-[11px] font-semibold flex items-center gap-1.5" style={{ color: "var(--color-text-primary)" }}>
        <UserPlus className="w-3.5 h-3.5" />
        {t('wizard.found.add_user')}
      </p>
      <p className="text-[10px] leading-relaxed" style={{ color: "var(--color-text-muted)" }}>
        {t('wizard.found.add_user_description')}
      </p>
      <div className="space-y-1.5">
        <div>
          <input
            type="text"
            placeholder={t('wizard.found.username_placeholder')}
            value={w.newUsername}
            onChange={(e) => w.setNewUsername(e.target.value.replace(/\s/g, ""))}
            className="w-full px-3 h-8 rounded-lg text-xs outline-none" style={{ backgroundColor: "var(--color-bg-elevated)", border: "1px solid var(--color-border)", color: "var(--color-text-primary)" }}
          />
          {w.newUsername.trim() && w.serverInfo?.users?.includes(w.newUsername.trim()) && (
            <p className="text-[10px] mt-0.5" style={{ color: "var(--color-danger-500)" }}>
              {t('wizard.found.user_already_exists')}
            </p>
          )}
        </div>
        <div className="relative">
          <input
            type={w.showNewPassword ? "text" : "password"}
            placeholder={t('wizard.found.password_placeholder')}
            value={w.newPassword}
            onChange={(e) => w.setNewPassword(e.target.value)}
            className="w-full px-3 h-8 pr-8 rounded-lg text-xs outline-none" style={{ backgroundColor: "var(--color-bg-elevated)", border: "1px solid var(--color-border)", color: "var(--color-text-primary)" }}
          />
          <button
            type="button"
            onClick={() => w.setShowNewPassword(!w.showNewPassword)}
            className="absolute right-2 top-1/2 -translate-y-1/2 transition-colors" style={{ color: "var(--color-text-muted)" }}
          >
            {w.showNewPassword ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
          </button>
        </div>
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
