import type { HTMLAttributes, ReactNode } from "react";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  padding?: "none" | "sm" | "md" | "lg";
  hover?: boolean;
}

const paddingMap = {
  none: "",
  sm: "p-[var(--space-3)]",
  md: "p-[var(--space-4)]",
  lg: "p-[var(--space-5)]",
};

export function Card({ children, padding = "md", hover, className = "", ...props }: CardProps) {
  return (
    <div
      className={`
        rounded-[var(--radius-lg)]
        border border-[var(--color-border)]
        bg-[var(--color-bg-surface)]
        shadow-[var(--shadow-sm)]
        transition-colors
        ${hover ? "hover:border-[var(--color-border-hover)]" : ""}
        ${paddingMap[padding]}
        ${className}
      `}
      {...props}
    >
      {children}
    </div>
  );
}

interface CardHeaderProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
}

export function CardHeader({ title, description, icon, action }: CardHeaderProps) {
  return (
    <div className="flex items-center justify-between mb-[var(--space-3)]">
      <div className="flex items-center gap-[var(--space-2)]">
        {icon && (
          <span style={{ color: "var(--color-accent-interactive)" }}>{icon}</span>
        )}
        <div>
          <h3
            className="text-[var(--font-size-lg)] font-[var(--font-weight-semibold)]"
            style={{ color: "var(--color-text-primary)" }}
          >
            {title}
          </h3>
          {description && (
            <p
              className="text-[var(--font-size-xs)] mt-0.5"
              style={{ color: "var(--color-text-muted)" }}
            >
              {description}
            </p>
          )}
        </div>
      </div>
      {action}
    </div>
  );
}
