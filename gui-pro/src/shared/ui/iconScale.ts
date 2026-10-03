/**
 * Icon size scale — the single source of truth for icon dimensions across the app.
 *
 * Five steps, all in px, matching the Tailwind spacing rhythm:
 *   xs = 12  (dense inline / caption-level icons)
 *   sm = 14  (compact buttons, table cells)
 *   md = 16  (default — body text, list rows, most buttons)
 *   lg = 20  (section headers, prominent actions)
 *   xl = 24  (hero / empty-state / onboarding glyphs)
 *
 * Use this for BOTH:
 *   - the Lucide `size` prop:  <Server size={ICON.md} />
 *   - Tailwind width/height:   className="w-4 h-4"  (4 = 16px = ICON.md)
 * keeping the prop value and the box size in lock-step.
 *
 * This plan (09-01) only DEFINES the scale. Migrating the Control Panel call
 * sites to it (ICON-01 / TC-01..TC-03) happens in a later plan.
 */
export const ICON = { xs: 12, sm: 14, md: 16, lg: 20, xl: 24 } as const;

export type IconSize = (typeof ICON)[keyof typeof ICON];
