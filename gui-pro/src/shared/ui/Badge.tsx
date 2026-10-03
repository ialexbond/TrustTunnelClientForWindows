/* eslint-disable react-refresh/only-export-components -- CVA variants are co-located with the component by design */
import { forwardRef, type HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";

export const badgeVariants = cva(
  [
    "inline-flex items-center gap-1.5",
    // UAT-F03: padding ONLY this round (owner 6.13) — bump horizontal px-2→px-2.5
    // and vertical py-0.5(2px)→py-[3px] so content isn't squeezed. Font size
    // (.text-caption) stays unchanged; font tuning is a later round.
    "px-2.5 py-[3px]",
    "rounded-[var(--radius-full)]",
    // Semantic composite: text-caption = 12px / medium / 1.35 / sans.
    // Badge-specific transform + tracking applied on top.
    "text-caption",
    // R5-F04 (round-5 UAT): uppercase labels sat OPTICALLY HIGH — .text-caption's
    // 1.35 line-height adds descender slack below the baseline that the all-caps
    // glyphs (no descenders) never use, so items-center centred the line-box, not
    // the glyphs. `leading-none` (utilities layer) overrides the components-layer
    // .text-caption line-height so the line-box hugs the caps and items-center
    // truly optical-centres them. Applies to ALL badges/sizes. No clipping risk:
    // the badge never sets overflow-hidden, and py padding gives descender room.
    "leading-none",
    "uppercase tracking-[var(--tracking-wide)]",
  ].join(" "),
  {
    variants: {
      variant: {
        success: [
          "bg-[var(--color-status-connected-bg)]",
          "text-[var(--color-status-connected)]",
          "border border-[var(--color-status-connected-border)]",
        ].join(" "),
        warning: [
          "bg-[var(--color-status-connecting-bg)]",
          "text-[var(--color-status-connecting)]",
          "border border-[var(--color-status-connecting-border)]",
        ].join(" "),
        danger: [
          "bg-[var(--color-status-error-bg)]",
          "text-[var(--color-status-error)]",
          "border border-[var(--color-status-error-border)]",
        ].join(" "),
        // info: blue family — same readable tint-bg + theme-scoped status text
        // (info-400 on dark / info-600 on light) + subtle border pattern as the
        // other status variants. Added for R4-F08 so accent-coloured rule-type
        // badges (ip / cidr) read clearly instead of bright accent-400 on a
        // same-hue transparent/saturated fill.
        info: [
          "bg-[var(--color-status-info-bg)]",
          "text-[var(--color-status-info)]",
          "border border-[var(--color-status-info-border)]",
        ].join(" "),
        neutral: [
          "bg-[var(--color-bg-elevated)]",
          "text-[var(--color-text-secondary)]",
          "border border-[var(--color-border)]",
        ].join(" "),
        dot: [
          "bg-transparent",
          "text-[var(--color-text-secondary)]",
          "border border-transparent",
        ].join(" "),
        default: [
          "bg-[var(--color-bg-elevated)]",
          "text-[var(--color-text-secondary)]",
          "border border-[var(--color-border)]",
        ].join(" "),
      },
      size: {
        // Size variants control padding only — font-size/weight/family come from .text-caption base.
        // R5-F03 (round-5 UAT): sm was px-1.5 py-0 — ZERO vertical padding made
        // sm badges (e.g. the Geodata «Загружено/READY» status badge) look
        // squeezed / vertically off next to the well-padded md badges. Give sm
        // real vertical padding (py-[2px]) so every sm badge breathes; slightly
        // tighter than md (py-[3px]) to keep the size distinction.
        sm: "px-2 py-[2px]",
        // UAT-F03: md matches the enlarged base padding (px-2.5 / py-[3px]).
        md: "px-2.5 py-[3px]",
      },
    },
    defaultVariants: {
      variant: "neutral",
      size: "md",
    },
  }
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  pulse?: boolean;
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  ({ variant, size, pulse, className, children, ...props }, ref) => {
    // data-variant / data-pulse are inert testability affordances: they let tests
    // assert the chosen variant + pulse state semantically without coupling to the
    // Tailwind utility classes (Phase-3 net rule — assert behavior, never CSS).
    // Falls back to the default variant so an unstyled <Badge> still reports "neutral".
    const resolvedVariant = variant ?? "neutral";
    return (
      <span
        ref={ref}
        data-variant={resolvedVariant}
        data-pulse={pulse ? "true" : undefined}
        className={cn(
          badgeVariants({ variant, size }),
          pulse && "animate-pulse",
          className
        )}
        {...props}
      >
        {variant === "dot" && (
          <span
            className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-muted)] shrink-0"
            aria-hidden="true"
          />
        )}
        {children}
      </span>
    );
  }
);

Badge.displayName = "Badge";
