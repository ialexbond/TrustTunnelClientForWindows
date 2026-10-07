import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import ru from "./locales/ru.json";
import en from "./locales/en.json";
import { stampDocumentLang } from "../utils/documentLang";

const savedLang = localStorage.getItem("tt_language");
const browserLang = navigator.language.startsWith("ru") ? "ru" : "en";

// MR3-03 (D-16, WCAG 3.1.1): the main window's document language must follow
// the interface language, the way notification.tsx already stamps its own
// window. Registered BEFORE .init(...) — i18next emits "languageChanged"
// during init too, so this also stamps the initial language, and every later
// switch path (settings, toggle, tray) goes through i18n.changeLanguage and is
// covered by this single listener without touching each caller.
i18n.on("languageChanged", stampDocumentLang);

i18n.use(initReactI18next).init({
  resources: {
    ru: { translation: ru },
    en: { translation: en },
  },
  lng: savedLang || browserLang,
  fallbackLng: "en",
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
