import { useTranslation } from "react-i18next";
import { Settings, FolderOpen } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import type { VpnConfig } from "../shared/types";

interface ConfigPanelProps {
  config: VpnConfig;
  onConfigChange: (config: VpnConfig) => void;
}

const LOG_LEVELS = ["error", "warn", "info", "debug", "trace"];

function ConfigPanel({ config, onConfigChange }: ConfigPanelProps) {
  const { t } = useTranslation();

  return (
    <div className="glass-card p-4 flex flex-col gap-3 lg:col-span-1">
      <div className="flex items-center gap-2">
        <Settings className="w-3.5 h-3.5" style={{ color: "var(--color-accent-interactive)" }} />
        <h2 className="text-xs font-medium uppercase tracking-wider" style={{ color: "var(--color-text-secondary)" }}>
          {t('configPanel.title')}
        </h2>
      </div>

      <div className="space-y-3">
        <div>
          <label className="block text-[11px] mb-1" style={{ color: "var(--color-text-muted)" }}>
            {t('configPanel.configFile')}
          </label>
          <div className="flex gap-1.5">
            <input
              type="text"
              value={config.configPath}
              onChange={(e) =>
                onConfigChange({ ...config, configPath: e.target.value })
              }
              className="flex-1 rounded-lg px-3 py-1.5 text-xs outline-none transition-colors"
              style={{
                backgroundColor: "var(--color-input-bg)",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "var(--color-input-border)",
                color: "var(--color-text-primary)",
              }}
              placeholder="trusttunnel_client.toml"
            />
            <button
              onClick={async () => {
                const selected = await open({
                  multiple: false,
                  filters: [{ name: "TOML Config", extensions: ["toml"] }],
                });
                if (selected) {
                  onConfigChange({ ...config, configPath: selected as string });
                }
              }}
              className="p-1.5 rounded-lg transition-colors"
              style={{
                backgroundColor: "var(--color-input-bg)",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "var(--color-input-border)",
                color: "var(--color-text-secondary)",
              }}
              title={t('configPanel.selectFile')}
            >
              <FolderOpen className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div>
          <label className="block text-[11px] mb-1" style={{ color: "var(--color-text-muted)" }}>
            {t('configPanel.logLevel')}
          </label>
          <select
            value={config.logLevel}
            onChange={(e) =>
              onConfigChange({ ...config, logLevel: e.target.value })
            }
            className="w-full rounded-lg px-3 py-1.5 text-xs outline-none transition-colors appearance-none"
            style={{
              backgroundColor: "var(--color-input-bg)",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: "var(--color-input-border)",
              color: "var(--color-text-primary)",
            }}
          >
            {LOG_LEVELS.map((level) => (
              <option key={level} value={level} className="bg-[var(--color-bg-primary)]">
                {level.toUpperCase()}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-auto pt-3" style={{ borderTop: "1px solid var(--color-border)" }}>
        <div className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>
          <p>Sidecar: trusttunnel_client &bull; TOML</p>
        </div>
      </div>
    </div>
  );
}

export default ConfigPanel;
