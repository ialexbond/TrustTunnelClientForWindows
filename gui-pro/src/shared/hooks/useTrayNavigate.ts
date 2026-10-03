import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";

/**
 * 06-17 C-26 — Cross-app navigation listener for the tray steering event.
 *
 * The backend tray `tray_vpn_connect` no-config branch emits a `tray-navigate`
 * event (tray.rs) BEFORE showing the window when the user clicks «Подключиться»
 * but no config exists. Without steering the user lands on a blank/last tab with
 * no hint to install. This hook listens for the event and invokes `onNavigate`
 * with the target so App can route to the install entry (the «Панель управления»
 * tab where ServerPanel's connect/install surface lives).
 *
 * The payload carries ONLY a navigation target string — no credentials, no
 * config path (threat-model boundary T-06-17-02). The target is a string union
 * so the consumer routes only on the known value and ignores anything else.
 *
 * Pattern follows useRulesTomlChanged.ts shape: listen() + then(unlisten)
 * cleanup, empty deps (callback captured via closure).
 *
 * Usage:
 *   useTrayNavigate((target) => {
 *     if (target === "install") setActiveTab("control");
 *   });
 */
export interface TrayNavigatePayload {
  /** Navigation target — currently only "install" (the Control-Panel install entry). */
  target: "install";
}

export function useTrayNavigate(
  onNavigate: (target: TrayNavigatePayload["target"]) => void,
): void {
  useEffect(() => {
    const unlistenPromise = listen<TrayNavigatePayload>("tray-navigate", (event) => {
      onNavigate(event.payload.target);
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // onNavigate captured via closure; intentional empty deps to avoid re-subscribing
}
