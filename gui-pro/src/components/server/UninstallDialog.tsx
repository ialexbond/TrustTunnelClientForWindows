import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Modal } from "../../shared/ui/Modal";
import { Button } from "../../shared/ui/Button";
import { Checkbox } from "../../shared/ui/Checkbox";
import { formatError } from "../../shared/utils/formatError";
import { translateSshError } from "../../shared/utils/translateSshError";
import {
  useUninstallSelection,
  type UninstallSshParams,
  type UninstallSelection,
} from "./useUninstallSelection";

interface UninstallDialogProps {
  open: boolean;
  sshParams: UninstallSshParams;
  onClose: () => void;
  /** Called after a successful uninstall (clear server info + success snackbar). */
  onSuccess: () => void;
  /** Called with the translated error message on failure (the dialog stays open). */
  onError: (message: string) => void;
  /** Reflect the in-flight state on the section button (DangerZone loader). */
  onLoadingChange?: (loading: boolean) => void;
}

// The selection fields, in render order (ufw/fail2ban/bbr/mtproto). ufw/fail2ban may carry
// the snapshot-gated «package also removed» note. There is NO user-accounts field — users
// are part of the protocol and are ALWAYS removed with it (18-UAT, owner decision).
type FieldKey = keyof UninstallSelection;

/**
 * UN-1 «Удалить протокол» component picker (Phase 18, plan 18-06).
 *
 * Replaces the plain confirm with a Modal checkbox list of exactly the extra components the
 * server has (D-01), defaulting to a full restore-to-pre-install (D-03). The protocol itself
 * (and its server-side user accounts) is always removed — shown as the fixed disabled row.
 * There is NO separate preview screen — the checkboxes plus the danger footer ARE the control
 * surface (D-08). The MTProto row is ownership-gated on the pre-install snapshot / markers
 * (D-05). Package purge stays backend-gated (D-07); its on-screen caption was removed (18-UAT).
 */
export function UninstallDialog({
  open,
  sshParams,
  onClose,
  onSuccess,
  onError,
  onLoadingChange,
}: UninstallDialogProps) {
  const { t } = useTranslation();
  const { loading: detecting, detected, selection, setSelection } =
    useUninstallSelection(sshParams, open);
  const [submitting, setSubmitting] = useState(false);

  const setField = (key: FieldKey, value: boolean) =>
    setSelection((prev) => ({ ...prev, [key]: value }));

  const handleConfirm = async () => {
    setSubmitting(true);
    onLoadingChange?.(true);
    try {
      // Ownership-gated selection crosses IPC to the tested backend, which independently
      // re-gates the package purge + the telemt/BBR folds against the snapshot (defence
      // in depth — T-18-19). camelCase keys map to Rust UninstallSelection.
      await invoke("uninstall_server", { ...sshParams, selection });
      onSuccess();
      onClose();
    } catch (e) {
      // Surface the failure translated; keep the dialog open so the user can retry or
      // cancel (mirrors DangerZone's prior error handling via translateSshError).
      onError(translateSshError(formatError(e), t));
    } finally {
      setSubmitting(false);
      onLoadingChange?.(false);
    }
  };

  return (
    <Modal
      isOpen={open}
      // INSTALL-LOCK: block close (backdrop + X) while the destructive op runs so it
      // can't be interrupted mid-flight (reuse ConfirmDialog loading-lock semantics).
      onClose={submitting ? undefined : onClose}
      closeOnBackdrop={!submitting}
      closeButtonDisabled={submitting}
      showCloseButton
      size="md"
      title={t("server.uninstall.title")}
    >
      <div className="flex flex-col gap-[var(--space-4)]">
        <p className="text-xs leading-relaxed" style={{ color: "var(--color-text-muted)" }}>
          {t("server.uninstall.description")}
        </p>

        {detecting ? (
          <div className="flex items-center justify-center py-8">
            <Loader2
              className="w-5 h-5 animate-spin"
              style={{ color: "var(--color-accent-fg)" }}
              aria-hidden="true"
            />
            <span className="sr-only">{t("server.uninstall.detecting")}</span>
          </div>
        ) : (
          <div className="flex flex-col gap-[var(--space-3)]">
            {/* Protocol — always removed (D-01). Fixed, disabled checked row so the user
                sees it is part of the revert but can't uncheck it. No caption (owner: the
                grey sub-notes were removed as clutter — 18-UAT). */}
            <Checkbox
              checked
              disabled
              onChange={() => {}}
              label={t("server.uninstall.components.protocol")}
            />

            {/* ufw — shown when detected. The package purge is still ownership-gated in the
                backend; the on-screen «package also removed» caption was removed (18-UAT). */}
            {detected.ufw && (
              <Checkbox
                checked={selection.ufw}
                onChange={(v) => setField("ufw", v)}
                label={t("server.uninstall.components.ufw")}
              />
            )}

            {/* fail2ban — same shape as ufw. */}
            {detected.fail2ban && (
              <Checkbox
                checked={selection.fail2ban}
                onChange={(v) => setField("fail2ban", v)}
                label={t("server.uninstall.components.fail2ban")}
              />
            )}

            {/* BBR — shown when currently on; the backend reverts only when the snapshot
                proves it was off before us. */}
            {detected.bbr && (
              <Checkbox
                checked={selection.bbr}
                onChange={(v) => setField("bbr", v)}
                label={t("server.uninstall.components.bbr")}
              />
            )}

            {/* MTProto — offered ONLY when detected AND snapshot-proves-ours (D-05). */}
            {detected.mtproto && (
              <Checkbox
                checked={selection.mtproto}
                onChange={(v) => setField("mtproto", v)}
                label={t("server.uninstall.components.mtproto")}
              />
            )}
          </div>
        )}

        {/* Danger footer — Cancel (left) + destructive «Удалить» (right); mirror
            ConfirmDialog lock semantics (loading + disabled while in-flight). */}
        <div
          className="flex items-center justify-end gap-[var(--space-3)] pt-[var(--space-3)] border-t"
          style={{ borderColor: "var(--color-border)" }}
        >
          <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
            {t("buttons.cancel")}
          </Button>
          <Button
            variant="danger"
            size="sm"
            icon={<AlertTriangle className="w-3.5 h-3.5" />}
            loading={submitting}
            disabled={submitting || detecting}
            onClick={() => void handleConfirm()}
          >
            {t("server.uninstall.confirm")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
