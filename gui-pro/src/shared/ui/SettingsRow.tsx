import type { ReactNode } from "react";

export interface SettingsRowProps {
  /** A Lucide glyph. When omitted the fixed icon column is not rendered at all — see below. */
  icon?: ReactNode;
  /**
   * Where the glyph sits when the row has a description under its label.
   *
   * `center` (the default, and what every «Настройки» row uses) centres it against the whole
   * label+description block. That is right for a card whose rows share an icon COLUMN: the glyphs
   * line up with each other, and the column is what the eye reads, not any single glyph.
   *
   * `label` puts it on the label line instead. That is right for a LONE row, where a centred glyph
   * has no column to belong to and simply floats between the two lines — read, correctly, as a
   * stray mark rather than as the label's icon. «Фильтрация по процессам» on the Routing tab is the
   * one such row.
   */
  iconAlign?: "center" | "label";
  label: string;
  description?: string;
  /** Usually a `HelpHint`. Sits immediately after the last word of the label. */
  labelExtra?: ReactNode;
  /** The switch / segmented control / action that this row operates. */
  control: ReactNode;
  /** Draw the hairline ABOVE this row. True for every row except the first one in a card. */
  separated?: boolean;
}

/**
 * `[icon slot] [label + description, flexible] [control, shrink-proof]`.
 *
 * The label is 14px/500 and the description 12px/400 muted — a real two-level hierarchy, replacing
 * the tab's previous two near-equal 12px lines. Neither ever truncates: a truncated sentence about
 * what a setting does is worse than a tall row, so the label column wraps. The row itself does NOT
 * wrap (no `flex-wrap`), so the control keeps its own cell however tall the label grows —
 * vertically centred against it, because the row is `items-center`. The tab is read at 768px
 * minimum and both lines must wrap there.
 *
 * The icon column has a FIXED width so that labels align across a card — but it is rendered only
 * when the card actually uses icons. A card whose rows carry no icon at all (the failover card is
 * one) would otherwise pay a permanent empty indent that reads as a layout bug.
 *
 * The row is not clickable as a whole and therefore carries no hover background: the control is the
 * target, and a row hover would promise a click that does not exist.
 *
 * Lifted from the Phase-27 story tier (`components/_story/settingsDemos.tsx`) unchanged apart from
 * its import path.
 */
export function SettingsRow({
  icon,
  iconAlign = "center",
  label,
  description,
  labelExtra,
  control,
  separated = false,
}: SettingsRowProps) {
  return (
    <div
      className={`flex min-h-[44px] items-center gap-[var(--space-2)] py-[var(--space-3)] ${
        separated ? "border-t border-[var(--color-border)]" : ""
      }`}
    >
      {icon !== undefined && (
        <span
          // `label` alignment: a 20px-tall box pinned to the top of the row's content, with the
          // glyph centred inside it. 20px is the label's own line-height (`text-sm` => 1.25rem), so
          // the glyph lands optically centred on the label's first line whatever the description
          // does below it — no magic offset to re-tune when the type scale moves.
          className={`flex w-[var(--space-5)] shrink-0 justify-center ${
            iconAlign === "label" ? "h-5 items-center self-start" : ""
          }`}
          style={{ color: "var(--color-text-muted)" }}
          aria-hidden="true"
        >
          {icon}
        </span>
      )}
      <div className="min-w-0 flex-1">
        {/* A <div>, not a <p>: `labelExtra` is a HelpHint, whose Tooltip root element is a <div>,
            and <p> cannot legally contain one — React logs «<p> cannot contain a nested <div>» and
            an HTML parser (SSR, a static snapshot) would auto-close the <p> and split the label in
            two. A <span> would not fix it either — a <div> inside phrasing content is just as
            illegal; a block <div> is. Typography is unchanged. */}
        <div className="text-sm font-medium" style={{ color: "var(--color-text-primary)" }}>
          {label}
          {labelExtra && (
            <span className="ml-[var(--space-1)] inline-flex align-middle">{labelExtra}</span>
          )}
        </div>
        {description && (
          <p className="mt-0.5 text-xs" style={{ color: "var(--color-text-muted)" }}>
            {description}
          </p>
        )}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}
