// TESTED IN `InsetPanel.test.tsx` — and the earlier claim that it could not be usefully tested was
// half right. The APPEARANCE genuinely cannot be: a test over this class list would only re-state
// it back to itself, and the no-left-rail rule is enforced statically by the token-hygiene gate.
// The CONTRACT can be, and it is not visual. This panel is placed around blocks that hold real
// controls, so two things must stay true of it and neither shows up in a screenshot: it stays
// transparent to the accessibility tree (no role, no name, no aria-hidden, no tab stop — a
// `<section>` here would make a screen reader announce a landmark around every wrapped block), and
// it never interposes between the user and its children (focus order, clicks and accessible names
// pass through untouched). Both are one-word edits away at any time, and no visual review catches
// either.
import type { ReactNode } from "react";

/**
 * A full-width recessed panel: elevated fill, hairline outline, medium radius, no left offset.
 *
 * THIS IS THE TAB'S BINDING VISUAL RULE MADE CONCRETE. Emphasis is carried by FILL and OUTLINE —
 * never by a coloured left edge, never by a coloured ring around the perimeter, never by a glow.
 * Those devices read as machine-generated decoration; the owner has rejected the left rail twice,
 * and the design system rejects it as a rule.
 *
 * Stated as a RULE, not as a description of the shipped app. A sweep of `gui-pro/src` for
 * left-edge border utilities still finds accent left edges in production —
 * `settings/AutoModeSettings.tsx` (the failover-parameters block this panel replaces) and
 * `server/Fail2banSettingsTab.tsx`, plus the error `SnackBar` and the `LogsViewerModal` severity
 * bar. So this panel is the Settings tab's answer to the rule, not the app's last remaining
 * offender.
 *
 * Lifted from the Phase-27 story tier (`components/_story/settingsDemos.tsx`).
 */
export function InsetPanel({ children }: { children: ReactNode }) {
  return (
    <div className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-[var(--space-3)]">
      {children}
    </div>
  );
}
