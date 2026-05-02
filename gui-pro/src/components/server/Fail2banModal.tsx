import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X, Shield } from "lucide-react";
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
  /** Storybook escape hatch — pre-select banned tab for stories. */
  _forceTab?: "settings" | "banned";
}

export function Fail2banModal({
  isOpen,
  onClose,
  state,
  sshParams,
  _forceTab,
}: Fail2banModalProps) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Find sshd jail (primary). Phase 16 Plan 04 wires только sshd.
  const sshdJail = state.status?.fail2ban.jails.find((j) => j.name === "sshd");
  const installed = state.status?.fail2ban.installed ?? false;

  // P0-2 #K — track custom-mode dirty state из Fail2banSettingsTab.
  // Used для close-confirm dialog когда юзер закрывает Modal с unsaved edits.
  const [customDirty, setCustomDirty] = useState(false);

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

  // Auto-focus X button on open (Modal primitive does not trap focus).
  useEffect(() => {
    if (!isOpen) return;
    const timer = setTimeout(() => closeButtonRef.current?.focus(), 250);
    return () => clearTimeout(timer);
  }, [isOpen]);

  const tabs = [
    {
      id: "settings",
      label: t("server.security.fail2ban.tabs.settings"),
      content: <Fail2banSettingsTab state={state} jail={sshdJail} onDirtyChange={setCustomDirty} />,
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
    <Modal isOpen={isOpen} onClose={() => void handleClose()} size="md" className="relative">
      <button
        ref={closeButtonRef}
        type="button"
        aria-label={t("buttons.close")}
        onClick={() => void handleClose()}
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
        <Shield
          className="w-5 h-5"
          style={{ color: "var(--color-accent-interactive)" }}
          aria-hidden="true"
        />
        <h2 className="text-title">
          {t("server.security.fail2ban.modal_title")}
        </h2>
      </div>

      {!installed ? (
        <div className="space-y-3" data-testid="fail2ban-install">
          <p className="text-body-sm">
            {t("server.security.fail2ban.install_help")}
          </p>
          <Button
            onClick={() => void state.installFail2ban()}
            loading={state.isBusy("install-f2b")}
            disabled={state.isBusy("install-f2b")}
            data-testid="install-fail2ban-button"
          >
            {t("server.security.fail2ban.install_button")}
          </Button>
        </div>
      ) : (
        <TabsInline
          tabs={tabs}
          defaultTab={_forceTab ?? "settings"}
          ariaLabel={t("server.security.fail2ban.tabs_aria")}
        />
      )}
    </Modal>
  );
}
