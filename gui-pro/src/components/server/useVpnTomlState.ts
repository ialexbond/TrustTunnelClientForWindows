import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isDirty, createSnapshot, type DirtySnapshot } from "../../shared/utils/dirtyTracker";
import { formatError } from "../../shared/utils/formatError";
import { useActivityLog } from "../../shared/hooks/useActivityLog";

/**
 * Phase 15 useVpnTomlState — load + dirty + save orchestration for vpn.toml.
 *
 * Responsibilities:
 *  - One-shot bundle load on mount via `server_get_config_bundle` (Plan 01) —
 *    single SSH channel mitigates Pitfall 4 (stampede on tab open).
 *  - Local form state for the 6 Quick Settings fields (D-1).
 *  - Dirty tracking via `dirtyTracker.ts` (Phase 14.1 pattern carried forward).
 *  - Sequential typed-mutation saveBatch (one invoke per dirty field).
 *  - Re-baseline snapshot on full success; refetch bundle to confirm server state.
 *  - In-flight cancellation guard (WR-03 pattern from UserModal.tsx).
 *
 * NOT responsible for: confirm dialog UX, snackbar, restart-required badge —
 * those belong to QuickSettingsSection (the consumer).
 */

/** Subset of vpn.toml fields editable via Quick Settings (D-1). */
export interface QuickSettingsFields {
  listen_address: string;
  log_level: string;
  allow_private_network_connections: boolean;
  auth_failure_status_code: number;
  ping_path: string;
  speedtest_path: string;
}

/** Disrupt-level classification per field (D-4). */
export const DISRUPT_HIGH_FIELDS = new Set<keyof QuickSettingsFields>([
  "listen_address",
]);

/** Backend payload shapes (camelCase from Rust serde). */
interface AllowedSniHostJs {
  hostname: string;
  allowedSni: string[];
}

interface ConfigBundleJs {
  vpnToml: string;
  hostsToml: string;
  typed: {
    listen_address: string;
    ipv6_available: boolean;
    allow_private_network_connections: boolean;
    log_level: string | null;
    auth_failure_status_code: number;
    ping_enable: boolean;
    speedtest_enable: boolean;
    ping_path: string;
    speedtest_path: string;
    credentials_file: string;
    extra: Record<string, unknown>;
  };
  allowedSni: AllowedSniHostJs[];
  serviceStatus: string;
}

export interface SshParamsLite {
  host: string;
  port: number;
  user: string;
  password: string;
  keyPath?: string;
}

export interface VpnTomlState {
  /** Raw vpn.toml string (for Advanced raw preview / fallback writes). */
  vpnTomlRaw: string;
  /** Raw hosts.toml string. */
  hostsTomlRaw: string;
  /** Typed Quick Settings projection (live, includes user edits). */
  fields: QuickSettingsFields;
  /** Initial values from server (for discard / dirty comparison). */
  initialFields: QuickSettingsFields;
  /** allowed_sni list (for AllowedSniEditor in Plan 06 / 07). */
  allowedSni: AllowedSniHostJs[];
  /** Service status from systemctl is-active. */
  serviceStatus: string;

  /** True until first bundle resolves. */
  loading: boolean;
  /** Save in flight. */
  saving: boolean;
  /** Last error message (load or save). */
  error: string | null;

  /** True when at least one field differs from initial. */
  isDirty: boolean;
  /** Names of fields that differ from initial. */
  dirtyFields: Array<keyof QuickSettingsFields>;
  /** Subset of dirtyFields that are disrupt-high. */
  highRiskCount: number;

  /** Update a single field locally (no IPC). */
  setField: <K extends keyof QuickSettingsFields>(key: K, value: QuickSettingsFields[K]) => void;
  /** Discard all local edits — restore to initialFields. */
  discard: () => void;
  /** Manually re-trigger bundle load (e.g. on tab activation). */
  loadBundle: () => Promise<void>;
  /** Persist all dirty fields sequentially via typed mutations. Re-baselines snapshot on full success. */
  saveBatch: () => Promise<void>;
}

