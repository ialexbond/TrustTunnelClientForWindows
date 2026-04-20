import { useTranslation } from "react-i18next";
import { Link2, FolderOpen, Trash2 } from "lucide-react";
import { Card, CardHeader } from "../../shared/ui/Card";
import { Input } from "../../shared/ui/Input";
import { PasswordInput } from "../../shared/ui/PasswordInput";
import type { SettingsState } from "./useSettingsState";

interface Props {
  state: SettingsState;
}

export function ConnectionSection({ state }: Props) {
  const { t } = useTranslation();
  const { config, localPath, browseConfig, clearConfig } = state;

  return (
    <Card padding="md">
      <CardHeader
        icon={<Link2 className="w-4 h-4" />}
        title={t("sections.connection")}
      />

      {/* Config file path */}
      <div className="mb-2">
        <label className="block text-xs font-medium mb-1" style={{ color: "var(--color-text-secondary)" }}>
          {t("labels.config_file")}
        </label>
        <div className="flex items-center gap-1.5">
          <div className="flex-1 min-w-0">
            <Input
              value={localPath}
              readOnly
              placeholder="trusttunnel_client.toml"
              className=""
            />
          </div>
          <button
            onClick={browseConfig}
            title={t("buttons.select_file")}
            className="shrink-0 inline-flex items-center justify-center rounded-[var(--radius-lg)] px-2.5 h-8 transition-colors"
            style={{
              backgroundColor: "var(--color-bg-hover)",
              border: "1px solid var(--color-border)",
              color: "var(--color-text-primary)",
            }}
          >
            <FolderOpen className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={clearConfig}
            title={t("buttons.delete")}
            className="shrink-0 inline-flex items-center justify-center rounded-[var(--radius-lg)] px-2.5 h-8 transition-colors"
            style={{
              backgroundColor: "var(--color-danger-tint-08)",
              border: "1px solid var(--color-danger-tint-25)",
              color: "var(--color-danger-500)",
            }}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Read-only connection info — 3 columns */}
      {config && (
        <div className="grid grid-cols-3 gap-1.5">
          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: "var(--color-text-secondary)" }}>
              {t("labels.host")}
            </label>
            <Input
              value={config.endpoint?.hostname || ""}
              readOnly
              disabled
              className=""
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: "var(--color-text-secondary)" }}>
              {t("labels.username")}
            </label>
            <Input
              value={config.endpoint?.username || ""}
              readOnly
              disabled
              className=""
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: "var(--color-text-secondary)" }}>
              {t("labels.password")}
            </label>
            <PasswordInput
              value={config.endpoint?.password || ""}
              readOnly
              disabled
              showIcon={false}
              className=""
            />
          </div>
        </div>
      )}
    </Card>
  );
}
