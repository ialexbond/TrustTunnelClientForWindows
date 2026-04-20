import { useState, useCallback } from "react";

export function useCollapse(defaultOpen = true) {
  const [open, setOpen] = useState(defaultOpen);
  const toggle = useCallback(() => setOpen((prev) => !prev), []);
  return { open, toggle, setOpen } as const;
}
