import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  Loader2, GitBranch, Save, Download, Upload,
  Zap, Globe, Ban, Shield, Route,
} from "lucide-react";
import type { VpnStatus } from "../shared/types";
import { Card } from "../shared/ui/Card";
import { Button } from "../shared/ui/Button";
import { ErrorBanner } from "../shared/ui/ErrorBanner";
import { SnackBar } from "../shared/ui/SnackBar";
import StatusPanel from "./StatusPanel";
import { useRoutingState } from "./routing/useRoutingState";
import { GeoDataStatusCard } from "./routing/GeoDataStatus";
import { RoutingBlockCard } from "./routing/RoutingBlockCard";
import { ProcessFilterSection } from "./routing/ProcessFilterSection";
import { useFeatureToggles } from "../shared/hooks/useFeatureToggles";

interface RoutingPanelProps {
  configPath: string;
  status: VpnStatus;
  connectedSince: Date | null;
  vpnError: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
  onReconnect: () => Promise<void>;
  vpnMode?: string;
  onVpnModeChange?: (mode: string) => void;
}

function RoutingPanel({ configPath, status, connectedSince, vpnError, onConnect, onDisconnect, onReconnect, vpnMode = "general", onVpnModeChange }: RoutingPanelProps) {
  const { t } = useTranslation();
  const state = useRoutingState({ configPath, status, onReconnect });
  const { toggles } = useFeatureToggles();

  // VPN mode change handler — writes to TOML config, marks dirty, notifies parent
  const handleVpnModeChange = async (mode: string) => {
    if (!configPath) return;
    try {
      await invoke("update_vpn_mode", { configPath, mode });
      onVpnModeChange?.(mode);
      state.markDirty(); // Activate "Save & Reconnect" button
    } catch (e) {
      console.error("Failed to update vpn_mode:", e);
    }
  };

  // Uptime ticker
  const [, setTick] = useState(0);
  const isConnected = status === "connected";
  const isLoading = status === "connecting" || status === "disconnecting" || status === "recovering";

  useEffect(() => {
    if (!isConnected || !connectedSince) return;
    const iv = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(iv);
  }, [isConnected, connectedSince]);

  const saveLabel = state.applying
    ? t("status.saving")
    : t("buttons.save_and_reconnect");

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
      <StatusPanel
        status={status}
        error={vpnError}
        connectedSince={connectedSince}
        onConnect={onConnect}
        onDisconnect={onDisconnect}
      />

      <div className="flex-1 scroll-overlay py-3 px-4 space-y-4">
        {/* Error — shown below connection block */}
        {state.error && (
          <ErrorBanner message={state.error} />
        )}

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
            {vpnMode === "general" ? t("help_text.vpn_mode_general") : t("help_text.vpn_mode_selective")}
          </p>

          {/* Save & Reconnect + Export/Import — inside mode card */}
          <div className="flex gap-2 mt-2">
            <Button
              variant="primary"
              size="sm"
              className="flex-1"
              icon={<Save className="w-3.5 h-3.5" />}
              loading={state.applying}
              disabled={!state.isVpnActive || !state.dirty}
              onClick={() => state.handleSave(true)}
            >
              {saveLabel}
            </Button>
            <button
              onClick={state.exportRules}
              disabled={state.saving || state.applying}
              className="px-3 py-2 rounded-[var(--radius-lg)] transition-colors disabled:opacity-40"
              style={{
                backgroundColor: "var(--color-bg-card)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text-secondary)",
              }}
              title={t("routing.exportRules")}
            >
              <Upload className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={state.importRules}
              disabled={state.saving || state.applying}
              className="px-3 py-2 rounded-[var(--radius-lg)] transition-colors disabled:opacity-40"
              style={{
                backgroundColor: "var(--color-bg-card)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text-secondary)",
              }}
              title={t("routing.importRules")}
            >
              <Download className="w-3.5 h-3.5" />
            </button>
          </div>
        </Card>

        {/* Routing Blocks */}
        <RoutingBlockCard
          action="direct"
          entries={state.rules.direct}
          geodataStatus={state.geodataStatus}
          geodataCategories={state.geodataCategories}
          onAdd={state.addEntry}
          onRemove={state.removeEntry}
          onMove={state.moveEntry}
        />

        <RoutingBlockCard
          action="proxy"
          entries={state.rules.proxy}
          geodataStatus={state.geodataStatus}
          geodataCategories={state.geodataCategories}
          onAdd={state.addEntry}
          onRemove={state.removeEntry}
          onMove={state.moveEntry}
        />

        {/* Блокировка сайтов — экспериментальная функция, включается в Настройках */}
        {toggles.blockRouting && (
        <RoutingBlockCard
          action="block"
          entries={state.rules.block}
          geodataStatus={state.geodataStatus}
          geodataCategories={state.geodataCategories}
          onAdd={state.addEntry}
          onRemove={state.removeEntry}
          onMove={state.moveEntry}
        />
        )}

        {/* Фильтрация по процессам — экспериментальная функция, включается в Настройках */}
        {toggles.processFilter && (
        <ProcessFilterSection
          processMode={state.rules.process_mode}
          processes={state.rules.processes}
          processList={state.processList}
          processListLoading={state.processListLoading}
          onModeChange={state.setProcessMode}
          onAdd={state.addProcess}
          onRemove={state.removeProcess}
          onLoadProcesses={state.loadProcessList}
        />
        )}
      </div>

      {/* SnackBar */}
      <SnackBar
        messages={state.successQueue}
        onShown={state.shiftSuccess}
        duration={2500}
      />
    </div>
  );
}

export default RoutingPanel;
