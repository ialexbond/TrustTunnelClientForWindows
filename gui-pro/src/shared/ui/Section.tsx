import { type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../lib/cn";
import { useCollapse } from "../hooks/useCollapse";

interface SectionHeaderProps {
  title: string;
  description?: string;
  action?: ReactNode;
  collapsed?: boolean;
  onToggle?: () => void;
  className?: string;
}

export function SectionHeader({
  title,
  description,
  action,
  collapsed,
  onToggle,
  className,
}: SectionHeaderProps) {
  const isClickable = onToggle !== undefined;

  return (
    <div className={cn("flex flex-col gap-0.5", className)}>
      <div className="flex items-center justify-between">
        {isClickable ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={!collapsed}
            className="flex items-center gap-1.5 flex-1 text-left"
            style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}
          >
            <span
              className="font-[var(--font-weight-semibold)] tracking-[var(--tracking-tight)]"
              style={{
                fontSize: "var(--font-size-lg)",
                color: "var(--color-text-primary)",
              }}
            >
              {title}
            </span>
            <ChevronDown
              className={cn(
                "w-4 h-4 transition-transform",
                !collapsed && "rotate-180"
              )}
              style={{
                color: "var(--color-text-muted)",
                transitionDuration: "var(--transition-fast)",
              }}
            />
          </button>
        ) : (
          <span
            className="font-[var(--font-weight-semibold)] tracking-[var(--tracking-tight)]"
            style={{
              fontSize: "var(--font-size-lg)",
              color: "var(--color-text-primary)",
            }}
          >
            {title}
          </span>
        )}
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {description && (
        <p
          className="mt-1"
          style={{
            fontSize: "var(--font-size-sm)",
            color: "var(--color-text-muted)",
          }}
        >
          {description}
        </p>
      )}
    </div>
  );
}

interface SectionProps {
  title?: string;
  description?: string;
  collapsible?: boolean;
  defaultOpen?: boolean;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Section({
  title,
  description,
  collapsible = false,
  defaultOpen = true,
  action,
  children,
  className,
}: SectionProps) {
  const { open, toggle } = useCollapse(defaultOpen);

  const showContent = !collapsible || open;

  return (
    <div
      className={cn("flex flex-col gap-[var(--space-4)]", className)}
    >
      {title && (
        <SectionHeader
          title={title}
          description={description}
          action={action}
          collapsed={collapsible ? !open : undefined}
          onToggle={collapsible ? toggle : undefined}
        />
      )}
      {collapsible ? (
        <div
          className="grid transition-[grid-template-rows] duration-200 ease-out"
          style={{
            gridTemplateRows: showContent ? "1fr" : "0fr",
            visibility: showContent ? undefined : "hidden",
          }}
          aria-hidden={!showContent}
        >
          <div className="overflow-hidden">
            {children}
          </div>
        </div>
      ) : (
        <div>{children}</div>
      )}
    </div>
  );
}
