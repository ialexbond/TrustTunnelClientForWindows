import { useEffect, useCallback, useState, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
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
  /**
   * a11y dialog semantics (opt-in). When `role="dialog"` is supplied the content
   * box becomes a screen-reader dialog; pair with `ariaLabelledby` (the id of the
   * visible title) so the dialog gets an accessible name. Left undefined by
   * default so existing modals keep their current (role-less) DOM byte-stable —
   * only callers that opt in (e.g. UserModal, Users H-06) gain the role.
   */
  role?: "dialog";
  ariaLabelledby?: string;
  ariaModal?: boolean;
  /**
   * Opt-in canonical close button (A-1). When true, renders the standard
   * absolutely-positioned close `<X>` (lifted from CertModal) wired to
   * `onClose`. Default `false` so every un-migrated modal stays DOM-byte-stable
   * until it opts in — the 9-modal adoption happens in plan 09-23, not here.
   */
  showCloseButton?: boolean;
  /**
   * Disable the canonical close button (09-23). Some modals must block the close
   * `<X>` while an operation is in flight — e.g. UserConfigModal disables it
   * during an SSH download (a half-finished config export must not be dismissable),
   * UserModal disables it while submitting. Mirrors the hand-rolled buttons'
   * `disabled` + `disabled:opacity-[var(--opacity-disabled)]` behaviour so the
   * canonical button is a faithful drop-in for those surfaces. Default `false`.
   */
  closeButtonDisabled?: boolean;
  /**
   * Optional test id for the canonical close button (09-23). Lets a migrated
   * modal keep a stable `data-testid` its existing suite queries (e.g. UserModal's
   * `user-modal-close`) without re-querying by SVG/class. Default `undefined`.
   */
  closeButtonTestId?: string;
  /**
   * Optional header slot rendered above `children` (and above `title` when both
   * are given). Lets a modal supply a richer header (icon + heading) while
   * sharing the canonical close button. Undefined = nothing extra rendered.
   */
  header?: ReactNode;
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
  role,
  ariaLabelledby,
  ariaModal,
  showCloseButton = false,
  closeButtonDisabled = false,
  closeButtonTestId,
  header,
}: ModalProps) {
  const { t } = useTranslation();
  const isVisible = isOpen ?? open ?? false;
  const [mounted, setMounted] = useState(false);
  const [animating, setAnimating] = useState(false);
  // Content box ref — the focus-trap boundary (A11Y-01 / A4). Tab/Shift+Tab
  // cycling and initial-focus are scoped to this element's focusables.
  const contentRef = useRef<HTMLDivElement>(null);
  // The element that had focus before the modal opened. Focus is returned here
  // on close so keyboard users land back on the trigger (focus-restore).
  const restoreFocusRef = useRef<HTMLElement | null>(null);

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

  // Focus management (A11Y-01 / A4) — built inline (~30 lines) instead of
  // adding focus-trap-react: single-layer modal, no nested-trap need, and we
  // avoid a new supply-chain dependency for a VPN app (threat T-09-05).
  //
  // Split into two effects on PURPOSE:
  //   • initial-focus is keyed on `mounted` so it runs once the content box is
  //     actually in the DOM and its first focusable is queryable. Focus is
  //     independent of the enter opacity animation, so running before
  //     `animating` flips is fine.
  //   • focus-restore is keyed on `isVisible` so focus returns to the trigger
  //     the instant the modal is asked to close — NOT 200ms later when the
  //     exit animation finishes and `mounted` flips false. (Keying restore on
  //     `mounted` would leave focus orphaned on a fading-out dialog.)
  //
  // jsdom note: `.focus()` is supported in jsdom but `scrollIntoView` is not —
  // we never call scrollIntoView here, and tests assert via document.activeElement.
  useEffect(() => {
    if (!mounted) return;
    // Capture the element to return focus to (the trigger) before we steal focus.
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const box = contentRef.current;
    const FOCUSABLE =
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const first = box?.querySelector<HTMLElement>(FOCUSABLE);
    // Fall back to the content box itself (tabIndex=-1) when there are no
    // focusable children, so focus still enters the dialog.
    (first ?? box)?.focus();
  }, [mounted]);

  useEffect(() => {
    if (isVisible) return;
    // Modal asked to close → return focus to the trigger immediately (don't
    // wait for the 200ms exit animation). No-op on the initial closed render
    // because restoreFocusRef is still null until a real open captured it.
    restoreFocusRef.current?.focus();
  }, [isVisible]);

  // Tab focus-trap — wrap last→first and first→last so keyboard focus can never
  // leave the dialog into the page behind it. Scoped to the content box.
  const handleTrapTab = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const box = contentRef.current;
    if (!box) return;
    const FOCUSABLE =
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusables = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (focusables.length === 0) return;
    const firstEl = focusables[0];
    const lastEl = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === firstEl) {
        e.preventDefault();
        lastEl.focus();
      }
    } else {
      if (active === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    }
  }, []);

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
        ref={contentRef}
        // tabIndex=-1 makes the box programmatically focusable so initial-focus
        // can land here when the dialog has no focusable children (fallback);
        // it stays out of the Tab sequence.
        tabIndex={-1}
        onKeyDown={handleTrapTab}
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
          // `relative` only when the absolutely-positioned close button is on,
          // so default-off modals keep their exact current class string.
          showCloseButton && "relative",
          className,
        )}
        // a11y: opt-in dialog role + accessible name (Users H-06). Undefined for
        // callers that don't pass them, so non-opted modals stay DOM-byte-stable.
        role={role}
        aria-labelledby={ariaLabelledby}
        aria-modal={ariaModal}
        // stopPropagation on click inside the modal so clicks inside never
        // bubble to the backdrop even when the gesture is clean.
        onClick={(e) => e.stopPropagation()}
      >
        {/* Canonical close button (A-1) — lifted verbatim from CertModal's
            hand-rolled markup so the 9-modal adoption (09-23) gets one source
            of truth. Off by default → un-migrated modals render nothing here. */}
        {showCloseButton && (
          <button
            type="button"
            aria-label={t("buttons.close")}
            onClick={onClose}
            disabled={closeButtonDisabled}
            data-testid={closeButtonTestId}
            className={cn(
              "absolute top-3 right-3 p-1 rounded",
              "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]",
              "focus-visible:shadow-[var(--focus-ring)] outline-none",
              "transition-colors",
              // Mirror the hand-rolled buttons' disabled styling so modals that
              // block close during an in-flight operation (UserConfigModal
              // download, UserModal submit) keep their exact look (09-23).
              "disabled:opacity-[var(--opacity-disabled)] disabled:cursor-not-allowed disabled:hover:text-[var(--color-text-muted)]",
            )}
          >
            <X className="w-4 h-4" />
          </button>
        )}
        {header}
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
