import { useState, useRef, useCallback, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/cn";

type TooltipPosition = "top" | "bottom" | "left" | "right";

interface TooltipProps {
  text: string;
  children: ReactNode;
  position?: TooltipPosition;
  maxWidth?: number;
  delay?: number;
}

export function Tooltip({ text, children, position = "top", maxWidth = 224, delay = 400 }: TooltipProps) {
  const [show, setShow] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleEnter = () => {
    timerRef.current = setTimeout(() => setShow(true), delay);
  };

  const handleLeave = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setShow(false);
  };

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

      const pos = fits[position] ? position : fits[flip[position]] ? flip[position] : position;

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

  return (
    <div
      className="relative inline-flex"
      ref={triggerRef}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      {children}
      {show &&
        createPortal(
          <div
            ref={positionTip}
            className="fixed z-[var(--z-dropdown)] px-[var(--space-2)] py-1 rounded-[var(--radius-sm)] shadow-[var(--shadow-md)] pointer-events-none animate-[fadeIn_150ms_ease-out]"
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
