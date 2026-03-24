import { useTranslation } from "react-i18next";
import {
  User, Download, Loader2, XCircle, Server, ChevronRight,
  PackageCheck, FolderOpen, RefreshCw, Trash2, Eye, EyeOff, UserPlus,
} from "lucide-react";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { StepBar } from "./StepBar";
import type { WizardState } from "./useWizardState";

// ─── Fetch mode: show users only, save config ──────────────
function FoundFetchMode(w: WizardState) {
  const { t } = useTranslation();
  const isInstalled = w.serverInfo?.installed;
  const users = w.serverInfo?.users || [];

  if (isInstalled && users.length > 0) {
    return (
      <>
        <div className="mx-auto w-14 h-14 rounded-2xl flex items-center justify-center" style={{ backgroundColor: "rgba(16, 185, 129, 0.1)" }}>
          <User className="w-7 h-7" style={{ color: "var(--color-success-500)" }} />
        </div>
        <div className="space-y-1.5">
          <h2 className="text-lg font-bold">{t('wizard.found.users_on_server')}</h2>
          <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
            {t('wizard.found.select_user_for_config')}
          </p>
        </div>

        <div className="text-left space-y-1 p-3 rounded-xl" style={{ backgroundColor: "var(--color-bg-surface)", border: "1px solid var(--color-border)" }}>
          {users.map((u) => (
            <div key={u} className="flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg transition-colors cursor-default"
              style={{ backgroundColor: "transparent" }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--color-bg-hover)"}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
            >
              <span className="text-sm" style={{ color: "var(--color-text-primary)" }}>{u}</span>
              <button
                onClick={() => w.handleSaveConfigDirect(u)}
                disabled={!!w.savingConfigFor}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:opacity-80 disabled:opacity-40"
                style={{ backgroundColor: "var(--color-accent-500)", color: "white" }}
              >
                {w.savingConfigFor === u ? (
                  <>
                    <Loader2 className="w-3 h-3 animate-spin" />
                    {t('wizard.found.saving_config')}
                  </>
                ) : (
                  <>
                    <Download className="w-3 h-3" />
                    {t('wizard.found.save_config')}
                  </>
                )}
              </button>
            </div>
          ))}
        </div>

        {w.errorMessage && (
          <p className="text-xs" style={{ color: "var(--color-danger-500)" }}>{w.errorMessage}</p>
        )}

        <button
          onClick={() => w.setWizardStep("welcome")}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm transition-all active:scale-[0.97]"
          style={{ color: "var(--color-text-secondary)" }}
          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--color-bg-hover)"}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
        >
          {t('wizard.found.to_home')}
        </button>
      </>
    );
  }

  if (isInstalled && users.length === 0) {
    return (
      <>
        <div className="mx-auto w-14 h-14 rounded-2xl flex items-center justify-center" style={{ backgroundColor: "rgba(245, 158, 11, 0.1)" }}>
          <User className="w-7 h-7" style={{ color: "var(--color-warning-500)" }} />
        </div>
        <div className="space-y-1.5">
          <h2 className="text-lg font-bold">{t('wizard.found.no_users_title')}</h2>
          <p className="text-xs" style={{ color: "var(--color-text-secondary)" }}>
            {t('wizard.found.no_users_description')}
          </p>
        </div>
        <div className="flex gap-2 w-full">
          <button
            onClick={() => w.setWizardStep("server")}
            className="px-4 py-2.5 rounded-xl text-sm transition-all active:scale-[0.97]"
            style={{ color: "var(--color-text-secondary)" }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--color-bg-hover)"}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
          >
            {t('buttons.back')}
          </button>
          <button
            onClick={() => { w.saveField("wizardMode", ""); w.setWizardStep("server"); }}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium transition-all active:scale-95"
            style={{ backgroundColor: "var(--color-accent-500)", color: "white" }}
          >
            {t('wizard.found.setup_server')}
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </>
    );
  }

  // Not installed or error in fetch mode
  return (
    <>
      <div className="mx-auto w-14 h-14 rounded-2xl flex items-center justify-center" style={{ backgroundColor: "rgba(239, 68, 68, 0.08)" }}>
        <XCircle className="w-7 h-7" style={{ color: "var(--color-danger-500)" }} />
      </div>
      <div className="space-y-1.5">
        <h2 className="text-lg font-bold" style={{ color: "var(--color-danger-500)" }}>
          {w.checkError ? t('wizard.found.server_unreachable') : t('wizard.found.not_installed_title')}
        </h2>
        <p className="text-xs" style={{ color: "var(--color-text-secondary)" }}>
          {w.checkError
            ? t('wizard.found.ssh_error_fetch_description')
            : t('wizard.found.not_installed_fetch_description')}
        </p>
        {w.checkError && (
          <div className="max-h-20 overflow-y-auto rounded-lg p-2 mt-2" style={{ backgroundColor: "var(--color-bg-elevated)" }}>
            <p className="text-[10px] leading-relaxed select-text cursor-text break-words" style={{ color: "var(--color-danger-500)", opacity: 0.8 }}>
              {w.checkError}
            </p>
          </div>
        )}
      </div>
      <div className="flex gap-2 w-full">
        <button
          onClick={() => w.setWizardStep("server")}
          className="px-4 py-2.5 rounded-xl text-sm transition-all active:scale-[0.97]"
          style={{ color: "var(--color-text-secondary)" }}
          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--color-bg-hover)"}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
        >
          {t('buttons.back')}
        </button>
        <button
          onClick={() => { w.saveField("wizardMode", ""); w.setWizardStep("server"); }}
          className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium transition-all active:scale-95"
          style={{ backgroundColor: "var(--color-accent-500)", color: "white" }}
        >
          {t('wizard.found.setup_server')}
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </>
  );
}

