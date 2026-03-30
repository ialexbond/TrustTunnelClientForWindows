import { useEffect } from "react";

interface ShortcutHandlers {
  onToggleConnect?: () => void;
  onNavigate?: (page: string) => void;
  onToggleTheme?: () => void;
  onToggleLanguage?: () => void;
}

/**
 * Global keyboard shortcuts:
 *  Ctrl+Shift+C  — Toggle VPN connect/disconnect
 *  Ctrl+1..8     — Navigate to panel by index
 *  Ctrl+Shift+D  — Toggle dark/light theme
 *  Ctrl+Shift+L  — Toggle language
 */
export function useKeyboardShortcuts(handlers: ShortcutHandlers) {
  useEffect(() => {
    const pages = ["dashboard", "server", "control", "settings", "routing", "logs", "appSettings", "about"];

    function onKeyDown(e: KeyboardEvent) {
      // Ignore if typing in input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (e.ctrlKey && e.shiftKey) {
        switch (e.key.toUpperCase()) {
          case "C":
            e.preventDefault();
            handlers.onToggleConnect?.();
            break;
          case "D":
            e.preventDefault();
            handlers.onToggleTheme?.();
            break;
          case "L":
            e.preventDefault();
            handlers.onToggleLanguage?.();
            break;
        }
      } else if (e.ctrlKey && !e.shiftKey && !e.altKey) {
        const num = parseInt(e.key, 10);
        if (num >= 1 && num <= pages.length) {
          e.preventDefault();
          handlers.onNavigate?.(pages[num - 1]);
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handlers]);
}
