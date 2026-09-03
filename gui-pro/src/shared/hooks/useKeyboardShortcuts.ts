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
 *  Ctrl+1..5     — Navigate to tab by index
 *  Ctrl+Shift+D  — Toggle dark/light theme
 *  Ctrl+Shift+L  — Toggle language
 */
export function useKeyboardShortcuts(handlers: ShortcutHandlers) {
  useEffect(() => {
    const pages = ["control", "connection", "routing", "settings", "about"];

    function onKeyDown(e: KeyboardEvent) {
      // Ignore if typing in input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (e.ctrlKey && e.shiftKey) {
        // Item 6 (30.1 review): match the PHYSICAL key (`e.code`), not the character the layout
        // produced (`e.key`). `e.key` is layout-dependent: under ЙЦУКЕН — the layout this app's
        // audience actually types on — the C key yields «С» (U+0421 CYRILLIC CAPITAL ES), which is
        // not «C» (U+0043), so `e.key.toUpperCase()` matched nothing and all three shortcuts were
        // simply dead for Russian users. `e.code` is unaffected by layout or modifiers.
        //
        // ONE RULE, not two: matching `e.code` OR `e.key` would make the character «С» arriving
        // from some other physical key (an IME, a remapped layout) toggle the tunnel — a second,
        // different bug. Accepted trade: `e.code` names a POSITION on a US-QWERTY reference layout,
        // so a Dvorak user presses the key at the QWERTY-C position rather than the one printed «C».
        // That is the standard mechanism for layout-independent shortcuts and it gives the RIGHT
        // answer for ЙЦУКЕН, which maps «С» onto exactly that position — the whole point of the fix.
        switch (e.code) {
          case "KeyC":
            e.preventDefault();
            handlers.onToggleConnect?.();
            break;
          case "KeyD":
            e.preventDefault();
            handlers.onToggleTheme?.();
            break;
          case "KeyL":
            e.preventDefault();
            handlers.onToggleLanguage?.();
            break;
        }
      } else if (e.ctrlKey && !e.shiftKey && !e.altKey) {
        // The digit branch deliberately still reads `e.key`, and must stay that way. Digits are
        // layout-independent on both Latin and Cyrillic layouts, so there is nothing here for the
        // fix above to repair — while `e.code` would be "Digit1" on the number row but "Numpad1" on
        // the keypad, so "finishing the job" here would BREAK numeric-keypad navigation, which works.
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
