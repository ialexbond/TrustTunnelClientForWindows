import {
  useId,
  cloneElement,
  isValidElement,
  type ReactNode,
  type ReactElement,
} from "react";
import { cn } from "../lib/cn";

interface FormFieldProps {
  label: string;
  required?: boolean;
  error?: string;
  helperText?: string;
  children: ReactNode;
  className?: string;
}

export function FormField({
  label,
  required = false,
  error,
  helperText,
  children,
  className,
}: FormFieldProps) {
  // A11Y-03: the child control is opaque, so we associate it with the label via
  // aria-labelledby (the lowest-risk linkage — no need to thread an id into an
  // unknown child's <input>). The label carries the id; the child references it.
  const labelId = useId();
  const labelledChild = isValidElement(children)
    ? cloneElement(children as ReactElement<{ "aria-labelledby"?: string }>, {
        "aria-labelledby": labelId,
      })
    : children;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label
        id={labelId}
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
      {labelledChild}
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
      ) : helperText ? (
        <p
          className="text-xs"
          style={{
            color: "var(--color-text-muted)",
          }}
        >
          {helperText}
        </p>
      ) : null}
    </div>
  );
}
