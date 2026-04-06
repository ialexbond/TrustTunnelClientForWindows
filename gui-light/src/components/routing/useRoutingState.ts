import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSnackBar } from "../../shared/ui/SnackBarContext";
import { useAutoSave } from "../../shared/hooks/useAutoSave";
import { formatError } from "../../shared/utils/formatError";

// ═══════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════

export type RuleEntryType = "domain" | "ip" | "cidr" | "geoip" | "geosite" | "iplist_group";
export type RouteAction = "direct" | "proxy" | "block";

export interface RuleEntry {
  id: string;
  type: RuleEntryType;
  value: string;
  label?: string;
}

export interface ProcessInfo {
  name: string;
  path?: string;
}

export interface RoutingRules {
  direct: RuleEntry[];
  proxy: RuleEntry[];
  block: RuleEntry[];
  process_mode: "exclude" | "only";
  processes: string[];
}

export interface GeoDataStatus {
  downloaded: boolean;
  geoip_exists: boolean;
  geosite_exists: boolean;
  release_tag?: string;
  downloaded_at?: string;
  geoip_categories_count: number;
  geosite_categories_count: number;
}

export interface GeoDataIndex {
  geoip: string[];
  geosite: string[];
}

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

let _idCounter = 0;
function nextId(): string {
  return `rule_${Date.now()}_${++_idCounter}`;
}

function detectEntryType(value: string): RuleEntryType {
  if (value.startsWith("geoip:")) return "geoip";
  if (value.startsWith("geosite:")) return "geosite";
  if (value.startsWith("iplist_group:")) return "iplist_group";
  if (/\/\d{1,3}$/.test(value)) return "cidr";
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)) return "ip";
  if (/^[0-9a-fA-F:]+$/.test(value) && value.includes(":")) return "ip";
  return "domain";
}

function parseEntryValue(raw: string): { type: RuleEntryType; value: string } {
  const type = detectEntryType(raw);
  if (type === "geoip") return { type, value: raw.replace(/^geoip:/, "") };
  if (type === "geosite") return { type, value: raw.replace(/^geosite:/, "") };
  if (type === "iplist_group") return { type, value: raw.replace(/^iplist_group:/, "") };
  return { type, value: raw };
}

function serializeEntry(entry: RuleEntry): string {
  switch (entry.type) {
    case "geoip": return `geoip:${entry.value}`;
    case "geosite": return `geosite:${entry.value}`;
    case "iplist_group": return `iplist_group:${entry.value}`;
    default: return entry.value;
  }
}

// ═══════════════════════════════════════════════════════
// Hook
// ═══════════════════════════════════════════════════════

export type VpnStatus = "connected" | "connecting" | "disconnected" | "disconnecting" | "recovering" | "error";

export interface UseRoutingStateOptions {
  configPath: string;
  status: VpnStatus;
  vpnMode: string;
  onReconnect: () => Promise<void>;
}

export interface UseRoutingStateReturn {
  // Data
  rules: RoutingRules;
  geodataStatus: GeoDataStatus;
  geodataCategories: GeoDataIndex;
  processList: ProcessInfo[];
  processListLoading: boolean;

  // State
  loading: boolean;
  saving: boolean;
  error: string;
  dirty: boolean;
  applying: boolean;

  // CRUD operations
  addEntry: (action: RouteAction, value: string) => string | null;
  removeEntry: (action: RouteAction, id: string) => void;
  moveEntry: (fromAction: RouteAction, toAction: RouteAction, id: string) => void;

  // Process operations
  setProcessMode: (mode: "exclude" | "only") => void;
  addProcess: (name: string) => void;
  removeProcess: (name: string) => void;
  loadProcessList: () => Promise<void>;

  // Persistence
  save: () => Promise<void>;
  load: () => Promise<void>;
  exportRules: () => Promise<void>;
  importRules: () => Promise<void>;

  // GeoData
  downloadGeoData: () => Promise<void>;
  geodataDownloading: boolean;

  // Save & Apply
  handleSave: (reconnect?: boolean) => Promise<void>;
  isVpnActive: boolean;
  markDirty: () => void;

  // Duplicate check
  isDuplicate: (action: RouteAction, value: string) => boolean;
}

const emptyRules: RoutingRules = {
  direct: [],
  proxy: [],
  block: [],
  process_mode: "exclude",
  processes: [],
};

const emptyGeoStatus: GeoDataStatus = {
  downloaded: false,
  geoip_exists: false,
  geosite_exists: false,
  geoip_categories_count: 0,
  geosite_categories_count: 0,
};

