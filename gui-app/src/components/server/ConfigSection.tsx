import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  Settings,
  ChevronDown,
  ChevronUp,
  Info,
  Loader2,
} from "lucide-react";
import { Card, CardHeader } from "../../shared/ui/Card";
import { Button } from "../../shared/ui/Button";
import { Tooltip } from "../../shared/ui/Tooltip";
import type { ServerState } from "./useServerState";

interface Props {
  state: ServerState;
}

interface ParsedConfig {
  listenAddr: string;
  tlsHandshake: string;
  tcpTimeout: string;
  udpTimeout: string;
  pingEnable: boolean;
  speedtestEnable: boolean;
  ipv6Available: boolean;
}

function parseTomlConfig(raw: string): ParsedConfig {
  const result: ParsedConfig = {
    listenAddr: "",
    tlsHandshake: "",
    tcpTimeout: "",
    udpTimeout: "",
    pingEnable: false,
    speedtestEnable: false,
    ipv6Available: false,
  };

  const listenMatch = raw.match(/listen\s*=\s*"([^"]+)"/);
  if (listenMatch) result.listenAddr = listenMatch[1];

  const tlsMatch = raw.match(/tls_handshake_timeout\s*=\s*"([^"]+)"/);
  if (tlsMatch) result.tlsHandshake = tlsMatch[1];

  const tcpMatch = raw.match(/tcp_connection_timeout\s*=\s*"([^"]+)"/);
  if (tcpMatch) result.tcpTimeout = tcpMatch[1];

  const udpMatch = raw.match(/udp_connection_timeout\s*=\s*"([^"]+)"/);
  if (udpMatch) result.udpTimeout = udpMatch[1];

  const pingMatch = raw.match(/ping_enable\s*=\s*(true|false)/);
  if (pingMatch) result.pingEnable = pingMatch[1] === "true";

  const speedMatch = raw.match(/speedtest_enable\s*=\s*(true|false)/);
  if (speedMatch) result.speedtestEnable = speedMatch[1] === "true";

  const ipv6Match = raw.match(/ipv6_available\s*=\s*(true|false)/);
  if (ipv6Match) result.ipv6Available = ipv6Match[1] === "true";

  return result;
}

