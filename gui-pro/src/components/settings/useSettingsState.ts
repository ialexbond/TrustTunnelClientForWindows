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
    // dns_upstreams lives under [endpoint] in the real config (sidecar contract).
    // The C++ core reads it from here, not from a top-level key (UAT-F05/F06/F07).
    dns_upstreams?: string[];
    [key: string]: unknown;
  };
  listener: {
    // TUN is the only listener mode — the SOCKS5 client mode was removed (it could not
    // deliver a working system-wide SOCKS5 proxy on Windows). Legacy `[listener.socks]`
    // configs are normalized to TUN on load (Rust: normalize_all_configs_to_tun).
    tun?: {
      mtu_size: number;
      change_system_dns: boolean;
      included_routes: string[];
      excluded_routes: string[];
    };
  };
  // NOTE: dns_upstreams is NOT a top-level key — it belongs under endpoint (see above).
  // Older configs may still carry a stray top-level key; it is migrated into endpoint on
  // load and dropped on save so the saved file matches the sidecar contract.
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
  /**
   * B3 (16-UAT round 2): when `false`, disable BOTH silent auto-write-to-disk paths — the
   * 1200ms debounce (useAutoSave, fires while VPN is disconnected) AND the `tt-peer-save`
   * window listener (fires when a sibling panel saves). Persistence then happens ONLY on the
   * explicit `handleSave` button. DEFAULT `true` so the inline Settings/Routing/live-apply
   * panels are unchanged; the per-config editor (ConfigEditView, the surface with a real
   * «Сохранить» button) passes `false` so edits never touch disk before the button.
   */
  autoSave?: boolean;
}

export interface SettingsState {
  config: ClientConfig | null;
  saving: boolean;
  error: string;
  /**
   * Phase 11 (11-06): true once a `read_client_config` attempt for the current path has
   * FAILED (corrupt/unreadable .toml). Lets a consumer (ConfigEditView) render an in-modal
   * load-error branch instead of the form, distinguishing a real read failure from the
   * transient null-config window during the initial load. Empty path / a pending read / a
   * successful read all leave it false. Optional so existing settings-section test mocks
   * that construct a full SettingsState by hand keep type-checking without it (they predate
   * the field and never exercise the load-error branch).
   */
  loadError?: boolean;
  localPath: string;
  dirty: boolean;
  status: VpnStatus;

  setLocalPath: (path: string) => void;
  setError: (msg: string) => void;
  updateField: (path: string, value: unknown) => void;
  /** Save the per-config .toml. Resolves to `true` on success, `false` on failure — lets a
   *  caller (ConfigEditView) close the modal only when the save actually succeeded. */
  handleSave: (reconnect?: boolean) => Promise<boolean>;
  browseConfig: () => Promise<void>;
  clearConfig: () => void;
  pushSuccess: (msg: string, type?: "success" | "error") => void;
  onVpnModeChange?: (mode: string) => void;
}

// ═══════════════════════════════════════════════════════
// Deep equal for dirty tracking (ignores empty strings in arrays)
// ═══════════════════════════════════════════════════════

// WR-01: an array key whose values are all empty strings after filtering "" is
// equivalent to the key being absent. The "Add DNS" button writes
// endpoint.dns_upstreams = [...prev, ""], which on a config that never carried
// the key ADDS a new key to endpoint (N → N+1). Without pruning, deepEqual's
// object branch compares key COUNTS first (aKeys.length !== bKeys.length) and
// flips dirty=true on a still-empty row — re-triggering the exact UAT-F05/F07
// symptom (Save lights up on an empty/cancelled row). Pruning these keys before
// the count comparison makes endpoint.dns_upstreams:[""] compare equal to absent.
function pruneEmptyArrays(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (Array.isArray(v) && v.filter(x => x !== "").length === 0) continue;
    out[k] = v;
  }
  return out;
}

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
  // Prune empty-array keys so a never-filled row (endpoint.dns_upstreams:[""])
  // is treated as absent and does not inflate the key count (WR-01).
  const aObj = pruneEmptyArrays(a as Record<string, unknown>);
  const bObj = pruneEmptyArrays(b as Record<string, unknown>);
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(k => k in bObj && deepEqual(aObj[k], bObj[k]));
}

