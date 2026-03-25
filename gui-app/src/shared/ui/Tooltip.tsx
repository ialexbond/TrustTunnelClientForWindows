import { useState, useRef, useCallback, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface TooltipProps {
  text: string;
  children: ReactNode;
  maxWidth?: number;
  delay?: number;
}

export function Tooltip({ text, children, maxWidth = 224, delay = 400 }: TooltipProps) {
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
      const pad = 8;

      let left = trRect.left + trRect.width / 2 - tipRect.width / 2;
      if (left < pad) left = pad;
      if (left + tipRect.width > window.innerWidth - pad)
        left = window.innerWidth - pad - tipRect.width;

      const above = trRect.top - tipRect.height - 6 >= pad;
      const top = above ? trRect.top - tipRect.height - 6 : trRect.bottom + 6;

      tip.style.left = left + "px";
      tip.style.top = top + "px";
      tip.style.visibility = "visible";
    },
    []
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
            className="fixed z-[9999] px-2.5 py-2 rounded-[var(--radius-md)] shadow-lg pointer-events-none"
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
            <p className="text-[10px] leading-relaxed whitespace-normal">{text}</p>
          </div>,
          document.body
        )}
    </div>
  );
}
