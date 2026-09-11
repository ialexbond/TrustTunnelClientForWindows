// Phase 13 / Plan 13-03 (Wave 2) — the PRODUCTION connection notification plate.
//
// Lifted verbatim from the presentational `ConnectionToast` demo in `Notification.stories.tsx`
// (the D-25 surface), then given the two real handlers the story lacked: `onBodyClick` (D-04 —
// body click restores the main window from tray) and `onClose` (D-04 — × dismisses the plate
// only). This component stays PURELY presentational: it renders `{ icon, iconColor, title, body,
// closable }` and calls the two callbacks; the event wiring, the copy lookup, and the D-02/D-03
// auto-dismiss timer live at the `notification.tsx` call site (the plate's own Vite entry).
//
// D-29 / V5: `body` is rendered as React text (auto-escaped) — never `dangerouslySetInnerHTML`,
// so a config display name can never inject markup. The caller passes only the display NAME in the
// body (never the `.toml` content or the password).
//
// Win11 #13859: the plate surface is OPAQUE (`bg-[var(--color-bg-elevated)]`) — a transparent
// Win11 window renders black in dark theme (the exact bug that killed this repo's custom webview
// tray-menu). All colours are `var(--*)` tokens (no hex — CLAUDE.md).
import { type ReactNode } from "react";
import { X } from "lucide-react";
import { IconButton } from "../../shared/ui/IconButton";

/**
 * One optional detail row shown UNDER the body for CONNECT notifications (13-08 design exploration):
 * a small leading icon + a value — e.g. the endpoint address, the login, or the connect-time ping.
 * Only the CONNECT kinds carry these (connected / autoConnected / autoSwitched); a disconnect /
 * error / reconnect stays compact. D-29: a value is a display string (address / login / ping) —
 * NEVER the endpoint password. Rendered as React text (auto-escaped), never markup.
 */
export interface ConnectionToastDetailRow {
  /** Small leading Lucide icon (~12px) — Globe (address), User (login), Gauge (ping). Decorative. */
  icon?: ReactNode;
  /** The value text (address / login / «42 мс»). Never the password (D-29). */
  value: string;
  /** Render the value monospace + tabular — addresses and pings read better aligned. */
  mono?: boolean;
  /** Optional value colour token (e.g. ping quality: connected/warning/error). `var(--…)`, no hex. */
  valueColor?: string;
}

export interface ConnectionToastProps {
  /** State icon (Lucide element). Rendered in the state colour. */
  icon: ReactNode;
  /** CSS colour token for the icon — the per-state status colour (`var(--…)`, never hex). */
  iconColor: string;
  /** Bold title — the short state word. */
  title: string;
  /** Quiet one-line body — what happened, in plain Russian. Rendered as text (never markup). */
  body: string;
  /**
   * Optional detail rows shown UNDER the body (13-08 — richer CONNECT notifications). When present,
   * a hairline-separated block lists the endpoint address / login / connect-time ping. Only the
   * CONNECT kinds pass it; disconnect/error/reconnect leave it undefined and stay compact. D-29:
   * values are display strings only — never the password.
   */
  details?: ConnectionToastDetailRow[];
  /** Show the × close affordance (default true). */
  closable?: boolean;
  /**
   * Accessible name for the × close button (review #11). Defaults to the Russian
   * «Закрыть уведомление» so Storybook/card usages are unchanged; the production plate passes the
   * language-resolved pair from `notificationCopy.plateCloseCopy` so the × is announced in the same
   * language as the rendered copy.
   */
  closeLabel?: string;
  /** Tooltip for the × close button (review #11). Defaults to the Russian «Закрыть» — see
   *  `closeLabel`. */
  closeTooltip?: string;
  /**
   * Surface style (13-07 — UAT round-3 defect 1 «подложка»).
   *
   * - `"card"` (default) — the presentational demo look: a `Card` with its OWN rounding, border and
   *   shadow, floating on whatever wraps it. Used by Storybook and any in-app preview so their look
   *   is unchanged.
   * - `"plate"` — the PRODUCTION desktop plate. The notification WINDOW is already opaque and DWM-
   *   rounded (13-06), and it is slightly TALLER than the toast content. With `variant="card"` the
   *   inner card drew its own border+rounding INSIDE that window, so the empty window area below the
   *   card read as a second rounded layer under a floating card — the «подложка». In `"plate"` the
   *   component DROPS its own chrome (no `rounded-*`, no `border`, no `shadow-*`) and FILLS the
   *   window (`h-full w-full`, vertically centred), so the DWM-rounded opaque window IS the single
   *   plate surface — one seamless plate, no backing.
   */
  variant?: "card" | "plate";
  /**
   * Body click (D-04) — restores the main window from the tray AND closes the plate. Wired to the
   * plate container so the whole plate (minus the ×) is the click target.
   */
  onBodyClick?: () => void;
  /**
   * × click (D-04) — closes the plate ONLY (does NOT restore the window). `stopPropagation` on the
   * × keeps a close from also triggering the body click.
   */
  onClose?: () => void;
}

