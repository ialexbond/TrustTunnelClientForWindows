import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Tooltip } from "./Tooltip";
import { cn } from "../lib/cn";

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required for accessibility: describes button action to screen readers */
  "aria-label": string;
  /** Icon content to render inside the button */
  icon?: ReactNode;
  /** Legacy children support (deprecated: prefer icon prop) */
  children?: ReactNode;
  /** Tooltip text shown on hover */
  tooltip?: string;
  /** Shows a loading spinner instead of the icon */
  loading?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    {
      "aria-label": ariaLabel,
      icon,
      children,
      tooltip,
      loading = false,
      disabled,
      className,
      onClick,
      ...rest
    },
    ref,
  ) {
    if (import.meta.env.DEV && !ariaLabel) {
      console.error("IconButton requires aria-label for accessibility");
    }

    const button = (
      <button
        ref={ref}
        type="button"
        aria-label={ariaLabel}
        onClick={onClick}
        disabled={disabled || loading}
        className={cn(
          "inline-flex items-center justify-center",
          "h-8 w-8 rounded-[var(--radius-md)]",
          "bg-transparent transition-colors",
          "hover:bg-[var(--color-bg-hover)] active:bg-[var(--color-bg-active)]",
          "focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]",
          "disabled:opacity-[var(--opacity-disabled)] disabled:cursor-not-allowed",
          className,
        )}
        style={{ color: "var(--color-text-muted)" }}
        {...rest}
      >
        {loading ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          icon ?? children
        )}
      </button>
    );

    if (tooltip) {
      return <Tooltip text={tooltip}>{button}</Tooltip>;
    }

    return button;
  },
);

IconButton.displayName = "IconButton";
