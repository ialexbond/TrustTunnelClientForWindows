import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  Loader2,
  GitBranch,
  Save,
  Download,
  Upload,
  Zap,
  Shield,
  Route,
} from "lucide-react";
import type { VpnStatus } from "../shared/types";
import { Card } from "../shared/ui/Card";
import { Button } from "../shared/ui/Button";
import { useRoutingState } from "./routing/useRoutingState";
import { GeoDataStatusCard } from "./routing/GeoDataStatus";
import { RoutingBlockCard } from "./routing/RoutingBlockCard";

interface RoutingScreenProps {
  configPath: string;
  status: VpnStatus;
  vpnMode: string;
  onVpnModeChange: (mode: string) => void;
  onReconnect: () => Promise<void>;
}

function RoutingScreen({
  configPath,
  status,
  vpnMode,
  onVpnModeChange,
  onReconnect,
}: RoutingScreenProps) {
  const { t } = useTranslation();
  const state = useRoutingState({ configPath, status, vpnMode, onReconnect });

  // VPN mode change handler
  const handleVpnModeChange = async (mode: string) => {
    if (!configPath) return;
    try {
      await invoke("update_vpn_mode", { configPath, mode });
      onVpnModeChange(mode);
    } catch (e) {
      console.error("Failed to update vpn_mode:", e);
    }
  };

  const isConnected = status === "connected";
  const isBusy = status === "connecting" || status === "disconnecting" || status === "recovering";

  const saveLabel = state.applying
    ? t("status.saving")
    : t("buttons.save_and_reconnect");

  // No config
  if (!configPath) {
    return (
      <div
        className="flex-1 flex flex-col items-center justify-center gap-2"
        style={{ color: "var(--color-text-muted)" }}
      >
        <GitBranch className="w-8 h-8" />
        <p className="text-xs">{t("routing.no_config_selected")}</p>
        <p className="text-[10px]">{t("routing.configure_in_settings")}</p>
      </div>
    );
  }

  // Loading
  if (state.loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2
          className="w-6 h-6 animate-spin"
          style={{ color: "var(--color-accent-400)" }}
        />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Status divider */}
      <div
        className="flex items-center gap-2 px-3 py-1.5"
        style={{ borderBottom: "1px solid var(--color-border)" }}
      >
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{
            backgroundColor: isConnected
              ? "var(--color-success-400)"
              : isBusy
              ? "var(--color-warning-400)"
              : "var(--color-text-muted)",
          }}
        />
        <span className="text-xs font-medium" style={{ color: "var(--color-text-primary)" }}>
          {isConnected
            ? t("status.connected")
            : isBusy
            ? t("status.connecting")
            : t("status.disconnected")}
        </span>
        {state.dirty && (
          <span
            className="ml-auto text-[10px] px-1.5 py-0.5 rounded"
            style={{
              backgroundColor: "rgba(99, 102, 241, 0.1)",
              color: "var(--color-accent-400)",
            }}
          >
            {t("status.unsaved")}
          </span>
        )}
      </div>

      <div className="flex-1 scroll-overlay pt-1 pb-1 px-3 space-y-3">
        {/* GeoData Status */}
        <GeoDataStatusCard
          status={state.geodataStatus}
          downloading={state.geodataDownloading}
          onDownload={state.downloadGeoData}
        />

        {/* VPN Mode selector */}
        <Card padding="md">
          <div className="flex items-center gap-2 mb-1.5">
            <Route className="w-4 h-4" style={{ color: "var(--color-accent-400)" }} />
            <span className="text-xs font-medium" style={{ color: "var(--color-text-primary)" }}>
              {t("labels.vpn_mode")}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <Button
              variant={vpnMode === "general" ? "primary" : "secondary"}
              size="sm"
              icon={<Shield className="w-3.5 h-3.5" />}
              onClick={() => handleVpnModeChange("general")}
            >
              {t("vpn_modes.general")}
            </Button>
            <Button
              variant={vpnMode === "selective" ? "primary" : "secondary"}
              size="sm"
              icon={<Zap className="w-3.5 h-3.5" />}
              onClick={() => handleVpnModeChange("selective")}
            >
              {t("vpn_modes.selective")}
            </Button>
          </div>
          <p className="text-[9px] mt-1" style={{ color: "var(--color-text-muted)" }}>
            {vpnMode === "general"
              ? t("help_text.vpn_mode_general")
              : t("help_text.vpn_mode_selective")}
          </p>

          {/* Save & Reconnect */}
          <div className="mt-2">
            <Button
              variant="primary"
              size="sm"
              fullWidth
              icon={<Save className="w-3.5 h-3.5" />}
              loading={state.applying}
              disabled={!state.isVpnActive || !state.dirty}
              onClick={() => {
                window.dispatchEvent(new CustomEvent("tt-peer-save"));
                state.handleSave(true);
              }}
            >
              {saveLabel}
            </Button>
          </div>
          {/* Export / Import */}
          <div className="flex gap-2 mt-1.5">
            <button
              onClick={state.exportRules}
              disabled={state.saving || state.applying}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-[var(--radius-lg)] text-xs transition-colors disabled:opacity-40"
              style={{
                backgroundColor: "var(--color-bg-card, var(--color-bg-elevated))",
                border: "1px solid var(--color-border)",
                color: "var(--color-text-secondary)",
              }}
            >
              <Upload className="w-3.5 h-3.5" />
              {t("routing.export")}
            </button>
            <button
              onClick={state.importRules}
              disabled={state.saving || state.applying}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-[var(--radius-lg)] text-xs transition-colors disabled:opacity-40"
              style={{
                backgroundColor: "var(--color-bg-card, var(--color-bg-elevated))",
                border: "1px solid var(--color-border)",
                color: "var(--color-text-secondary)",
              }}
            >
              <Download className="w-3.5 h-3.5" />
              {t("routing.import")}
            </button>
          </div>
        </Card>

        {/* Routing Blocks */}
        <RoutingBlockCard
          action="direct"
          vpnMode={vpnMode}
          entries={state.rules.direct}
          geodataStatus={state.geodataStatus}
          geodataCategories={state.geodataCategories}
          onAdd={state.addEntry}
          onRemove={state.removeEntry}
          onMove={state.moveEntry}
        />

        <RoutingBlockCard
          action="proxy"
          vpnMode={vpnMode}
          entries={state.rules.proxy}
          geodataStatus={state.geodataStatus}
          geodataCategories={state.geodataCategories}
          onAdd={state.addEntry}
          onRemove={state.removeEntry}
          onMove={state.moveEntry}
        />
      </div>
    </div>
  );
}

export default RoutingScreen;