const emptyGeoIndex: GeoDataIndex = {
  geoip: [],
  geosite: [],
};

export function useRoutingState({ configPath, status, vpnMode, onReconnect }: UseRoutingStateOptions): UseRoutingStateReturn {
  const isVpnActive = status === "connected" || status === "connecting";
  const [rules, setRules] = useState<RoutingRules>(emptyRules);
  const [geodataStatus, setGeodataStatus] = useState<GeoDataStatus>(emptyGeoStatus);
  const [geodataCategories, setGeodataCategories] = useState<GeoDataIndex>(emptyGeoIndex);
  const [processList, setProcessList] = useState<ProcessInfo[]>([]);
  const [processListLoading, setProcessListLoading] = useState(false);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [applying, setApplying] = useState(false);
  const [geodataDownloading, setGeodataDownloading] = useState(false);

  const pushSuccess = useSnackBar();

  const baselineRef = useRef<string>("");
  const baselineVpnModeRef = useRef<string>(vpnMode);

  // ─── Load ───────────────────────────────────────────

  const load = useCallback(async () => {
    if (!configPath) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      // Backend returns RoutingRules with RuleEntry[] (not string[])
      const raw = await invoke<RoutingRules>("load_routing_rules");

      // Ensure each entry has an id and strip prefix from value
      const normalizeEntries = (entries: RuleEntry[]): RuleEntry[] =>
        (entries || []).map((e) => {
          const { type, value } = parseEntryValue(e.value);
          return { ...e, id: e.id || nextId(), type, value };
        });

      const loaded: RoutingRules = {
        direct: normalizeEntries(raw.direct),
        proxy: normalizeEntries(raw.proxy),
        block: normalizeEntries(raw.block),
        process_mode: raw.process_mode || "exclude",
        processes: raw.processes || [],
      };

      setRules(loaded);
      baselineRef.current = JSON.stringify({
        direct: loaded.direct.map(serializeEntry).sort(),
        proxy: loaded.proxy.map(serializeEntry).sort(),
        block: loaded.block.map(serializeEntry).sort(),
        process_mode: loaded.process_mode,
        processes: loaded.processes.sort(),
      });
      baselineVpnModeRef.current = vpnMode;
      setDirty(false);
    } catch (e) {
      console.error("Failed to load routing rules:", e);
      pushSuccess(formatError(e), "error");
    } finally {
      setLoading(false);
    }
  }, [configPath]);

  // ─── Load geodata status ────────────────────────────

  const loadGeoStatus = useCallback(async () => {
    try {
      const status = await invoke<GeoDataStatus>("get_geodata_status");
      setGeodataStatus(status);

      if (status.downloaded) {
        try {
          const index = await invoke<GeoDataIndex>("load_geodata_categories");
          setGeodataCategories(index);
        } catch {
          // Categories not available yet
        }
      }
    } catch {
      // GeoData commands not implemented yet — use defaults
    }
  }, []);

  useEffect(() => {
    load();
    loadGeoStatus();
  }, [load, loadGeoStatus]);

  // Listen for geodata file changes (fs watcher from Rust)
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen<GeoDataStatus>("geodata-files-changed", (event) => {
        setGeodataStatus(event.payload);
        // Reload categories if files appeared
        if (event.payload.downloaded) {
          loadGeoStatus();
        }
      }).then((fn) => { unlisten = fn; });
    });
    return () => { unlisten?.(); };
  }, [loadGeoStatus]);

  // ─── Dirty tracking ────────────────────────────────

  const computeSnapshot = useCallback((r: RoutingRules): string => {
    return JSON.stringify({
      direct: r.direct.map(serializeEntry).sort(),
      proxy: r.proxy.map(serializeEntry).sort(),
      block: r.block.map(serializeEntry).sort(),
      process_mode: r.process_mode,
      processes: r.processes.slice().sort(),
    });
  }, []);

  const markDirty = useCallback(
    (newRules?: RoutingRules) => {
      const r = newRules || rules;
      const rulesChanged = computeSnapshot(r) !== baselineRef.current;
      const modeChanged = vpnMode !== baselineVpnModeRef.current;
      setDirty(rulesChanged || modeChanged);
    },
    [computeSnapshot, rules, vpnMode]
  );

  // Recalculate dirty when vpnMode changes externally
  useEffect(() => {
    const rulesChanged = computeSnapshot(rules) !== baselineRef.current;
    const modeChanged = vpnMode !== baselineVpnModeRef.current;
    setDirty(rulesChanged || modeChanged);
  }, [vpnMode, rules, computeSnapshot]);

  // ─── CRUD ──────────────────────────────────────────

  const isDuplicate = useCallback(
    (action: RouteAction, value: string): boolean => {
      const { type, value: parsed } = parseEntryValue(value);
      return rules[action].some((e) => e.type === type && e.value === parsed);
    },
    [rules]
  );

  const addEntry = useCallback(
    (action: RouteAction, rawValue: string): string | null => {
      const trimmed = rawValue.trim();
      if (!trimmed) return "empty";

      const { type, value } = parseEntryValue(trimmed);

      // Check duplicates across all blocks
      for (const block of ["direct", "proxy", "block"] as RouteAction[]) {
        if (rules[block].some((e) => e.type === type && e.value === value)) {
          return "duplicate";
        }
      }

      const entry: RuleEntry = { id: nextId(), type, value };
      setRules((prev) => {
        const updated = { ...prev, [action]: [...prev[action], entry] };
        markDirty(updated);
        return updated;
      });
      return null;
    },
    [rules, markDirty]
  );

  const removeEntry = useCallback(
    (action: RouteAction, id: string) => {
      setRules((prev) => {
        const updated = { ...prev, [action]: prev[action].filter((e) => e.id !== id) };
        markDirty(updated);
        return updated;
      });
    },
    [markDirty]
  );

  const moveEntry = useCallback(
    (fromAction: RouteAction, toAction: RouteAction, id: string) => {
      if (fromAction === toAction) return;
      setRules((prev) => {
        const entry = prev[fromAction].find((e) => e.id === id);
        if (!entry) return prev;

        // Check duplicate in target
        if (prev[toAction].some((e) => e.type === entry.type && e.value === entry.value)) {
          return prev;
        }

        const updated = {
          ...prev,
          [fromAction]: prev[fromAction].filter((e) => e.id !== id),
          [toAction]: [...prev[toAction], entry],
        };
        markDirty(updated);
        return updated;
      });
    },
    [markDirty]
  );

  // ─── Process operations ─────────────────────────────

  const setProcessMode = useCallback(
    (mode: "exclude" | "only") => {
      setRules((prev) => {
        const updated = { ...prev, process_mode: mode };
        markDirty(updated);
        return updated;
      });
    },
    [markDirty]
  );

  const addProcess = useCallback(
    (name: string) => {
      setRules((prev) => {
        if (prev.processes.includes(name)) return prev;
        const updated = { ...prev, processes: [...prev.processes, name] };
        markDirty(updated);
        return updated;
      });
    },
    [markDirty]
  );

  const removeProcess = useCallback(
    (name: string) => {
      setRules((prev) => {
        const updated = { ...prev, processes: prev.processes.filter((p) => p !== name) };
        markDirty(updated);
        return updated;
      });
    },
    [markDirty]
  );

  const loadProcessList = useCallback(async () => {
    setProcessListLoading(true);
    try {
      const list = await invoke<ProcessInfo[]>("list_running_processes");
      setProcessList(list);
    } catch (e) {
      console.error("Failed to list processes:", e);
    } finally {
      setProcessListLoading(false);
    }
  }, []);

  // ─── Save ──────────────────────────────────────────

  // Convert frontend rules to backend format (RuleEntry[] with serialized values)
  const toBackendPayload = useCallback((r: RoutingRules) => ({
    direct: r.direct.map((e) => ({
      ...e,
      value: e.type === "geoip" ? `geoip:${e.value}` : e.type === "geosite" ? `geosite:${e.value}` : e.value,
      entry_type: e.type,
    })),
    proxy: r.proxy.map((e) => ({
      ...e,
      value: e.type === "geoip" ? `geoip:${e.value}` : e.type === "geosite" ? `geosite:${e.value}` : e.value,
      entry_type: e.type,
    })),
    block: r.block.map((e) => ({
      ...e,
      value: e.type === "geoip" ? `geoip:${e.value}` : e.type === "geosite" ? `geosite:${e.value}` : e.value,
      entry_type: e.type,
    })),
    process_mode: r.process_mode,
    processes: r.processes,
  }), []);

  const save = useCallback(async () => {
    if (!configPath) return;
    setSaving(true);
    setError("");
    try {
      await invoke("save_routing_rules", { rules: toBackendPayload(rules) });
      baselineRef.current = computeSnapshot(rules);
      baselineVpnModeRef.current = vpnMode;
      setDirty(false);
      pushSuccess("Правила сохранены");
    } catch (e) {
      console.error("Failed to save routing rules:", e);
      pushSuccess(formatError(e), "error");
    } finally {
      setSaving(false);
    }
  }, [configPath, rules, computeSnapshot, pushSuccess, toBackendPayload]);

  // ─── Export / Import ────────────────────────────────

  const exportRules = useCallback(async () => {
    try {
      // Save current rules first so export has data to read
      await invoke("save_routing_rules", { rules: toBackendPayload(rules) });
      const result = await invoke<string | null>("export_routing_rules");
      if (result) {
        pushSuccess("Правила экспортированы");
      }
    } catch (e) {
      pushSuccess(formatError(e), "error");
    }
  }, [rules, pushSuccess, toBackendPayload]);

  const importRules = useCallback(async () => {
    try {
      const raw = await invoke<RoutingRules | null>("import_routing_rules");
      if (!raw) return; // User cancelled

      const normalizeEntries = (entries: RuleEntry[]): RuleEntry[] =>
        (entries || []).map((e) => {
          const { type, value } = parseEntryValue(e.value);
          return { ...e, id: e.id || nextId(), type, value };
        });

      const imported: RoutingRules = {
        direct: normalizeEntries(raw.direct),
        proxy: normalizeEntries(raw.proxy),
        block: normalizeEntries(raw.block),
        process_mode: raw.process_mode || "exclude",
        processes: raw.processes || [],
      };

      setRules(imported);
      markDirty(imported);
      pushSuccess("Правила импортированы");
    } catch (e) {
      pushSuccess(formatError(e), "error");
    }
  }, [markDirty, pushSuccess]);

  // ─── GeoData download ──────────────────────────────

  const downloadGeoData = useCallback(async () => {
    setGeodataDownloading(true);
    setError("");
    try {
      await invoke("download_geodata");
      await loadGeoStatus();
      pushSuccess("Гео-данные загружены");
    } catch (e) {
      pushSuccess(formatError(e), "error");
    } finally {
      setGeodataDownloading(false);
    }
  }, [loadGeoStatus, pushSuccess]);

  // ─── Silent save (auto-save when VPN inactive) ─────

  const silentSave = useCallback(async () => {
    if (!configPath) return;
    try {
      const payload = toBackendPayload(rules);
      await invoke("save_routing_rules", { rules: payload });
      await invoke("resolve_and_apply", { configPath, rules: payload });
      baselineRef.current = computeSnapshot(rules);
      baselineVpnModeRef.current = vpnMode;
      setDirty(false);
      pushSuccess("Настройки сохранены");
    } catch (e) {
      pushSuccess(formatError(e), "error");
    }
  }, [configPath, rules, vpnMode, computeSnapshot, pushSuccess, toBackendPayload]);

  // ─── Manual save (with reconnect) ─────────────────

  const handleSave = useCallback(async (reconnect = false) => {
    if (!configPath) return;
    setApplying(true);
    setError("");
    try {
      const payload = toBackendPayload(rules);
      await invoke("save_routing_rules", { rules: payload });
      await invoke("resolve_and_apply", { configPath, rules: payload });
      baselineRef.current = computeSnapshot(rules);
      baselineVpnModeRef.current = vpnMode;
      setDirty(false);

      pushSuccess("Настройки сохранены");
      if (reconnect && isVpnActive) {
        await onReconnect();
      }
    } catch (e) {
      pushSuccess(formatError(e), "error");
    } finally {
      setApplying(false);
    }
  }, [configPath, rules, vpnMode, computeSnapshot, pushSuccess, toBackendPayload, isVpnActive, onReconnect]);

  // ─── Peer-save: when Settings panel saves, save our rules too ───
  useEffect(() => {
    const handler = () => { if (dirty) silentSave(); };
    window.addEventListener("tt-peer-save", handler);
    return () => window.removeEventListener("tt-peer-save", handler);
  }, [dirty, silentSave]);

  // ─── Auto-save when VPN not active ────────────────

  useAutoSave({
    dirty,
    canSave: !!configPath,
    isActive: isVpnActive,
    onSave: silentSave,
  });

  return {
    rules,
    geodataStatus,
    geodataCategories,
    processList,
    processListLoading,
    loading,
    saving,
    error,
    dirty,
    applying,
    addEntry,
    removeEntry,
    moveEntry,
    setProcessMode,
    addProcess,
    removeProcess,
    loadProcessList,
    save,
    load,
    exportRules,
    importRules,
    downloadGeoData,
    geodataDownloading,
    handleSave,
    isVpnActive,
    markDirty: useCallback(() => markDirty(), [markDirty]),
    isDuplicate,
  };
}
