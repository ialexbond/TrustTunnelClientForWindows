import type { InputHTMLAttributes } from "react";
import { cn } from "../lib/cn";

/**
 * Radio — the design-system radio button.
 *
 * A single native `<input type="radio">` with `appearance-none`, so it keeps full native
 * keyboard / focus / form-group semantics (arrow-key navigation, `name` grouping, label
 * association) while the RING and inner DOT are painted from theme tokens — NOT the OS /
 * browser system accent colour, which renders inconsistently across platforms.
 *
 * The inner dot is the content box: `border-2` (the ring) + `p-[3px]` + `bg-clip-content`
 * means the `checked:` background fills only the ~8px centre, leaving the 2px accent ring
 * around it. Drop-in for `<input type="radio">` — pass name/value/checked/onChange/disabled
 * as usual (the `type` is fixed to "radio" internally).
 *
 * States: default (muted ring) · hover (accent ring) · checked (accent ring + dot) ·
 * focus-visible (accent focus ring) · disabled (--opacity-disabled, no hover).
 */
export type RadioProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type">;

export function Radio({ className, ...props }: RadioProps) {
  return (
    <input
      type="radio"
      className={cn(
        "appearance-none shrink-0 w-[18px] h-[18px] rounded-full border-2 p-[3px] bg-clip-content cursor-pointer transition-colors",
        "border-[var(--color-border)] hover:border-[var(--color-accent-interactive)]",
        "checked:border-[var(--color-accent-interactive)] checked:bg-[var(--color-accent-interactive)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-interactive)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg-primary)]",
        "disabled:cursor-not-allowed disabled:opacity-[var(--opacity-disabled)] disabled:hover:border-[var(--color-border)]",
        className,
      )}
      {...props}
    />
  );
}
