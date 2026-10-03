import { useTranslation } from "react-i18next";
import { Modal } from "./Modal";
import { Button } from "./Button";

interface ConfirmDialogProps {
  isOpen?: boolean;
  /** @deprecated Use isOpen */
  open?: boolean;
  title: string;
  message: string;
  confirmText?: string;
  confirmLabel?: string;
  cancelText?: string;
  cancelLabel?: string;
  variant?: "danger" | "warning";
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
  /**
   * Phase 14 (FAB-05): disable the confirm button WITHOUT the loading spinner. Used when the
   * confirmed action becomes unsafe while the dialog is open (e.g. a config-switch started, so a
   * delete would race the swap). Cancel stays enabled so the user can still dismiss the dialog.
   */
  confirmDisabled?: boolean;
  /** Modal size (default: "md"). Use "sm" for very short confirmations. */
  size?: "sm" | "md" | "lg";
}

export function ConfirmDialog({
  isOpen,
  open,
  title,
  message,
  confirmText,
  confirmLabel,
  cancelText,
  cancelLabel,
  variant = "danger",
  onConfirm,
  onCancel,
  loading,
  confirmDisabled,
  size = "md",
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  const isVisible = isOpen ?? open ?? false;
  const resolvedConfirmText = confirmLabel ?? confirmText ?? t("confirmDialog.confirm");
  const resolvedCancelText = cancelLabel ?? cancelText ?? t("confirmDialog.cancel");

  return (
    <Modal
      isOpen={isVisible}
      onClose={loading ? undefined : onCancel}
      closeOnBackdrop={!loading}
      size={size}
    >
      {/* DELMODAL (16-12): the reset/uninstall confirm rendered its title, body AND
          buttons CENTERED, which read as off-pattern vs the app's other confirms.
          Use the standard modal layout: title + body LEFT-aligned, action buttons
          in a RIGHT-aligned footer row (Отмена secondary + danger action on the
          right). Same copy/behavior, just the alignment. */}
      <div className="space-y-[var(--space-4)]">
        <h3
          className="text-base font-semibold text-left"
          style={{
            color:
              variant === "danger"
                ? "var(--color-danger-fg)"
                : "var(--color-warning-fg)",
          }}
        >
          {title}
        </h3>
        <p
          className="text-sm text-left leading-relaxed text-[var(--color-text-secondary)] whitespace-pre-line"
        >
          {message}
        </p>
        <div className="flex gap-[var(--space-3)] items-center justify-end">
          <Button
            variant="ghost"
            onClick={onCancel}
            disabled={loading}
            size="sm"
          >
            {resolvedCancelText}
          </Button>
          <Button
            variant={variant === "danger" ? "danger" : "primary"}
            onClick={onConfirm}
            loading={loading}
            disabled={loading || confirmDisabled}
            size="sm"
          >
            {resolvedConfirmText}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
