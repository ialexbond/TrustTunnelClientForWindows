import { useTranslation } from "react-i18next";
import { Palette } from "lucide-react";
import { Card, CardHeader } from "../../shared/ui/Card";
import { Select } from "../../shared/ui/Select";

export type ThemeMode = "system" | "dark" | "light";

interface Props {
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
  language: string;
  onLanguageChange: (lang: string) => void;
}

export function AppearanceSection({ theme, onThemeChange, language, onLanguageChange }: Props) {
  const { t } = useTranslation();

  const themeOptions = [
    { value: "system", label: t("settings.app.theme_system") },
    { value: "dark", label: t("settings.app.theme_dark") },
    { value: "light", label: t("settings.app.theme_light") },
  ];

  const languageOptions = [
    { value: "ru", label: "Русский" },
    { value: "en", label: "English" },
  ];

  return (
    <Card padding="md">
      <CardHeader
        icon={<Palette className="w-4 h-4" />}
        title={t("settings.app.appearance_title")}
      />

      <div className="space-y-3">
        <Select
          label={t("settings.app.theme")}
          options={themeOptions}
          value={theme}
          onChange={(e) => onThemeChange(e.target.value as ThemeMode)}
        />
        <Select
          label={t("settings.app.language")}
          options={languageOptions}
          value={language}
          onChange={(e) => onLanguageChange(e.target.value)}
        />
      </div>
    </Card>
  );
}