// ═══════════════════════════════════════════════════════
// DNS upstreams normalization (UAT-F05/F06/F07)
// ═══════════════════════════════════════════════════════
//
// dns_upstreams is an [endpoint]-nested field in the real config (sidecar contract).
// Older configs may carry a stray top-level dns_upstreams; fold it into endpoint when
// endpoint has none, and always strip the top-level key so the canonical shape is used
// on both load (baseline) and save (written file).
function normalizeDnsUpstreams(config: ClientConfig): ClientConfig {
  const clone: ClientConfig = JSON.parse(JSON.stringify(config));
  const legacyTop = clone.dns_upstreams as string[] | undefined;
  if (legacyTop !== undefined) {
    if (clone.endpoint && clone.endpoint.dns_upstreams === undefined) {
      clone.endpoint.dns_upstreams = legacyTop;
    }
    delete clone.dns_upstreams;
  }
  return clone;
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
    // 06-uat: onSwitchToSetup is intentionally NOT destructured/used here anymore —
    // deleting the config must NOT auto-switch to the Control Panel (clearConfig only
    // clears). The prop stays on SettingsProps because ConnectionPanel passes the whole
    // props object through and other surfaces (ServerPanel install) still rely on it.
    onClearConfig,
    onVpnModeChange,
    // B3: default true — omitting the flag keeps every existing caller (Settings/Routing/inline
    // live-apply panels) on the original auto-save behavior. Only ConfigEditView opts out.
    autoSave = true,
  } = props;

  const [config, setConfig] = useState<ClientConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // Phase 11 (11-06): a read_client_config failure flag, surfaced so ConfigEditView can
  // render an in-modal load-error branch instead of the form. Reset on every (re)load.
  const [loadError, setLoadError] = useState(false);
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
      setLoadError(false);
      savedConfig.current = null;
    }
  }, [configPath]);

  // ─── Load config ───
  const loadConfig = useCallback(async () => {
    if (!localPath) return;
    try {
      setError("");
      setLoadError(false);
      const data = await invoke<ClientConfig>("read_client_config", {
        configPath: localPath,
      });
      // Migrate a stray legacy top-level dns_upstreams into endpoint.dns_upstreams.
      // The sidecar reads it from [endpoint]; a top-level key never hydrated the UI (F06).
      // We fold it in on load (only when endpoint has none) and drop the top-level key so
      // the baseline already matches the canonical shape — migration alone is not "dirty".
      const normalized = normalizeDnsUpstreams(data);
      setConfig(normalized);
      savedConfig.current = JSON.parse(JSON.stringify(normalized));
    } catch (e) {
      // 11-06: flag the load failure so ConfigEditView can render the in-modal load-error
      // branch (the SnackBar still fires for the settings-tab surface that has no banner).
      setLoadError(true);
      pushSuccess(formatError(e), "error");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localPath, reloadKey]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  // ─── Update a nested field ───
  // Phase 11 (IN-54): use a FUNCTIONAL setState updater (read `prev`, not the closed-over
  // `config`). The old form cloned the render-time `config` and was memoized with [config], so
  // two updateField calls fired in ONE handler both saw the SAME stale config → last-write-wins
  // dropped the first change. A functional updater makes each chained call see the prior result,
  // so the deps can be [] and the callback identity is stable.
  const updateField = useCallback(
    (path: string, value: unknown) => {
      setConfig((prev) => {
        if (!prev) return prev;
        const clone = JSON.parse(JSON.stringify(prev));
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
        return clone;
      });
    },
    []
  );

  // ─── Build config for saving (TUN-only) ───
  // SOCKS5 client mode was removed — the sidecar always runs a TUN listener. Ensure
  // `change_system_dns` stays true so a full tunnel always sets the system DNS; fields inside
  // listener.tun (mtu_size / routes) are preserved from the edited config.
  const buildConfigToSave = useCallback(() => {
    if (!config) return config;
    const clone = { ...config };
    clone.listener = {
      tun: { ...config.listener?.tun, change_system_dns: true } as NonNullable<ClientConfig["listener"]["tun"]>,
    };
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
  // Returns true on a successful save (so ConfigEditView can close the modal only then),
  // false on failure. The error is surfaced as a SnackBar (the modal stays open to retry).
  const handleSave = useCallback(async (reconnect = false): Promise<boolean> => {
    if (!config || !localPath) return false;
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
      return true;
    } catch (e) {
      pushSuccess(formatError(e), "error");
      setSaving(false);
      return false;
    }
  }, [config, localPath, buildConfigToSave, onConfigChange, status, onReconnect, pushSuccess, t]);

  // ─── Peer-save: when Routing panel saves, save our config too ───
  // B3: gated on `autoSave`. When a caller opts out (ConfigEditView), a sibling panel's Save
  // must NOT silently flush this config to disk — persistence is button-only there.
  useEffect(() => {
    if (!autoSave) return;
    const handler = () => { if (dirty) silentSave(); };
    window.addEventListener("tt-peer-save", handler);
    return () => window.removeEventListener("tt-peer-save", handler);
  }, [autoSave, dirty, silentSave]);

  // ─── Auto-save when VPN not active (silent, no UI) ───
  // B3: gate the debounce on `autoSave` by passing `dirty: autoSave && dirty`. When a caller
  // opts out, the timer never arms (dirty is forced false into the hook), so an edit is never
  // written to disk 1200ms after typing — it persists ONLY on the explicit handleSave button.
  useAutoSave({
    dirty: autoSave && dirty,
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

  // ─── Clear config ───
  // 06-uat: clearing the config no longer auto-switches to the Control Panel
  // (onSwitchToSetup was removed). Deleting the config must not navigate or open the
  // wizard — it only clears the active config; the user chooses where to go next.
  const clearConfig = useCallback(() => {
    onClearConfig();
  }, [onClearConfig]);

  return {
    config,
    saving,
    error,
    loadError,
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
