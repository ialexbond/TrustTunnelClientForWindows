import { useTranslation } from "react-i18next";
import { Shield, Unplug, Fingerprint, Lock, HelpCircle } from "lucide-react";
import { Card, CardHeader } from "../../shared/ui/Card";
import { Toggle } from "../../shared/ui/Toggle";
import { Tooltip } from "../../shared/ui/Tooltip";
import type { SettingsState } from "./useSettingsState";

interface Props {
  state: SettingsState;
}

function TooltipIcon({ text }: { text: string }) {
  return (
    <Tooltip text={text}>
      <HelpCircle
        className="w-3 h-3 cursor-help"
        style={{ color: "var(--color-text-muted)" }}
      />
    </Tooltip>
  );
}

export function SecuritySection({ state }: Props) {
  const { t } = useTranslation();
  const { config, updateField } = state;
  if (!config) return null;

  return (
    <Card padding="md">
      <CardHeader
        icon={<Shield className="w-4 h-4" />}
        title={t("settings.security.title")}
      />

      <div className="space-y-0.5">
        <Toggle
          value={config.killswitch_enabled}
          onChange={(v) => updateField("killswitch_enabled", v)}
          label={t("features.kill_switch")}
          description={t("help_text.kill_switch")}
          icon={<Unplug className="w-3.5 h-3.5" />}
          labelExtra={<TooltipIcon text={t("tooltips.kill_switch_detailed")} />}
        />
        <Toggle
          value={config.endpoint?.anti_dpi || false}
          onChange={(v) => updateField("endpoint.anti_dpi", v)}
          label={t("features.anti_dpi")}
          description={t("help_text.anti_dpi")}
          icon={<Fingerprint className="w-3.5 h-3.5" />}
          labelExtra={<TooltipIcon text={t("tooltips.anti_dpi_detailed")} />}
        />
        <Toggle
          value={config.post_quantum_group_enabled}
          onChange={(v) => updateField("post_quantum_group_enabled", v)}
          label={t("features.post_quantum")}
          description={t("help_text.post_quantum")}
          icon={<Lock className="w-3.5 h-3.5" />}
          labelExtra={<TooltipIcon text={t("tooltips.post_quantum_detailed")} />}
        />
      </div>

    </Card>
  );
}
