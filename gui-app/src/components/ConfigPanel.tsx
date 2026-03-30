import { Settings, FolderOpen } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import type { VpnConfig } from "../shared/types";

interface ConfigPanelProps {
  config: VpnConfig;
  onConfigChange: (config: VpnConfig) => void;
}

const LOG_LEVELS = ["error", "warn", "info", "debug", "trace"];

function ConfigPanel({ config, onConfigChange }: ConfigPanelProps) {
  return (
    <div className="glass-card p-4 flex flex-col gap-3 lg:col-span-1">
      <div className="flex items-center gap-2">
        <Settings className="w-3.5 h-3.5 text-indigo-400" />
        <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400">
          Настройки
        </h2>
      </div>

      <div className="space-y-3">
        <div>
          <label className="block text-[11px] text-gray-500 mb-1">
            Файл конфигурации
          </label>
          <div className="flex gap-1.5">
            <input
              type="text"
              value={config.configPath}
              onChange={(e) =>
                onConfigChange({ ...config, configPath: e.target.value })
              }
              className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs
                         text-gray-200 placeholder-gray-600 focus:outline-none focus:border-indigo-500/50
                         focus:ring-1 focus:ring-indigo-500/25 transition-colors"
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
              className="p-1.5 bg-white/5 border border-white/10 rounded-lg
                         hover:bg-white/10 transition-colors text-gray-400 hover:text-gray-200"
              title="Выбрать файл"
            >
              <FolderOpen className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div>
          <label className="block text-[11px] text-gray-500 mb-1">
            Уровень логирования
          </label>
          <select
            value={config.logLevel}
            onChange={(e) =>
              onConfigChange({ ...config, logLevel: e.target.value })
            }
            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs
                       text-gray-200 focus:outline-none focus:border-indigo-500/50
                       focus:ring-1 focus:ring-indigo-500/25 transition-colors appearance-none"
          >
            {LOG_LEVELS.map((level) => (
              <option key={level} value={level} className="bg-surface-900">
                {level.toUpperCase()}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-auto pt-3 border-t border-white/5">
        <div className="text-[10px] text-gray-600">
          <p>Sidecar: trusttunnel_client • TOML</p>
        </div>
      </div>
    </div>
  );
}

export default ConfigPanel;
