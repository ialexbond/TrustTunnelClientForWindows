import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Settings, Power, EyeOff, FileText, FolderOpen } from "lucide-react";
import { Card, CardHeader } from "../../shared/ui/Card";
import { Toggle } from "../../shared/ui/Toggle";

// Phase 12 (12-07): the «Автоподключение при запуске» toggle MOVED out of «Основные» into
// «Авто-режим» (AutoModeSettings). It reads/writes the SAME `tt_auto_connect` localStorage key
// via useAppSettings — exactly ONE control for that setting now lives in the app (no duplicate).
// The `hasConfig`/`onAutoConnectChange` props (which only fed that toggle's disabled/tooltip
// state + its change callback) were removed together with it. GeneralSection now holds only the
// app-startup-behavior toggles: autostart / start-minimized / logging.
interface Props {
  onSaved?: () => void;
}

export function GeneralSection({ onSaved }: Props) {
  const { t } = useTranslation();

  // ─── Autostart (tauri plugin) ───
  const [autostart, setAutostart] = useState(false);

  useEffect(() => {
    import("@tauri-apps/plugin-autostart").then(({ isEnabled }) => {
      isEnabled().then(setAutostart).catch(() => {});
    });
  }, []);

  const handleAutostartChange = async (value: boolean) => {
    try {
      const { enable, disable } = await import("@tauri-apps/plugin-autostart");
      if (value) {
        await enable();
      } else {
        await disable();
      }
      setAutostart(value);
      onSaved?.();
    } catch {
      // plugin not available in dev mode
    }
  };

  // ─── Start minimized (file flag via Tauri) ───
  const [startMinimized, setStartMinimized] = useState(false);

  useEffect(() => {
    invoke<boolean>("get_start_minimized").then(setStartMinimized).catch(() => {});
  }, []);

  const handleStartMinimized = async (value: boolean) => {
    try {
      await invoke("set_start_minimized", { enabled: value });
      setStartMinimized(value);
      onSaved?.();
    } catch {
      // ignore
    }
  };

  // ─── Logging (flag file via Tauri) ───
  const [loggingEnabled, setLoggingEnabled] = useState(false);

  useEffect(() => {
    invoke<boolean>("get_logging_enabled").then(setLoggingEnabled).catch(() => {});
  }, []);

  const handleLoggingChange = async (value: boolean) => {
    try {
      await invoke("set_logging_enabled", { enabled: value });
      setLoggingEnabled(value);
      onSaved?.();
    } catch {
      // ignore
    }
  };

  const handleOpenLogs = async () => {
    try {
      await invoke("open_logs_folder");
    } catch {
      // ignore
    }
  };

  return (
    <Card padding="md">
      <CardHeader
        icon={<Settings className="w-4 h-4" />}
        title={t("settings.app.general_title")}
        description={t("settings.app.general_description")}
      />

      <div className="space-y-0.5">
        <Toggle
          value={autostart}
          onChange={handleAutostartChange}
          label={t("settings.app.autostart")}
          description={t("settings.app.autostart_desc")}
          icon={<Power className="w-3.5 h-3.5" />}
        />
        <Toggle
          value={startMinimized}
          onChange={handleStartMinimized}
          label={t("settings.app.start_minimized")}
          description={t("settings.app.start_minimized_desc")}
          icon={<EyeOff className="w-3.5 h-3.5" />}
        />
        <Toggle
          value={loggingEnabled}
          onChange={handleLoggingChange}
          label={t("settings.app.logging")}
          description={t("settings.app.logging_desc")}
          icon={<FileText className="w-3.5 h-3.5" />}
        />
        {loggingEnabled && (
          <button
            onClick={handleOpenLogs}
            className="flex items-center gap-1.5 ml-8 mt-1 mb-1 text-xs cursor-pointer"
            style={{ color: "var(--color-accent)" }}
          >
            <FolderOpen className="w-3 h-3" />
            {t("settings.app.logging_show_folder")}
          </button>
        )}
      </div>
    </Card>
  );
}