const DEFAULT_FIELDS: QuickSettingsFields = {
  listen_address: "0.0.0.0:443",
  log_level: "",
  allow_private_network_connections: false,
  auth_failure_status_code: 407,
  ping_path: "/ping",
  speedtest_path: "/speedtest",
};

/** Map field key → backend Tauri command + payload key (per Plan 02 ssh_pool_command! signatures). */
const FIELD_TO_INVOKE: Record<
  keyof QuickSettingsFields,
  { cmd: string; arg: string }
> = {
  listen_address:                     { cmd: "server_update_listen_address",   arg: "address" },
  log_level:                          { cmd: "server_update_log_level",        arg: "level" },
  allow_private_network_connections:  { cmd: "server_update_allow_private",    arg: "enabled" },
  auth_failure_status_code:           { cmd: "server_update_auth_status",      arg: "code" },
  ping_path:                          { cmd: "server_update_ping_path",        arg: "path" },
  speedtest_path:                     { cmd: "server_update_speedtest_path",   arg: "path" },
};

const FIELD_KEYS: Array<keyof QuickSettingsFields> = [
  "listen_address",
  "log_level",
  "allow_private_network_connections",
  "auth_failure_status_code",
  "ping_path",
  "speedtest_path",
];

function fieldsToSnapshot(f: QuickSettingsFields): DirtySnapshot {
  return createSnapshot({
    listen_address: f.listen_address,
    log_level: f.log_level,
    allow_private_network_connections: f.allow_private_network_connections,
    auth_failure_status_code: String(f.auth_failure_status_code),
    ping_path: f.ping_path,
    speedtest_path: f.speedtest_path,
  });
}

function projectFields(typed: ConfigBundleJs["typed"]): QuickSettingsFields {
  return {
    listen_address: typed.listen_address ?? DEFAULT_FIELDS.listen_address,
    log_level: typed.log_level ?? "",
    allow_private_network_connections:
      typed.allow_private_network_connections ?? false,
    auth_failure_status_code:
      typed.auth_failure_status_code ?? DEFAULT_FIELDS.auth_failure_status_code,
    ping_path: typed.ping_path ?? DEFAULT_FIELDS.ping_path,
    speedtest_path: typed.speedtest_path ?? DEFAULT_FIELDS.speedtest_path,
  };
}

