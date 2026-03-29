import { useTranslation } from "react-i18next";
import { Cable, Minus, Plus, HelpCircle, Globe, Shield } from "lucide-react";
import { Card, CardHeader } from "../../shared/ui/Card";
import { Button } from "../../shared/ui/Button";
import { Input } from "../../shared/ui/Input";
import { Tooltip } from "../../shared/ui/Tooltip";
import type { SettingsState } from "./useSettingsState";

interface Props {
  state: SettingsState;
}

export function TunnelSection({ state }: Props) {
  const { t } = useTranslation();
  const { config, updateField } = state;
  if (!config) return null;

  const protocol = config.endpoint?.upstream_protocol || "http2";
  const mtu = config.listener?.tun?.mtu_size || 1280;
  const listenerMode = config.listener?.socks ? "socks" : "tun";
  const socksAddress = config.listener?.socks?.address || "127.0.0.1:1080";

  return (
    <Card padding="md">
      <CardHeader
        icon={<Cable className="w-4 h-4" />}
        title={t("settings.tunnel.title")}
      />

      {/* Listener Mode: TUN vs SOCKS5 */}
      <div className="mb-3">
        <label className="block text-[10px] font-medium mb-1" style={{ color: "var(--color-text-secondary)" }}>
          {t("settings.tunnel.listenerMode")}
        </label>
        <div className="grid grid-cols-2 gap-1.5">
          <Button
            variant={listenerMode === "tun" ? "primary" : "secondary"}
            size="sm"
            icon={<Shield className="w-3 h-3" />}
            onClick={() => {
              if (listenerMode === "socks") {
                // Switch to TUN: remove socks, ensure tun exists
                updateField("listener.socks", undefined);
                if (!config.listener?.tun) {
                  updateField("listener.tun.mtu_size", 1280);
                  updateField("listener.tun.change_system_dns", true);
                }
              }
            }}
          >
            TUN
          </Button>
          <Button
            variant={listenerMode === "socks" ? "primary" : "secondary"}
            size="sm"
            icon={<Globe className="w-3 h-3" />}
            onClick={() => {
              if (listenerMode === "tun") {
                // Switch to SOCKS5: add socks config
                updateField("listener.socks.address", "127.0.0.1:1080");
              }
            }}
          >
            SOCKS5
          </Button>
        </div>
      </div>

      {/* SOCKS5 address (only in socks mode) */}
      {listenerMode === "socks" && (
        <div className="mb-3">
          <label className="block text-[10px] font-medium mb-1" style={{ color: "var(--color-text-secondary)" }}>
            {t("settings.tunnel.socksAddress")}
          </label>
          <Input
            value={socksAddress}
            onChange={(e) => updateField("listener.socks.address", e.target.value)}
            placeholder="127.0.0.1:1080"
          />
        </div>
      )}

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
