import { useEffect, useRef, useState } from "react";
import { CheckCircle2 } from "lucide-react";

interface SnackItem {
  id: number;
  message: string;
  phase: "enter" | "visible" | "exit";
}

let _nextId = 0;

interface SnackBarProps {
  messages: string[];
  onShown: () => void;
  duration?: number;
}

export function SnackBar({ messages, onShown, duration = 2500 }: SnackBarProps) {
  const [items, setItems] = useState<SnackItem[]>([]);
  const seenCount = useRef(0);

  useEffect(() => {
    // How many new messages appeared since last render
    const newCount = messages.length;
    if (newCount <= 0 || seenCount.current >= newCount) return;

    // Process all new messages
    for (let i = seenCount.current; i < newCount; i++) {
      const msg = messages[i];
      const id = ++_nextId;

      setItems(prev => [...prev, { id, message: msg, phase: "enter" }]);

      // Enter → visible
      setTimeout(() => {
        setItems(prev => prev.map(s => s.id === id ? { ...s, phase: "visible" } : s));
      }, 30);

      // Visible → exit (fade out in place, keep in DOM)
      setTimeout(() => {
        setItems(prev => prev.map(s => s.id === id ? { ...s, phase: "exit" } : s));
        // After all are "exit", clear the whole stack
        setTimeout(() => {
          setItems(prev => {
            if (prev.every(s => s.phase === "exit")) return [];
            return prev;
          });
        }, 400);
      }, duration);
    }

    seenCount.current = newCount;
  }, [messages, duration]);

  // Reset counter when parent clears the queue
  useEffect(() => {
    if (messages.length === 0) {
      seenCount.current = 0;
    }
  }, [messages.length]);

  // Periodically clear consumed messages from parent (batch, not per-message)
  useEffect(() => {
    if (messages.length === 0) return;
    const timer = setTimeout(() => {
      for (let i = 0; i < messages.length; i++) onShown();
    }, 100);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length]);

  if (items.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 left-1/2 z-[9999] flex flex-col-reverse items-center gap-2 pointer-events-none"
      style={{ transform: "translateX(-50%)", transition: "all 0.3s ease" }}
    >
      {items.map((item) => (
        <div
          key={item.id}
          className="flex items-center gap-2 px-4 py-2.5 rounded-[var(--radius-lg)] shadow-lg text-sm font-medium pointer-events-auto"
          style={{
            backgroundColor: "var(--color-bg-secondary)",
            color: "var(--color-text-primary)",
            border: "1px solid var(--color-border)",
            opacity: item.phase === "visible" ? 1 : 0,
            transform: item.phase === "visible"
              ? "translateY(0)"
              : item.phase === "enter"
                ? "translateY(15px)"
                : "translateY(0)",
            pointerEvents: item.phase === "exit" ? "none" : undefined,
            transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
            maxWidth: "90vw",
            whiteSpace: "nowrap",
          }}
        >
          <CheckCircle2 className="w-4 h-4 shrink-0" style={{ color: "var(--color-success-500)" }} />
          <span className="truncate">{item.message}</span>
        </div>
      ))}
    </div>
  );
}
