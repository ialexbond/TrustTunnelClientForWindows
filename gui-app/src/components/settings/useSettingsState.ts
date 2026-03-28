import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { VpnConfig, VpnStatus } from "../../App";
import { useSuccessQueue } from "../../shared/hooks/useSuccessQueue";
import { useAutoSave } from "../../shared/hooks/useAutoSave";

// ═══════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════

export interface ClientConfig {
  loglevel: string;
  vpn_mode: string;
  killswitch_enabled: boolean;
  post_quantum_group_enabled: boolean;
  endpoint: {
    hostname: string;
    addresses: string[];
    upstream_protocol: string;
    anti_dpi: boolean;
    skip_verification: boolean;
    custom_sni: string;
    has_ipv6: boolean;
    username: string;
    password: string;
    [key: string]: unknown;
  };
  listener: {
    tun: {
      mtu_size: number;
      change_system_dns: boolean;
      included_routes: string[];
      excluded_routes: string[];
    };
  };
  dns_upstreams?: string[];
  [key: string]: unknown;
}

export interface SettingsProps {
  configPath: string;
  onConfigChange: (config: VpnConfig) => void;
  status: VpnStatus;
  onReconnect: () => Promise<void>;
  onSwitchToSetup: () => void;
  onClearConfig: () => void;
  onVpnModeChange?: (mode: string) => void;
}

export interface SettingsState {
  config: ClientConfig | null;
  saving: boolean;
  error: string;
  localPath: string;
  dirty: boolean;
  status: VpnStatus;
  successQueue: string[];

  setLocalPath: (path: string) => void;
  setError: (msg: string) => void;
  updateField: (path: string, value: unknown) => void;
  handleSave: (reconnect?: boolean) => Promise<void>;
  browseConfig: () => Promise<void>;
  clearConfig: () => void;
  pushSuccess: (msg: string) => void;
  shiftSuccess: () => void;
  onVpnModeChange?: (mode: string) => void;
}

// ═══════════════════════════════════════════════════════
// Hook
// ═══════════════════════════════════════════════════════