// ─── Setup mode: TT installed or not ──────────────
function FoundSetupMode(w: WizardState) {
  const { t } = useTranslation();
  const isInstalled = w.serverInfo?.installed;

  if (isInstalled) {
    return (
      <>
        <div className="mx-auto w-14 h-14 rounded-2xl flex items-center justify-center" style={{ backgroundColor: "rgba(245, 158, 11, 0.1)" }}>
          <PackageCheck className="w-7 h-7" style={{ color: "var(--color-warning-500)" }} />
        </div>
        <div className="space-y-1.5">
          <h2 className="text-lg font-bold" style={{ color: "var(--color-warning-500)" }}>
            {t('wizard.found.already_installed')}
          </h2>
          {w.serverInfo?.version && (
            <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
              {t('wizard.found.version_label', { version: w.serverInfo.version })}
            </p>
          )}
          <p className="text-xs" style={{ color: "var(--color-text-secondary)" }}>
            {t('wizard.found.service_label')} {w.serverInfo?.serviceActive ? (
              <span style={{ color: "var(--color-success-500)" }}>{t('wizard.found.service_running')}</span>
            ) : (
              <span style={{ color: "var(--color-text-muted)" }}>{t('wizard.found.service_stopped')}</span>
            )}
          </p>
        </div>

        {/* ── Users on server ── */}
        {w.serverInfo?.users && w.serverInfo.users.length > 0 && (
          <div className="text-left space-y-2 p-3 rounded-xl" style={{ backgroundColor: "var(--color-bg-surface)", border: "1px solid var(--color-border)" }}>
            <p className="text-[11px] font-semibold flex items-center gap-1.5" style={{ color: "var(--color-text-primary)" }}>
              <User className="w-3.5 h-3.5" />
              {t('wizard.found.users_on_server')}
            </p>
            <div className="space-y-1">
              {w.serverInfo.users.map((u) => {
                const isSelected = w.selectedUser === u;
                return (
                  <div key={u} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg transition-colors"
                    style={{ backgroundColor: isSelected ? "rgba(99, 102, 241, 0.1)" : "transparent", border: isSelected ? "1px solid rgba(99, 102, 241, 0.3)" : "1px solid transparent" }}
                    onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.backgroundColor = "var(--color-bg-hover)"; }}
                    onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.backgroundColor = "transparent"; }}
                  >
                    <button
                      onClick={() => w.setSelectedUser(u)}
                      className="flex items-center gap-2 flex-1 min-w-0 text-left"
                    >
                      <div className="w-3.5 h-3.5 rounded-full border-2 shrink-0 flex items-center justify-center"
                        style={{ borderColor: isSelected ? "var(--color-accent-500)" : "var(--color-border)" }}
                      >
                        {isSelected && <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: "var(--color-accent-500)" }} />}
                      </div>
                      <span className="text-xs truncate" style={{ color: isSelected ? "var(--color-accent-500)" : "var(--color-text-secondary)" }}>{u}</span>
                    </button>
                    <div className="flex items-center gap-0.5 shrink-0">
                      <button
                        onClick={() => w.handleSaveConfigDirect(u)}
                        disabled={!!w.savingConfigFor}
                        className="p-1.5 rounded-lg transition-all hover:opacity-70 disabled:opacity-40"
                        style={{ color: "var(--color-accent-500)" }}
                        title={t('wizard.found.save_config_tooltip')}
                      >
                        {w.savingConfigFor === u ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                      </button>
                      <button
                        onClick={() => !w.deletingUser && w.setConfirmDeleteUser(u)}
                        disabled={!!w.deletingUser}
                        className="p-1.5 rounded-lg transition-all hover:opacity-70 disabled:opacity-40"
                        style={{ color: "var(--color-danger-500)" }}
                        title={t('wizard.found.delete_user_tooltip')}
                      >
                        {w.deletingUser === u ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            <ConfirmDialog
              open={!!w.confirmDeleteUser}
              title={t('wizard.found.confirm_delete_title')}
              message={t('wizard.found.confirm_delete_message', { user: w.confirmDeleteUser })}
              confirmLabel={t('buttons.confirm_delete')}
              onConfirm={() => w.confirmDeleteUser && w.handleDeleteUser(w.confirmDeleteUser)}
              onCancel={() => w.setConfirmDeleteUser(null)}
            />
          </div>
        )}

        {/* ── Add new user ── */}
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
                className="w-full px-3 py-1.5 rounded-lg text-xs outline-none" style={{ backgroundColor: "var(--color-bg-elevated)", border: "1px solid var(--color-border)", color: "var(--color-text-primary)" }}
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
                className="w-full px-3 py-1.5 pr-8 rounded-lg text-xs outline-none" style={{ backgroundColor: "var(--color-bg-elevated)", border: "1px solid var(--color-border)", color: "var(--color-text-primary)" }}
              />
              <button
                type="button"
                onClick={() => w.setShowNewPassword(!w.showNewPassword)}
                className="absolute right-2 top-1/2 -translate-y-1/2 transition-colors" style={{ color: "var(--color-text-muted)" }}
              >
                {w.showNewPassword ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
              </button>
            </div>
            <button
              onClick={w.handleAddUser}
              disabled={w.addingUser || !w.newUsername.trim() || !w.newPassword.trim() || !!w.serverInfo?.users?.includes(w.newUsername.trim())}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ backgroundColor: "var(--color-accent-500)", color: "white" }}
            >
              {w.addingUser ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  {t('wizard.found.adding_user')}
                </>
              ) : (
                <>
                  <UserPlus className="w-3.5 h-3.5" />
                  {t('wizard.found.add_btn')}
                </>
              )}
            </button>
          </div>
        </div>

        {/* Continue button */}
        <button
          onClick={() => { if (w.selectedUser) w.handleFetchConfig(w.selectedUser); }}
          disabled={!w.selectedUser}
          className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ backgroundColor: "var(--color-accent-500)", color: "white" }}
        >
          {t('wizard.found.continue_btn')}
          <ChevronRight className="w-4 h-4" />
        </button>

        <div className="space-y-2 pt-1">
          <button
            onClick={w.handleSkip}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm transition-all active:scale-[0.97] hover:opacity-80"
            style={{ backgroundColor: "var(--color-bg-hover)", border: "1px solid var(--color-border)", color: "var(--color-text-secondary)" }}
          >
            <FolderOpen className="w-4 h-4" />
            {t('wizard.found.skip_have_config')}
          </button>
          <button
            onClick={() => { w.setCameFromFound(true); w.setWizardStep("endpoint"); }}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm transition-all active:scale-[0.97] hover:opacity-80"
            style={{ backgroundColor: "var(--color-bg-hover)", border: "1px solid var(--color-border)", color: "var(--color-text-secondary)" }}
          >
            <RefreshCw className="w-3.5 h-3.5" />
            {t('wizard.found.reinstall_tt')}
          </button>
          <button
            onClick={() => w.setConfirmUninstall(true)}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm transition-all active:scale-[0.97] hover:opacity-80"
            style={{ backgroundColor: "rgba(239, 68, 68, 0.08)", border: "1px solid rgba(239, 68, 68, 0.25)", color: "var(--color-danger-500)" }}
          >
            <Trash2 className="w-3.5 h-3.5" />
            {t('wizard.found.delete_tt')}
          </button>
        </div>
        <ConfirmDialog
          open={w.confirmUninstall}
          title={t('wizard.found.confirm_uninstall_title')}
          message={t('wizard.found.uninstall_consequences')}
          confirmLabel={t('buttons.confirm_delete')}
          onConfirm={() => { w.setConfirmUninstall(false); w.handleUninstall(); }}
          onCancel={() => w.setConfirmUninstall(false)}
        />
      </>
    );
  }

  // Not installed
  if (w.checkError) {
    return (
      <>
        <div className="mx-auto w-14 h-14 rounded-2xl flex items-center justify-center" style={{ backgroundColor: "rgba(239, 68, 68, 0.08)" }}>
          <XCircle className="w-7 h-7" style={{ color: "var(--color-danger-500)" }} />
        </div>
        <div className="space-y-1.5">
          <h2 className="text-lg font-bold" style={{ color: "var(--color-danger-500)" }}>{t('wizard.found.server_unreachable')}</h2>
          <p className="text-xs" style={{ color: "var(--color-text-secondary)" }}>
            {t('wizard.found.connection_error_help')}
          </p>
          <div className="max-h-20 overflow-y-auto rounded-lg p-2 mt-2" style={{ backgroundColor: "var(--color-bg-elevated)" }}>
            <p className="text-[10px] leading-relaxed select-text cursor-text break-words" style={{ color: "var(--color-danger-500)", opacity: 0.8 }}>
              {w.checkError}
            </p>
          </div>
        </div>
        <button
          onClick={() => w.setWizardStep("server")}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm transition-all active:scale-[0.97]"
          style={{ color: "var(--color-text-secondary)" }}
          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--color-bg-hover)"}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
        >
          {t('buttons.back')}
        </button>
      </>
    );
  }

  // Server ready, TT not installed
  return (
    <>
      <div className="mx-auto w-14 h-14 rounded-2xl flex items-center justify-center" style={{ backgroundColor: "rgba(99, 102, 241, 0.1)" }}>
        <Server className="w-7 h-7" style={{ color: "var(--color-accent-500)" }} />
      </div>
      <div className="space-y-1.5">
        <h2 className="text-lg font-bold">{t('wizard.found.server_ready')}</h2>
        <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
          {t('wizard.found.not_found_can_install')}
        </p>
      </div>
      <div className="flex gap-2 w-full">
        <button
          onClick={() => w.setWizardStep("server")}
          className="px-4 py-2.5 rounded-xl text-sm transition-all active:scale-[0.97]"
          style={{ color: "var(--color-text-secondary)" }}
          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--color-bg-hover)"}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
        >
          {t('buttons.back')}
        </button>
        <button
          onClick={() => w.setWizardStep("endpoint")}
          className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium transition-all active:scale-95"
          style={{ backgroundColor: "var(--color-accent-500)", color: "white" }}
        >
          {t('wizard.found.continue_setup')}
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </>
  );
}

// ─── Main FoundStep ──────────────
export function FoundStep(w: WizardState) {
  const { t } = useTranslation();
  const isInstalled = w.serverInfo?.installed;

  return (
    <>
      <StepBar step={w.step} isFetchMode={w.isFetchMode} />
      <div className="flex-1 flex items-center justify-center p-6 overflow-y-auto">
        <div className="max-w-sm w-full text-center space-y-5 my-auto">
          {w.isFetchMode ? (
            <FoundFetchMode {...w} />
          ) : (
            <>
              <FoundSetupMode {...w} />
              {isInstalled && (
                <button
                  onClick={() => w.setWizardStep("server")}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm transition-all active:scale-[0.97]"
                  style={{ color: "var(--color-text-secondary)" }}
                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--color-bg-hover)"}
                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
                >
                  {t('buttons.back')}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
