import { useEffect, useRef, useState, useCallback } from "react";
import { CheckCircle2, AlertTriangle, X, Copy } from "lucide-react";
import { cn } from "../lib/cn";

type SnackMessage = string | { text: string; type?: "success" | "error" };

interface SnackItem {
  id: number;
  text: string;
  type: "success" | "error";
  phase: "enter" | "visible" | "exit";
}

let _nextId = 0;

interface SnackBarProps {
  messages: SnackMessage[];
  onShown: () => void;
  duration?: number;
}

function normalize(msg: SnackMessage): { text: string; type: "success" | "error" } {
  if (typeof msg === "string") return { text: msg, type: "success" };
  return { text: msg.text, type: msg.type ?? "success" };
}

/** Sub-component: renders a single error snackbar item with truncation-aware Copy button */
function ErrorSnackText({ text, onCopy }: { text: string; onCopy: () => void }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    setTruncated(el.scrollHeight > el.clientHeight);
  }, [text]);

  return (
    <>
      <span ref={textRef} className="line-clamp-3">
        {text}
      </span>
      {truncated && (
        <button
          className="shrink-0 p-0.5 rounded hover:bg-[var(--color-bg-hover)] transition-colors"
          title="Copy"
          onClick={onCopy}
        >
          <Copy className="w-3.5 h-3.5" style={{ color: "var(--color-text-secondary)" }} />
        </button>
      )}
    </>
  );
}