export function ConnectionToast({
  icon,
  iconColor,
  title,
  body,
  details,
  closable = true,
  closeLabel = "Закрыть уведомление",
  closeTooltip = "Закрыть",
  variant = "card",
  onBodyClick,
  onClose,
}: ConnectionToastProps) {
  // 13-07 (defect 1 «подложка») + round-4 (match the Storybook design 1:1): the two variants share
  // EVERYTHING except the rounding/shadow (which the WINDOW provides) — same border, padding, gap,
  // item layout, alignment.
  //   - card: the demo Card — own rounding + shadow, width-capped, floating (Storybook/preview).
  //   - plate: the PRODUCTION desktop plate. The DWM-rounded opaque WINDOW is the plate surface, so it
  //            FILLS the window (h-full w-full) and drops the OWN rounding + shadow — but KEEPS the
  //            1px border and top-aligns the row (items-start), matching the Storybook design exactly
  //            (which is 360×67, top-aligned, 1px --color-border, no shadow — the plate window is sized
  //            to that content height in lib.rs so there is no «подложка»). The design has NO drop
  //            shadow (its shadow-lg token resolves to none on this surface), so the plate omits it too.
  const isPlate = variant === "plate";
  // F15 (14-UAT round 2): the plate FILLS the window (the DWM-rounded opaque window is the single plate
  // surface — no «подложка») but must GROW with wrapped content. `min-h-full` (not `h-full`) keeps the
  // fill for short content AND lets the toast's border-box grow when a long config name wraps the body,
  // so #notification-root.scrollHeight includes the toast's FULL height (content + top/bottom padding +
  // border) and the F15 resize preserves the design's bottom inset instead of clipping it.
  const containerClass = isPlate
    ? "flex min-h-full w-full cursor-pointer items-start gap-[var(--space-3)] border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-[var(--space-3)]"
    : "flex w-full max-w-[360px] cursor-pointer items-start gap-[var(--space-3)] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-[var(--space-3)] shadow-[var(--shadow-lg)]";

  return (
    // role=status: a live toast is announced politely (informational, not an alert).
    // The card variant is the design-system Card — rounded-lg, border, shadow — on the ELEVATED
    // surface. The plate variant drops that chrome and fills the (already rounded, opaque) window.
    // Capped at a toast width (card) so the body wraps (never truncates) for long config names. The
    // whole plate is the D-04 body-click target; the × below stops propagation so a close does not
    // also restore.
    <div
      role="status"
      onClick={onBodyClick}
      className={containerClass}
      // TA-10: stable semantic marker for the surface variant. The plate/card distinction
      // (rounding + shadow dropped on the DWM-rounded window) is driven by the `variant` prop;
      // tests assert on this attribute rather than Tailwind class substrings, per «test behaviour,
      // not CSS». The precise visual chrome is a Storybook concern.
      data-variant={variant}
    >
      {/* State icon — the only saturated element, so a glance at the colour reads the state.
          aria-hidden: the title carries the meaning for screen readers. BOTH variants top-align the
          row (items-start), so the icon gets the same tiny top nudge to align with the title's cap
          height (matches the Storybook design). */}
      <span className="mt-0.5 shrink-0" style={{ color: iconColor }} aria-hidden="true">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-[var(--color-text-primary)]">{title}</p>
        {/* Body shown IN FULL — wraps to a second line if it does not fit (NO truncation, no «…»);
            the toast is width-capped, not text-clipped, so long config names stay readable.
            Rendered as React text (V5 — no dangerouslySetInnerHTML). */}
        <p className="mt-0.5 text-xs text-[var(--color-text-secondary)]">{body}</p>
        {/* 13-08: optional detail rows (address / login / ping) under the body for CONNECT plates.
            A hairline separator sets them apart from the body; each row is a small muted icon + a
            value (mono for addresses/pings). Rendered as text (D-29 — display values only, never
            the password). */}
        {details && details.length > 0 && (
          <div className="mt-[var(--space-2)] flex flex-col gap-[var(--space-1)] border-t border-[var(--color-border)] pt-[var(--space-2)]">
            {details.map((d, i) => (
              <div
                key={i}
                className="flex items-center gap-[var(--space-2)] text-[11px] leading-tight text-[var(--color-text-secondary)]"
              >
                {d.icon && (
                  <span className="shrink-0 text-[var(--color-text-muted)]" aria-hidden="true">
                    {d.icon}
                  </span>
                )}
                <span
                  className={`min-w-0 truncate ${d.mono ? "font-mono tabular-nums" : ""}`}
                  style={d.valueColor ? { color: d.valueColor } : undefined}
                >
                  {d.value}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      {closable && (
        <IconButton
          aria-label={closeLabel}
          tooltip={closeTooltip}
          icon={<X className="h-3.5 w-3.5" />}
          className="-mr-1 -mt-1 h-6 w-6 shrink-0"
          onClick={(e) => {
            // D-04: × closes the plate ONLY. Stop propagation so the enclosing body-click
            // (restore-the-window) does NOT also fire on a close.
            e.stopPropagation();
            onClose?.();
          }}
        />
      )}
    </div>
  );
}
