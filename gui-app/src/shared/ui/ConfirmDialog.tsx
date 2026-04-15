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
}

export function ConfirmDialog({
  isOpen,
  open,
  title,
  message,
  confirmText = "Confirm",
  confirmLabel,
  cancelText = "Cancel",
  cancelLabel,
  variant = "danger",
  onConfirm,
  onCancel,
  loading,
}: ConfirmDialogProps) {
  const isVisible = isOpen ?? open ?? false;
  const resolvedConfirmText = confirmLabel ?? confirmText;
  const resolvedCancelText = cancelLabel ?? cancelText;

  return (
    <Modal
      isOpen={isVisible}
      onClose={loading ? undefined : onCancel}
      closeOnBackdrop={!loading}
      size="sm"
    >
      <div className="space-y-[var(--space-4)]">
        <h3
          className="text-base font-[var(--font-weight-semibold)] text-center"
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
          className="text-xs text-center leading-relaxed"
          style={{ color: "var(--color-text-secondary)" }}
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
