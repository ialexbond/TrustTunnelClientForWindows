import { useEffect, useCallback, useState, useRef, type ReactNode } from "react";
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

  // FIX-J: a naïve `onClick` backdrop-close fires when the mouseup happens on
  // the backdrop — including the case where the user started a text-drag
  // INSIDE the modal, moved the mouse outside, and released the button.
  // Result: a drag-select near a field edge accidentally closes the modal
  // and erases whatever the user was typing. Modern desktop apps close
  // only when the WHOLE mouse gesture happens on the backdrop, so we track
  // the mousedown target and compare against the mouseup target.
  return (
    <ModalBackdrop
      animating={animating}
      closeOnBackdrop={closeOnBackdrop}
      onClose={onClose}
    >
      <div
        className={cn(
          "w-full", sizeClasses[size], "mx-4",
          "bg-[var(--color-bg-surface)]",
          "border border-[var(--color-border)]",
          "rounded-[var(--radius-lg)]",
          "shadow-[var(--shadow-lg)]",
          "p-[var(--space-6)]",
          "max-h-[calc(100vh-var(--space-8))] overflow-y-auto scroll-visible",
          "transition-all duration-200 ease-out",
          animating ? "opacity-100 scale-100 translate-y-0" : "opacity-0 scale-95 translate-y-2",
          className,
        )}
        // stopPropagation on click inside the modal so clicks inside never
        // bubble to the backdrop even when the gesture is clean.
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <h2
            className="text-lg font-semibold mb-[var(--space-4)]"
            style={{ color: "var(--color-text-primary)" }}
          >
            {title}
          </h2>
        )}
        {children}
      </div>
    </ModalBackdrop>
  );
}

interface ModalBackdropProps {
  animating: boolean;
  closeOnBackdrop: boolean;
  onClose?: () => void;
  children: ReactNode;
}

function ModalBackdrop({
  animating,
  closeOnBackdrop,
  onClose,
  children,
}: ModalBackdropProps) {
  // Tracks where a mouse gesture started. Close fires only when BOTH the
  // mousedown AND mouseup land on this backdrop element (see FIX-J above).
  const mouseDownOnBackdropRef = useRef(false);

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    mouseDownOnBackdropRef.current = e.target === e.currentTarget;
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLDivElement>) => {
    const started = mouseDownOnBackdropRef.current;
    mouseDownOnBackdropRef.current = false;
    if (!started) return;
    if (e.target !== e.currentTarget) return;
    if (!closeOnBackdrop || !onClose) return;
    onClose();
  };

  // Backdrop SPEC (DO NOT REMOVE):
  //   • `backdrop-blur-sm` is part of the design system's Modal contract —
  //     it gives the user a clear visual "something modal is active" cue
  //     without needing to dim the entire window. See memory/v3/design-system
  //     / known-issues.md for the Modal backdrop invariant.
  //   • `bg-[var(--color-glass-bg)]` is the tinted layer sampled by the blur
  //     so content behind stays legible but softly de-emphasized.
  //   • Previously (FIX-S) I removed both. That was wrong: the blur is
  //     load-bearing UX — user's mental model of "dialog is foreground" breaks
  //     without it. It has been restored.
  return createPortal(
    <div
      className={cn(
        "fixed inset-0 flex items-center justify-center z-[var(--z-modal)] backdrop-blur-sm",
        "transition-opacity duration-200 ease-out",
        animating ? "opacity-100 bg-[var(--color-glass-bg)]" : "opacity-0 bg-transparent",
      )}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
    >
      {children}
    </div>,
    document.body
  );
}
