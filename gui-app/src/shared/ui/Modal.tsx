import { useEffect, useCallback, useState, type ReactNode } from "react";
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

/**
 * Modal primitive — lifecycle contract.
 *
 * Плавный open/close обеспечивается ДВУМЯ state'ами:
 *   - `mounted`: в DOM / не в DOM (React unmount)
 *   - `animating`: визуально видимо / скрыто (opacity + scale + translateY transition 200ms ease-out)
 *
 * Жизненный цикл:
 *   1. isVisible=false → isVisible=true: `mounted=true` сразу → двойной RAF → `animating=true` → enter 200ms
 *   2. isVisible=true → isVisible=false: `animating=false` сразу → exit 200ms → setTimeout(200) → `mounted=false`
 *
 * ⚠ ПРАВИЛО ДЛЯ CALLER'ов (parent-компонентов):
 * **НИКОГДА не делайте `if (!isOpen) return null` до `<Modal>`** — это отключит
 * exit-анимацию, потому что React unmount'ит всё дерево раньше чем Modal
 * успеет проиграть свои 200ms.
 *
 * ❌ НЕ ТАК:
 *   function MyModal({ isOpen, onClose }) {
 *     if (!isOpen) return null;       // 🐛 Модалка закрывается МГНОВЕННО
 *     return <Modal isOpen={isOpen} onClose={onClose}>...</Modal>;
 *   }
 *
 * ✓ ПРАВИЛЬНО:
 *   function MyModal({ isOpen, onClose }) {
 *     return <Modal isOpen={isOpen} onClose={onClose}>...</Modal>;
 *   }
 *
 * Modal САМ управляет visibility + mount/unmount timing. Parent лишь передаёт
 * `isOpen` boolean и `onClose` callback.
 *
 * Если содержимое Modal зависит от async-state (fetch'ит данные при open), не
 * очищайте state в useEffect на `!isOpen` — используйте `setTimeout(200)` чтобы
 * cleanup прошёл ПОСЛЕ exit-анимации (см. UserConfigModal.tsx как эталон).
 *
 * Этот anti-pattern задокументирован в:
 *   - memory/v3/design-system/known-issues.md #10
 *   - memory/v3/design-system/animations.md (Modal section)
 *   - CLAUDE.md Gotchas
 */
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
  const [mounted, setMounted] = useState(false);
  const [animating, setAnimating] = useState(false);

  useEffect(() => {
    if (isVisible) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- modal must mount before exit-animation cleanup so backdrop is hit-testable on first paint
      setMounted(true);
      requestAnimationFrame(() => requestAnimationFrame(() => setAnimating(true)));
    } else {
      setAnimating(false);
      const t = setTimeout(() => setMounted(false), 200);
      return () => clearTimeout(t);
    }
  }, [isVisible]);

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

  if (!mounted) return null;

  return createPortal(
    <div
      className={cn(
        "fixed inset-0 flex items-center justify-center z-[var(--z-modal)] backdrop-blur-sm",
        "transition-opacity duration-200 ease-out",
        animating ? "opacity-100 bg-[var(--color-glass-bg)]" : "opacity-0 bg-transparent",
      )}
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
          "transition-all duration-200 ease-out",
          animating ? "opacity-100 scale-100 translate-y-0" : "opacity-0 scale-95 translate-y-2",
          className,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <h2
            className="text-lg font-[var(--font-weight-semibold)] mb-[var(--space-4)]"
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
