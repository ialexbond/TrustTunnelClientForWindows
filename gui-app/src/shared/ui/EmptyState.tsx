import { type ReactNode } from "react";
import { cn } from "../lib/cn";

interface EmptyStateProps {
  icon?: ReactNode;
  heading?: string;
  body?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon,
  heading = "Ничего нет",
  body = "Здесь появятся элементы после добавления.",
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 py-8 text-center",
        className
      )}
    >
      {icon && (
        <div
          className="opacity-40"
          style={{ color: "var(--color-text-muted)" }}
        >
          {icon}
        </div>
      )}
      <p
        className="font-[var(--font-weight-semibold)]"
        style={{
          fontSize: "var(--font-size-md)",
          color: "var(--color-text-secondary)",
        }}
      >
        {heading}
      </p>
      <p
        style={{
          fontSize: "var(--font-size-sm)",
          color: "var(--color-text-muted)",
        }}
      >
        {body}
      </p>
      {action && <div>{action}</div>}
    </div>
  );
}
