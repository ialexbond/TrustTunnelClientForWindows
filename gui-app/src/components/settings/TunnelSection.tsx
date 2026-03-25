import { useTranslation } from "react-i18next";
import { Cable, Minus, Plus, HelpCircle } from "lucide-react";
import { Card, CardHeader } from "../../shared/ui/Card";
import { Button } from "../../shared/ui/Button";
import { Tooltip } from "../../shared/ui/Tooltip";
import type { SettingsState } from "./useSettingsState";

interface Props {
  state: SettingsState;
}

export function TunnelSection({ state }: Props) {
  const { t } = useTranslation();
  const { config, updateField, onVpnModeChange } = state;
  if (!config) return null;

  const vpnMode = config.vpn_mode;
  const protocol = config.endpoint?.upstream_protocol || "http2";
  const mtu = config.listener?.tun?.mtu_size || 1280;

  return (
    <Card padding="md">
      <CardHeader
        icon={<Cable className="w-4 h-4" />}
        title={t("settings.tunnel.title")}
      />

      {/* VPN Mode */}
      <div className="mb-2.5">
        <label className="block text-[10px] font-medium mb-1" style={{ color: "var(--color-text-secondary)" }}>
          {t("labels.vpn_mode")}
        </label>
        <div className="grid grid-cols-2 gap-1.5">
          <Button
            variant={vpnMode === "general" ? "primary" : "secondary"}
            size="sm"
            onClick={() => { updateField("vpn_mode", "general"); onVpnModeChange?.("general"); }}
          >
            {t("vpn_modes.general")}
          </Button>
          <Button
            variant={vpnMode === "selective" ? "primary" : "secondary"}
            size="sm"
            onClick={() => { updateField("vpn_mode", "selective"); onVpnModeChange?.("selective"); }}
          >
            {t("vpn_modes.selective")}
          </Button>
        </div>
        <p className="text-[9px] mt-0.5" style={{ color: "var(--color-text-muted)" }}>
          {vpnMode === "general" ? t("help_text.vpn_mode_general") : t("help_text.vpn_mode_selective")}
        </p>
      </div>

      {/* Protocol + MTU */}
      <div className="grid grid-cols-2 gap-3">
        {/* Protocol */}
        <div>
          <label className="block text-[10px] font-medium mb-1" style={{ color: "var(--color-text-secondary)" }}>
            {t("labels.protocol")}
          </label>
          <div className="grid grid-cols-2 gap-1.5">
            {(["http2", "http3"] as const).map((proto) => (
              <Button
                key={proto}
                variant={protocol === proto ? "primary" : "secondary"}
                size="sm"
                onClick={() => updateField("endpoint.upstream_protocol", proto)}
              >
                {proto === "http2" ? "HTTP/2" : "HTTP/3"}
              </Button>
            ))}
          </div>
        </div>

        {/* MTU — buttons embedded inside input */}
        <div>
          <div className="flex items-center gap-1 mb-1">
            <label className="text-[10px] font-medium" style={{ color: "var(--color-text-secondary)" }}>
              {t("labels.mtu")}
            </label>
            <Tooltip text={t("tooltips.mtu")}>
              <HelpCircle className="w-3 h-3 cursor-help" style={{ color: "var(--color-text-muted)" }} />
            </Tooltip>
          </div>
          <div
            className="flex items-center rounded-[var(--radius-lg)] overflow-hidden"
            style={{
              backgroundColor: "var(--color-input-bg)",
              border: "1px solid var(--color-input-border)",
            }}
          >
            <button
              onClick={() => updateField("listener.tun.mtu_size", Math.max(576, mtu - 10))}
              className="px-2.5 py-1.5 transition-colors shrink-0"
              style={{ color: "var(--color-text-muted)" }}
            >
              <Minus className="w-3 h-3" />
            </button>
            <input
              type="text"
              inputMode="numeric"
              value={mtu}
              onChange={(e) => {
                const raw = e.target.value.replace(/\D/g, "").slice(0, 4);
                const num = Number(raw) || 0;
                updateField("listener.tun.mtu_size", Math.min(9000, num));
              }}
              onBlur={() => {
                if (mtu < 576) updateField("listener.tun.mtu_size", 576);
                else if (mtu > 9000) updateField("listener.tun.mtu_size", 9000);
              }}
              className="flex-1 min-w-0 bg-transparent text-center text-xs outline-none py-1.5"
              style={{ color: "var(--color-text-primary)" }}
            />
            <button
              onClick={() => updateField("listener.tun.mtu_size", Math.min(9000, mtu + 10))}
              className="px-2.5 py-1.5 transition-colors shrink-0"
              style={{ color: "var(--color-text-muted)" }}
            >
              <Plus className="w-3 h-3" />
            </button>
          </div>
        </div>
      </div>
    </Card>
  );
}
