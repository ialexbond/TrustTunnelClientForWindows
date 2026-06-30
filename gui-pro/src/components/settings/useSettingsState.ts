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
  /** Switch the listener mode (TUN ↔ SOCKS5) in one atomic write, preserving the other block's
   *  data for a round-trip and defaulting a fresh TUN to a full tunnel (0.0.0.0/0). */
  setListenerMode: (mode: "tun" | "socks") => void;
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

  // IN-54: stash for the listener block we are leaving on a mode switch, so a TUN→SOCKS→TUN
  // round-trip restores the original routes. Reset when the edited config changes (below) so one
  // config's routes can never leak into another.
  const stashedListenerRef = useRef<{ tun?: unknown; socks?: unknown }>({});

  // ─── Sync path from parent ───
  useEffect(() => {
    setLocalPath(configPath);
    setReloadKey(k => k + 1);
    stashedListenerRef.current = {}; // IN-54: drop a prior config's stashed listener block
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
  // dropped the first change. That is exactly why the TUN/SOCKS mode toggle needed two clicks
  // (three chained writes collided). A functional updater makes each chained call see the prior
  // result, so the deps can be [] and the callback identity is stable.
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

  // ─── Switch the listener mode (TUN ↔ SOCKS5) atomically ───
  // Phase 11 (IN-54): the sidecar config can hold ONLY ONE listener type, so switching modes
  // must drop the other block. The old toggle did this with several chained updateField calls
  // AND it DESTROYED the routing data: TUN→SOCKS deleted the whole [listener.tun] (the
  // `included_routes`/`excluded_routes` that actually carry traffic), and SOCKS→TUN recreated a
  // bare tun with NO routes → the config "connects but passes no traffic". We instead:
  //   1) stash whichever block we are leaving, so a round-trip (TUN→SOCKS→TUN) RESTORES the
  //      original routes instead of losing them, and
  //   2) when creating a fresh TUN with nothing to restore, default to a FULL tunnel
  //      (`included_routes = ["0.0.0.0/0"]`) so a TUN config always routes — the server
  //      configs are full-tunnel and that is the expected default.
  // One setConfig write = no stale-closure collision, so the toggle also flips on the FIRST click.
  const setListenerMode = useCallback((mode: "tun" | "socks") => {
    setConfig((prev) => {
      if (!prev) return prev;
      const clone: ClientConfig = JSON.parse(JSON.stringify(prev));
      const cur = clone.listener ?? {};
      // Remember what we are leaving so switching back can restore it (esp. TUN routes).
      if (cur.tun) stashedListenerRef.current.tun = cur.tun;
      if (cur.socks) stashedListenerRef.current.socks = cur.socks;
      if (mode === "tun") {
        const restored = (cur.tun ?? stashedListenerRef.current.tun) as
          | ClientConfig["listener"]["tun"]
          | undefined;
        clone.listener = {
          tun: restored ?? {
            mtu_size: 1280,
            change_system_dns: true,
            included_routes: ["0.0.0.0/0"],
            excluded_routes: [],
          },
        };
      } else {
        const restored = (cur.socks ?? stashedListenerRef.current.socks) as
          | ClientConfig["listener"]["socks"]
          | undefined;
        clone.listener = { socks: restored ?? { address: "127.0.0.1:1080" } };
      }
      return clone;
    });
  }, []);

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
    setListenerMode,
    handleSave,
    browseConfig,
    clearConfig,
    pushSuccess,
    onVpnModeChange,
  };
}
