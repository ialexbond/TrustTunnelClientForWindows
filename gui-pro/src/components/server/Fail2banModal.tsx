import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Shield } from "lucide-react";
import { Modal } from "../../shared/ui/Modal";
import { Button } from "../../shared/ui/Button";
import { TabsInline } from "../../shared/ui/TabsInline";
import { useConfirm } from "../../shared/ui/useConfirm";
import type { SecurityState, SshParams } from "./useSecurityState";
import { Fail2banSettingsTab } from "./Fail2banSettingsTab";
import { Fail2banBannedTab } from "./Fail2banBannedTab";
import { cn } from "../../shared/lib/cn";

/**
 * Phase 16 Plan 04 — Fail2banModal compound.
 *
 * Two states:
 *   - !installed → Install button + helper text. Invokes
 *     `state.installFail2ban` (existing Plan 16 backend command).
 *   - installed → TabsInline (first non-Configuration consumer of
 *     the Phase 15.1 dead-code primitive) с 2 табами:
 *       1. Настройки → Fail2banSettingsTab (3 presets + Accordion custom)
 *       2. Забаненные IP → Fail2banBannedTab (table + Unban actions)
 *
 * Modal lifecycle (T-03):
 *   - НИКОГДА `if (!isOpen) return null` — Modal primitive owns 200ms exit anim.
 *   - На re-open вызываем state.load() для refresh (initial state может быть stale).
 *
 * Storybook escape hatches:
 *   - `_forceTab` pre-selects banned tab (для visual review без click).
 *
 * Backend `security_fail2ban_set_jail` НЕ изменяется (Plan 16 frontend-only).
 */
export interface Fail2banModalProps {
  isOpen: boolean;
  onClose: () => void;
  state: SecurityState;
  sshParams: SshParams;
  /**
   * P UAT 2026-05-04 — parent reload callback. Без этого SecuritySection
   * card 2 + Overview tab security card остаются stale после
   * install/uninstall/preset apply.
   */
  onSecurityChanged?: () => void | Promise<void>;
  /** Storybook escape hatch — pre-select banned tab for stories. */
  _forceTab?: "settings" | "banned";
}

