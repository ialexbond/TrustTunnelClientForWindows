import { useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { SlidersHorizontal, Network, Zap, AlertTriangle } from "lucide-react";
import { Card, CardHeader } from "../../shared/ui/Card";
import { Button } from "../../shared/ui/Button";
import { Toggle } from "../../shared/ui/Toggle";
import { Accordion } from "../../shared/ui/Accordion";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { formatError } from "../../shared/utils/formatError";
import type { ServerState } from "./useServerState";
import { useBbrState } from "./useBbrState";
import { useMtProtoState } from "./useMtProtoState";
import { useSecurityState } from "./useSecurityState";
import { SshPortSection } from "./SshPortSection";
import { VersionSection } from "./VersionSection";
import { MtProtoSection } from "./MtProtoSection";

interface Props {
  state: ServerState;
}

function parseTomlConfig(raw: string) {
  const pingMatch = raw.match(/ping_enable\s*=\s*(true|false)/);
  const speedMatch = raw.match(/speedtest_enable\s*=\s*(true|false)/);
  const ipv6Match = raw.match(/ipv6_available\s*=\s*(true|false)/);
  return {
    pingEnable: pingMatch ? pingMatch[1] === "true" : false,
    speedtestEnable: speedMatch ? speedMatch[1] === "true" : false,
    ipv6Available: ipv6Match ? ipv6Match[1] === "true" : false,
  };
}

export function ServerSettingsSection({ state }: Props) {
  const { t } = useTranslation();
  const { sshParams, configRaw: preloadedConfig, setConfigRaw: setPreloadedConfig, setActionResult } = state;

  const configRaw = preloadedConfig ?? "";

  // ─── Feature toggles state ───
  const [togglingFeatures, setTogglingFeatures] = useState<Set<string>>(new Set());
  const [localOverrides, setLocalOverrides] = useState<Record<string, boolean>>({});
  const activeTogglesRef = useRef(0);

  // ─── Sub-hooks ───
  const bbr = useBbrState(sshParams, state.pushSuccess);
  const mtproto = useMtProtoState(sshParams, state.pushSuccess);
  const security = useSecurityState(sshParams, state.pushSuccess, state.onPortChanged);

  // ─── Save settings state ───
  const [saveLoading, setSaveLoading] = useState(false);
  const [confirmSave, setConfirmSave] = useState(false);

  const parsed = configRaw ? parseTomlConfig(configRaw) : null;

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
    if (togglingFeatures.has(feature)) return;
    setTogglingFeatures((prev) => new Set(prev).add(feature));
    activeTogglesRef.current += 1;
    try {
      await invoke("server_update_config_feature", {
        ...sshParams,
        feature,
        enabled: !currentValue,
      });
      setLocalOverrides((prev) => ({ ...prev, [feature]: !currentValue }));
      const name = featureNames[feature] || feature;
      const stateText = !currentValue
        ? t("server.config.toggled_on")
        : t("server.config.toggled_off");
      state.pushSuccess(`${name} ${stateText}`);
    } catch (e) {
      setLocalOverrides((prev) => {
        const next = { ...prev };
        delete next[feature];
        return next;
      });
      setActionResult({ type: "error", message: formatError(e) });
    } finally {
      setTogglingFeatures((prev) => {
        const next = new Set(prev);
        next.delete(feature);
        return next;
      });
      activeTogglesRef.current -= 1;
      if (activeTogglesRef.current === 0) {
        await loadConfig();
        setLocalOverrides({});
      }
    }
  };

  const handleSaveSettings = async () => {
    setSaveLoading(true);
    try {
      await invoke("server_apply_config", sshParams);
      state.pushSuccess(t("server.actions.success_generic"));
      setConfirmSave(false);
    } catch (e) {
      setActionResult({ type: "error", message: formatError(e) });
    } finally {
      setSaveLoading(false);
    }
  };

  const featureItems = parsed
    ? [
        {
          key: "ping_enable",
          label: "Health-check Ping",
          desc: t("server.config.ping_desc"),
          value: localOverrides.ping_enable ?? parsed.pingEnable,
        },
        {
          key: "speedtest_enable",
          label: "Speedtest",
          desc: t("server.config.speedtest_desc"),
          value: localOverrides.speedtest_enable ?? parsed.speedtestEnable,
        },
        {
          key: "ipv6_available",
          label: "IPv6",
          desc: t("server.config.ipv6_desc"),
          value: localOverrides.ipv6_available ?? parsed.ipv6Available,
        },
      ]
    : [];

  return (
    <div className="space-y-4">
      {/* Block 1: Feature Toggles */}
      <Card>
        <CardHeader
          title={t("server.config.toggles_title")}
          icon={<SlidersHorizontal className="w-3.5 h-3.5" />}
        />
        {featureItems.length > 0 ? (
          <div className="space-y-1">
            {featureItems.map((feat) => (
              <div
                key={feat.key}
                className="flex items-start justify-between px-3 py-3 rounded-[var(--radius-md)]"
                style={{ borderBottom: "1px solid var(--color-border)" }}
              >
                <div className="leading-tight">
                  <span
                    className="text-sm font-[var(--font-weight-semibold)]"
                    style={{ color: "var(--color-text-primary)" }}
                  >
                    {feat.label}
                  </span>
                  <span
                    className="text-xs block mt-0.5"
                    style={{ color: "var(--color-text-muted)" }}
                  >
                    {feat.desc}
                  </span>
                </div>
                <button
                  onClick={() => void handleToggleFeature(feat.key, feat.value)}
                  disabled={togglingFeatures.has(feat.key)}
                  className="shrink-0 rounded-full focus:outline-none focus-visible:shadow-[var(--focus-ring)] relative overflow-hidden"
                  style={{
                    width: "40px",
                    height: "22px",
                    backgroundColor: feat.value
                      ? "var(--color-accent-500)"
                      : "var(--color-border)",
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
                      <svg
                        className="animate-spin"
                        width="10"
                        height="10"
                        viewBox="0 0 10 10"
                        fill="none"
                      >
                        <circle
                          cx="5"
                          cy="5"
                          r="4"
                          stroke="var(--color-accent-500)"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeDasharray="12 8"
                        />
                      </svg>
                    )}
                  </span>
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div
            className="text-xs py-2"
            style={{ color: "var(--color-text-muted)" }}
          >
            {t("server.config.loading")}
          </div>
        )}
      </Card>

      {/* Block 2: Network */}
      <Card>
        <CardHeader
          title={t("server.config.network_title")}
          icon={<Network className="w-3.5 h-3.5" />}
        />
        <div className="space-y-2">
          {/* BBR Toggle */}
          <Toggle
            value={bbr.enabled}
            onChange={() => void bbr.toggle()}
            label={t("server.utilities.bbr.label")}
            description={
              bbr.loading
                ? t("server.utilities.bbr.detecting")
                : t("server.utilities.bbr.description")
            }
            icon={<Zap className="w-3 h-3" />}
            disabled={bbr.loading}
          />
          {/* SSH Port Section */}
          <SshPortSection state={security} />
        </div>
      </Card>

      {/* Block 3: Advanced Accordion */}
      <Accordion
        defaultOpen={[]}
        items={[
          {
            id: "advanced",
            title: (
              <span
                className="text-sm font-[var(--font-weight-semibold)]"
                style={{ color: "var(--color-text-primary)" }}
              >
                {t("server.config.advanced")}
              </span>
            ),
            content: (
              <div className="space-y-4">
                {/* Version Section */}
                <VersionSection state={state} />

                {/* Raw vpn.toml */}
                {configRaw && (
                  <div>
                    <span
                      className="text-xs font-[var(--font-weight-semibold)] block mb-2"
                      style={{ color: "var(--color-text-secondary)" }}
                    >
                      vpn.toml
                    </span>
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
                )}

                {/* MTProto Section */}
                {mtproto.status && <MtProtoSection state={mtproto} />}

                <ConfirmDialog
                  open={!!mtproto.confirm}
                  title={mtproto.confirm?.title ?? ""}
                  message={mtproto.confirm?.message ?? ""}
                  confirmLabel={t("server.utilities.mtproto.uninstall")}
                  cancelLabel={t("buttons.cancel")}
                  variant="warning"
                  onCancel={() => mtproto.setConfirm(null)}
                  onConfirm={() => mtproto.confirm?.onConfirm()}
                />
              </div>
            ),
          },
        ]}
      />

      {/* ConfirmDialog for security actions */}
      <ConfirmDialog
        open={!!security.confirm}
        title={security.confirm?.title ?? ""}
        message={security.confirm?.message ?? ""}
        variant={security.confirm?.variant ?? "danger"}
        confirmLabel={t("buttons.confirm")}
        cancelLabel={t("buttons.cancel")}
        onCancel={() => security.setConfirm(null)}
        onConfirm={() => security.confirm?.onConfirm()}
      />

      {/* Save CTA */}
      <div className="flex justify-end pt-2">
        <Button
          variant="primary"
          onClick={() => setConfirmSave(true)}
          loading={saveLoading}
        >
          {t("server.config.save_settings")}
        </Button>
      </div>

      <ConfirmDialog
        open={confirmSave}
        title={t("server.danger.confirm_reboot_title")}
        message={t("server.config.save_settings")}
        confirmLabel={t("buttons.confirm")}
        cancelLabel={t("buttons.cancel")}
        variant="warning"
        loading={saveLoading}
        onCancel={() => setConfirmSave(false)}
        onConfirm={() => void handleSaveSettings()}
      />

      {/* Warning if no config loaded */}
      {!configRaw && (
        <div
          className="flex items-center gap-2 text-xs"
          style={{ color: "var(--color-warning-500)" }}
        >
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>{t("server.config.loading")}</span>
        </div>
      )}
    </div>
  );
}
