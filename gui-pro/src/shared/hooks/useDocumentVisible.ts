import { useEffect, useState } from "react";

/**
 * useDocumentVisible — the single shared poller-gating hook (Plan 09-19, QE-05).
 *
 * Returns `!document.hidden` (true when the tab/window is visible) and
 * re-renders on every `visibilitychange`. Overview interval pollers fold this
 * value into their `enabled`/guard so they pause when the window is minimized or
 * the tab is backgrounded — cutting needless SSH traffic while the user can't
 * see the data anyway.
 *
 * IMPORTANT EXCEPTION: the reboot poller in OverviewSection deliberately does
 * NOT use this hook. Gating the reboot poll while hidden would stall recovery
 * detection (the server may finish rebooting while the window is minimized), so
 * that one poller must keep running regardless of visibility. See the
 * `// QE-05 exception` comment on the reboot effect.
 */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState<boolean>(() =>
    typeof document === "undefined" ? true : !document.hidden,
  );

  useEffect(() => {
    const handler = () => setVisible(!document.hidden);
    // Sync once on mount in case visibility changed before the listener bound.
    handler();
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, []);

  return visible;
}
