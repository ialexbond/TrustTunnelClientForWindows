import { useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  Settings,
  ChevronDown,
  ChevronUp,
  Info,
} from "lucide-react";
import { Card, CardHeader } from "../../shared/ui/Card";
import { Button } from "../../shared/ui/Button";
import { Tooltip } from "../../shared/ui/Tooltip";
import { formatError } from "../../shared/utils/formatError";
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

  const listenMatch = raw.match(/listen_address\s*=\s*"([^"]+)"/);
  if (listenMatch) result.listenAddr = listenMatch[1];

  const tlsMatch = raw.match(/tls_handshake_timeout_secs\s*=\s*(\d+)/);
  if (tlsMatch) result.tlsHandshake = `${tlsMatch[1]}s`;

  const tcpMatch = raw.match(/tcp_connections_timeout_secs\s*=\s*(\d+)/);
  if (tcpMatch) result.tcpTimeout = `${tcpMatch[1]}s`;

  const udpMatch = raw.match(/udp_connections_timeout_secs\s*=\s*(\d+)/);
  if (udpMatch) result.udpTimeout = `${udpMatch[1]}s`;

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
  const { sshParams, setActionResult, configRaw: preloadedConfig, setConfigRaw: setPreloadedConfig } = state;
  const [showFull, setShowFull] = useState(false);
  const [togglingFeatures, setTogglingFeatures] = useState<Set<string>>(new Set());
  // Local overrides: optimistic UI — shows new value immediately after server confirms
  const [localOverrides, setLocalOverrides] = useState<Record<string, boolean>>({});
  const activeTogglesRef = useRef(0);

  const configRaw = preloadedConfig || "";

  const loadConfig = async () => {
    try {
      const raw = await invoke<string>("server_get_config", sshParams);
      setPreloadedConfig(raw);
    } catch (e) {
      state.pushSuccess(formatError(e), "error");
    }
  };

  const featureNames: Record<string, string> = {
    ping_enable: "Health-check Ping",
    speedtest_enable: "Speedtest",
    ipv6_available: "IPv6",
  };

  const handleToggleFeature = async (feature: string, currentValue: boolean) => {
    // Ignore if already toggling this specific feature (prevent double-click)
    if (togglingFeatures.has(feature)) return;

    setTogglingFeatures(prev => new Set(prev).add(feature));
    activeTogglesRef.current += 1;

    try {
      await invoke("server_update_config_feature", {
        ...sshParams,
        feature,
        enabled: !currentValue,
      });
      // Optimistic: update THIS switch immediately
      setLocalOverrides(prev => ({ ...prev, [feature]: !currentValue }));
      const name = featureNames[feature] || feature;
      const stateText = !currentValue ? t("server.config.toggled_on") : t("server.config.toggled_off");
      state.pushSuccess(`${name} ${stateText}`);
    } catch (e) {
      // Rollback: remove override so it shows original value
      setLocalOverrides(prev => { const next = { ...prev }; delete next[feature]; return next; });
      setActionResult({ type: "error", message: formatError(e) });
    } finally {
      setTogglingFeatures(prev => { const next = new Set(prev); next.delete(feature); return next; });
      activeTogglesRef.current -= 1;
      // Reload config only after ALL toggles are done — sync with server
      if (activeTogglesRef.current === 0) {
        await loadConfig();
        setLocalOverrides({}); // Clear overrides, use fresh server data
      }
    }
  };

  const parsed = configRaw ? parseTomlConfig(configRaw) : null;

  // If no config data yet, don't render
  if (!configRaw) return null;

  if (!parsed) return null;

  const featureItems = [
    { key: "ping_enable", label: "Health-check Ping", desc: t("server.config.ping_desc"), value: localOverrides.ping_enable ?? parsed.pingEnable },
    { key: "speedtest_enable", label: "Speedtest", desc: t("server.config.speedtest_desc"), value: localOverrides.speedtest_enable ?? parsed.speedtestEnable },
    { key: "ipv6_available", label: "IPv6", desc: t("server.config.ipv6_desc"), value: localOverrides.ipv6_available ?? parsed.ipv6Available },
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
          <div className="space-y-1">
            {featureItems.map((feat) => (
              <div
                key={feat.key}
                className="flex items-center justify-between px-3 py-1.5 rounded-[var(--radius-md)]"
                style={{ borderBottom: "1px solid var(--color-border)" }}
              >
                <div className="leading-tight">
                  <span className="text-xs font-medium" style={{ color: "var(--color-text-primary)" }}>{feat.label}</span>
                  <span className="text-[10px] block" style={{ color: "var(--color-text-muted)", marginTop: "1px" }}>{feat.desc}</span>
                </div>
                <button
                  onClick={() => handleToggleFeature(feat.key, feat.value)}
                  disabled={togglingFeatures.has(feat.key)}
                  className="shrink-0 rounded-full focus:outline-none relative overflow-hidden"
                  style={{
                    width: "40px",
                    height: "22px",
                    backgroundColor: feat.value ? "var(--color-accent-500)" : "var(--color-border)",
                    transition: "background-color 0.3s ease",
                  }}
                >
                  <span
                    className="absolute flex items-center justify-center rounded-full"
                    style={{
                      width: "18px",
                      height: "18px",
                      top: "2px",
                      left: feat.value ? "20px" : "2px",
                      backgroundColor: "white",
                      transition: "left 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
                    }}
                  >
                    {togglingFeatures.has(feat.key) && (
                      <svg className="animate-spin" width="10" height="10" viewBox="0 0 10 10" fill="none">
                        <circle cx="5" cy="5" r="4" stroke="var(--color-accent-500)" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="12 8" />
                      </svg>
                    )}
                  </span>
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
