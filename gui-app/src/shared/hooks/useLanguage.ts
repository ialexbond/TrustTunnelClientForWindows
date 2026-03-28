import { useCallback } from "react";
import { useTranslation } from "react-i18next";

export function useLanguage() {
  const { i18n } = useTranslation();

  const handleLanguageChange = useCallback((lang: string) => {
    i18n.changeLanguage(lang);
    localStorage.setItem("tt_language", lang);
  }, [i18n]);

  const toggleLanguage = useCallback(() => {
    const next = i18n.language === "ru" ? "en" : "ru";
    handleLanguageChange(next);
  }, [i18n, handleLanguageChange]);

  return { i18n, handleLanguageChange, toggleLanguage };
}
