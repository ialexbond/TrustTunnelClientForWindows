import type { ReactNode } from "react";
import { Card } from "./Card";
import { PanelHeader } from "./PanelHeader";

/** Which family the header chip is painted in. `warning` marks the one card whose content is not
 *  like the others; everything else is `accent`. */
export type SettingsCardVariant = "accent" | "warning";

export interface SettingsCardProps {
  /** A Lucide glyph, already sized (16px). Rendered inside the chip, never bare. */
  icon: ReactNode;
  title: string;
  description?: string;
  variant?: SettingsCardVariant;
  children: ReactNode;
}

/**
 * The card every section of the «Настройки» tab is built from: a 28px tinted chip holding the
 * section glyph, the title, an optional description, then the body.
 *
 * The chip replaces the bare accent glyph the tab carried before the redesign and is the main
 * «this was redesigned» signal — deliberately built from existing tint/-fg token pairs rather than
 * a new decoration, so it costs the design system nothing.
 *
 * WHY THE `-fg` ALIASES AND NOT THE `-500` PRIMITIVES. The `-fg` aliases are theme-scoped
 * (accent-400 in dark, accent-600 in light); the raw `-500` primitives fail contrast as a
 * light-theme foreground. That gap is banked as A11Y-27-01 and is deliberately NOT fixed here, so
 * substituting a `-500` would silently ship the known-failing colour.
 *
 * `warning` tints the header tile ONLY: the card shell stays neutral, because a whole card painted
 * amber reads as an error state rather than as "handle with care".
 *
 * IT CURRENTLY HAS NO USER. It existed for «Экспериментальные функции», and that card was removed
 * on 2026-09-03 together with its one row — «Блокировка сайтов», a feature that never worked. The
 * variant stays because the RULE it encodes is still the design's: warning tone means «this card is
 * not like the others», and it says that only while exactly one card on a tab wears it. The next
 * card that needs it inherits the rule, not a fresh invention — which is why deleting the variant
 * would cost more than keeping it. That there is no such card today is asserted, not assumed:
 * `AppSettingsPanel.test.tsx` fails if a warning tile appears on the tab.
 *
 * Lifted from the Phase-27 story tier (`components/_story/settingsDemos.tsx`) unchanged apart from
 * its import path — `_story/` never ships, so the approved design could not be drawn from there.
 *
 * The header itself now lives in `PanelHeader`, which the «Маршрутизация» cards render too. It was
 * moved out rather than copied so that this tab stays the single definition of the treatment: a
 * second hand-rolled copy on another tab is precisely how the two tabs drifted apart in the first
 * place. Nothing about this card's own rendering changed in the move.
 */
export function SettingsCard({
  icon,
  title,
  description,
  variant = "accent",
  children,
}: SettingsCardProps) {
  return (
    <Card padding="md">
      <PanelHeader icon={icon} title={title} description={description} variant={variant} />
      {children}
    </Card>
  );
}
