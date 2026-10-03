import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
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

  // Phase 13 (13-06) — mirror the EFFECTIVE theme into the Rust plate-theme cell whenever it changes
  // AND once at startup (this effect runs on mount too). The notification plate is a separate webview
  // with its OWN empty localStorage, so it never learns `data-theme` from here; notify::maybe_fire
  // reads THIS mirror and stamps the plate's theme so a light-theme plate is actually light (UAT
  // round-2 defect 1). Fire-and-forget, guarded for the non-Tauri/test env (jsdom has no IPC bridge —
  // the invoke rejects; a bare `.catch` swallows it so a test render never throws). Mirrors the
  // useAppSettings `set_notifications_enabled` push discipline. A 2-value theme string, no secret (D-29).
  useEffect(() => {
    void invoke("set_plate_theme", { theme }).catch(() => {});
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
