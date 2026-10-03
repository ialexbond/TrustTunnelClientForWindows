import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

export function useLanguage() {
  const { i18n } = useTranslation();

  // Sync tray menu language + the desktop notification plate's language on mount and language changes.
  useEffect(() => {
    emit("update-tray-language", { language: i18n.language }).catch(() => {});
    // Phase 13 (13-07) — mirror the UI language into the Rust plate-language cell so notify::maybe_fire
    // threads it into the notify-plate payload and the plate renders the right-language copy even with
    // the main window closed to tray (localStorage is not shared across webview windows — Pitfall 5).
    // Normalize a region locale ("en-US") to the 2-value whitelist; Rust coerces anything non-"en" to
    // "ru" anyway. `.catch` swallows a non-Tauri/test-env rejection. Mirrors the useTheme plate mirror.
    const lang = i18n.language.startsWith("en") ? "en" : "ru";
    invoke("set_plate_language", { language: lang }).catch(() => {});
  }, [i18n.language]);

  const handleLanguageChange = useCallback((lang: string) => {
    i18n.changeLanguage(lang);
    localStorage.setItem("tt_language", lang);
    emit("update-tray-language", { language: lang }).catch(() => {});
  }, [i18n]);

  const toggleLanguage = useCallback(() => {
    const next = i18n.language === "ru" ? "en" : "ru";
    handleLanguageChange(next);
  }, [i18n, handleLanguageChange]);

  return { i18n, handleLanguageChange, toggleLanguage };
}
