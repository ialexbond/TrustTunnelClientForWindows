import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, GitBranch, RefreshCw, AlertCircle } from "lucide-react";
import type { VpnStatus } from "../App";
import { Button } from "../shared/ui/Button";
import { ErrorBanner } from "../shared/ui/ErrorBanner";
import { SnackBar } from "../shared/ui/SnackBar";
import { ConfirmDialog } from "../shared/ui/ConfirmDialog";
import { useRoutingState } from "./routing/useRoutingState";
import { GeoDataStatusCard } from "./routing/GeoDataStatus";
import { RoutingBlockCard } from "./routing/RoutingBlockCard";
import { ProcessFilterSection } from "./routing/ProcessFilterSection";
import { ExportImportButtons } from "./routing/ExportImportButtons";

interface RoutingPanelProps {
  configPath: string;
  status: VpnStatus;
  onReconnect: () => Promise<void>;
  vpnMode?: string;
}

function RoutingPanel({ configPath, status, onReconnect, vpnMode: _vpnMode }: RoutingPanelProps) {
  const { t } = useTranslation();
  const state = useRoutingState({ configPath });
  const [showReconnectConfirm, setShowReconnectConfirm] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  const isActive = status === "connected" || status === "connecting" || status === "recovering";

  // Handle apply: save + optionally reconnect
  const handleApply = async () => {
    await state.resolveAndApply();
    if (isActive) {
      setShowReconnectConfirm(true);
    }
  };

  const handleReconnectConfirm = async () => {
    setReconnecting(true);
    try {
      await onReconnect();
    } finally {
      setReconnecting(false);
      setShowReconnectConfirm(false);
    }
  };

  // Loading state
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
      <div className="flex-1 scroll-overlay py-3 px-4 space-y-4">
        {/* Error */}
        {state.error && (
          <ErrorBanner message={state.error} />
        )}

        {/* Dirty indicator */}
        {state.dirty && (
          <div
            className="flex items-center gap-2 px-3 py-2 rounded-[var(--radius-lg)]"
            style={{
              backgroundColor: "rgba(245, 158, 11, 0.08)",
              border: "1px solid rgba(245, 158, 11, 0.25)",
            }}
          >
            <AlertCircle className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--color-warning-400)" }} />
            <p className="flex-1 text-[11px]" style={{ color: "var(--color-warning-400)" }}>
              {isActive
                ? t("routing.unsavedChangesReconnect")
                : t("routing.unsavedChanges")}
            </p>
          </div>
        )}

        {/* 1. GeoData Status */}
        <GeoDataStatusCard
          status={state.geodataStatus}
          downloading={state.geodataDownloading}
          onDownload={state.downloadGeoData}
        />

        {/* 2. Routing Blocks */}
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

        <RoutingBlockCard
          action="block"
          entries={state.rules.block}
          geodataStatus={state.geodataStatus}
          geodataCategories={state.geodataCategories}
          onAdd={state.addEntry}
          onRemove={state.removeEntry}
          onMove={state.moveEntry}
        />

        {/* 3. Process Filter */}
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

        {/* 4. Export / Import */}
        <ExportImportButtons
          onExport={state.exportRules}
          onImport={state.importRules}
          disabled={state.saving || state.applying}
        />

        {/* 5. Apply button */}
        <Button
          variant="primary"
          size="md"
          fullWidth
          icon={<RefreshCw className="w-4 h-4" />}
          loading={state.applying}
          disabled={!state.dirty || state.saving}
          onClick={handleApply}
        >
          {state.applying
            ? t("routing.applying")
            : t("routing.applyChanges")}
        </Button>
      </div>

      {/* Reconnect confirmation dialog */}
      <ConfirmDialog
        open={showReconnectConfirm}
        title={t("routing.reconnectTitle")}
        message={t("routing.reconnectMessage")}
        confirmLabel={t("routing.reconnectConfirm")}
        cancelLabel={t("buttons.cancel")}
        variant="warning"
        onConfirm={handleReconnectConfirm}
        onCancel={() => setShowReconnectConfirm(false)}
        loading={reconnecting}
      />

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
