import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { i18n as I18nType } from "i18next";
import type { AppTab, VpnConfig } from "../types";

interface UseConfigLifecycleParams {
  config: VpnConfig;
  setConfig: React.Dispatch<React.SetStateAction<VpnConfig>>;
  setVpnMode: React.Dispatch<React.SetStateAction<string>>;
  setWizardKey: React.Dispatch<React.SetStateAction<number>>;
  setSettingsKey: React.Dispatch<React.SetStateAction<number>>;
  activeTab: AppTab;
  setActiveTab: React.Dispatch<React.SetStateAction<AppTab>>;
  pushSuccess: (message: string, variant?: "success" | "error") => void;
  i18n: I18nType;
}

/**
 * Lifecycle hook for the VPN config file:
 * - On mount: validate saved path, auto-detect if empty, clean up stale localStorage.
 * - Watch file while a path is set; unwatch on change/unmount.
 * - React to `config-file-changed` events (external delete / restore).
 *
 * Extracted from App.tsx verbatim (Phase 12.5, D-03).
 */
export function useConfigLifecycle({
  config,
  setConfig,
  setVpnMode,
  setWizardKey,
  setSettingsKey,
  activeTab,
  setActiveTab,
  pushSuccess,
  i18n,
}: UseConfigLifecycleParams) {
  // ─── Config validation on startup ───
  // WR-05 fix: explicit startup-once guard via useRef. Without this the
  // effect would re-run in React.StrictMode (DEV), double-clearing the
  // wizard localStorage entries and issuing two auto_detect_config calls.
  const didValidateStartupRef = useRef(false);
  useEffect(() => {
    if (didValidateStartupRef.current) return;
    didValidateStartupRef.current = true;
    const savedPath = localStorage.getItem("tt_config_path");
    if (savedPath) {
      invoke<{ vpn_mode?: string }>("read_client_config", { configPath: savedPath })
        .then((cfg) => {
          if (cfg?.vpn_mode) setVpnMode(cfg.vpn_mode);
        })
        .catch(() => {
          localStorage.removeItem("tt_config_path");
          localStorage.removeItem("tt_active_page");
          localStorage.removeItem("tt_active_tab");
          localStorage.removeItem("tt_connected_since");
          localStorage.removeItem("trusttunnel_wizard");
          setConfig({ configPath: "", logLevel: "info" });
          setWizardKey((k) => k + 1);
        });
    } else {
      localStorage.removeItem("trusttunnel_wizard");
      localStorage.removeItem("tt_active_page");
      localStorage.removeItem("tt_active_tab");
      localStorage.removeItem("tt_connected_since");

      // Skip auto-detect if user explicitly cleared config
      const wasCleared = localStorage.getItem("tt_config_cleared");
      if (!wasCleared) {
        invoke<string | null>("auto_detect_config")
          .then((detected) => {
            if (detected) {
              setConfig((prev) => ({ ...prev, configPath: detected }));
              if (activeTab === "control") setActiveTab("connection");
            }
          })
          .catch(() => {});
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Watch config file for external deletion ───
  useEffect(() => {
    if (config.configPath) {
      invoke("watch_config_file", { configPath: config.configPath }).catch(() => {});
    }
    return () => {
      invoke("unwatch_config_file").catch(() => {});
    };
  }, [config.configPath]);

  useEffect(() => {
    const unlisten = listen<{ exists: boolean; path: string }>("config-file-changed", (event) => {
      const { exists, path } = event.payload;
      if (!exists && path === config.configPath) {
        // Config file was deleted externally
        localStorage.removeItem("tt_config_path");
        setConfig({ configPath: "", logLevel: "info" });
        setWizardKey((k) => k + 1);
        pushSuccess(i18n.t("messages.config_file_deleted", "Config file was deleted"), "error");
      } else if (exists && !config.configPath) {
        // Config file appeared — reload it
        setConfig({ configPath: path, logLevel: "info" });
        localStorage.setItem("tt_config_path", path);
        setSettingsKey((k) => k + 1);
        setActiveTab("connection");
        pushSuccess(i18n.t("messages.config_file_restored", "Config loaded"));
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.configPath]);
}
