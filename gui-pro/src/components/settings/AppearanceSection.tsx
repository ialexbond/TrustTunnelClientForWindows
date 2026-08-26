import { useTranslation } from "react-i18next";
import { Monitor, Moon, Palette, Sun } from "lucide-react";
import type { ThemeMode } from "../../shared/types";
import {
  SegmentedControl,
  SettingsCard,
  SettingsRow,
  type SegmentedOption,
} from "../../shared/ui";

// AppSettingsPanel imports ThemeMode from here rather than from shared/types. Keeping the
// re-export is not tidiness — removing it would break that import for a rename this section has no
// reason to force.
export type { ThemeMode } from "../../shared/types";

interface Props {
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
  language: string;
  onLanguageChange: (lang: string) => void;
}

/**
 * «Внешний вид» — two rows, each a one-line choice.
 *
 * Phase 28 (28-06): the two `Select` dropdowns became two `SegmentedControl` radiogroups. A
 * dropdown cost two presses and hid the alternatives; there are three themes and two languages, and
 * they fit on one line even at the window's 800px minimum, so the choice is simply shown.
 *
 * BOTH ROWS CARRY A DESCRIPTION, and each one earns its place by saying something the label cannot.
 * This was the only card on the tab whose rows had a bare label, which made the two rows read as
 * unfinished beside every other row on the tab — and the label alone left the one genuinely
 * non-obvious thing about each control unsaid. «Системная» does not merely pick a theme once: it
 * follows the Windows appearance setting and re-resolves live when that setting flips (`useTheme`
 * keeps a `prefers-color-scheme` listener open for exactly that mode). And the language applies
 * immediately, with no restart, reaching the tray menu and the desktop notification plate as well
 * as the window (`useLanguage` calls `changeLanguage`, emits `update-tray-language` and mirrors the
 * language into Rust). Neither fact is guessable from «Тема оформления» / «Язык интерфейса».
 *
 * The rows carry no icon, and that is deliberate rather than an omission: a card whose rows have no
 * icon at all skips the icon column entirely (`SettingsRow`), so two rows are consistent with each
 * other. «Авто-режим» and «Экспериментальные функции» are built the same way.
 *
 * The section deliberately owns NEITHER value. `App` holds the theme and the language and passes
 * them down; moving that ownership here would take the whole application's theming with it. Only
 * the control changed — the prop contract is exactly what it was.
 *
 * There is no loading state and no error state, and that is a property rather than a gap: both
 * values apply in place, nothing is sent anywhere, so there is nothing to wait for and nothing that
 * can fail.
 */
export function AppearanceSection({ theme, onThemeChange, language, onLanguageChange }: Props) {
  const { t } = useTranslation();

  const themeLabel = t("settings.app.theme");
  const languageLabel = t("settings.app.language");

  const themeOptions: SegmentedOption[] = [
    {
      value: "system",
      label: t("settings.app.theme_system"),
      icon: <Monitor className="h-3.5 w-3.5" />,
    },
    { value: "dark", label: t("settings.app.theme_dark"), icon: <Moon className="h-3.5 w-3.5" /> },
    { value: "light", label: t("settings.app.theme_light"), icon: <Sun className="h-3.5 w-3.5" /> },
  ];

  // No icon on the language options, on purpose: a flag names a COUNTRY, not a language, and a
  // letter badge beside the language's own name adds nothing the name does not already say. The
  // names are literals rather than dictionary lookups because each is written in its own language
  // and is therefore the same in both bundles.
  const languageOptions: SegmentedOption[] = [
    { value: "ru", label: "Русский" },
    { value: "en", label: "English" },
  ];

  return (
    <SettingsCard
      icon={<Palette className="h-4 w-4" />}
      title={t("settings.app.appearance_title")}
      // This was the ONE card on the tab with no caption, which made it read as unfinished beside
      // the three that have one. It names what the card holds — the two rows below it — in the same
      // voice as its siblings («Поведение при запуске приложения», «Автоматическое подключение и
      // уведомления»): a short noun phrase, no verb, no full stop.
      description={t("settings.app.appearance_description")}
    >
      <div>
        <SettingsRow
          label={themeLabel}
          description={t("settings.app.theme_desc")}
          control={
            <SegmentedControl
              options={themeOptions}
              value={theme}
              onChange={(value) => onThemeChange(value as ThemeMode)}
              aria-label={themeLabel}
            />
          }
        />
        <SettingsRow
          separated
          label={languageLabel}
          description={t("settings.app.language_desc")}
          control={
            <SegmentedControl
              options={languageOptions}
              value={language}
              onChange={onLanguageChange}
              aria-label={languageLabel}
            />
          }
        />
      </div>
    </SettingsCard>
  );
}
