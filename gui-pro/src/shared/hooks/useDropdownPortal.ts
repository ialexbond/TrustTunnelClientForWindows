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

/** Estimated max dropdown height — keep in sync with Select/OverflowMenu `max-h-48` (12rem ≈ 192px). */
const DEFAULT_DROPDOWN_MAX_HEIGHT = 192;
const GAP = 4;

/**
 * Shared hook for dropdown portals.
 *
 * Positioning rules (all via `position: fixed` + getBoundingClientRect):
 *   1. Default: open BELOW trigger if `viewport.height - rect.bottom >= maxH + GAP`
 *   2. If no room below: flip UP when `rect.top >= maxH + GAP`
 *   3. Neither fits: pick the side with more space; clamp `maxHeight` to that space
 *
 * Z-index uses `var(--z-dropdown)` (400 — above modal at 300) so dropdowns inside
 * modals render on top without custom overrides.
 */
export function useDropdownPortal(): UseDropdownPortalReturn {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const portalRef = useRef<HTMLDivElement>(null);

  const computePosition = useCallback((): CSSProperties => {
    if (!triggerRef.current) return {};
    const rect = triggerRef.current.getBoundingClientRect();
    const viewportH = window.innerHeight;
    const spaceBelow = viewportH - rect.bottom - GAP;
    const spaceAbove = rect.top - GAP;

    // Prefer below if it fits entirely
    if (spaceBelow >= DEFAULT_DROPDOWN_MAX_HEIGHT) {
      return {
        position: "fixed",
        top: rect.bottom + GAP,
        left: rect.left,
        width: rect.width,
        zIndex: "var(--z-dropdown)",
        maxHeight: DEFAULT_DROPDOWN_MAX_HEIGHT,
      };
    }

    // Flip up if above fits entirely
    if (spaceAbove >= DEFAULT_DROPDOWN_MAX_HEIGHT) {
      return {
        position: "fixed",
        bottom: viewportH - rect.top + GAP,
        left: rect.left,
        width: rect.width,
        zIndex: "var(--z-dropdown)",
        maxHeight: DEFAULT_DROPDOWN_MAX_HEIGHT,
      };
    }

    // Neither side fits — pick the roomier side, clamp height
    if (spaceBelow >= spaceAbove) {
      return {
        position: "fixed",
        top: rect.bottom + GAP,
        left: rect.left,
        width: rect.width,
        zIndex: "var(--z-dropdown)",
        maxHeight: Math.max(spaceBelow, 64), // minimum 64px usable
      };
    }
    return {
      position: "fixed",
      bottom: viewportH - rect.top + GAP,
      left: rect.left,
      width: rect.width,
      zIndex: "var(--z-dropdown)",
      maxHeight: Math.max(spaceAbove, 64),
    };
  }, []);

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

  // Reposition on scroll/resize while open (viewport changes shift anchor)
  useEffect(() => {
    if (!open) return;
    const reposition = () => setStyle(computePosition());
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open, computePosition]);

  const toggle = useCallback(() => {
    if (!open && triggerRef.current) {
      setStyle(computePosition());
    }
    setOpen((prev) => !prev);
  }, [open, computePosition]);

  const close = useCallback(() => setOpen(false), []);

  return { open, style, containerRef, triggerRef, portalRef, toggle, close };
}
