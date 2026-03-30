import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Settings, Power, EyeOff, Zap, HelpCircle } from "lucide-react";
import { Card, CardHeader } from "../../shared/ui/Card";
import { Toggle } from "../../shared/ui/Toggle";
import { Tooltip } from "../../shared/ui/Tooltip";

interface Props {
  hasConfig: boolean;
  onAutoConnectChange?: (enabled: boolean) => void;
  onSaved?: () => void;
}

export function GeneralSection({ hasConfig, onAutoConnectChange, onSaved }: Props) {
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

  // ─── Auto-connect (localStorage) ───
  const [autoConnect, setAutoConnect] = useState(() => {
    return localStorage.getItem("tt_auto_connect") === "true";
  });

  const handleAutoConnect = (value: boolean) => {
    setAutoConnect(value);
    localStorage.setItem("tt_auto_connect", String(value));
    onAutoConnectChange?.(value);
    onSaved?.();
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
          value={autoConnect}
          onChange={handleAutoConnect}
          label={t("settings.app.auto_connect")}
          description={
            hasConfig
              ? t("settings.app.auto_connect_desc")
              : t("settings.app.auto_connect_no_config")
          }
          icon={<Zap className="w-3.5 h-3.5" />}
          disabled={!hasConfig}
          labelExtra={
            !hasConfig ? (
              <Tooltip text={t("settings.app.auto_connect_no_config")}>
                <HelpCircle
                  className="w-3 h-3 cursor-help"
                  style={{ color: "var(--color-text-muted)" }}
                />
              </Tooltip>
            ) : undefined
          }
        />
      </div>
    </Card>
  );
}
