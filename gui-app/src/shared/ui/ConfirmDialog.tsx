import { Modal } from "./Modal";
import { Button } from "./Button";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "danger" | "warning";
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Подтвердить",
  cancelLabel = "Отмена",
  variant = "danger",
  onConfirm,
  onCancel,
  loading,
}: ConfirmDialogProps) {
  return (
    <Modal open={open} onClose={loading ? undefined : onCancel} closeOnBackdrop={!loading}>
      <div
        className="max-w-sm w-full mx-4 p-6 rounded-2xl space-y-4 shadow-2xl"
        style={{ backgroundColor: "var(--color-bg-elevated)" }}
      >
        <h3
          className="text-base font-semibold text-center"
          style={{ color: variant === "danger" ? "var(--color-danger-500)" : "var(--color-warning-500)" }}
        >
          {title}
        </h3>
        <p className="text-xs text-center leading-relaxed" style={{ color: "var(--color-text-secondary)" }}>
          {message}
        </p>
        <div className="flex gap-3 items-center justify-center">
          <Button
            variant="ghost"
            onClick={onCancel}
            disabled={loading}
            size="sm"
          >
            {cancelLabel}
          </Button>
          <Button
            variant={variant === "danger" ? "danger" : "warning"}
            onClick={onConfirm}
            loading={loading}
            disabled={loading}
            size="sm"
            style={{ whiteSpace: "nowrap" }}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
