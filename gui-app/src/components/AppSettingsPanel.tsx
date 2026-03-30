import { type ReactNode, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { GeneralSection } from "./settings/GeneralSection";
import { AppearanceSection, type ThemeMode } from "./settings/AppearanceSection";
import { ExperimentalSection } from "./settings/ExperimentalSection";
import { useSnackBar } from "../shared/ui/SnackBarContext";

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
  const pushSnack = useSnackBar();

  const showSaved = useCallback(() => {
    pushSnack(t("messages.settings_saved"));
  }, [t, pushSnack]);

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
    </div>
  );
}
