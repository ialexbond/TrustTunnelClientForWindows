import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { emit } from "@tauri-apps/api/event";

export function useLanguage() {
  const { i18n } = useTranslation();

  // Sync tray menu language on mount and language changes
  useEffect(() => {
    emit("update-tray-language", { language: i18n.language }).catch(() => {});
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
