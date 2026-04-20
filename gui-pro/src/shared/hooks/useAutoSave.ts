import { useEffect, useRef } from "react";

export function useAutoSave(opts: {
  dirty: boolean;
  canSave: boolean;
  isActive: boolean;
  onSave: () => void;
  delay?: number;
}) {
  const { dirty, canSave, isActive, onSave, delay = 1200 } = opts;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!dirty || !canSave || isActive) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(onSave, delay);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [dirty, canSave, isActive, onSave, delay]);
}
