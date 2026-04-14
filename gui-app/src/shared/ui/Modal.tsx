import { useEffect, useCallback, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/cn";

type ModalSize = "sm" | "md" | "lg";

interface ModalProps {
  isOpen?: boolean;
  /** @deprecated Use isOpen */
  open?: boolean;
  onClose?: () => void;
  title?: string;
  size?: ModalSize;
  children: ReactNode;
  className?: string;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
}

const sizeClasses: Record<ModalSize, string> = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
};

export function Modal({
  isOpen,
  open,
  onClose,
  title,
  size = "md",
  children,
  className = "",
  closeOnBackdrop = true,
  closeOnEscape = true,
}: ModalProps) {
  const isVisible = isOpen ?? open ?? false;

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (closeOnEscape && e.key === "Escape" && onClose) onClose();
    },
    [closeOnEscape, onClose]
  );

  useEffect(() => {
    if (!isVisible) return;
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isVisible, handleKeyDown]);

  if (!isVisible) return null;

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center z-[var(--z-modal)] bg-[var(--color-glass-bg)] backdrop-blur-sm"
      onClick={closeOnBackdrop && onClose ? onClose : undefined}
    >
      <div
        className={cn(
          "w-full", sizeClasses[size], "mx-4",
          "bg-[var(--color-bg-surface)]",
          "border border-[var(--color-border)]",
          "rounded-[var(--radius-lg)]",
          "shadow-[var(--shadow-lg)]",
          "p-[var(--space-6)]",
          "transition-all duration-[var(--transition-normal)]",
          className,
        )}
        style={{ transitionTimingFunction: "var(--ease-in-out)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <h2
            className="text-[var(--font-size-lg)] font-[var(--font-weight-semibold)] mb-[var(--space-4)]"
            style={{ color: "var(--color-text-primary)" }}
          >
            {title}
          </h2>
        )}
        {children}
      </div>
    </div>,
    document.body
  );
}
