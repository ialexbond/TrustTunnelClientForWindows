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

/**
 * Where a rule sends its traffic. TWO destinations, not three.
 *
 * `"block"` was the third until 2026-09-03, when site blocking by domain was removed (owner
 * decision). It never worked: in TUN mode the C++ core can only block a name by dropping its DNS
 * query, it answers with silence instead of NXDOMAIN — so Windows simply re-asks through another
 * adapter — and its connection-refusal gate compares IP only. The core logged not one
 * `[ROUTE] BLOCKED` in thirteen days of real logs.
 *
 * The entries users already typed are NOT deleted: the backend carries the `block` key of
 * `routing_rules.json` forward on every save, untouched, in case the feature ever returns as a
 * filtering DNS on the server. Nothing on this side of the bridge reads them.
 */
export type RouteAction = "direct" | "proxy";

export interface RuleEntry {
  id: string;
  type: RuleEntryType;
  value: string;
  label?: string;
}

/**
 * One running program, as `list_running_processes` reports it.
 *
 * NAME ONLY, and deliberately so. The struct used to carry a `path` that the backend hard-coded to
 * `None` on every code path — dead data that read as live, and the picker had already wired it into
 * its search filter and rendered it as a second line under each row. A full image path is
 * `C:\Users\<name>\…`, i.e. the Windows user name, which `processes.rs` and this file both go out of
 * their way to keep off every channel including the log. The field was one populated value away
 * from putting it on screen, so it is gone from both sides of the bridge rather than left waiting.
 *
 * If a path is ever genuinely needed for display, that is a deliberate decision with its own
 * review — not an accident of a field that happened to be already wired.
 */
export interface ProcessInfo {
  name: string;
}

export interface RoutingRules {
  direct: RuleEntry[];
  proxy: RuleEntry[];
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
  return { type, value: stripWirePrefix(type, raw) };
}

/** Strip the wire prefix that belongs to `type` — and only that one. */
function stripWirePrefix(type: RuleEntryType, raw: string): string {
  if (type === "geoip") return raw.replace(/^geoip:/, "");
  if (type === "geosite") return raw.replace(/^geosite:/, "");
  if (type === "iplist_group") return raw.replace(/^iplist_group:/, "");
  return raw;
}

/**
 * Turn one stored entry into the shape the panel renders (item 17, 30.1 milestone review).
 *
 * **The persisted `type` wins when it is present.** It used to lose: the old code spread the
 * record first and then overwrote `type` with one derived from the value alone, so an entry
 * written by an older build — type `iplist_group` on the record, but a BARE `games` in the value
 * because the prefix predates T-26/D-04 — came back as a plain `domain`. The group then stopped
 * routing and stopped refreshing from its cache, while the chip on screen still looked active.
 * That is this phase's defect in miniature: the app showing one thing and doing another.
 *
 * Derivation is still the fallback for a record with no type at all, and the prefix is stripped
 * against the FINAL type rather than the derived one — otherwise trusting a persisted `domain`
 * beside a `geoip:ru` value would strip a prefix the entry no longer claims to have.
 *
 * ONE function, called from BOTH doors (`load` and `importRules`). It replaces two byte-identical
 * copies — and two copies of a rule is exactly how the next reader fixes one of them and ships the
 * bug through the other. Each door still has its own regression case; see
 * `useRoutingState.test.ts`.
 */
