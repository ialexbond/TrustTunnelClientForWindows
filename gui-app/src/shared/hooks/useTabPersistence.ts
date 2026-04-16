import { useEffect } from "react";
import type { AppTab, VpnConfig, VpnStatus } from "../types";

interface UseTabPersistenceParams {
  activeTab: AppTab;
  config: VpnConfig;
  status: VpnStatus;
  connectedSince: Date | null;
}

/**
 * Persists app shell state to localStorage + resets scroll on tab change.
 * Encapsulates all cross-mount persistence previously scattered across
 * 5 useEffects in App.tsx (Phase 12.5, D-03).
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

  // Reset scroll position on tab change
  useEffect(() => {
    document.querySelectorAll('[class*="overflow"]').forEach((el) => {
      el.scrollTop = 0;
    });
  }, [activeTab]);
}
