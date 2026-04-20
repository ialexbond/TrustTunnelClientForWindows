import { type ReactNode } from "react";
import { cn } from "../lib/cn";

interface FormFieldProps {
  label: string;
  required?: boolean;
  error?: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}

export function FormField({
  label,
  required = false,
  error,
  hint,
  children,
  className,
}: FormFieldProps) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label
        className="text-sm font-normal"
        style={{
          color: "var(--color-text-secondary)",
        }}
      >
        {label}
        {required && (
          <span
            className="ml-0.5"
            style={{ color: "var(--color-danger-500)" }}
            aria-hidden="true"
          >
            *
          </span>
        )}
      </label>
      {children}
      {error ? (
        <p
          role="alert"
          className="text-xs"
          style={{
            color: "var(--color-status-error)",
          }}
        >
          {error}
        </p>
      ) : hint ? (
        <p
          className="text-xs"
          style={{
            color: "var(--color-text-muted)",
          }}
        >
          {hint}
        </p>
      ) : null}
    </div>
  );
}
