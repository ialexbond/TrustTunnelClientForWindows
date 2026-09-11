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
  type FocusEvent as ReactFocusEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  canObservePointer,
  isFocusBeingPlaced,
  isFocusUserInitiated,
  usePointerPresence,
  type PresenceSignal,
} from "../hooks/usePointerPresence";

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
  // Two INDEPENDENT claims on visibility, deliberately not one `show` flag (G-32-16). Collapsing
  // them into one boolean is what forced the first fix to choose between dropping a legitimate
  // keyboard tip and keeping an orphaned hover tip.
  //
  // The claims differ in WHAT expires them, not in whether they can (round three). The keyboard
  // claim outlives the pointer's own `hover-recheck` — «the cursor is no longer on this element»
  // says nothing about the focus — and nothing else. Every other signal is about the window itself
  // going away or coming back, and a tip raised by a Tab before that no longer belongs on screen;
  // native Windows agrees, an alt-tab there keeps the focus ring and drops the tip. Round two had
  // this claim expire for NOTHING, on the reasoning that a window regaining focus restores the
  // focused element and the tip belongs with it. The real log refuted the premise, and the report
  // refuted the result — «теперь оно вообще не пропадает».
  const [hoverShow, setHoverShow] = useState(false);
  const [focusShow, setFocusShow] = useState(false);
  const show = hoverShow || focusShow;

  const triggerRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // CC-7: a generated id ties the tooltip content (role="tooltip") to the
  // focusable child via aria-describedby, so screen readers announce the tip
  // when the child receives keyboard focus.
  const tooltipId = useId();

  // A pointer press (mouse click / tap) also focuses the child, which would pop the
  // tooltip ON CLICK — annoying, and pointer users already get it via hover. Track the
  // pointer press so the focus it triggers does NOT show the tooltip; keyboard focus
  // still does. A click also dismisses any hover-shown tip (the action was taken).
  const pointerFocusRef = useRef(false);

  // G-32-16: the tip is on screen only while the pointer is ATTESTED to be on the trigger, and the
  // attestation expires the moment the document loses the ability to see the pointer. The FIRST
  // version of this hook took that from `blur` / `focus` / `visibilitychange`; it shipped as build
  // t3ykm8 and the tooltip still hung on a real machine, which proved his close-to-tray path emits none of
  // them here. The rule now rests on the gap between two painted frames, which no window manager
  // has to cooperate to produce — see usePointerPresence.
  //
  // `triggerRef` is handed over so the loop can also ask the DOM directly whether the pointer is
  // still on this wrapper. That is a cross-check, not the mechanism: it calibrates itself on the
  // first frame and stays silent wherever `:hover` cannot answer. jsdom does answer it for an
  // element that received a dispatched mouseEnter (measured), so the rule is live in this file's
  // tests rather than switched off in them — the failure mode of the fix this one replaces.
  //
  // The expiry callback takes DOWN what is showing and deliberately does NOT also cancel a pending
  // reveal timer. Cancelling here as well would make the precondition below unreachable — a guard
  // that can never fail, which is the shape of check this phase keeps finding. Leaving the timer to
  // run and be refused by the precondition is what makes that precondition the mechanism rather
  // than a second copy of it, and it holds for any future path that drops presence without coming
  // through here. A refused timer touches no state, so nothing leaks.
  const { presentRef, enter, leave } = usePointerPresence(
    useCallback((signal: PresenceSignal) => {
      setHoverShow(false);
      // Defence in depth, and deliberately NOT the mechanism. On the path these signals
      // arrive BEFORE the returning focus does, so on their own they would take the tip down a
      // moment before the focus put it back up — which is exactly what round one shipped. What
      // decides the case is the refusal in `handleFocus`; this is what makes sure that a claim
      // raised while the window was away cannot outlive the window's next departure either.
      if (signal !== "hover-recheck") setFocusShow(false);
    }, []),
    triggerRef,
  );

  const handleEnter = () => {
    if (disabled) return;
    enter();
    clearTimer();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      // Showing is a PRECONDITION, not a reaction: when the delay elapses, re-verify that the
      // pointer is still attested and that the document can still see it. Without this a timer
      // armed a moment before a hide would paint a tip into a window nobody is looking at, ready
      // to greet the user on the next show.
      if (!presentRef.current || !canObservePointer()) return;
      setHoverShow(true);
    }, delay);
  };

  const handleLeave = () => {
    leave();
    clearTimer();
    setHoverShow(false);
  };

  const handlePointerDown = () => {
    pointerFocusRef.current = true;
    clearTimer();
    // The action was taken — drop the tip but keep the attestation, since the pointer really is
    // still on the trigger. Nothing re-arms the timer, so it stays down until a genuine re-entry,
    // which is the behaviour this component has always had on click.
    setHoverShow(false);
  };

  // CC-7: keyboard parity with hover. Focus events bubble through the wrapper, so
  // onFocus/onBlur on the wrapper fire when the interactive child gains or loses focus.
  // Show immediately on KEYBOARD focus (no hover delay), but NOT when the focus came
  // from a pointer press (that path is covered by hover) — see handlePointerDown.
  const handleFocus = (e: ReactFocusEvent<HTMLDivElement>) => {
    if (disabled) return;
    // G-32-20, round four — asked FIRST, before the pointer-press bookkeeping.
    //
    // A dialog returns focus to the control that opened it when it closes; that is correct
    // accessibility behaviour and it stays. But closing a dialog is itself something the user did a
    // moment earlier — he clicked its close button — so the restored focus passes the «did the user
    // do anything recently» test below and the tip was painted with the pointer nowhere near. The
    // owner met this on «Показать конфиг» and asked, fairly, why this keeps being fixed one place at
    // a time.
    //
    // There is no proxy needed for this class: the app is the thing moving the focus, and it says so
    // (`placeFocus`).
    //
    // It sits above `pointerFocusRef` for readability, NOT for a reason that can be tested — the
    // browser focuses a pressed control synchronously with the `mousedown` that arms that ref, so
    // nothing of ours can run in between and no reachable sequence tells the two orders apart. Said
    // plainly because this file has twice carried a rationale nothing could falsify.
    if (isFocusBeingPlaced(e.target)) return;
    if (pointerFocusRef.current) {
      pointerFocusRef.current = false;
      return;
    }
    // G-32-16, round three — a focus event is not by itself a user action.
    //
    // The sequence: he presses «Закрыть» with the MOUSE, the window hides to the tray, he
    // clicks the tray icon, the window returns and Windows restores focus to the last focused
    // element — that same button. The DOM re-fires `focus` on it with no keypress and no pointer
    // movement anywhere, `pointerFocusRef` was consumed by the press's own focus long before, and so
    // this arrived looking exactly like a keyboard Tab. Round one raised the tip a moment after
    // correctly dismissing it; round two raised a keyboard claim that was by design immune to every
    // expiry rule, which is why he reported it as worse — «теперь оно вообще не пропадает».
    //
    // The question that separates a Tab from a window coming back is not WHEN the focus arrived but
    // whether the user did anything that could have caused it, and it is asked here, at show time.
    // A check made when the window LEFT would have to be delivered an event this machine has already
    // been measured not to send — the mistake both previous rounds made.
    if (!isFocusUserInitiated()) return;
    clearTimer();
    setFocusShow(true);
  };

  const handleBlur = () => {
    pointerFocusRef.current = false;
    clearTimer();
    setFocusShow(false);
  };

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && show) {
      setHoverShow(false);
      setFocusShow(false);
    }
  };

  // WR-07 fix: clear any pending show-timer on unmount so we don't call setShow
  // on an unmounted component. Symptom without this: user hovers trigger →
  // parent unmounts during the 400ms delay (e.g. VPN event rerender swaps the
  // titlebar button) → setTimeout fires → setState warning.
  useEffect(() => clearTimer, [clearTimer]);

  // The per-instance `tauri://blur` subscription that used to sit here is GONE (G-32-16). It hid
  // the tip on the way out and did nothing on the way back, which is where the user actually sees
  // the defect; it registered one IPC listener per mounted Tooltip; and it wrapped itself in a
  // try/catch that made it a silent no-op under vitest, so no test in the suite could ever have
  // failed because of the bug it was written to fix. Its job — and the return path it never
  // covered — now belongs to usePointerPresence, which subscribes to the same Tauri events once
  // for the whole app on top of the DOM signals that work everywhere, tests included.

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
