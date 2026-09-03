import { type ReactNode, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { GeneralSection } from "./settings/GeneralSection";
import { AutoModeSettings } from "./settings/AutoModeSettings";
import { AppearanceSection, type ThemeMode } from "./settings/AppearanceSection";
import { useSnackBar } from "../shared/ui/SnackBarContext";

interface Props {
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
  language: string;
  onLanguageChange: (lang: string) => void;
  statusPanel?: ReactNode;
  /**
   * Phase 14 (D-13): a seamless A→B switch is in flight (App-owned isSwitching). Passed straight to
   * AutoModeSettings as `locked` so its master toggle + priority reorder are inert while switching —
   * a mid-switch master-on / reorder could arm a competing switch (Pitfall 5). Pure pass-through.
   */
  isSwitching?: boolean;
  /** Path of the config the tunnel runs through. Pure pass-through to AutoModeSettings, which needs
   *  it to collapse same-server twins the same way «Подключение» does. */
  activeConfigPath?: string;
}

export default function AppSettingsPanel({
  theme,
  onThemeChange,
  language,
  onLanguageChange,
  statusPanel,
  isSwitching = false,
  activeConfigPath,
}: Props) {
  const { t } = useTranslation();
  const pushSnack = useSnackBar();

  const showSaved = useCallback(() => {
    pushSnack(t("messages.settings_saved"));
  }, [t, pushSnack]);

  /**
   * The other half of the same contract: a section reports a write that did NOT persist.
   *
   * It takes the same slot as the confirmation — the shared snackbar — because a change and its
   * refusal are the same event to the user and answering them in two different places would make
   * the failure the easier one to miss. The primitive supplies the rest of the design's rule: an
   * error is a `role="alert"` / `aria-live="assertive"` region (urgent, not queued behind the
   * polite confirmation), it is held for 5s rather than 3s so there is time to read it, and it
   * carries a close button so the user can put it away instead of waiting.
   *
   * T-28-20: the callback takes NO argument. There is nothing for a caller to pass, so a backend
   * error string cannot reach the screen even by accident — the sentence rendered is always the
   * localized one.
   */
  const showSaveFailed = useCallback(() => {
    pushSnack(t("messages.settings_save_failed"), "error");
  }, [t, pushSnack]);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {statusPanel}
      <div className="flex-1 scroll-overlay py-3 px-4 space-y-4">
        <GeneralSection onSaved={showSaved} onSaveFailed={showSaveFailed} />
        {/* 12-07: «Авто-режим» mounts right after «Основные», before «Внешний вид» (RESEARCH
            §Pattern 3). It groups all connection-automation prefs (auto-switch master + params +
            priority list, the MOVED startup auto-connect toggle, notifications). It owns its own
            useAppSettings/useConfigList — AppSettingsPanel only feeds onSaved, like the siblings. */}
        {/* 28-06: «Внешний вид» applies its change in place (a theme, a language) — there is no
            write that can refuse, so handing it a callback it could never fire would be a dead prop,
            and a dead prop reads as a wired one.
            WR-02 (Phase-28 review): «Авто-режим» is no longer in that group. The 28-06 note said
            it «treats its one backend call, reorder_configs, as deliberately optimistic» — but
            that stopped being its only backend call in this same phase. `set_failover_settings` is
            the second, and it is the one the whole feature depends on: if it refuses, the master
            toggle shows ON while `app_settings.json` reads OFF and the monitor never fires, with
            nothing on screen saying why. */}
        <AutoModeSettings
          onSaved={showSaved}
          onSaveFailed={showSaveFailed}
          locked={isSwitching}
          activeConfigPath={activeConfigPath}
        />
        <AppearanceSection
          theme={theme}
          onThemeChange={(t) => { onThemeChange(t); showSaved(); }}
          language={language}
          onLanguageChange={(l) => { onLanguageChange(l); showSaved(); }}
        />
        {/* Здесь была четвёртая карточка — «Экспериментальные функции», предупреждающего тона, с
            одним тумблером «Блокировка сайтов». Блокировка удалена 2026-09-03 (решение владельца:
            она не работала и не могла работать без правки замороженного C++-ядра), а других
            экспериментальных функций в секции не было. Пустая карточка предупреждающего тона хуже,
            чем её отсутствие, поэтому убрана вся секция, а не только строка. */}
      </div>
    </div>
  );
}
