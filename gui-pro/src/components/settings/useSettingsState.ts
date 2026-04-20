import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { VpnConfig, VpnStatus } from "../../shared/types";
import { useSnackBar } from "../../shared/ui/SnackBarContext";
import { useAutoSave } from "../../shared/hooks/useAutoSave";
import { formatError } from "../../shared/utils/formatError";

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
    tun?: {
      mtu_size: number;
      change_system_dns: boolean;
      included_routes: string[];
      excluded_routes: string[];
    };
    socks?: {
      address: string;
      username?: string;
      password?: string;
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

  setLocalPath: (path: string) => void;
  setError: (msg: string) => void;
  updateField: (path: string, value: unknown) => void;
  handleSave: (reconnect?: boolean) => Promise<void>;
  browseConfig: () => Promise<void>;
  clearConfig: () => void;
  pushSuccess: (msg: string, type?: "success" | "error") => void;
  onVpnModeChange?: (mode: string) => void;
}

// ═══════════════════════════════════════════════════════
// Deep equal for dirty tracking (ignores empty strings in arrays)
// ═══════════════════════════════════════════════════════

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    const fa = a.filter(v => v !== "");
    const fb = b.filter(v => v !== "");
    if (fa.length !== fb.length) return false;
    return fa.every((v, i) => deepEqual(v, fb[i]));
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(k => k in bObj && deepEqual(aObj[k], bObj[k]));
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

  // ─── SnackBar (global) ───
  const pushSuccess = useSnackBar();

  // ─── Dirty tracking via deep equal ───
  const savedConfig = useRef<ClientConfig | null>(null);
  const dirty = config !== null && savedConfig.current !== null && !deepEqual(config, savedConfig.current);

  // ─── Sync path from parent ───
  useEffect(() => {
    setLocalPath(configPath);
    setReloadKey(k => k + 1);
    if (!configPath) {
      setConfig(null);
      setError("");
      savedConfig.current = null;
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
      savedConfig.current = JSON.parse(JSON.stringify(data));
    } catch (e) {
      pushSuccess(formatError(e), "error");
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
        if (obj[parts[i]] == null || typeof obj[parts[i]] !== "object") {
          obj[parts[i]] = {};
        }
        obj = obj[parts[i]];
      }
      if (value === undefined) {
        delete obj[parts[parts.length - 1]];
      } else {
        obj[parts[parts.length - 1]] = value;
      }
      setConfig(clone);
    },
    [config]
  );

  // ─── Build config for saving (preserve only active listener) ───
  const buildConfigToSave = useCallback(() => {
    if (!config) return config;
    const clone = { ...config };
    if (config.listener?.socks) {
      // SOCKS5 mode — only socks, no tun
      clone.listener = { socks: config.listener.socks };
    } else {
      // TUN mode — ensure change_system_dns is true
      clone.listener = {
        tun: { ...config.listener?.tun, change_system_dns: true } as { mtu_size: number; change_system_dns: boolean; included_routes: string[]; excluded_routes: string[] },
      };
    }
    return clone;
  }, [config]);

  // ─── Silent save (for auto-save — subtle snackbar, no saving spinner) ───
  const silentSave = useCallback(async () => {
    if (!config || !localPath) return;
    try {
      const configToSave = buildConfigToSave();
      await invoke("save_client_config", {
        configPath: localPath,
        config: configToSave,
      });
      savedConfig.current = JSON.parse(JSON.stringify(config));
      onConfigChange({ configPath: localPath, logLevel: config.loglevel });
      pushSuccess(t("messages.settings_saved", "Настройки сохранены"));
    } catch (e) {
      pushSuccess(formatError(e), "error");
    }
  }, [config, localPath, buildConfigToSave, onConfigChange, pushSuccess, t]);

  // ─── Manual save (with UI feedback, snackbar, reconnect) ───
  const handleSave = useCallback(async (reconnect = false) => {
    if (!config || !localPath) return;
    setSaving(true);
    setError("");
    try {
      const configToSave = buildConfigToSave();
      await invoke("save_client_config", {
        configPath: localPath,
        config: configToSave,
      });
      savedConfig.current = JSON.parse(JSON.stringify(config));
      onConfigChange({ configPath: localPath, logLevel: config.loglevel });
      setSaving(false);
      pushSuccess(t("messages.settings_saved", "Настройки сохранены"));

      if (reconnect && (status === "connected" || status === "connecting")) {
        await onReconnect();
      }
    } catch (e) {
      pushSuccess(formatError(e), "error");
      setSaving(false);
    }
  }, [config, localPath, buildConfigToSave, onConfigChange, status, onReconnect, pushSuccess, t]);

  // ─── Peer-save: when Routing panel saves, save our config too ───
  useEffect(() => {
    const handler = () => { if (dirty) silentSave(); };
    window.addEventListener("tt-peer-save", handler);
    return () => window.removeEventListener("tt-peer-save", handler);
  }, [dirty, silentSave]);

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

    setLocalPath,
    setError,
    updateField,
    handleSave,
    browseConfig,
    clearConfig,
    pushSuccess,
    onVpnModeChange,
  };
}
