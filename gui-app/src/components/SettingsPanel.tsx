import { useTranslation } from "react-i18next";
import { Save } from "lucide-react";
import type { VpnConfig, VpnStatus } from "../shared/types";
import { Button } from "../shared/ui/Button";
import { ErrorBanner } from "../shared/ui/ErrorBanner";
import { useSettingsState } from "./settings/useSettingsState";
import { ConnectionSection } from "./settings/ConnectionSection";
import { TunnelSection } from "./settings/TunnelSection";
import { SecuritySection } from "./settings/SecuritySection";
import { NetworkSection } from "./settings/NetworkSection";

interface SettingsPanelProps {
  configPath: string;
  onConfigChange: (config: VpnConfig) => void;
  status: VpnStatus;
  onReconnect: () => Promise<void>;
  onSwitchToSetup: () => void;
  onClearConfig: () => void;
  onVpnModeChange?: (mode: string) => void;
  statusPanel?: React.ReactNode;
}

function SettingsPanel(props: SettingsPanelProps) {
  const { t } = useTranslation();
  const state = useSettingsState(props);
  const { config, saving, error, status, setError } = state;

  const isVpnActive = status === "connected" || status === "connecting";

  const saveLabel = saving
    ? t("status.saving")
    : t("buttons.save_and_reconnect");

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* StatusPanel — sticky at top */}
      {props.statusPanel}

      {/* Scrollable content — padding inside scroll area, scrollbar to window edge */}
      {config ? (
        <div className="flex-1 scroll-overlay py-3 px-4 space-y-4">
          <ConnectionSection state={state} />

          {/* Save & Reconnect — always visible, active only when VPN on + dirty */}
          <Button
            variant="primary"
            size="sm"
            fullWidth
            icon={<Save className="w-3.5 h-3.5" />}
            loading={saving}
            disabled={!isVpnActive || !state.dirty}
            onClick={() => {
              window.dispatchEvent(new CustomEvent("tt-peer-save"));
              state.handleSave(true);
            }}
          >
            {saveLabel}
          </Button>

          <TunnelSection state={state} />
          <SecuritySection state={state} />
          <NetworkSection state={state} />
        </div>
      ) : (
        <div
          className="flex-1 flex items-center justify-center text-xs"
          style={{ color: "var(--color-text-muted)" }}
        >
          {t("messages.specify_config_path")}
        </div>
      )}

    </div>
  );
}

export default SettingsPanel;
