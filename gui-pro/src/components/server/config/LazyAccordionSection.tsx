import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../../shared/lib/cn";

/**
 * Phase 15.1 — Accordion wrapper с lazy mount of content children.
 *
 * Differs from gui-pro/src/shared/ui/Accordion.tsx (whose `item.content` is
 * always mounted, only visibility-toggled):
 *   - Children mount ТОЛЬКО при первом open. Once mounted, stays mounted
 *     (sticky) so subsequent close→open animations are smooth and keep
 *     internal field state. Reduces first-paint cost — критичный для
 *     Phase 15.1 600ms budget when 4 accordions × 50+ fields = 200+
 *     SchemaFieldRenderer instances would otherwise render at mount.
 *   - One file = one wrapper (вместо array of items shape).
 *   - Slot для inline badges в trigger (e.g. «N изменений» Badge для D-1.3
 *     dirty count, «ТОЛЬКО ЧТЕНИЕ» Badge для credentials.toml D-2.1).
 *
 * Animation: gridTemplateRows: "0fr" → "1fr" (200ms ease-out) — same pattern
 * как Accordion.tsx (Phase 9). Visibility: hidden when closed (НЕ display:none)
 * per CLAUDE.md §Testing Patterns — keeps DOM stable for Vitest queries.
 *
 * Usage в Plan 15.1-06 ConfigurationTab:
 *   <LazyAccordionSection title="vpn.toml" badge={<Badge>2 изменения</Badge>}>
 *     <SchemaFieldRenderer schema={...} />
 *   </LazyAccordionSection>
 */
export interface LazyAccordionSectionProps {
  /** Title shown in trigger header. Render verbatim — D-3.3 raw English file names. */
  title: string;
  /** Optional badge slot (e.g. «N изменений» Badge или «ТОЛЬКО ЧТЕНИЕ» Badge). */
  badge?: ReactNode;
  /** Lazy-mounted content. Mount fires on first open. */
  children: ReactNode;
  /** Default open state. Defaults to false (collapsed — D-PRE-2). */
  defaultOpen?: boolean;
  /** Optional callback fired when open state changes. */
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

export function LazyAccordionSection({
  title,
  badge,
  children,
  defaultOpen = false,
  onOpenChange,
  className,
}: LazyAccordionSectionProps) {
  // Config H-5: stable ids tie the trigger to the panel it controls
  // (aria-controls ↔ panel id, panel aria-labelledby ↔ trigger id) so SR users
  // know which region the button expands. useId keeps them unique per instance.
  const baseId = useId();
  const triggerId = `${baseId}-trigger`;
  const panelId = `${baseId}-panel`;

  const [isOpen, setIsOpen] = useState<boolean>(defaultOpen);
  // mounted: true once children should render (sticky — once mounted, stays
  // mounted, so close→open animations are smooth and field state persists).
  const [mounted, setMounted] = useState<boolean>(defaultOpen);

  const handleToggle = () => {
    const next = !isOpen;
    if (next) setMounted(true); // lazy mount on first open
    setIsOpen(next);
    onOpenChange?.(next);
  };

  return (
    <div
      className={cn(
        "rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-surface)]",
        className
      )}
    >
      {/* Trigger */}
      <button
        type="button"
        id={triggerId}
        onClick={handleToggle}
        aria-expanded={isOpen}
        aria-controls={panelId}
        className={cn(
          "w-full flex items-center justify-between gap-3 px-4 py-3",
          "text-title-sm text-[var(--color-text-primary)]",
          "transition-colors hover:bg-[var(--color-bg-hover)]",
          "focus-visible:shadow-[var(--focus-ring)] outline-none",
          "rounded-[var(--radius-md)]",
          isOpen && "bg-[var(--color-bg-elevated)]"
        )}
      >
        <span className="flex items-center gap-2 min-w-0">
          <span className="text-mono truncate">{title}</span>
          {badge}
        </span>
        <ChevronDown
          size={18}
          className={cn(
            "shrink-0 transition-transform duration-200 ease-out text-[var(--color-text-muted)]",
            isOpen && "rotate-180"
          )}
          aria-hidden="true"
        />
      </button>

      {/* Content area — gridTemplateRows animation (Accordion pattern) */}
      <div
        id={panelId}
        role="region"
        aria-labelledby={triggerId}
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{
          gridTemplateRows: isOpen ? "1fr" : "0fr",
          visibility: isOpen ? undefined : "hidden",
        }}
        aria-hidden={!isOpen}
      >
        <div className="overflow-hidden">
          <div className="p-3">
            {/* LAZY MOUNT: children render only after first open (sticky). */}
            {mounted ? children : null}
          </div>
        </div>
      </div>
    </div>
  );
}
