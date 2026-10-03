import { useEffect } from "react";
import type { AppTab, VpnConfig, VpnStatus } from "../types";

interface UseTabPersistenceParams {
  activeTab: AppTab;
  config: VpnConfig;
  status: VpnStatus;
  connectedSince: Date | null;
}

/**
 * Persists app shell state to localStorage.
 * Encapsulates all cross-mount persistence previously scattered across
 * 5 useEffects in App.tsx (Phase 12.5, D-03).
 *
 * NOTE — deliberately NO scroll manipulation here. This hook used to run
 * `document.querySelectorAll('[class*="overflow"]').forEach(el => el.scrollTop = 0)`
 * keyed on [activeTab]. That effect predates the tab shell (its original App.tsx
 * comment said "reset scroll positions on mount — fresh state after app restart",
 * but the [activeTab] dep made it fire on EVERY tab switch) and it was the LAST
 * hidden scroll-reset vector after the IN-39/44/47/49 hunt: the tab panels stay
 * MOUNTED across switches (App.tsx only toggles position/opacity/visibility), so
 * the browser preserves each panel's inner scrollTop natively (proven by the
 * IN-49 isolated DOM repro of the exact tab structure) — this global reset was
 * the one thing still zeroing it, which the owner reported as "tabs forget their
 * scroll position". It also zeroed any OPEN modal / the log overlay / the
 * background wizard overlay mid-use (their classes match [class*="overflow"]).
 * The original "fresh state after app restart" intent needs no code at all: a
 * freshly mounted DOM always starts at scrollTop 0 by construction. Do NOT
 * reintroduce a save/restore layer either — IN-49 showed such layers race the
 * async tab-show re-render and cause the very resets they try to prevent.
 */
export function useTabPersistence({
  activeTab,
  config,
  status,
  connectedSince,
}: UseTabPersistenceParams) {
  // Persist active tab (+ old key for backward compat)
  useEffect(() => {
    localStorage.setItem("tt_active_tab", activeTab);
    localStorage.setItem("tt_active_page", activeTab);
  }, [activeTab]);

  // Persist config path + log level
  useEffect(() => {
    localStorage.setItem("tt_config_path", config.configPath);
    localStorage.setItem("tt_log_level", config.logLevel);
  }, [config]);

  // Persist VPN status
  useEffect(() => {
    localStorage.setItem("tt_vpn_status", status);
  }, [status]);

  // Persist / clear connectedSince
  useEffect(() => {
    if (connectedSince) {
      localStorage.setItem("tt_connected_since", connectedSince.toISOString());
    } else {
      localStorage.removeItem("tt_connected_since");
    }
  }, [connectedSince]);
}