export function useVpnTomlState(sshParams: SshParamsLite): VpnTomlState {
  const { log } = useActivityLog();

  const [vpnTomlRaw, setVpnTomlRaw] = useState<string>("");
  const [hostsTomlRaw, setHostsTomlRaw] = useState<string>("");
  const [fields, setFields] = useState<QuickSettingsFields>(DEFAULT_FIELDS);
  const [initialFields, setInitialFields] =
    useState<QuickSettingsFields>(DEFAULT_FIELDS);
  const [allowedSni, setAllowedSni] = useState<AllowedSniHostJs[]>([]);
  const [serviceStatus, setServiceStatus] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // WR-03 pattern: cancellation guard for in-flight bundle load.
  // Single source of truth — cancelledRef.current. Reset to false at start of each
  // load, set to true by useEffect cleanup when sshParams change or hook unmounts.
  // Mirrors UserModal.tsx:413,577 cancellation pattern (`let cancelled = false;
  // ... return () => { cancelled = true; }`).
  const cancelledRef = useRef<boolean>(false);

  const loadBundle = useCallback(async () => {
    cancelledRef.current = false;
    setLoading(true);
    setError(null);
    try {
      log("STATE", "vpn-toml.load.start", "useVpnTomlState.loadBundle");
      const bundle = await invoke<ConfigBundleJs>(
        "server_get_config_bundle",
        sshParams as unknown as Record<string, unknown>,
      );
      if (cancelledRef.current) return; // guard after each await
      const projected = projectFields(bundle.typed);
      setVpnTomlRaw(bundle.vpnToml);
      setHostsTomlRaw(bundle.hostsToml);
      setFields(projected);
      setInitialFields(projected);
      setAllowedSni(bundle.allowedSni ?? []);
      setServiceStatus(bundle.serviceStatus);
      log(
        "STATE",
        `vpn-toml.load.completed sniHosts=${bundle.allowedSni?.length ?? 0}`,
        "useVpnTomlState.loadBundle",
      );
    } catch (e) {
      if (cancelledRef.current) return;
      const msg = formatError(e);
      setError(msg);
      log(
        "ERROR",
        `vpn-toml.load.failed err="${msg.slice(0, 200)}"`,
        "useVpnTomlState.loadBundle",
      );
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }, [sshParams, log]);

  // Bundle load on mount + when sshParams change. Cleanup flips cancelledRef so
  // a stale in-flight invoke cannot overwrite fresh state when sshParams change
  // (or the hook unmounts).
  useEffect(() => {
    void loadBundle();
    return () => {
      cancelledRef.current = true;
    };
  }, [loadBundle]);

  const setField = useCallback(
    <K extends keyof QuickSettingsFields>(key: K, value: QuickSettingsFields[K]) => {
      setFields((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const discard = useCallback(() => {
    setFields(initialFields);
  }, [initialFields]);

  const dirtyFields = useMemo<Array<keyof QuickSettingsFields>>(
    () =>
      FIELD_KEYS.filter((k) => {
        const a = initialFields[k];
        const b = fields[k];
        return a !== b;
      }),
    [fields, initialFields],
  );

  const dirtyFlag = useMemo(
    () => isDirty(fieldsToSnapshot(initialFields), fieldsToSnapshot(fields)),
    [fields, initialFields],
  );

  const highRiskCount = useMemo(
    () => dirtyFields.filter((k) => DISRUPT_HIGH_FIELDS.has(k)).length,
    [dirtyFields],
  );

  const saveBatch = useCallback(async () => {
    if (dirtyFields.length === 0) return;
    setSaving(true);
    setError(null);
    log(
      "USER",
      `vpn-toml.save.start fields=${dirtyFields.join(",")}`,
      "useVpnTomlState.saveBatch",
    );
    try {
      // Sequential per-dirty-field mutation. Each backend call validates input
      // server-side (Plan 01 sanitize.rs) and triggers `systemctl --no-block restart`.
      for (const key of dirtyFields) {
        const route = FIELD_TO_INVOKE[key];
        const value = fields[key];
        await invoke(route.cmd, {
          ...(sshParams as unknown as Record<string, unknown>),
          [route.arg]: value,
        });
      }
      // Refetch bundle to confirm server state and re-baseline snapshot.
      const bundle = await invoke<ConfigBundleJs>(
        "server_get_config_bundle",
        sshParams as unknown as Record<string, unknown>,
      );
      const projected = projectFields(bundle.typed);
      setVpnTomlRaw(bundle.vpnToml);
      setHostsTomlRaw(bundle.hostsToml);
      setFields(projected);
      setInitialFields(projected);
      setAllowedSni(bundle.allowedSni ?? []);
      setServiceStatus(bundle.serviceStatus);
      log("USER", "vpn-toml.save.completed", "useVpnTomlState.saveBatch");
    } catch (e) {
      const msg = formatError(e);
      setError(msg);
      log(
        "ERROR",
        `vpn-toml.save.failed err="${msg.slice(0, 200)}"`,
        "useVpnTomlState.saveBatch",
      );
      throw e; // re-throw so useConfirm action handler can detect failure
    } finally {
      setSaving(false);
    }
  }, [dirtyFields, fields, sshParams, log]);

  return {
    vpnTomlRaw,
    hostsTomlRaw,
    fields,
    initialFields,
    allowedSni,
    serviceStatus,
    loading,
    saving,
    error,
    isDirty: dirtyFlag,
    dirtyFields,
    highRiskCount,
    setField,
    discard,
    loadBundle,
    saveBatch,
  };
}
