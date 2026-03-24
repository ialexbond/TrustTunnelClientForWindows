import { useEffect, useCallback, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface ModalProps {
  open: boolean;
  onClose?: () => void;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  children: ReactNode;
}

export function Modal({
  open,
  onClose,
  closeOnBackdrop = true,
  closeOnEscape = true,
  children,
}: ModalProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (closeOnEscape && e.key === "Escape" && onClose) onClose();
    },
    [closeOnEscape, onClose]
  );

  useEffect(() => {
    if (!open) return;
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, handleKeyDown]);

  if (!open) return null;

  return createPortal(
    <div
      className="flex items-center justify-center"
      style={{
        position: "fixed",
        top: "-50px",
        left: "-50px",
        right: "-50px",
        bottom: "-50px",
        zIndex: 9999,
        backgroundColor: "rgba(0,0,0,0.4)",
        backdropFilter: "blur(6px)",
      }}
      onClick={closeOnBackdrop && onClose ? onClose : undefined}
    >
      <div onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>,
    document.body
  );
}
