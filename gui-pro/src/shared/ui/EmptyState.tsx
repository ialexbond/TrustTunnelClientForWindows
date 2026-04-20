import { type ReactNode } from "react";
import { useTranslation } from "react-i18next";
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
  heading,
  body,
  action,
  className,
}: EmptyStateProps) {
  const { t } = useTranslation();
  const resolvedHeading = heading ?? t("empty.heading");
  const resolvedBody = body ?? t("empty.body");
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-[var(--space-3)] py-[var(--space-7)] text-center",
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
        className="font-semibold text-base"
        style={{
          color: "var(--color-text-secondary)",
        }}
      >
        {resolvedHeading}
      </p>
      <p
        className="text-sm"
        style={{
          color: "var(--color-text-muted)",
        }}
      >
        {resolvedBody}
      </p>
      {action && <div>{action}</div>}
    </div>
  );
}
