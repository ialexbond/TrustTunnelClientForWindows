import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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

// iplist.opencck.org group descriptor (backend get_iplist_groups). `label` is the English
// display name; the frontend localizes the visible name via i18n, `id` is the wire/cache key.
export interface IplistGroup {
  id: string;
  label: string;
}

// The special RU-whitelist cache key. It is NOT one of the get_iplist_groups ids, but it IS a
// valid group-cache key (fetch_whitelist_domains writes group_cache/ru_whitelist.json). Both the
// FE whitelist here and the backend is_valid_group_id accept it.
const RU_WHITELIST_ID = "ru_whitelist";

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

// 02-20: must mirror the shared `VpnStatus` union (src/shared/types.ts) — `reconnecting`
// («Переподключение») is a distinct status from `recovering` («Восстановление»). This
// local copy exists for the routing state machine; keep it in lock-step with the source.
export type VpnStatus = "connected" | "connecting" | "disconnected" | "disconnecting" | "recovering" | "reconnecting" | "error";

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
  iplistGroups: IplistGroup[];
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

  // iplist groups (D-03 / T-25): the available group list + a whitelisted fetch-on-add dispatcher
  ensureGroupCache: (groupId: string) => Promise<void>;
  groupFetching: boolean;

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
  const [iplistGroups, setIplistGroups] = useState<IplistGroup[]>([]);
  const [groupFetching, setGroupFetching] = useState(false);
  const [processList, setProcessList] = useState<ProcessInfo[]>([]);
  const [processListLoading, setProcessListLoading] = useState(false);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [applying, setApplying] = useState(false);
  const [geodataDownloading, setGeodataDownloading] = useState(false);

  const pushSuccess = useSnackBar();
  const { t } = useTranslation();

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
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // ─── Load iplist groups (D-03) ─────────────────────
  // Mirror loadGeoStatus: invoke the backend list once on mount and hold it in state. This list
  // is the source of truth the manual-entry whitelist (AddRuleInput) and the preset grid (Plan 04)
  // check an id against before it becomes a rule. On failure we keep the empty list (an unknown id
  // then fails the whitelist — safe by default) and surface nothing (non-critical read).
  const loadIplistGroups = useCallback(async () => {
    try {
      const groups = await invoke<IplistGroup[]>("get_iplist_groups");
      // Guard a non-array response (the real backend returns Vec<IplistGroup>, but a null/undefined
      // from a stub or a future contract change must NOT poison state — a null would flow to
      // AddRuleInput.groupIds (iplistGroups.map) and the preset grid, crashing the whole Routing tab.
      setIplistGroups(Array.isArray(groups) ? groups : []);
    } catch {
      // get_iplist_groups unavailable — keep empty list (whitelist rejects everything, safe).
    }
  }, []);

  // ensureGroupCache: fetch-on-add dispatcher (Pitfall #2 — a group must resolve to real domains,
  // never silently route zero traffic). Frontend-guards the id against the loaded group set PLUS
  // the literal ru_whitelist (belt to the backend is_valid_group_id): an unknown / traversal id is
  // a silent no-op that invokes NO fetch. For a known id it dispatches ru_whitelist →
  // fetch_whitelist_domains, else → fetch_iplist_group_domains, surfacing failures via the error
  // snackbar. Reused by manual entry (Task 3) and the preset grid (Plan 04).
  const ensureGroupCache = useCallback(
    async (groupId: string) => {
      const known = groupId === RU_WHITELIST_ID || iplistGroups.some((g) => g.id === groupId);
      if (!known) return; // unknown / traversal id → no fetch (backend guard is the second belt)
      setGroupFetching(true);
      try {
        if (groupId === RU_WHITELIST_ID) {
          await invoke<string[]>("fetch_whitelist_domains");
        } else {
          await invoke<string[]>("fetch_iplist_group_domains", { groupId });
        }
      } catch (e) {
        pushSuccess(formatError(e), "error");
      } finally {
        setGroupFetching(false);
      }
    },
    [iplistGroups, pushSuccess]
  );

  useEffect(() => {
    load();
    loadGeoStatus();
    loadIplistGroups();
  }, [load, loadGeoStatus, loadIplistGroups]);

  // Listen for geodata file changes (fs watcher from Rust)
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<GeoDataStatus>("geodata-files-changed", (event) => {
      setGeodataStatus(event.payload);
      // Reload categories if files appeared
      if (event.payload.downloaded) {
        loadGeoStatus();
      }
    }).then((fn) => { unlisten = fn; });
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

      // Same token already in the TARGET block → a genuine no-op duplicate (unchanged: AddRuleInput
      // maps this "duplicate" sentinel to the routing.duplicateEntry message).
      if (rules[action].some((e) => e.type === type && e.value === value)) {
        return "duplicate";
      }

      // Same token in a DIFFERENT block → MOVE it here instead of rejecting (Phase 22 owner UAT
      // decision: a category lives in exactly one block; re-adding it elsewhere relocates it and
      // tells the user where it came from — instead of the old "already exists" dead-end, which was
      // confusing when the existing entry sat in a collapsed/hidden block the user couldn't see).
      // addEntry's own guard keeps a token out of two blocks at once, so the source block is unique.
      const fromBlock = (["direct", "proxy", "block"] as RouteAction[]).find(
        (block) => block !== action && rules[block].some((e) => e.type === type && e.value === value)
      );
      if (fromBlock) {
        // Inline the move (mirrors moveEntry's remove-from-A + append-to-B + dedup) rather than
        // calling moveEntry: moveEntry is a const declared LATER, so referencing it in addEntry's
        // dep array would hit the temporal-dead-zone at render time.
        setRules((prev) => {
          const existing = prev[fromBlock].find((e) => e.type === type && e.value === value);
          if (!existing) return prev;
          if (prev[action].some((e) => e.type === type && e.value === value)) return prev; // target dedup
          const updated = {
            ...prev,
            [fromBlock]: prev[fromBlock].filter((e) => e.id !== existing.id),
            [action]: [...prev[action], existing],
          };
          markDirty(updated);
          return updated;
        });
        pushSuccess(t("routing.movedFromBlock", { block: t(`routing.${fromBlock}Title`) }));
        return null;
      }

      const entry: RuleEntry = { id: nextId(), type, value };
      setRules((prev) => {
        const updated = { ...prev, [action]: [...prev[action], entry] };
        markDirty(updated);
        return updated;
      });
      return null;
    },
    [rules, markDirty, pushSuccess, t]
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

  // Convert frontend rules to backend format (RuleEntry[] with serialized values).
  // T-26/D-04: all three group types (geoip/geosite/iplist_group) go through the
  // shared serializeEntry — the single source of truth for the wire prefix. The old
  // inline ternary only prefixed geoip/geosite, so an iplist_group was persisted with
  // a bare value, re-detected as a plain domain on reload, and misrouted. The load-path
  // parseEntryValue strips the prefix back, closing the round-trip.
  const toBackendPayload = useCallback((r: RoutingRules) => {
    const mapEntry = (e: RuleEntry) => ({
      ...e,
      value: serializeEntry(e),
      entry_type: e.type,
    });
    return {
      direct: r.direct.map(mapEntry),
      proxy: r.proxy.map(mapEntry),
      block: r.block.map(mapEntry),
      process_mode: r.process_mode,
      processes: r.processes,
    };
  }, []);

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
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
      // IN-57: the «Импорт» button now shares the drag door's 64 KiB cap; the backend returns
      // i18n key codes (routing.import_too_large / routing.import_invalid) so the error shows
      // localized instead of raw English. Other failures fall back to formatError.
      const msg = e instanceof Error ? e.message : String(e);
      pushSuccess(msg.startsWith("routing.import_") ? t(msg) : formatError(e), "error");
    }
  }, [markDirty, pushSuccess, t]);

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
    iplistGroups,
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
    ensureGroupCache,
    groupFetching,
    handleSave,
    isVpnActive,
    markDirty: useCallback(() => markDirty(), [markDirty]),
    isDuplicate,
  };
}