export function Fail2banModal({
  isOpen,
  onClose,
  state,
  sshParams,
  onSecurityChanged,
  _forceTab,
}: Fail2banModalProps) {
  const { t } = useTranslation();
  const confirm = useConfirm();

  // P UAT 2026-05-04 — Uninstall handler с confirm.
  const handleUninstall = async () => {
    const ok = await confirm({
      title: t("server.security.fail2ban.uninstall_confirm_title"),
      message: t("server.security.fail2ban.uninstall_confirm_message"),
      variant: "danger",
      confirmText: t("buttons.delete"),
    });
    if (!ok) return;
    await state.uninstallFail2ban();
    void onSecurityChanged?.();
  };

  const handleInstall = async () => {
    await state.installFail2ban();
    void onSecurityChanged?.();
  };

  // P UAT 2026-05-04 — Stop/Start handlers (отключить vs удалить).
  // Stop = `systemctl stop fail2ban` (mute pkg sits, can be re-enabled).
  // Uninstall = `apt-get remove` (полное удаление).
  const handleStop = async () => {
    const ok = await confirm({
      title: t("server.security.fail2ban.stop_confirm_title"),
      message: t("server.security.fail2ban.stop_confirm_message"),
      variant: "warning",
      confirmText: t("server.security.fail2ban.stop_confirm_action"),
    });
    if (!ok) return;
    await state.stopFail2ban();
    void onSecurityChanged?.();
  };

  const handleStart = async () => {
    await state.startFail2ban();
    void onSecurityChanged?.();
  };

  const fail2banActive = state.status?.fail2ban.active ?? false;

  // Find sshd jail (primary). Phase 16 Plan 04 wires только sshd.
  const sshdJail = state.status?.fail2ban.jails.find((j) => j.name === "sshd");
  const installed = state.status?.fail2ban.installed ?? false;

  // P0-2 #K — track custom-mode dirty state из Fail2banSettingsTab.
  // Used для close-confirm dialog когда юзер закрывает Modal с unsaved edits.
  const [customDirty, setCustomDirty] = useState(false);
  // Footer divider only shows when «Своя конфигурация» is selected (custom accordion open).
  const [customActive, setCustomActive] = useState(false);

  // WR-06 (10.1 review): customDirty is the COMPLETE unsaved-state surface of this
  // modal. The «Своя конфигурация» draft is the only thing a user can edit without
  // committing; the three presets (Мягкая/Сбалансированная/Строгая) AUTO-APPLY the
  // instant they're selected (Fail2banSettingsTab.handleApplyPreset →
  // state.applyFail2banPreset), so there is no pending preset edit to lose. The
  // close-confirm guard below is therefore intentionally scoped to customDirty.
  const handleClose = async () => {
    if (customDirty) {
      const ok = await confirm({
        title: t("server.security.fail2ban.close_dirty_title"),
        message: t("server.security.fail2ban.close_dirty_message"),
        variant: "warning",
        confirmText: t("server.security.fail2ban.close_dirty_confirm"),
        cancelText: t("buttons.cancel"),
      });
      if (!ok) return;
    }
    onClose();
  };

  // T-03 — refresh status on open if installed (initial state may be stale
  // when Modal re-mounted from previously-closed instance).
  useEffect(() => {
    if (isOpen && installed) {
      void state.load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: trigger reload only on isOpen flip; state.load identity changes on every render but we don't want recurring reloads
  }, [isOpen]);

  // T-03 — initial focus is now owned by the Modal primitive (09-05): on open it
  // focuses the first focusable inside the content box (the canonical close
  // button). The hand-rolled auto-focus effect + ref were removed in 09-23 when
  // this modal adopted Modal's showCloseButton.

  const tabs = [
    {
      id: "settings",
      label: t("server.security.fail2ban.tabs.settings"),
      content: <Fail2banSettingsTab state={state} jail={sshdJail} onDirtyChange={setCustomDirty} onCustomActiveChange={setCustomActive} />,
    },
    {
      id: "banned",
      label: t("server.security.fail2ban.tabs.banned"),
      content: (
        <Fail2banBannedTab state={state} jail={sshdJail} sshParams={sshParams} />
      ),
    },
  ];

  // T-03 — NEVER early return null. Modal owns mount/animating lifecycle.
  return (
    <Modal
      isOpen={isOpen}
      onClose={() => void handleClose()}
      size="md"
      showCloseButton
      // a11y (review a11y-3): Modal applies an unconditional focus-trap, so the
      // trapped container must be announced as a NAMED dialog (role + accessible
      // name via aria-labelledby → the visible <h2>). Mirrors UserModal.
      role="dialog"
      ariaModal
      ariaLabelledby="fail2ban-modal-title"
    >
      <div className="flex items-center gap-2 mb-3">
        <Shield
          className="w-5 h-5"
          style={{ color: "var(--color-accent-interactive)" }}
          aria-hidden="true"
        />
        <h2 id="fail2ban-modal-title" className="text-title">
          {t("server.security.fail2ban.modal_title")}
        </h2>
      </div>

      {!installed ? (
        <div className="space-y-3" data-testid="fail2ban-install">
          <p className="text-body-sm">
            {t("server.security.fail2ban.install_help")}
          </p>
          {/* Install CTA — modal-footer standard (owner UAT): bottom-right, unified
              with MtProto / Firewall so the install button is always in the same place. */}
          <div className="flex justify-end gap-2 mt-4">
            <Button
              variant="primary"
              size="sm"
              onClick={() => void handleInstall()}
              loading={state.isBusy("install-f2b")}
              disabled={state.isBusy("install-f2b")}
              data-testid="install-fail2ban-button"
            >
              {t("server.security.fail2ban.install_button")}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <TabsInline
            tabs={tabs}
            defaultTab={_forceTab ?? "settings"}
            ariaLabel={t("server.security.fail2ban.tabs_aria")}
          />

          {/* P UAT 2026-05-04 — Footer с двумя действиями:
              - Отключить/Включить (systemctl stop/start fail2ban — пакет
                остаётся, конфиг сохранён, можно включить обратно)
              - Удалить (apt-get remove — полное удаление пакета).
              Разные impact'ы → разные buttons. */}
          <div
            className={cn(
              "mt-4 pt-4 flex items-center justify-end gap-2 flex-wrap",
              // Divider only when the custom-config accordion is open (no stray line over
              // the bordered preset cards). UAT 2026-06-22 (owner).
              customActive && "border-t",
            )}
            style={{ borderColor: "var(--color-border)" }}
            data-testid="fail2ban-danger-zone"
          >
            {fail2banActive ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handleStop()}
                loading={state.isBusy("stop-f2b")}
                disabled={state.isBusy("stop-f2b")}
                data-testid="stop-fail2ban-button"
              >
                {t("server.security.fail2ban.stop_button")}
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handleStart()}
                loading={state.isBusy("start-f2b")}
                disabled={state.isBusy("start-f2b")}
                data-testid="start-fail2ban-button"
              >
                {t("server.security.fail2ban.start_button")}
              </Button>
            )}
            <Button
              variant="danger-outline"
              size="sm"
              onClick={() => void handleUninstall()}
              loading={state.isBusy("uninstall-f2b")}
              disabled={state.isBusy("uninstall-f2b")}
              data-testid="uninstall-fail2ban-button"
            >
              {t("server.security.fail2ban.uninstall_button")}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
