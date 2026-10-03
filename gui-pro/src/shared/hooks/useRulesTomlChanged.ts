import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";

/**
 * Phase 15.1 REQ-15.8 — Cross-tab Tauri event listener for rules.toml changes.
 *
 * Backend Plan 15.1-01 emits `rules-toml-changed` event after successful
 * server_save_config_file write для rules.toml. Other tabs (e.g., Users tab)
 * subscribe via this hook to invalidate their cached views of rules.toml.
 *
 * Pattern follows useVpnEvents.ts shape: listen() + then(unlisten) cleanup.
 *
 * Usage:
 *   useRulesTomlChanged(() => {
 *     // Invalidate Users tab cache, refetch on next open
 *     setUsersRulesCache(null);
 *   });
 */
export interface RulesTomlChangedPayload {
  /** Always "rules.toml" — present для forward-compat (future events may fire same hook). */
  file: "rules.toml";
}

export function useRulesTomlChanged(onChanged: () => void): void {
  useEffect(() => {
    const unlistenPromise = listen<RulesTomlChangedPayload>("rules-toml-changed", (event) => {
      if (event.payload.file === "rules.toml") {
        onChanged();
      }
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // onChanged captured via closure; intentional empty deps to avoid re-subscribing
}
