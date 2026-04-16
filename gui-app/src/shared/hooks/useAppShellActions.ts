import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppTab, VpnConfig, VpnStatus } from "../types";

interface UseAppShellActionsParams {
  status: VpnStatus;
  setStatus: React.Dispatch<React.SetStateAction<VpnStatus>>;
  setConfig: React.Dispatch<React.SetStateAction<VpnConfig>>;
  setWizardKey: React.Dispatch<React.SetStateAction<number>>;
  setSettingsKey: React.Dispatch<React.SetStateAction<number>>;
  setRoutingKey: React.Dispatch<React.SetStateAction<number>>;
  setActiveTab: React.Dispatch<React.SetStateAction<AppTab>>;
}

/**
 * Shell-level composite callbacks: handleClearConfig, handleDropConfig,
 * handleDropRouting. Encapsulates multi-step side effects that previously
 * lived inline in App.tsx (Phase 12.5, D-03).
 */
export function useAppShellActions({
  status,
  setStatus,
  setConfig,
  setWizardKey,
  setSettingsKey,
  setRoutingKey,
  setActiveTab,
}: UseAppShellActionsParams) {
  const handleClearConfig = useCallback(async () => {
    // Disconnect VPN first if running
    if (status === "connected" || status === "connecting") {
      try {
        setStatus("disconnecting");
        await invoke("vpn_disconnect");
      } catch {
        /* ignore */
      }
    }
    setConfig({ configPath: "", logLevel: "info" });
    localStorage.removeItem("tt_config_path");
    localStorage.setItem("tt_config_cleared", "true"); // prevent auto-detect on restart
    try {
      const raw = localStorage.getItem("trusttunnel_wizard");
      const obj = raw ? JSON.parse(raw) : {};
      obj.wizardStep = "welcome";
      obj.deploySteps = "{}";
      obj.deployLogs = "[]";
      obj.configPath = "";
      obj.errorMessage = "";
      localStorage.setItem("trusttunnel_wizard", JSON.stringify(obj));
    } catch {
      /* ignore */
    }
    setWizardKey((k) => k + 1);
  }, [status, setStatus, setConfig, setWizardKey]);

  const handleDropConfig = useCallback(
    (configPath: string) => {
      setConfig((prev) => ({ ...prev, configPath }));
      localStorage.setItem("tt_config_path", configPath);
      localStorage.removeItem("tt_config_cleared");
      setSettingsKey((k) => k + 1);
      setActiveTab("connection");
    },
    [setConfig, setSettingsKey, setActiveTab],
  );

  const handleDropRouting = useCallback(() => {
    setRoutingKey((k) => k + 1);
    setActiveTab("routing");
  }, [setRoutingKey, setActiveTab]);

  return { handleClearConfig, handleDropConfig, handleDropRouting };
}
