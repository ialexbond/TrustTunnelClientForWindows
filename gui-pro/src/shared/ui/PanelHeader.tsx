import type { ReactNode } from "react";
import { cn } from "../lib/cn";

/** Which family the chip is painted in. `warning` marks content that is not like the others. */
export type PanelHeaderVariant = "accent" | "warning";

export interface PanelHeaderProps {
  /** A Lucide glyph, already sized (16px). Rendered inside the chip, never bare. */
  icon: ReactNode;
  title: string;
  description?: string;
  variant?: PanelHeaderVariant;
  /**
   * Status text or a control that belongs on the TITLE line, right-aligned.
   *
   * It aligns to the title rather than to the middle of the header, so a description long enough to
   * wrap grows downwards AWAY from it instead of colliding with it. That collision is exactly what
   * `CardHeader`'s `items-center` produces, and it is why the geodata card used to hand-build this
   * row instead of using a shared one.
   */
  action?: ReactNode;
  className?: string;
}

/**
 * The header every «Настройки» card is built from — and now every «Маршрутизация» card too: a 28px
 * tinted chip holding the section glyph, then the title and an optional description.
 *
 * Extracted VERBATIM out of `SettingsCard`, which now renders it. The Settings tab therefore stays
 * the definition of this treatment rather than becoming a second copy of it that can drift, and the
 * no-`action` branch below emits the same node `SettingsCard` emitted before the extraction, down to
 * the class list — so nothing on that tab moves by a pixel.
 *
 * WHY ROUTING USES THIS AND NOT `CardHeader`. `CardHeader` centres the glyph against the whole
 * title+description block, so on any card that HAS a description the glyph floats between the two
 * lines and reads as a stray square beside the text rather than as the section's mark. `items-start`
 * puts the chip on the title line where it belongs. `CardHeader` is deliberately left untouched: a
 * dozen dashboard / log-panel / server / legacy-settings call sites still render it and must keep
 * their current look.
 *
 * WHY THE `-fg` ALIASES AND NOT THE `-500` PRIMITIVES. The `-fg` aliases are theme-scoped
 * (accent-400 in dark, accent-600 in light); the raw `-500` primitives fail contrast as a
 * light-theme foreground. That gap is banked as A11Y-27-01 and is deliberately NOT fixed here, so
 * substituting a `-500` would silently ship the known-failing colour.
 */
export function PanelHeader({
  icon,
  title,
  description,
  variant = "accent",
  action,
  className,
}: PanelHeaderProps) {
  const chipFill =
    variant === "warning" ? "var(--color-warning-tint-12)" : "var(--color-accent-tint-10)";
  const chipForeground =
    variant === "warning" ? "var(--color-warning-fg)" : "var(--color-accent-fg)";

  const heading = (
    <>
      <span
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-md)]"
        style={{ backgroundColor: chipFill, color: chipForeground }}
        aria-hidden="true"
      >
        {icon}
      </span>
      <div className="min-w-0">
        <h3 className="text-title-sm" style={{ color: "var(--color-text-primary)" }}>
          {title}
        </h3>
        {description && (
          <p className="mt-0.5 text-xs" style={{ color: "var(--color-text-muted)" }}>
            {description}
          </p>
        )}
      </div>
    </>
  );

  if (!action) {
    return (
      <div className={cn("mb-[var(--space-3)] flex items-start gap-[var(--space-2)]", className)}>
        {heading}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "mb-[var(--space-3)] flex items-start justify-between gap-[var(--space-3)]",
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-[var(--space-2)]">{heading}</div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}
