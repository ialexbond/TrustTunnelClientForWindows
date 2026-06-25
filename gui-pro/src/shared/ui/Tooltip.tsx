import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useId,
  cloneElement,
  isValidElement,
  type ReactNode,
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";

type TooltipPosition = "top" | "bottom" | "left" | "right";

interface TooltipProps {
  text: string;
  children: ReactNode;
  position?: TooltipPosition;
  maxWidth?: number;
  delay?: number;
  /** Extra classes for the trigger WRAPPER — REPLACES the default `inline-flex` display so a
   *  truncation host can pass e.g. `flex min-w-0 max-w-full` to shrink inside a flex/grid
   *  parent and let a `truncate` child clip. When omitted the wrapper stays `inline-flex`. */
  className?: string;
  /** When true the tip never shows (DOM stays identical) — used to gate a tooltip on a
   *  measured condition (e.g. only-when-truncated) without changing the wrapper structure. */
  disabled?: boolean;
}

export function Tooltip({ text, children, position = "bottom", maxWidth = 224, delay = 400, className, disabled = false }: TooltipProps) {
  const [show, setShow] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // CC-7: a generated id ties the tooltip content (role="tooltip") to the
  // focusable child via aria-describedby, so screen readers announce the tip
  // when the child receives keyboard focus.
  const tooltipId = useId();

  // A pointer press (mouse click / tap) also focuses the child, which would pop the
  // tooltip ON CLICK — annoying, and pointer users already get it via hover. Track the
  // pointer press so the focus it triggers does NOT show the tooltip; keyboard focus
  // still does. A click also dismisses any hover-shown tip (the action was taken).
  const pointerFocusRef = useRef(false);

  const handleEnter = () => {
    if (disabled) return;
    timerRef.current = setTimeout(() => setShow(true), delay);
  };

  const handleLeave = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setShow(false);
  };

  const handlePointerDown = () => {
    pointerFocusRef.current = true;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setShow(false);
  };

  // CC-7: keyboard parity with hover. Focus events bubble through the wrapper, so
  // onFocus/onBlur on the wrapper fire when the interactive child gains or loses focus.
  // Show immediately on KEYBOARD focus (no hover delay), but NOT when the focus came
  // from a pointer press (that path is covered by hover) — see handlePointerDown.
  const handleFocus = () => {
    if (disabled) return;
    if (pointerFocusRef.current) {
      pointerFocusRef.current = false;
      return;
    }
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setShow(true);
  };

  const handleBlur = () => {
    pointerFocusRef.current = false;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setShow(false);
  };

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && show) {
      setShow(false);
    }
  };

  // WR-07 fix: clear any pending show-timer on unmount so we don't call setShow
  // on an unmounted component. Symptom without this: user hovers trigger →
  // parent unmounts during the 400ms delay (e.g. VPN event rerender swaps the
  // titlebar button) → setTimeout fires → setState warning.
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  // Hide tooltip при blur окна (tray-click скрывает window через hide()).
  // Без этого фикса: пользователь hover над кнопкой → tooltip показан →
  // tray-click скрывает окно → при show tooltip остаётся "висеть" поверх
  // контента (потому что mouseLeave не стреляет когда окно просто hide).
  // Парный symptom к WindowControls hover-state stuck.
  //
  // **Graceful degradation в test environment:** vitest не имеет
  // @tauri-apps/api/window runtime metadata → `getCurrentWindow()` throws
  // "Cannot read properties of undefined (reading 'metadata')". Оборачиваем
  // в try/catch чтобы tooltip работал в unit-тестах без Tauri context.
  // Test scope жертвует blur-reset но компонент рендерится корректно.
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    let cancelled = false;

    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        const unlisten = await win.listen("tauri://blur", () => {
          if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
          }
          setShow(false);
        });
        if (cancelled) {
          unlisten();
        } else {
          unlistenFn = unlisten;
        }
      } catch {
        // Tauri API недоступен (vitest / Storybook / SSR) — silent no-op.
      }
    })();

    return () => {
      cancelled = true;
      if (unlistenFn) unlistenFn();
    };
  }, []);

  const positionTip = useCallback(
    (tip: HTMLDivElement | null) => {
      const tr = triggerRef.current;
      if (!tip || !tr) return;

      const trRect = tr.getBoundingClientRect();
      const tipRect = tip.getBoundingClientRect();
      const gap = 6;
      const pad = 8;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      const fits = {
        top: trRect.top - tipRect.height - gap >= pad,
        bottom: trRect.bottom + tipRect.height + gap <= vh - pad,
        left: trRect.left - tipRect.width - gap >= pad,
        right: trRect.right + tipRect.width + gap <= vw - pad,
      };

      const flip: Record<TooltipPosition, TooltipPosition> = {
        top: "bottom", bottom: "top", left: "right", right: "left",
      };

      // WR-08 fix: when neither the requested direction nor its flip fits (e.g.
      // tiny webview height with button at top-right), pick whichever axis side
      // has more available space instead of falling back to the requested pos
      // (which would render off-screen, then get clamped awkwardly).
      let pos: TooltipPosition;
      if (fits[position]) {
        pos = position;
      } else if (fits[flip[position]]) {
        pos = flip[position];
      } else if (position === "top" || position === "bottom") {
        pos = vh - trRect.bottom > trRect.top ? "bottom" : "top";
      } else {
        pos = vw - trRect.right > trRect.left ? "right" : "left";
      }

      let left: number, top: number;
      switch (pos) {
        case "bottom":
          left = trRect.left + trRect.width / 2 - tipRect.width / 2;
          top = trRect.bottom + gap;
          break;
        case "left":
          left = trRect.left - tipRect.width - gap;
          top = trRect.top + trRect.height / 2 - tipRect.height / 2;
          break;
        case "right":
          left = trRect.right + gap;
          top = trRect.top + trRect.height / 2 - tipRect.height / 2;
          break;
        default:
          left = trRect.left + trRect.width / 2 - tipRect.width / 2;
          top = trRect.top - tipRect.height - gap;
          break;
      }

      // Clamp to viewport edges
      left = Math.max(pad, Math.min(left, vw - pad - tipRect.width));
      top = Math.max(pad, Math.min(top, vh - pad - tipRect.height));

      tip.style.left = left + "px";
      tip.style.top = top + "px";
      tip.style.visibility = "visible";
    },
    [position]
  );

  // CC-7: forward aria-describedby to the interactive child (e.g. IconButton's
  // <button>) rather than the wrapper div, which is not itself describable.
  // Clone only when the child is a valid element; otherwise render as-is so
  // plain-text/fragment children still work.
  const describedChild = isValidElement(children)
    ? cloneElement(children as ReactElement<{ "aria-describedby"?: string }>, {
        "aria-describedby": tooltipId,
      })
    : children;

  return (
    <div
      className={`relative ${className ?? "inline-flex"}`}
      ref={triggerRef}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      onMouseDown={handlePointerDown}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    >
      {describedChild}
      {show &&
        createPortal(
          <div
            ref={positionTip}
            id={tooltipId}
            role="tooltip"
            className="fixed z-[var(--z-tooltip)] px-[var(--space-2)] py-1 rounded-[var(--radius-sm)] shadow-[var(--shadow-md)] pointer-events-none animate-[fadeIn_var(--transition-fast)_var(--ease-out)]"
            style={{
              visibility: "hidden",
              maxWidth,
              backgroundColor: "var(--color-bg-elevated)",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: "var(--color-border)",
              color: "var(--color-text-secondary)",
            }}
          >
            <p className="text-xs leading-relaxed whitespace-normal">{text}</p>
          </div>,
          document.body
        )}
    </div>
  );
}
