import { type ReactNode } from "react";
import { cn } from "../lib/cn";

export interface FieldErrorProps {
  /**
   * The validation message. When empty / falsy the component renders nothing, so
   * callers can write `<FieldError>{error}</FieldError>` with no extra guard.
   */
  children?: ReactNode;
  /** Optional id so a control can point at it via aria-describedby. */
  id?: string;
  className?: string;
}

/**
 * FieldError — the canonical validation message shown BELOW a form control.
 *
 * One primitive for every "field … error text" line so the look and the a11y are
 * uniform across the design system (Input, Select, NumberInput, the inline rename
 * field, …). `role="alert"` so assistive tech announces it the moment it appears;
 * tokens only (`--color-status-error`, `text-xs`).
 *
 * Placement is the caller's job — it sits in normal flow directly under the field
 * (an `mt-1` gap), never overlapping it.
 */
export function FieldError({ children, id, className }: FieldErrorProps) {
  if (!children) return null;
  return (
    <p
      id={id}
      role="alert"
      className={cn("mt-1 text-xs text-[var(--color-status-error)]", className)}
    >
      {children}
    </p>
  );
}
