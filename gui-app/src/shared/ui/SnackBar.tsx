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

      // Task 1b: When a success message arrives, dismiss all existing error snackbars
      if (type === "success") {
        setItems(prev => {
          const updated = prev.map(s =>
            s.type === "error" && s.phase !== "exit" ? { ...s, phase: "exit" as const } : s,
          );
          // Schedule removal of exiting errors
          updated.forEach(s => {
            if (s.type === "error" && s.phase === "exit") {
              const timer = timersRef.current.get(s.id);
              if (timer) {
                clearTimeout(timer);
                timersRef.current.delete(s.id);
              }
              setTimeout(() => {
                setItems(p => p.filter(x => x.id !== s.id));
              }, 400);
            }
          });
          return updated;
        });
      }

      // Check for duplicate that is still visible
      const existing = items.find(
        (s) => s.text === text && s.type === type && s.phase !== "exit",
      );

      if (existing) {
        // Reset timer for duplicate
        scheduleDismiss(existing.id, type === "error" ? 5000 : undefined);
        onShown();
        seenCount.current = i + 1;
        continue;
      }

      const id = ++_nextId;

      setItems(prev => [...prev, { id, text, type, phase: "enter" }]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      className="fixed bottom-4 left-1/2 flex flex-col-reverse items-center gap-2 pointer-events-none"
      style={{
        zIndex: "var(--z-snackbar)",
        transform: "translateX(-50%)",
        transition: "all 0.3s ease",
      }}
    >
      {items.map((item) => (
        <div
          key={item.id}
          className={cn(
            "flex items-center gap-2 px-4 py-2.5",
            "rounded-[var(--radius-lg)] text-sm font-[var(--font-weight-normal)] pointer-events-auto",
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
