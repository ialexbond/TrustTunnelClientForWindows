import { useTranslation } from "react-i18next";
import { FlaskConical } from "lucide-react";
import { RowToggle, SettingsCard, SettingsRow } from "../../shared/ui";
import { useFeatureToggles } from "../../shared/hooks/useFeatureToggles";

/**
 * «Экспериментальные функции» — one row, on the tab's one warning-toned card.
 *
 * Phase 28 (28-06): moved onto `SettingsCard` + `SettingsRow`. The logic did not change.
 *
 * The card is the same size and carries the same padding as its three neighbours; what differs is
 * TONE. Its header tile is warning-tinted — the only such tile on the whole tab — and that
 * exclusivity is the signal: the contents of this card are not like the others. The colour stays in
 * the header and the body remains neutral.
 *
 * One row, so there is no divider inside the card: a hairline separates rows, and there is nothing
 * here to separate. No per-row glyph either — the tab's pattern is one icon in the card header.
 *
 * What the switch actually does (it reveals the «Заблокировать» block in the Routing tab) is
 * explained on the section's documentation page, NOT inside the card: a settings card does not
 * explain the layout of a neighbouring tab.
 *
 * There is no loading state and no error state — the setting is written to the window's own store
 * immediately, so there is nothing to wait for and nothing that can refuse.
 */
export function ExperimentalSection() {
  const { t } = useTranslation();
  const { toggles, update } = useFeatureToggles();

  const blockRoutingLabel = t("settings.experimental.block_routing");

  return (
    <SettingsCard
      icon={<FlaskConical className="h-4 w-4" />}
      title={t("settings.experimental.title")}
      description={t("settings.experimental.description")}
      variant="warning"
    >
      <SettingsRow
        label={blockRoutingLabel}
        description={t("settings.experimental.block_routing_desc")}
        control={
          <RowToggle
            checked={toggles.blockRouting}
            onChange={(value) => update("blockRouting", value)}
            aria-label={blockRoutingLabel}
          />
        }
      />
    </SettingsCard>
  );
}