function normalizeEntries(entries: RuleEntry[]): RuleEntry[] {
  return (entries || []).map((e) => {
    const derived = parseEntryValue(e.value);
    const type = e.type ?? derived.type;
    return { ...e, id: e.id || nextId(), type, value: stripWirePrefix(type, e.value) };
  });
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
  /**
   * A translated, user-facing message when the process enumeration FAILED — empty otherwise.
   * Deliberately never the raw backend error: a Win32 or path-bearing message would put the
   * Windows user name on screen, and the list of programs someone routes is their own business.
   */
  processListError: string;

  // State
  loading: boolean;
  /**
   * D-02 (30.1 blocker 2): the rules file exists and could NOT be parsed.
   *
   * The panel needs this to tell «сломано» from «пусто» — the two render identically otherwise,
   * and only one of them is the user's own doing. Not a latch: a successful reload clears it.
   */
  loadFailed: boolean;
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
  /**
   * D-02: throw the rule list away and write an empty document in its place — the way out of
   * `loadFailed`. DESTRUCTIVE and irreversible; the caller must confirm first (`RoutingPanel`
   * does). Reuses `save_routing_rules`, so no new command and no new capability.
   */
  resetRules: () => Promise<void>;

  // GeoData
  downloadGeoData: () => Promise<void>;
  geodataDownloading: boolean;
  /**
   * A geodata write is in flight ANYWHERE — this window's own download, another window's, or the
   * background scheduler's. `geodataDownloading` only ever knew about the first, which is why the
   * card's button stayed pressable during a background cycle and answered a click with
   * GEODATA_ALREADY_UPDATING instead of simply being disabled.
   */
  geodataBusy: boolean;

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
  const [processListError, setProcessListError] = useState("");

  const [loading, setLoading] = useState(true);
  /**
   * D-02: the last load FAILED — the rules file exists and could not be read.
   *
   * Deliberately separate from `error`: an empty rule list and an unreadable rule file look
   * identical on screen and mean opposite things, and this is the only thing that tells them
   * apart. Never latched — a successful reload clears it.
   */
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [applying, setApplying] = useState(false);
  const [geodataDownloading, setGeodataDownloading] = useState(false);
  const [geodataBusy, setGeodataBusy] = useState(false);

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

      const loaded: RoutingRules = {
        direct: normalizeEntries(raw.direct),
        proxy: normalizeEntries(raw.proxy),
        process_mode: raw.process_mode || "exclude",
        processes: raw.processes || [],
      };

      setRules(loaded);
      baselineRef.current = JSON.stringify({
        direct: loaded.direct.map(serializeEntry).sort(),
        proxy: loaded.proxy.map(serializeEntry).sort(),
        process_mode: loaded.process_mode,
        processes: loaded.processes.sort(),
      });
      baselineVpnModeRef.current = vpnMode;
      setDirty(false);
      // D-02: a fact about the LAST load, not a latch — a successful reload after a reset has to
      // give the user their panel back.
      setLoadFailed(false);
    } catch (e) {
      // D-02 (30.1 blocker 2). This arm used to raise a snackbar and leave `rules` at the empty
      // baseline, so the panel rendered its ordinary body with nothing in it — indistinguishable
      // from somebody who has no rules. Two problems in one: the user was told «пусто» about a
      // file that is merely broken, and the obvious response (start typing rules again) would
      // overwrite the list they still had.
      //
      // The snackbar carried `formatError(e)`, i.e. the backend's raw serde message — English,
      // unbounded, able to quote the file's own bytes. It is logged and nothing more (D-29); the
      // user gets the localized unreadable state instead.
      console.error("Failed to load routing rules:", e);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configPath]);

  /**
   * D-02: the way out of the unreadable state — replace the broken document with an empty one.
   *
   * Destructive, and gated by an explicit confirmation at the CALL SITE rather than here: the
   * panel owns the dialog (`RoutingPanel.tsx`), this owns the mechanism. Keeping the confirm out
   * of the hook is also what lets the hook be tested without a dialog provider.
   *
   * Implemented through the EXISTING `save_routing_rules` command — no new Tauri command and no
   * new capability surface, and it inherits the atomic writer from 30.1-01, so the file it leaves
   * behind is whole or not written at all. Reloads afterwards, which is what clears `loadFailed`.
   */
  const resetRules = useCallback(async () => {
    try {
      // The wire shape, written out rather than routed through `toBackendPayload`: there are no
      // entries to map, and an empty document has to be spelled explicitly so a future field added
      // to the payload builder cannot silently start travelling on a RESET.
      await invoke("save_routing_rules", {
        rules: {
          direct: [],
          proxy: [],
          process_mode: "exclude",
          processes: [],
        },
      });
      pushSuccess(t("routing.unreadable.reset_done"));
      await load();
    } catch (e) {
      console.error("Failed to reset routing rules:", e);
      pushSuccess(t("routing.unreadable.reset_failed"), "error");
    }
  }, [load, pushSuccess, t]);

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

  // Track whether ANY geodata write is in flight — this window's, another's, or the background
  // scheduler's — so the card can disable its button instead of letting a click fail.
  //
  // Both halves are needed. The event covers a cycle that STARTS while we are mounted; the one-off
  // read covers a cycle already running when we mount, which is the common case: the first
  // background cycle fires 8s after launch, and that is exactly when a user opens Маршрутизация.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    invoke<boolean>("geodata_update_in_flight").then(setGeodataBusy).catch(() => {});
    listen<boolean>("geodata-busy", (event) => {
      setGeodataBusy(event.payload);
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  // ─── Dirty tracking ────────────────────────────────

  const computeSnapshot = useCallback((r: RoutingRules): string => {
    return JSON.stringify({
      direct: r.direct.map(serializeEntry).sort(),
      proxy: r.proxy.map(serializeEntry).sort(),
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
      const fromBlock = (["direct", "proxy"] as RouteAction[]).find(
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

  /**
   * The ONE duplicate rule for adding a program, whichever way the user got here (D-04/D-05).
   *
   * Two halves, and they pull in opposite directions:
   *   • COMPARE FOLDED. `Chrome.exe` and `chrome.exe` are the same program, so the second one must
   *     not appear as a twin. Case-insensitivity here is purely about not showing the user two rows
   *     for one program — it changes nothing about routing.
   *   • STORE VERBATIM. The name goes in exactly as it arrived. The tempting shortcut is to
   *     lowercase before storing so the comparison becomes trivial; that would silently rewrite a
   *     rule the user typed. Process-name semantics belong to the C++ core, which lowercases and
   *     path-strips BOTH sides of its own comparison, so casing can never affect matching there —
   *     normalizing on our side would buy nothing and cost the user their own spelling.
   *
   * The persisted rule file is written verbatim by the Rust writer, and its format is core-owned;
   * nothing in this hook may start normalizing what it hands over.
   */
  const addProcess = useCallback(
    (name: string) => {
      setRules((prev) => {
        const folded = name.toLowerCase();
        if (prev.processes.some((existing) => existing.toLowerCase() === folded)) return prev;
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

  // A failure here used to stop at the console. The picker then rendered an empty list under the
  // words "no processes found" — telling the user the exact opposite of what happened, since there
  // were plenty of processes and we simply could not see them. Now the failure becomes state the
  // picker can show. The console keeps the raw detail for a developer; the user gets a TRANSLATED
  // message and never the raw error text, because a Win32 or path-bearing string would print their
  // Windows user name on screen. The error is cleared before every attempt, so a stale one can
  // never outlive a load that succeeded.
  const loadProcessList = useCallback(async () => {
    setProcessListLoading(true);
    setProcessListError("");
    try {
      const list = await invoke<ProcessInfo[]>("list_running_processes");
      setProcessList(list);
    } catch (e) {
      console.error("Failed to list processes:", e);
      setProcessListError(t("routing.processListError"));
    } finally {
      setProcessListLoading(false);
    }
  }, [t]);

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
    // The wire shape carries no `block` / `block_enabled` since site blocking was removed
    // (2026-09-03). Whatever those keys hold in the user's `routing_rules.json` is preserved by
    // the BACKEND on save, not echoed back through here — see `CARRIED_LEGACY_KEYS` in
    // `routing_rules.rs`. Re-adding them to this payload would put a removed feature back on the
    // bridge and make the browser the owner of data it does not render.
    return {
      direct: r.direct.map(mapEntry),
      proxy: r.proxy.map(mapEntry),
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
      pushSuccess(t("routing.rulesSaved"));
    } catch (e) {
      console.error("Failed to save routing rules:", e);
      pushSuccess(formatError(e), "error");
    } finally {
      setSaving(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configPath, rules, computeSnapshot, pushSuccess, toBackendPayload, t]);

  // ─── Export / Import ────────────────────────────────

  const exportRules = useCallback(async () => {
    try {
      // Save current rules first so export has data to read
      await invoke("save_routing_rules", { rules: toBackendPayload(rules) });
      const result = await invoke<string | null>("export_routing_rules");
      if (result) {
        pushSuccess(t("routing.rulesExported"));
      }
    } catch (e) {
      pushSuccess(formatError(e), "error");
    }
  }, [rules, pushSuccess, toBackendPayload, t]);

  const importRules = useCallback(async () => {
    try {
      const raw = await invoke<RoutingRules | null>("import_routing_rules");
      if (!raw) return; // User cancelled

      // Item 17: the SAME `normalizeEntries` the load path uses. These were two byte-identical
      // inline copies, and the import door is precisely how a fix applied to `load` alone gets
      // undone — the user re-imports their own export and every legacy group is re-typed again.
      const imported: RoutingRules = {
        direct: normalizeEntries(raw.direct),
        proxy: normalizeEntries(raw.proxy),
        process_mode: raw.process_mode || "exclude",
        processes: raw.processes || [],
      };

      setRules(imported);
      markDirty(imported);
      pushSuccess(t("routing.rulesImported"));
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
      // Phase 23: this was a hardcoded Russian literal — an i18n-rule violation that predates this
      // phase and is fixed here rather than left to drift, since the same call site changed anyway.
      pushSuccess(t("routing.geodataDownloaded"));
    } catch (e) {
      // D-17: the backend serialises the manual button and the background scheduler through one
      // in-flight guard and refuses the loser with the opaque code GEODATA_ALREADY_UPDATING. That
      // code must never reach the screen — a collision with a background cycle is a "try again in a
      // moment", not an error the user can act on.
      const msg = e instanceof Error ? e.message : String(e);
      pushSuccess(
        msg.includes("GEODATA_ALREADY_UPDATING") ? t("routing.geodataAlreadyUpdating") : formatError(e),
        "error",
      );
    } finally {
      setGeodataDownloading(false);
    }
  }, [loadGeoStatus, pushSuccess, t]);

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
      pushSuccess(t("routing.settingsSaved"));
    } catch (e) {
      pushSuccess(formatError(e), "error");
    }
  }, [configPath, rules, vpnMode, computeSnapshot, pushSuccess, toBackendPayload, t]);

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

      pushSuccess(t("routing.settingsSaved"));
      if (reconnect && isVpnActive) {
        await onReconnect();
      }
    } catch (e) {
      pushSuccess(formatError(e), "error");
    } finally {
      setApplying(false);
    }
  }, [configPath, rules, vpnMode, computeSnapshot, pushSuccess, toBackendPayload, isVpnActive, onReconnect, t]);

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
    processListError,
    loading,
    loadFailed,
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
    resetRules,
    downloadGeoData,
    geodataDownloading,
    geodataBusy,
    ensureGroupCache,
    groupFetching,
    handleSave,
    isVpnActive,
    markDirty: useCallback(() => markDirty(), [markDirty]),
    isDuplicate,
  };
}
