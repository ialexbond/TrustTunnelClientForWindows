import type { HTMLAttributes, ReactNode } from "react";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  padding?: "none" | "sm" | "md" | "lg";
  hover?: boolean;
}

const paddingMap = {
  none: "",
  sm: "p-3",
  md: "p-4",
  lg: "p-5",
};

export function Card({ children, padding = "md", hover, className = "", ...props }: CardProps) {
  return (
    <div
      className={`
        rounded-[var(--radius-xl)] border transition-colors
        ${hover ? "hover:border-[var(--color-border-hover)]" : ""}
        ${paddingMap[padding]}
        ${className}
      `}
      style={{
        backgroundColor: "var(--color-bg-surface)",
        borderColor: "var(--color-border)",
      }}
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
    <div className="flex items-center justify-between mb-3">
      <div className="flex items-center gap-2">
        {icon && (
          <span style={{ color: "var(--color-accent-400)" }}>{icon}</span>
        )}
        <div>
          <h3 className="text-sm font-semibold" style={{ color: "var(--color-text-primary)" }}>
            {title}
          </h3>
          {description && (
            <p className="text-[11px] mt-0.5" style={{ color: "var(--color-text-muted)" }}>
              {description}
            </p>
          )}
        </div>
      </div>
      {action}
    </div>
  );
}
