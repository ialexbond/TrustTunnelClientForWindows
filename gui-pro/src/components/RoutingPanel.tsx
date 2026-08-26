import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  Loader2, GitBranch, Save,
  Zap, Shield, Route,
} from "lucide-react";
import type { VpnStatus } from "../shared/types";
import { Card } from "../shared/ui/Card";
import { PanelHeader } from "../shared/ui/PanelHeader";
import { Button } from "../shared/ui/Button";
import StatusPanel from "./StatusPanel";
import { useRoutingState } from "./routing/useRoutingState";
import { GeoDataStatusCard } from "./routing/GeoDataStatus";
import { PresetGrid } from "./routing/PresetGrid";
import { RoutingBlockCard } from "./routing/RoutingBlockCard";
import { ProcessFilterSection } from "./routing/ProcessFilterSection";
import { ExportImportButtons } from "./routing/ExportImportButtons";
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
  // Fable F4 (BUG-A2 fix-all-paths): the Routing tab renders its OWN StatusPanel, so it must thread
  // the SAME switching/connectPending props App gives the shell StatusPanel — otherwise the Routing
  // status strip shows a DEAD live «Отмена» during a switch's `connecting` leg (handler inert) and can
  // render two buttons during the switch's transient `disconnected` window (Fable F3). App owns both.
  isSwitching?: boolean;
  connectPending?: boolean;
}

function RoutingPanel({ configPath, status, connectedSince, vpnError, onConnect, onDisconnect, onReconnect, vpnMode = "general", onVpnModeChange, isSwitching = false, connectPending = false }: RoutingPanelProps) {
  const { t } = useTranslation();
  const state = useRoutingState({ configPath, status, vpnMode, onReconnect });
  const { toggles } = useFeatureToggles();

  // VPN mode change handler — writes to TOML config, marks dirty, notifies parent
  const handleVpnModeChange = async (mode: string) => {
    if (!configPath) return;
    try {
      await invoke("update_vpn_mode", { configPath, mode });
      onVpnModeChange?.(mode);
    } catch (e) {
      console.error("Failed to update vpn_mode:", e);
    }
  };

  // Uptime ticker
  const [, setTick] = useState(0);
  const isConnected = status === "connected";
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
        <p className="text-xs">{t("routing.configure_in_settings")}</p>
      </div>
    );
  }

  if (state.loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2
          className="w-6 h-6 animate-spin"
          style={{ color: "var(--color-accent-fg)" }}
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
        // Fable F4: thread the same switch/pending flags the shell StatusPanel gets so the Routing
        // status strip's live «Отмена» is hidden during a switch's connecting leg (handler inert) and
        // its control branches stay mutually exclusive during the switch's transient disconnected window.
        switching={isSwitching}
        connectPending={connectPending}
      />

      <div className="flex-1 scroll-overlay py-3 px-4 space-y-4">
        {/* VPN Mode selector — canon: FIRST section (Phase-20 flagship order) */}
        <Card padding="md">
          {/* Shared `PanelHeader` — same header as the «Настройки» cards, so the glyph is a tinted
              chip on the title line instead of a bare accent icon. The card had no caption of its
              own, only the per-mode help text under the buttons, which left the heading looking
              unfinished; the description says what the card governs, the help text below still says
              what the CURRENTLY selected mode does. Two levels, same split as Settings uses between
              a card description and a row description. */}
          <PanelHeader
            icon={<Route className="w-4 h-4" />}
            title={t("labels.vpn_mode")}
            description={t("routing.vpnModeDescription")}
          />
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
          <p className="text-xs mt-1" style={{ color: "var(--color-text-muted)" }}>
            {vpnMode === "general" ? t("help_text.vpn_mode_general") : t("help_text.vpn_mode_selective")}
          </p>
        </Card>

        {/* GeoData Status */}
        <GeoDataStatusCard
          status={state.geodataStatus}
          downloading={state.geodataDownloading}
          // Any write in flight — including the background scheduler's — disables the card's
          // button. Without this it stayed pressable and the click came back refused.
          busy={state.geodataBusy}
          onDownload={state.downloadGeoData}
        />

        {/* Быстрые пресеты — one-click named groups (T-25 / D-01). Canon section order: sits between
            the geodata card and the routing blocks. Each tile lands its group at a smart-default block
            via addEntry; iplist backings fetch their cache on add; block-target tiles gate on the
            blockRouting toggle and geosite tiles on geodata-downloaded (Pitfalls #1/#3). */}
        <PresetGrid
          rules={state.rules}
          onAdd={state.addEntry}
          ensureGroupCache={state.ensureGroupCache}
          geodataDownloaded={state.geodataStatus.downloaded}
          blockRoutingEnabled={toggles.blockRouting}
        />

        {/* Routing Blocks */}
        <RoutingBlockCard
          action="direct"
          vpnMode={vpnMode}
          entries={state.rules.direct}
          geodataStatus={state.geodataStatus}
          geodataCategories={state.geodataCategories}
          iplistGroups={state.iplistGroups}
          onAdd={state.addEntry}
          onRemove={state.removeEntry}
          onMove={state.moveEntry}
          onEnsureGroupCache={state.ensureGroupCache}
        />

        <RoutingBlockCard
          action="proxy"
          vpnMode={vpnMode}
          entries={state.rules.proxy}
          geodataStatus={state.geodataStatus}
          geodataCategories={state.geodataCategories}
          iplistGroups={state.iplistGroups}
          onAdd={state.addEntry}
          onRemove={state.removeEntry}
          onMove={state.moveEntry}
          onEnsureGroupCache={state.ensureGroupCache}
        />

        {/* Блокировка сайтов — экспериментальная функция, включается в Настройках */}
        {toggles.blockRouting && (
        <RoutingBlockCard
          action="block"
          vpnMode={vpnMode}
          entries={state.rules.block}
          geodataStatus={state.geodataStatus}
          geodataCategories={state.geodataCategories}
          iplistGroups={state.iplistGroups}
          onAdd={state.addEntry}
          onRemove={state.removeEntry}
          onMove={state.moveEntry}
          onEnsureGroupCache={state.ensureGroupCache}
        />
        )}

        {/* Фильтрация по процессам */}
        <ProcessFilterSection
          processMode={state.rules.process_mode}
          processes={state.rules.processes}
          processList={state.processList}
          processListLoading={state.processListLoading}
          processListError={state.processListError}
          onModeChange={state.setProcessMode}
          onAdd={state.addProcess}
          onRemove={state.removeProcess}
          onLoadProcesses={state.loadProcessList}
        />

        {/* Save & Reconnect + Export/Import — standalone bottom strip (canon, Phase-20 flagship).
            Moved out of the VPN-mode Card; the Save two-liner (tt-peer-save → handleSave(true)),
            its disabled gate, and loading state are preserved VERBATIM. Export/import wire the
            reshaped ExportImportButtons to the existing FUNCTIONAL state.exportRules/importRules
            (real file I/O — the D-03 "inert" premise was wrong; Phase 21 reshaped the look only,
            it did not add or remove behavior). */}
        <div className="flex gap-2">
          <Button
            variant="primary"
            size="sm"
            className="flex-1"
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
          <ExportImportButtons
            onExport={state.exportRules}
            onImport={state.importRules}
            disabled={state.saving || state.applying}
          />
        </div>
      </div>

    </div>
  );
}

export default RoutingPanel;
