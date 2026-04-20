import { useTranslation } from "react-i18next";
import { FlaskConical, Ban } from "lucide-react";
import { Card, CardHeader } from "../../shared/ui/Card";
import { Toggle } from "../../shared/ui/Toggle";
import { useFeatureToggles } from "../../shared/hooks/useFeatureToggles";

export function ExperimentalSection() {
  const { t } = useTranslation();
  const { toggles, update } = useFeatureToggles();

  return (
    <Card padding="md">
      <CardHeader
        icon={<FlaskConical className="w-4 h-4" />}
        title={t("settings.experimental.title")}
        description={t("settings.experimental.description")}
      />

      <Toggle
        value={toggles.blockRouting}
        onChange={(v) => update("blockRouting", v)}
        label={t("settings.experimental.block_routing")}
        description={t("settings.experimental.block_routing_desc")}
        icon={<Ban className="w-3.5 h-3.5" />}
      />
    </Card>
  );
}
