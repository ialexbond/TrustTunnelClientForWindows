import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";

/**
 * Phase 13 (13-09, Fix 2) — cross-app navigation listener for the plate BODY-click steering event.
 *
 * The backend `restore_main_window` command (lib.rs) — invoked when the user clicks the connection
 * notification plate's BODY — shows + focuses the main window, hides the plate, and THEN emits a
 * `navigate-to-tab` event carrying the tab id to open. Because the plate is a CONNECTION
 * notification, the target is the Connection tab: the user should land on the connection surface,
 * not on whatever tab they were last on. This hook listens for the event and invokes `onNavigate`
 * with the tab id so App can switch the active tab.
 *
 * The payload carries ONLY a bare tab-id string — no credentials, no config path (D-29). The
 * consumer routes only on the known value and ignores anything else.
 *
 * Pattern mirrors useTrayNavigate.ts: listen() + then(unlisten) cleanup, empty deps (the callback
 * is captured via closure; a stable useCallback at the call site keeps it from re-subscribing).
 *
 * The × close path does NOT trigger this (it only hides the plate, no restore, no navigation), so
 * a dismiss never changes the active tab.
 *
 * Usage:
 *   useNavigateToTab(
 *     useCallback((tab: string) => {
 *       if (tab === "connection") setActiveTab("connection");
 *     }, []),
 *   );
 */
export function useNavigateToTab(onNavigate: (tab: string) => void): void {
  useEffect(() => {
    const unlistenPromise = listen<string>("navigate-to-tab", (event) => {
      onNavigate(event.payload);
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // onNavigate captured via closure; intentional empty deps to avoid re-subscribing
}
