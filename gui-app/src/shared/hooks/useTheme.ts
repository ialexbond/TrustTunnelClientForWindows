import { useState, useEffect, useCallback } from "react";
import type { ThemeMode } from "../types";

export function useTheme() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    return (localStorage.getItem("tt_theme") as ThemeMode) || "system";
  });

  // Resolve effective theme from mode
  const getEffectiveTheme = useCallback((mode: ThemeMode): "dark" | "light" => {
    if (mode === "system") {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    return mode;
  }, []);

  const [theme, setTheme] = useState<"dark" | "light">(() => getEffectiveTheme(
    (localStorage.getItem("tt_theme") as ThemeMode) || "system"
  ));

  // Apply theme to DOM
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // Listen for system theme changes when mode is "system"
  useEffect(() => {
    localStorage.setItem("tt_theme", themeMode);
    setTimeout(() => setTheme(getEffectiveTheme(themeMode)), 0);

    if (themeMode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => setTheme(e.matches ? "dark" : "light");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [themeMode, getEffectiveTheme]);

  const handleThemeChange = useCallback((mode: ThemeMode) => {
    setThemeMode(mode);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeMode((prev) => {
      if (prev === "dark") return "light";
      if (prev === "light") return "system";
      return "dark";
    });
  }, []);

  return { theme, themeMode, handleThemeChange, toggleTheme };
}
