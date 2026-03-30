import { useState, useRef, useEffect, useCallback, type CSSProperties, type RefObject } from "react";

interface UseDropdownPortalReturn {
  open: boolean;
  style: CSSProperties;
  containerRef: RefObject<HTMLDivElement | null>;
  triggerRef: RefObject<HTMLButtonElement | null>;
  portalRef: RefObject<HTMLDivElement | null>;
  toggle: () => void;
  close: () => void;
}

/**
 * Shared hook for dropdown portals.
 * Handles: open/close state, positioning via getBoundingClientRect,
 * outside-click listener, and portal styles (fixed, z-index: 40).
 */
export function useDropdownPortal(): UseDropdownPortalReturn {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const portalRef = useRef<HTMLDivElement>(null);

  // Close on outside click — check both trigger container AND portal content
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      const inContainer = containerRef.current?.contains(target);
      const inPortal = portalRef.current?.contains(target);
      if (!inContainer && !inPortal) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const toggle = useCallback(() => {
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setStyle({
        position: "fixed",
        top: rect.bottom + 4,
        left: rect.left,
        width: rect.width,
        zIndex: 40,
      });
    }
    setOpen((prev) => !prev);
  }, [open]);

  const close = useCallback(() => setOpen(false), []);

  return { open, style, containerRef, triggerRef, portalRef, toggle, close };
}