export function SnackBar({ messages, onShown, duration = 3000 }: SnackBarProps) {
  const [items, setItems] = useState<SnackItem[]>([]);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const seenCount = useRef(0);

  const dismiss = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setItems(prev => prev.map(s => (s.id === id ? { ...s, phase: "exit" } : s)));
    setTimeout(() => {
      setItems(prev => prev.filter(s => s.id !== id));
    }, 400);
  }, []);

  const scheduleDismiss = useCallback(
    (id: number, customDuration?: number) => {
      const old = timersRef.current.get(id);
      if (old) clearTimeout(old);
      const t = setTimeout(() => {
        timersRef.current.delete(id);
        dismiss(id);
      }, customDuration ?? duration);
      timersRef.current.set(id, t);
    },
    [duration, dismiss],
  );

  useEffect(() => {
    const newCount = messages.length;
    if (newCount <= 0 || seenCount.current >= newCount) return;

    for (let i = seenCount.current; i < newCount; i++) {
      const { text, type } = normalize(messages[i]);

      // Helper: schedule the deferred removal of an item that has just been
      // flagged exit, mirroring the dismiss() teardown (clear its dismiss timer,
      // then drop it from the list after the 400ms exit animation).
      const scheduleRemoval = (idToRemove: number) => {
        const timer = timersRef.current.get(idToRemove);
        if (timer) {
          clearTimeout(timer);
          timersRef.current.delete(idToRemove);
        }
        setTimeout(() => {
          setItems(p => p.filter(x => x.id !== idToRemove));
        }, 400);
      };

      // Pre-allocate the id for a potential NEW item. We may not use it if the
      // message turns out to be a duplicate (decided inside the updater below),
      // but we need it captured for the enter->visible / dismiss schedules.
      const id = ++_nextId;
      // Did the updater decide this was a duplicate of a still-visible item?
      // Read back synchronously after setItems so we know whether to schedule
      // the enter/dismiss timers for `id` or just reset the existing one.
      let duplicateOfId: number | null = null;

      // UAT-F08: a single setItems updater owns BOTH replace-not-stack and
      // dedup so the decision reads `prev` (never the stale `items` closure,
      // which lagged across the for-loop and could mis-dedup a batch).
      setItems(prev => {
        // Dedup (F08 part 4): identical text+type still showing → no new item;
        // the caller resets that item's dismiss timer instead.
        const dup = prev.find(
          s => s.text === text && s.type === type && s.phase !== "exit",
        );
        if (dup) {
          duplicateOfId = dup.id;
          return prev;
        }

        // Replace-not-stack (F08 part 3): a NEW success replaces the current
        // visible snackbar — mark every still-visible non-exit item as exit so
        // at most one snackbar is on screen. (Errors arriving keep their own
        // path below; here success supersedes both prior successes and errors,
        // preserving the original "success dismisses errors" behavior.)
        let next = prev;
        if (type === "success") {
          next = prev.map(s =>
            s.phase !== "exit" ? { ...s, phase: "exit" as const } : s,
          );
          next.forEach(s => {
            if (s.phase === "exit") scheduleRemoval(s.id);
          });
        }

        return [...next, { id, text, type, phase: "enter" }];
      });

      if (duplicateOfId !== null) {
        // Duplicate: just reset the dismiss timer (keep prior behavior) and do
        // not append. _nextId was bumped but the unused id is harmless.
        scheduleDismiss(duplicateOfId, type === "error" ? 5000 : undefined);
        onShown();
        seenCount.current = i + 1;
        continue;
      }

      // Enter -> visible
      setTimeout(() => {
        setItems(prev =>
          prev.map(s => (s.id === id ? { ...s, phase: "visible" } : s)),
        );
      }, 30);

      // Auto-dismiss: success=3s, error=5s
      scheduleDismiss(id, type === "error" ? 5000 : undefined);

      onShown();
    }

    seenCount.current = newCount;
    // No exhaustive-deps suppression needed any more: the dedup/replace
    // decision now reads `prev` inside the setItems updater (UAT-F08), so the
    // effect no longer closes over the stale `items` state — every referenced
    // value (messages, duration, onShown, scheduleDismiss) is in the dep array.
  }, [messages, duration, onShown, scheduleDismiss]);

  // Reset counter when parent clears the queue
  useEffect(() => {
    if (messages.length === 0) {
      seenCount.current = 0;
    }
  }, [messages.length]);

  // Cleanup all timers on unmount
  useEffect(() => {
    const map = timersRef.current;
    return () => {
      map.forEach((t) => clearTimeout(t));
      map.clear();
    };
  }, []);

  if (items.length === 0) return null;

  return (
    <div
      // UAT-F08 (position): the snackbar must sit ABOVE the bottom TabNavigation
      // (~64px tall) so it never overlaps the tab buttons. bottom-[80px] clears
      // the bar with a small gap (was bottom-4, which sat on top of the tabs).
      className="fixed bottom-[80px] left-1/2 flex flex-col-reverse items-center gap-2 pointer-events-none"
      style={{
        zIndex: "var(--z-snackbar)",
        transform: "translateX(-50%)",
        transition: "all 0.3s ease",
      }}
    >
      {items.map((item) => (
        <div
          key={item.id}
          // D-03.3: make each toast an announced live region. Errors are
          // assertive (role="alert", interrupts) and successes are polite
          // (role="status", queued) — matching the panel's aria-live
          // conventions so screen readers read the toast out.
          role={item.type === "error" ? "alert" : "status"}
          aria-live={item.type === "error" ? "assertive" : "polite"}
          className={cn(
            "flex items-center gap-[var(--space-2)] px-[var(--space-4)] py-[var(--space-2)]",
            "rounded-[var(--radius-lg)] text-sm font-normal pointer-events-auto",
            "shadow-[var(--shadow-lg)]",
            item.type === "error" && "border-l-2 border-[var(--color-status-error)]",
          )}
          style={{
            backgroundColor: "var(--color-bg-elevated)",
            color: "var(--color-text-primary)",
            border: "1px solid var(--color-border)",
            borderLeftColor:
              item.type === "error" ? "var(--color-status-error)" : undefined,
            opacity: item.phase === "visible" ? 1 : 0,
            transform:
              item.phase === "visible"
                ? "translateY(0)"
                : item.phase === "enter"
                  ? "translateY(15px)"
                  : "translateY(0)",
            pointerEvents: item.phase === "exit" ? "none" : undefined,
            transition: "opacity var(--transition-fast), transform var(--transition-fast)",
            maxWidth: "90vw",
          }}
        >
          {item.type === "success" ? (
            <CheckCircle2
              className="w-4 h-4 shrink-0"
              style={{ color: "var(--color-status-connected)" }}
            />
          ) : (
            <AlertTriangle
              className="w-4 h-4 shrink-0"
              style={{ color: "var(--color-status-error)" }}
            />
          )}

          {item.type === "success" ? (
            <span className="truncate" style={{ whiteSpace: "nowrap" }}>
              {item.text}
            </span>
          ) : (
            <ErrorSnackText
              text={item.text}
              onCopy={() => navigator.clipboard.writeText(item.text)}
            />
          )}

          {item.type === "error" && (
            <button
              className="shrink-0 p-0.5 rounded hover:bg-[var(--color-bg-hover)] transition-colors"
              aria-label="Close notification"
              title="Close"
              onClick={() => dismiss(item.id)}
            >
              <X className="w-3.5 h-3.5" style={{ color: "var(--color-text-secondary)" }} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
