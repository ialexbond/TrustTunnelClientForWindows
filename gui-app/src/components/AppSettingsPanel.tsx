import { type ReactNode, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { GeneralSection } from "./settings/GeneralSection";
import { AppearanceSection, type ThemeMode } from "./settings/AppearanceSection";
import { ExperimentalSection } from "./settings/ExperimentalSection";
import { SnackBar } from "../shared/ui/SnackBar";

interface Props {
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
  language: string;
  onLanguageChange: (lang: string) => void;
  hasConfig: boolean;
  statusPanel?: ReactNode;
}

export default function AppSettingsPanel({
  theme,
  onThemeChange,
  language,
  onLanguageChange,
  hasConfig,
  statusPanel,
}: Props) {
  const { t } = useTranslation();
  const [snackMessages, setSnackMessages] = useState<string[]>([]);

  const showSaved = useCallback(() => {
    setSnackMessages((prev) => [...prev, t("messages.settings_saved")]);
  }, [t]);

  const shiftSnack = useCallback(() => {
    setSnackMessages((prev) => prev.slice(1));
  }, []);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {statusPanel}
      <div className="flex-1 scroll-overlay py-3 px-4 space-y-4">
        <GeneralSection hasConfig={hasConfig} onSaved={showSaved} />
        <AppearanceSection
          theme={theme}
          onThemeChange={(t) => { onThemeChange(t); showSaved(); }}
          language={language}
          onLanguageChange={(l) => { onLanguageChange(l); showSaved(); }}
        />
        <ExperimentalSection />
      </div>
      <SnackBar messages={snackMessages} onShown={shiftSnack} duration={1500} />
    </div>
  );
}
