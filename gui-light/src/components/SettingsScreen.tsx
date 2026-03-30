import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { ScrollText } from "lucide-react";
import type { ThemeMode } from "../shared/types";
import { GeneralSection } from "./settings/GeneralSection";
import { AppearanceSection } from "./settings/AppearanceSection";
import { Card, CardHeader } from "../shared/ui/Card";
import { Toggle } from "../shared/ui/Toggle";

interface SettingsScreenProps {
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
  language: string;
  onLanguageChange: (lang: string) => void;
  hasConfig: boolean;
}

function SettingsScreen({
  theme,
  onThemeChange,
  language,
  onLanguageChange,
  hasConfig,
}: SettingsScreenProps) {
  const { t } = useTranslation();
  const [loggingEnabled, setLoggingEnabled] = useState(false);

  useEffect(() => {
    invoke<boolean>("get_logging_enabled").then(setLoggingEnabled).catch(() => {});
  }, []);

  const handleLoggingChange = useCallback(async (value: boolean) => {
    try {
      await invoke("set_logging_enabled", { enabled: value });
      setLoggingEnabled(value);
    } catch { /* ignore */ }
  }, []);

  return (
    <div className="flex-1 scroll-overlay py-4 px-4 space-y-4">
      <GeneralSection hasConfig={hasConfig} />
      <AppearanceSection
        theme={theme}
        onThemeChange={onThemeChange}
        language={language}
        onLanguageChange={onLanguageChange}
      />
      <Card padding="md">
        <CardHeader
          icon={<ScrollText className="w-4 h-4" />}
          title={t("settings.app.logging_title", "Logging")}
        />
        <Toggle
          value={loggingEnabled}
          onChange={handleLoggingChange}
          label={t("settings.app.logging_enable", "Write logs to file")}
          description={t("settings.app.logging_desc", "Save VPN connection logs to .log file")}
          icon={<ScrollText className="w-3.5 h-3.5" />}
        />
      </Card>
    </div>
  );
}

export default SettingsScreen;
