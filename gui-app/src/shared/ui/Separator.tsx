import { cn } from "../lib/cn";

interface SeparatorProps {
  orientation?: "horizontal" | "vertical";
  label?: string;
  className?: string;
}

export function Separator({
  orientation = "horizontal",
  label,
  className,
}: SeparatorProps) {
  if (orientation === "vertical") {
    return (
      <div
        className={cn("w-px self-stretch bg-[var(--color-border)]", className)}
        role="separator"
        aria-orientation="vertical"
      />
    );
  }

  if (label) {
    return (
      <div
        className={cn("flex items-center gap-3", className)}
        role="separator"
      >
        <div className="flex-1 h-px bg-[var(--color-border)]" />
        <span
          className="text-[var(--font-size-xs)] text-[var(--color-text-muted)] whitespace-nowrap"
          style={{ fontSize: "var(--font-size-xs)" }}
        >
          {label}
        </span>
        <div className="flex-1 h-px bg-[var(--color-border)]" />
      </div>
    );
  }

  return (
    <div
      className={cn("h-px w-full bg-[var(--color-border)]", className)}
      role="separator"
    />
  );
}
