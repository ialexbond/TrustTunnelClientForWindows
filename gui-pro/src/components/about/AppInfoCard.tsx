import { useTranslation } from "react-i18next";
import { Heart, Info } from "lucide-react";
import { Card } from "../../shared/ui/Card";
// `PanelHeader`, not `CardHeader` (G-30-17b) — see the note at the same import in `UpdateCard`.
// Both headings on this tab move together: fixing one and leaving the other would replace a tab
// that disagrees with «Настройки» by a tab that disagrees with itself.
import { PanelHeader } from "../../shared/ui/PanelHeader";

/**
 * «О приложении» — what this program is, and the honest note about how it is written.
 *
 * Ported from the story tier's own drawing of this card, which has since been deleted — the showcase
 * now renders THIS component. Before the port this was a hand-rolled
 * `div` with a border and a radius inside `AboutPanel`, carrying no heading at all — which is why
 * it read as a loose paragraph rather than as a section of the screen. It is now the shared `Card`,
 * with a title.
 *
 * ONE CARD, NOT TWO.
 *
 * The note about vibe coding is a QUALIFICATION of the description, not a second claim. Split into
 * its own card it would carry the same weight as the description of the product itself, and the
 * reader would take the two as unrelated statements. It therefore stays inside, in a recessed inner
 * block on the elevated background step, with its glyph in a fixed column of its own so the text
 * never wraps underneath it. The inset is recessed rather than warning-coloured for the same
 * reason: this is a fact about the program's origin, not a risk.
 *
 * NEITHER STRING IS REWORDED HERE.
 *
 * `about.description` and `about.vibe_coding` already existed and are rendered through `t()`
 * untouched. The design transcribed both verbatim from this bundle precisely so the port changes
 * PRESENTATION and never CLAIMS — a redesign that quietly rewrites a product statement is an
 * unreviewed copy change wearing a layout change's clothes. Two test cases assert both strings
 * byte-for-byte against the bundle, so a reword cannot pass quietly.
 *
 * The card has no controls at all, which is why its only states are the widths the window can have.
 */
export function AppInfoCard() {
  const { t } = useTranslation();

  return (
    <Card padding="md" className="w-full">
      {/* The title is NEW in this design — the block previously had none. */}
      <PanelHeader title={t("about.app_info_title")} icon={<Info className="w-4 h-4" />} />

      <p className="text-sm leading-relaxed" style={{ color: "var(--color-text-secondary)" }}>
        {t("about.description")}
      </p>

      <div
        className="mt-[var(--space-3)] flex items-start gap-[var(--space-3)] rounded-[var(--radius-md)] p-[var(--space-3)]"
        style={{ backgroundColor: "var(--color-bg-elevated)" }}
      >
        <Heart
          className="mt-0.5 h-4 w-4 shrink-0"
          style={{ color: "var(--color-accent-fg)" }}
          aria-hidden="true"
        />
        {/* `min-w-0 flex-1` keeps the glyph column fixed while the text reflows: without it a long
            line at the narrowest window width squeezes the glyph out of its own column. */}
        <p
          className="min-w-0 flex-1 text-xs leading-relaxed"
          style={{ color: "var(--color-text-secondary)" }}
        >
          {t("about.vibe_coding")}
        </p>
      </div>
    </Card>
  );
}
