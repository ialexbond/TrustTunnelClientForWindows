import { useState, useId, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../lib/cn";

export interface AccordionItem {
  id: string;
  title: ReactNode;
  content: ReactNode;
}

interface AccordionProps {
  items: AccordionItem[];
  defaultOpen?: string[];
  single?: boolean;
  className?: string;
}

export function Accordion({ items, defaultOpen = [], single = false, className }: AccordionProps) {
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set(defaultOpen));

  function toggle(id: string) {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        if (single) next.clear();
        next.add(id);
      }
      return next;
    });
  }

  return (
    <div className={className}>
      {items.map((item, i) => (
        <AccordionItemComponent
          key={item.id}
          item={item}
          open={openIds.has(item.id)}
          onToggle={() => toggle(item.id)}
          isLast={i === items.length - 1}
        />
      ))}
    </div>
  );
}

interface AccordionItemComponentProps {
  item: AccordionItem;
  open: boolean;
  onToggle: () => void;
  isLast: boolean;
}

function AccordionItemComponent({ item, open, onToggle, isLast }: AccordionItemComponentProps) {
  const baseId = useId();
  const headerId = `${baseId}-header`;
  const contentId = `${baseId}-content`;

  return (
    <div className={cn(!isLast && "border-b border-[var(--color-border)]")}>
      <button
        type="button"
        id={headerId}
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={contentId}
        className={cn(
          "flex items-center justify-between w-full text-left",
          "py-[var(--space-3)] px-0",
          "hover:bg-[var(--color-bg-hover)] rounded-[var(--radius-sm)]",
          "focus-visible:shadow-[var(--focus-ring)] outline-none",
          "transition-colors"
        )}
        style={{ background: "none", border: "none", cursor: "pointer" }}
      >
        <span
          className="font-[var(--font-weight-semibold)]"
          style={{ fontSize: "var(--font-size-md)", color: "var(--color-text-primary)" }}
        >
          {item.title}
        </span>
        <ChevronDown
          className={cn(
            "w-4 h-4 transition-transform",
            open && "rotate-180"
          )}
          style={{
            color: "var(--color-text-muted)",
            transitionDuration: "var(--transition-fast)",
          }}
        />
      </button>

      <div
        id={contentId}
        role="region"
        aria-labelledby={headerId}
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{
          gridTemplateRows: open ? "1fr" : "0fr",
          visibility: open ? undefined : "hidden",
        }}
        aria-hidden={!open}
      >
        <div className="overflow-hidden">
          <div className="pb-[var(--space-3)]" style={{ color: "var(--color-text-secondary)" }}>
            {item.content}
          </div>
        </div>
      </div>
    </div>
  );
}
