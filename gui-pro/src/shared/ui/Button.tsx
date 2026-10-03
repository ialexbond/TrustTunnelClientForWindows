/* eslint-disable react-refresh/only-export-components -- CVA variants are co-located with the component by design */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "../lib/cn";

export const buttonVariants = cva(
  [
    "inline-flex items-center justify-center",
    // Every size below sets a FIXED height (h-8/h-9/h-10). A label that wraps to a
    // second line therefore does not grow the button — it spills out of it, which is
    // how the process picker's three-button footer rendered as mangled boxes once
    // Phase 24 added the «Обзор» file action to a row sized for two. Wrapping inside a
    // fixed-height box is never the right answer for a button: refusing to wrap turns
    // a silent visual corruption into visible overflow, which is a layout bug someone
    // can see and fix. `min-w-0` lets a button still shrink inside a flex row rather
    // than forcing its parent to overflow.
    "whitespace-nowrap min-w-0",
    "font-medium",
    "rounded-[var(--radius-md)]",
    "transition-all duration-[var(--transition-fast)] ease-[var(--ease-out)]",
    "active:scale-[0.97]",
    "disabled:opacity-[var(--opacity-disabled)] disabled:cursor-not-allowed disabled:pointer-events-none",
    "focus-visible:shadow-[var(--focus-ring)] outline-none",
  ].join(" "),
  {
    variants: {
      variant: {
        primary: [
          "bg-[var(--color-accent-interactive)]",
          "hover:bg-[var(--color-accent-hover)]",
          "active:bg-[var(--color-accent-active)]",
          // A-3 (WCAG AA): theme-scoped on-accent token, not hardcoded white.
          // On the dark teal fill white is only ≈3.53:1 (FAIL); the token is
          // dark text (accent-900) ≈4.71:1 dark / white ≈5.05:1 light. See
          // tokens.css --color-on-accent (defined 09-01).
          "text-[var(--color-on-accent)]",
          "border border-transparent",
        ].join(" "),
        secondary: [
          "bg-[var(--color-bg-elevated)]",
          "hover:bg-[var(--color-bg-hover)]",
          "active:bg-[var(--color-bg-active)]",
          "text-[var(--color-text-primary)]",
          "border border-[var(--color-border)]",
        ].join(" "),
        danger: [
          // A-3 (WCAG AA): button fill uses the theme-scoped
          // --color-danger-interactive (analog of --color-accent-interactive),
          // NOT the broadly-shared --color-destructive. On dark, white over the
          // lighter --color-destructive (#e05545) reached only ≈3.78:1 (FAIL,
          // UAT #12); --color-danger-interactive (#bd2a1c dark / #b03020 light)
          // is deep enough that white clears 4.5:1 in both themes (≈5.98 dark /
          // ≈6.38 light) while still reading as a vivid red destructive button.
          // Scoped to the button so danger TEXT/badges keep --color-destructive.
          "bg-[var(--color-danger-interactive)]",
          "hover:opacity-90",
          "text-white",
          "border border-transparent",
        ].join(" "),
        "danger-outline": [
          "bg-transparent",
          // A-3: on hover the outline fills with the destructive colour, so the
          // text must switch to the on-accent token (was hardcoded white).
          "hover:bg-[var(--color-destructive)] hover:text-[var(--color-on-accent)]",
          "text-[var(--color-destructive)]",
          "border border-[var(--color-destructive)]",
        ].join(" "),
        ghost: [
          "bg-transparent",
          "hover:bg-[var(--color-bg-hover)]",
          "active:bg-[var(--color-bg-active)]",
          "text-[var(--color-text-secondary)]",
          "border border-transparent",
        ].join(" "),
        icon: [
          "bg-transparent",
          "hover:bg-[var(--color-bg-hover)]",
          "active:bg-[var(--color-bg-active)]",
          "text-[var(--color-text-muted)]",
          "border border-transparent",
        ].join(" "),
      },
      size: {
        sm: "h-8 px-3 text-sm gap-1.5",
        md: "h-9 px-4 text-sm gap-2",
        lg: "h-10 px-5 text-base gap-2",
      },
      fullWidth: {
        true: "w-full",
        false: "",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
      fullWidth: false,
    },
  }
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  loading?: boolean;
  fullWidth?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { variant, size, fullWidth, loading, icon, className, children, disabled, ...props },
    ref
  ) => {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        // data-variant exposes the resolved variant so tests can assert the
        // semantic intent (e.g. MTProto Stop=danger / Start=primary, 09-25)
        // without coupling to volatile CVA class strings. Falls back to the
        // primary default to mirror defaultVariants above.
        data-variant={variant ?? "primary"}
        className={cn(buttonVariants({ variant, size, fullWidth }), className)}
        {...props}
      >
        {loading && <Loader2 className="w-4 h-4 animate-spin" />}
        {!loading && icon}
        {children}
      </button>
    );
  }
);

Button.displayName = "Button";