export function useSettingsState(props: SettingsProps): SettingsState {
  const { t } = useTranslation();
  const {
    configPath,
    onConfigChange,
    status,
    onReconnect,
    onSwitchToSetup,
    onClearConfig,
    onVpnModeChange,
  } = props;

  const [config, setConfig] = useState<ClientConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [localPath, setLocalPath] = useState(configPath);
  const [reloadKey, setReloadKey] = useState(0);

  // ─── SnackBar queue ───
  const { successQueue, pushSuccess, shiftSuccess } = useSuccessQueue();

  // ─── Dirty tracking ───
  const savedSnapshot = useRef<string>("");
  const dirty = config ? JSON.stringify(config) !== savedSnapshot.current : false;

  // ─── Sync path from parent ───
  useEffect(() => {
    setLocalPath(configPath);
    setReloadKey(k => k + 1);
    if (!configPath) {
      setConfig(null);
      setError("");
      savedSnapshot.current = "";
    }
  }, [configPath]);

  // ─── Load config ───
  const loadConfig = useCallback(async () => {
    if (!localPath) return;
    try {
      setError("");
      const data = await invoke<ClientConfig>("read_client_config", {
        configPath: localPath,
      });
      setConfig(data);
      savedSnapshot.current = JSON.stringify(data);
    } catch (e) {
      setError(String(e));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localPath, reloadKey]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  // ─── Update a nested field ───
  const updateField = useCallback(
    (path: string, value: unknown) => {
      if (!config) return;
      const clone = JSON.parse(JSON.stringify(config));
      const parts = path.split(".");
      let obj = clone;
      for (let i = 0; i < parts.length - 1; i++) {
        obj = obj[parts[i]];
      }
      obj[parts[parts.length - 1]] = value;
      setConfig(clone);
    },
    [config]
  );

  // ─── Silent save (for auto-save — subtle snackbar, no saving spinner) ───
  const silentSave = useCallback(async () => {
    if (!config || !localPath) return;
    try {
      const configToSave = {
        ...config,
        listener: {
          ...config.listener,
          tun: { ...config.listener?.tun, change_system_dns: true },
        },
      };
      await invoke("save_client_config", {
        configPath: localPath,
        config: configToSave,
      });
      savedSnapshot.current = JSON.stringify(config);
      onConfigChange({ configPath: localPath, logLevel: config.loglevel });
      pushSuccess(t("messages.settings_saved", "Настройки сохранены"));
    } catch (e) {
      setError(String(e));
    }
  }, [config, localPath, onConfigChange, pushSuccess, t]);

  // ─── Manual save (with UI feedback, snackbar, reconnect) ───
  const handleSave = useCallback(async (reconnect = false) => {
    if (!config || !localPath) return;
    setSaving(true);
    setError("");
    try {
      const configToSave = {
        ...config,
        listener: {
          ...config.listener,
          tun: { ...config.listener?.tun, change_system_dns: true },
        },
      };
      await invoke("save_client_config", {
        configPath: localPath,
        config: configToSave,
      });
      savedSnapshot.current = JSON.stringify(config);
      onConfigChange({ configPath: localPath, logLevel: config.loglevel });

      if (reconnect && (status === "connected" || status === "connecting")) {
        pushSuccess(t("messages.reconnecting", "Переподключение..."));
        await onReconnect();
      } else {
        pushSuccess(t("messages.settings_saved", "Настройки сохранены"));
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [config, localPath, onConfigChange, status, onReconnect, pushSuccess, t]);

  // ─── SnackBar on VPN status change ───
  const prevStatus = useRef<VpnStatus>(status);
  useEffect(() => {
    if (prevStatus.current === status) return;
    const prev = prevStatus.current;
    prevStatus.current = status;
    if (status === "connected" && prev !== "connected") {
      pushSuccess(t("status.connected"));
    } else if (status === "disconnected" && prev !== "disconnected") {
      pushSuccess(t("status.disconnected"));
    }
  }, [status, pushSuccess, t]);

  // ─── Auto-save when VPN not active (silent, no UI) ───
  useAutoSave({
    dirty,
    canSave: !!config && !!localPath,
    isActive: status === "connected" || status === "connecting",
    onSave: silentSave,
  });

  // ─── Browse for config file ───
  const browseConfig = useCallback(async () => {
    let defaultPath: string | undefined;
    if (localPath) {
      const sep = localPath.includes("/") ? "/" : "\\";
      const lastSep = localPath.lastIndexOf(sep);
      if (lastSep > 0) defaultPath = localPath.substring(0, lastSep);
    }
    const selected = await open({
      multiple: false,
      defaultPath,
      filters: [{ name: "TOML Config", extensions: ["toml"] }],
    });
    if (selected) {
      try {
        const copied = await invoke<string>("copy_config_to_app_dir", { sourcePath: selected as string });
        setLocalPath(copied);
        setReloadKey(k => k + 1);
        onConfigChange({ configPath: copied, logLevel: config?.loglevel || "info" });
      } catch {
        setLocalPath(selected as string);
        setReloadKey(k => k + 1);
        onConfigChange({ configPath: selected as string, logLevel: config?.loglevel || "info" });
      }
    }
  }, [localPath, config, onConfigChange]);

  // ─── Clear config & switch to setup ───
  const clearConfig = useCallback(() => {
    onClearConfig();
    onSwitchToSetup();
  }, [onClearConfig, onSwitchToSetup]);

  return {
    config,
    saving,
    error,
    localPath,
    dirty,
    status,
    successQueue,

    setLocalPath,
    setError,
    updateField,
    handleSave,
    browseConfig,
    clearConfig,
    pushSuccess,
    shiftSuccess,
    onVpnModeChange,
  };
}
