import { useTranslation } from "react-i18next";
import { Card } from "../../../shared/ui/Card";
import { ToggleField } from "./fields/ToggleField";
import type { TomlFieldSchema, TomlFieldType } from "./types";

/**
 * Phase 15.1 D-1.1 — Quick Settings Card.
 *
 * 4 boolean toggles from vpn.toml at top of Configuration tab:
 *   - ipv6_available
 *   - allow_private_network_connections
 *   - speedtest_enable
 *   - ping_enable
 *
 * Layout: 1 Card "Быстрые настройки" с 4 inline rows (label + Info + helper + Toggle справа).
 * Each row composed via shared ToggleField primitive (Plan 15.1-03).
 *
 * Если bundle ещё не загружен (schema lookup → undefined), renders placeholder
 * schema (kind: "boolean", value: false) — пользователь видит default state
 * за время загрузки. Real values appear after bundle resolves.
 */
const QUICK_TOGGLE_KEYS = [
  "ipv6_available",
  "allow_private_network_connections",
  "speedtest_enable",
  "ping_enable",
] as const;

export interface QuickSettingsCardProps {
  /** Lookup function — passes path to retrieve TomlFieldSchema. */
  getSchema: (path: string[]) => TomlFieldSchema | undefined;
  onChange: (path: string[], value: boolean) => void;
  disabled?: boolean;
}

export function QuickSettingsCard({
  getSchema,
  onChange,
  disabled,
}: QuickSettingsCardProps) {
  const { t } = useTranslation();

  return (
    <Card>
      <h2 className="text-title-sm text-[var(--color-text-primary)] mb-3">
        {t("server.config.quick_settings_title")}
      </h2>
      <div className="flex flex-col divide-y divide-[var(--color-border)]">
        {QUICK_TOGGLE_KEYS.map((key) => {
          const schema = getSchema([key]);
          if (!schema) {
            // Schema not loaded yet OR key missing from current bundle.
            // Render placeholder schema so user sees default value за время загрузки.
            const placeholder: TomlFieldSchema = {
              key,
              path: [key],
              type: { kind: "boolean", value: false } as TomlFieldType,
              isExplicit: false,
              tooltipKey: `server.config.field_desc.vpn.${key}`,
            };
            return (
              <ToggleField
                key={key}
                schema={placeholder}
                onChange={(path, value) => onChange(path, value)}
                disabled={disabled}
              />
            );
          }
          return (
            <ToggleField
              key={key}
              schema={schema}
              onChange={(path, value) => onChange(path, value)}
              disabled={disabled}
            />
          );
        })}
      </div>
    </Card>
  );
}
