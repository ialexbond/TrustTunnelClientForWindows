import { useState, useRef, useEffect, useCallback, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal, Loader2 } from "lucide-react";
import { cn } from "../lib/cn";
import { IconButton } from "./IconButton";

export interface OverflowMenuItem {
  label: string;
  onSelect: () => void;
  loading?: boolean;
  disabled?: boolean;
  destructive?: boolean;
  icon?: ReactNode;
}

export interface OverflowMenuProps {
  items: OverflowMenuItem[];
  triggerAriaLabel: string;
  className?: string;
}

export function OverflowMenu({ items, triggerAriaLabel, className }: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        !menuRef.current?.contains(target) &&
        !triggerRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  // Position menu relative to trigger with viewport auto-flip (D-12).
  // Algorithm ported from Tooltip.tsx (WR-08 fix included — when neither
  // direction fits, pick the side with more available space instead of
  // clipping at the requested direction).
  //
  // Flow: handleToggle renders menu with visibility:hidden → this effect
  // measures both rects → computes top/left with clamp → sets visibility:visible.
  useEffect(() => {
    if (!open) return;
    const menuEl = menuRef.current;
    const triggerEl = triggerRef.current;
    if (!menuEl || !triggerEl) return;

    const triggerRect = triggerEl.getBoundingClientRect();
    const menuRect = menuEl.getBoundingClientRect();
    const gap = 4; // OverflowMenu gap (UI-SPEC §Spacing — Menu gap from trigger)
    const pad = 8; // viewport edge padding (matches Tooltip `pad`)
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Vertical fit check
    const fitsBelow = triggerRect.bottom + gap + menuRect.height <= vh - pad;
    const fitsAbove = triggerRect.top - gap - menuRect.height >= pad;

    // Choose vertical position: below preferred, above if doesn't fit below,
    // neither fits → pick the side with more available space (WR-08 fallback)
    let top: number;
    if (fitsBelow) {
      top = triggerRect.bottom + gap;
    } else if (fitsAbove) {
      top = triggerRect.top - menuRect.height - gap;
    } else {
      const spaceBelow = vh - triggerRect.bottom;
      const spaceAbove = triggerRect.top;
      top =
        spaceBelow > spaceAbove
          ? triggerRect.bottom + gap
          : triggerRect.top - menuRect.height - gap;
    }

    // Horizontal: prefer left-align, flip to right-align if overflow
    let left: number;
    const rightEdgeIfLeftAligned = triggerRect.left + menuRect.width;
    if (rightEdgeIfLeftAligned <= vw - pad) {
      left = triggerRect.left;
    } else {
      left = triggerRect.right - menuRect.width;
    }

    // Clamp to viewport edges (prevents negative values / over-right overflow
    // when menu wider than viewport-minus-padding)
    left = Math.max(pad, Math.min(left, vw - pad - menuRect.width));
    top = Math.max(pad, Math.min(top, vh - pad - menuRect.height));

    setMenuStyle({
      position: "fixed",
      top,
      left,
      zIndex: "var(--z-dropdown)",
      visibility: "visible",
    });
  }, [open]);

  // Close menu on scroll/resize (simpler than recompute; matches Select
  // primitive behaviour — menu is transient). D-12 decision.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("scroll", close, { capture: true, passive: true });
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, { capture: true });
      window.removeEventListener("resize", close);
    };
  }, [open]);

  // Focus first non-disabled item when menu opens
  useEffect(() => {
    if (!open) return;
    const firstEnabled = itemRefs.current.find((el) => el && !el.disabled);
    if (firstEnabled) {
      // Use rAF to ensure portal has rendered
      requestAnimationFrame(() => firstEnabled.focus());
    }
  }, [open]);

  const handleToggle = useCallback(() => {
    if (!open) {
      // Render hidden first — auto-flip useEffect measures + positions
      setMenuStyle({
        position: "fixed",
        top: 0,
        left: 0,
        zIndex: "var(--z-dropdown)",
        visibility: "hidden",
      });
    }
    setOpen((prev) => !prev);
  }, [open]);

  const handleItemKeyDown = (
    e: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    const enabledItems = itemRefs.current.filter((el) => el && !el.disabled);
    const currentEnabledIndex = enabledItems.indexOf(itemRefs.current[index]);

    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = enabledItems[currentEnabledIndex + 1];
      if (next) next.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prev = enabledItems[currentEnabledIndex - 1];
      if (prev) prev.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      enabledItems[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      enabledItems[enabledItems.length - 1]?.focus();
    }
  };

  const handleItemSelect = (item: OverflowMenuItem) => {
    if (item.disabled || item.loading) return;
    item.onSelect();
    setOpen(false);
  };

  // Trim stale refs when items count decreases
  useEffect(() => {
    itemRefs.current = itemRefs.current.slice(0, items.length);
  }, [items.length]);

  const menu = (
    <div
      ref={menuRef}
      role="menu"
      aria-label={triggerAriaLabel}
      style={{
        ...menuStyle,
        backgroundColor: "var(--color-bg-elevated)",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-md)",
        boxShadow: "var(--shadow-md)",
        minWidth: "160px",
        padding: "4px 0",
      }}
    >
      {items.map((item, index) => (
        <button
          key={index}
          ref={(el) => { itemRefs.current[index] = el; }}
          role="menuitem"
          tabIndex={-1}
          disabled={item.disabled}
          onKeyDown={(e) => handleItemKeyDown(e, index)}
          onClick={() => handleItemSelect(item)}
          className={cn(
            "px-3 py-2 w-full text-left text-sm flex items-center gap-2",
            "hover:bg-[var(--color-bg-hover)]",
            "focus-visible:shadow-[var(--focus-ring)] outline-none",
            "transition-colors",
            item.disabled && "opacity-50 cursor-not-allowed",
          )}
          style={
            item.destructive
              ? { color: "var(--color-destructive)" }
              : { color: "var(--color-text-primary)" }
          }
        >
          {item.loading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
          ) : item.icon ? (
            <span className="w-4 h-4 shrink-0 flex items-center justify-center">
              {item.icon}
            </span>
          ) : null}
          {item.label}
        </button>
      ))}
    </div>
  );

  return (
    <div className={className}>
      <IconButton
        ref={triggerRef}
        aria-label={triggerAriaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        icon={<MoreHorizontal className="w-4 h-4" />}
        className="h-9 w-9"
        onClick={handleToggle}
      />
      {open && createPortal(menu, document.body)}
    </div>
  );
}
