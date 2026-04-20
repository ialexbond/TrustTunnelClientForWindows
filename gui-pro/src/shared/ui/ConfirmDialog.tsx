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
      <div className="space-y-[var(--space-4)]">
        <h3
          className="text-base font-semibold text-center"
          style={{
            color:
              variant === "danger"
                ? "var(--color-danger-500)"
                : "var(--color-warning-500)",
          }}
        >
          {title}
        </h3>
        <p
          className="text-sm text-center leading-relaxed text-[var(--color-text-secondary)] whitespace-pre-line"
        >
          {message}
        </p>
        <div className="flex gap-[var(--space-3)] items-center justify-center">
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
            disabled={loading}
            size="sm"
          >
            {resolvedConfirmText}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