export function ConfigSection({ state }: Props) {
  const { t } = useTranslation();
  const { sshParams, setActionResult } = state;

  const [configRaw, setConfigRaw] = useState("");
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState("");
  const [showFull, setShowFull] = useState(false);
  const [togglingFeature, setTogglingFeature] = useState<string | null>(null);

  const loadConfig = async () => {
    setConfigLoading(true);
    setConfigError("");
    try {
      const raw = await invoke<string>("server_get_config", sshParams);
      setConfigRaw(raw);
    } catch (e) {
      setConfigError(String(e));
    } finally {
      setConfigLoading(false);
    }
  };

  // Auto-load on mount
  useEffect(() => {
    loadConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleToggleFeature = async (feature: string, currentValue: boolean) => {
    setTogglingFeature(feature);
    try {
      await invoke("server_update_config_feature", {
        ...sshParams,
        feature,
        enabled: !currentValue,
      });
      await loadConfig();
      setActionResult({
        type: "ok",
        message: `${feature}: ${!currentValue ? t("server.config.enabled") : t("server.config.disabled")}`,
      });
    } catch (e) {
      setActionResult({ type: "error", message: String(e) });
    } finally {
      setTogglingFeature(null);
    }
  };

  const parsed = configRaw ? parseTomlConfig(configRaw) : null;

  if (configLoading) {
    return (
      <Card>
        <CardHeader title={t("server.config.title")} icon={<Settings className="w-3.5 h-3.5" />} />
        <div className="flex items-center gap-2 py-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: "var(--color-text-muted)" }} />
          <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>{t("server.config.loading")}</span>
        </div>
      </Card>
    );
  }

  if (configError) {
    return (
      <Card>
        <CardHeader title={t("server.config.title")} icon={<Settings className="w-3.5 h-3.5" />} />
        <p className="text-[11px]" style={{ color: "var(--color-danger-500)" }}>{configError}</p>
        <Button variant="secondary" size="sm" onClick={loadConfig} className="mt-2">{t("server.actions.retry")}</Button>
      </Card>
    );
  }

  if (!parsed) return null;

  const featureItems = [
    { key: "ping_enable", label: "Health-check Ping", desc: t("server.config.ping_desc"), value: parsed.pingEnable },
    { key: "speedtest_enable", label: "Speedtest", desc: t("server.config.speedtest_desc"), value: parsed.speedtestEnable },
    { key: "ipv6_available", label: "IPv6", desc: t("server.config.ipv6_desc"), value: parsed.ipv6Available },
  ];

  return (
    <Card>
      <CardHeader
        title={t("server.config.title")}
        icon={<Settings className="w-3.5 h-3.5" />}
        action={
          <Tooltip text={t("server.config.tooltip")}>
            <Info className="w-3.5 h-3.5 cursor-help" style={{ color: "var(--color-text-muted)" }} />
          </Tooltip>
        }
      />

      <div className="space-y-3">
        {/* Listen Address */}
        {parsed.listenAddr && (
          <div className="flex items-center justify-between">
            <span className="text-[11px]" style={{ color: "var(--color-text-secondary)" }}>{t("server.config.listen")}</span>
            <code
              className="text-[11px] px-1.5 py-0.5 rounded-[var(--radius-sm)] font-mono"
              style={{ backgroundColor: "var(--color-bg-hover)", color: "var(--color-text-primary)" }}
            >
              {parsed.listenAddr}
            </code>
          </div>
        )}

        {/* Timeouts */}
        {(parsed.tlsHandshake || parsed.tcpTimeout || parsed.udpTimeout) && (
          <div>
            <span className="text-[11px] font-medium block mb-1.5" style={{ color: "var(--color-text-secondary)" }}>
              {t("server.config.timeouts")}
            </span>
            <div className="space-y-1 pl-2">
              {parsed.tlsHandshake && (
                <div className="flex items-center justify-between">
                  <span className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>{t("server.config.tls_handshake")}</span>
                  <span className="text-[10px] font-mono" style={{ color: "var(--color-text-primary)" }}>{parsed.tlsHandshake}</span>
                </div>
              )}
              {parsed.tcpTimeout && (
                <div className="flex items-center justify-between">
                  <span className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>{t("server.config.tcp_timeout")}</span>
                  <span className="text-[10px] font-mono" style={{ color: "var(--color-text-primary)" }}>{parsed.tcpTimeout}</span>
                </div>
              )}
              {parsed.udpTimeout && (
                <div className="flex items-center justify-between">
                  <span className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>{t("server.config.udp_timeout")}</span>
                  <span className="text-[10px] font-mono" style={{ color: "var(--color-text-primary)" }}>{parsed.udpTimeout}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Feature toggles */}
        <div>
          <span className="text-[11px] font-medium block mb-2" style={{ color: "var(--color-text-secondary)" }}>
            {t("server.config.features")}
          </span>
          <div className="space-y-2">
            {featureItems.map((feat) => (
              <div
                key={feat.key}
                className="flex items-center justify-between px-3 py-2 rounded-[var(--radius-md)]"
                style={{ backgroundColor: "var(--color-bg-elevated)", border: "1px solid var(--color-border)" }}
              >
                <div>
                  <span className="text-xs font-medium block" style={{ color: "var(--color-text-primary)" }}>{feat.label}</span>
                  <span className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>{feat.desc}</span>
                </div>
                <button
                  onClick={() => handleToggleFeature(feat.key, feat.value)}
                  disabled={togglingFeature === feat.key}
                  className="relative shrink-0 w-10 h-[22px] rounded-full transition-colors duration-200 focus:outline-none"
                  style={{
                    backgroundColor: feat.value ? "var(--color-accent-500)" : "#d1d5db",
                    opacity: togglingFeature === feat.key ? 0.5 : 1,
                  }}
                >
                  <span
                    className="absolute top-[3px] w-4 h-4 rounded-full transition-transform duration-200 shadow-sm"
                    style={{
                      backgroundColor: "white",
                      transform: feat.value ? "translateX(22px)" : "translateX(3px)",
                    }}
                  />
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Show full vpn.toml toggle */}
        <Button
          variant="ghost"
          size="sm"
          icon={showFull ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          onClick={() => setShowFull(!showFull)}
        >
          {showFull ? t("server.config.hide_full") : t("server.config.show_full")}
        </Button>

        <div
          className="overflow-hidden transition-all duration-300 ease-in-out"
          style={{ maxHeight: showFull ? "240px" : "0px", opacity: showFull ? 1 : 0 }}
        >
          <pre
            className="p-3 rounded-[var(--radius-md)] text-[10px] leading-relaxed overflow-auto max-h-48 whitespace-pre-wrap font-mono"
            style={{
              backgroundColor: "var(--color-bg-primary)",
              border: "1px solid var(--color-border)",
              color: "var(--color-text-muted)",
              paddingRight: "1rem",
            }}
          >
            {configRaw}
          </pre>
        </div>
      </div>
    </Card>
  );
}
