import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { GitBranch, Globe, Plus, Trash2, Loader2, RefreshCw, Upload, Download, Check, AlertCircle, List } from "lucide-react";
import type { VpnStatus } from "../App";

const RU_DOMAINS_MARKER = "@@RU-домены";

interface RoutingPanelProps {
  configPath: string;
  status: VpnStatus;
  onReconnect: () => Promise<void>;
  vpnMode?: string;
}

function RoutingPanel({ configPath, status, onReconnect, vpnMode }: RoutingPanelProps) {
  // Display entries: markers (@@RU-домены) + manual domains
  const [displayEntries, setDisplayEntries] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [needsReconnect, setNeedsReconnect] = useState(false);
  const [input, setInput] = useState("");
  const [saveError, setSaveError] = useState("");
  const [duplicateWarning, setDuplicateWarning] = useState("");
  const [fetchingDownload, setFetchingDownload] = useState(false);
  const [fetchingRefresh, setFetchingRefresh] = useState(false);
  const [whitelistLoaded, setWhitelistLoaded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const isActive = status === "connected" || status === "connecting" || status === "recovering";

  // Baseline: the flat domain list that was loaded initially (what VPN is running with)
  const baselineFlat = useRef<string>("");

  // Cached RU-domains (full whitelist from server)
  const [ruDomainsCache, setRuDomainsCache] = useState<string[]>([]);
  // Active RU-domains (the subset actually present in config — may be smaller than cache)
  const [ruDomainsActive, setRuDomainsActive] = useState<string[]>([]);

  // JSON backup domains (survives config deletion)
  const [jsonBackupDomains, setJsonBackupDomains] = useState<string[]>([]);
  const [showImportBanner, setShowImportBanner] = useState(false);

  // Check if RU-domains were previously downloaded (cache file exists)
  useEffect(() => {
    invoke<string[]>("load_group_cache", { groupId: "ru_whitelist" })
      .then((cached) => {
        if (cached.length > 0) {
          setRuDomainsCache(cached);
          setWhitelistLoaded(true);
        }
      })
      .catch(() => {});
  }, []);

  // Helper: given flat domains and a whitelist, separate into marker + manual
  // Also sets ruDomainsActive to the matched subset
  const collapseRuDomains = useCallback((flatDomains: string[], whitelist: string[]): string[] => {
    const wlSet = new Set(whitelist);
    const ruMatched = flatDomains.filter((d) => wlSet.has(d));
    const manual = flatDomains.filter((d) => !wlSet.has(d)).sort((a, b) => a.localeCompare(b));
    if (ruMatched.length > 0) {
      setRuDomainsActive(ruMatched);
      return [RU_DOMAINS_MARKER, ...manual];
    }
    return manual;
  }, []);

  // Load domains from config
  useEffect(() => {
    if (!configPath) {
      invoke<string[]>("load_exclusion_json")
        .then((jsonDomains) => {
          if (jsonDomains.length > 0) {
            setJsonBackupDomains(jsonDomains);
            setShowImportBanner(true);
          }
        })
        .catch(console.warn)
        .finally(() => setLoading(false));
      return;
    }
    invoke<string[]>("load_exclusion_list", { configPath })
      .then(async (tomlDomains) => {
        // Set baseline for dirty comparison
        baselineFlat.current = JSON.stringify(tomlDomains.slice().sort());
        // First try local cache
        let cached: string[] = [];
        try {
          cached = await invoke<string[]>("load_group_cache", { groupId: "ru_whitelist" });
        } catch { /* no cache */ }

        if (cached.length > 0) {
          // Cache exists — use it to detect RU-domains
          setRuDomainsCache(cached);
          setWhitelistLoaded(true);
          setDisplayEntries(collapseRuDomains(tomlDomains, cached));
        } else if (tomlDomains.length > 50) {
          // No cache but many domains — try to auto-detect by fetching whitelist
          try {
            const fetched = await invoke<string[]>("fetch_whitelist_domains");
            if (fetched.length > 0) {
              const wlSet = new Set(fetched);
              const overlap = tomlDomains.filter((d) => wlSet.has(d)).length;
              // If >50% of config domains match the whitelist, auto-detect
              if (overlap > tomlDomains.length * 0.5 || overlap > 100) {
                setRuDomainsCache(fetched);
                setWhitelistLoaded(true);
                setDisplayEntries(collapseRuDomains(tomlDomains, fetched));
              } else {
                setDisplayEntries(tomlDomains.sort((a, b) => a.localeCompare(b)));
              }
            } else {
              setDisplayEntries(tomlDomains.sort((a, b) => a.localeCompare(b)));
            }
          } catch {
            setDisplayEntries(tomlDomains.sort((a, b) => a.localeCompare(b)));
          }
        } else {
          setDisplayEntries(tomlDomains.sort((a, b) => a.localeCompare(b)));
        }

        // Check JSON backup for additional domains
        try {
          const jsonDomains = await invoke<string[]>("load_exclusion_json");
          const hasNew = jsonDomains.some((d) => !tomlDomains.includes(d));
          if (jsonDomains.length > 0 && hasNew) {
            setJsonBackupDomains(jsonDomains);
            setShowImportBanner(true);
          }
        } catch { /* ignore */ }
      })
      .catch(console.warn)
      .finally(() => setLoading(false));
  }, [configPath, collapseRuDomains]);

  // Expand display entries → flat domain list for saving to config
  // Uses ruDomainsActive (actual config domains), NOT full cache
  const expandToFlat = useCallback((entries: string[], activeDomains: string[]): string[] => {
    const all = new Set<string>();
    for (const e of entries) {
      if (e === RU_DOMAINS_MARKER) {
        activeDomains.forEach((d) => all.add(d));
      } else {
        all.add(e);
      }
    }
    return [...all].sort((a, b) => a.localeCompare(b));
  }, []);

  const totalDomains = expandToFlat(displayEntries, ruDomainsActive).length;

  // How many new domains are available in the whitelist but not in the active set
  const ruDomainsMissing = ruDomainsCache.length > 0 && ruDomainsActive.length > 0
    ? ruDomainsCache.filter((d) => !new Set(ruDomainsActive).has(d)).length
    : 0;

  const saveEntries = useCallback(async (newEntries: string[], activeDomains: string[], skipReconnect = false) => {
    setDisplayEntries(newEntries);
    const flat = expandToFlat(newEntries, activeDomains);
    setSaving(true);
    setSaveError("");
    try {
      await invoke("save_exclusion_json", { domains: flat });
      if (configPath) {
        await invoke("save_exclusion_list", { configPath, domains: flat });
      }
      if (!skipReconnect) {
        // Compare against baseline to decide if reconnect is needed
        const currentSorted = JSON.stringify(flat.slice().sort());
        setNeedsReconnect(currentSorted !== baselineFlat.current);
      }
    } catch (e) {
      console.error("Failed to save:", e);
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }, [configPath, expandToFlat]);

  const handleImportFromJson = useCallback(async () => {
    if (!configPath) return;
    const flat = expandToFlat(displayEntries, ruDomainsActive);
    const merged = new Set(flat);
    for (const d of jsonBackupDomains) merged.add(d);
    const cachedSet = new Set(ruDomainsCache);
    const hasRu = displayEntries.includes(RU_DOMAINS_MARKER);
    const allMerged = [...merged];
    const manual = allMerged.filter((d) => !cachedSet.has(d)).sort((a, b) => a.localeCompare(b));
    // Update active with any new RU-domains from the import
    const newActive = hasRu ? allMerged.filter((d) => cachedSet.has(d)) : ruDomainsActive;
    if (hasRu) setRuDomainsActive(newActive);
    const newEntries = hasRu ? [RU_DOMAINS_MARKER, ...manual] : allMerged.sort((a, b) => a.localeCompare(b));
    await saveEntries(newEntries, newActive);
    setShowImportBanner(false);
  }, [configPath, jsonBackupDomains, displayEntries, ruDomainsCache, ruDomainsActive, expandToFlat, saveEntries]);

  // Download and add RU-domains as a single marker entry
  // Deduplicates: existing domains that match the whitelist get absorbed into the marker
  const handleAddRuDomains = useCallback(async () => {
    if (displayEntries.includes(RU_DOMAINS_MARKER)) return;
    setFetchingDownload(true);
    setSaveError("");
    try {
      const fetched = await invoke<string[]>("fetch_whitelist_domains");
      setRuDomainsCache(fetched);
      setWhitelistLoaded(true);
      // Absorb existing domains that match the whitelist into the marker
      const wlSet = new Set(fetched);
      const manualOnly = displayEntries.filter((d) => !wlSet.has(d));
      // Active = full whitelist (user chose to add all RU-domains)
      setRuDomainsActive(fetched);
      const newEntries = [RU_DOMAINS_MARKER, ...manualOnly];
      await saveEntries(newEntries, fetched);
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setFetchingDownload(false);
    }
  }, [displayEntries, saveEntries]);

  // Refresh RU-domains: re-download whitelist and update active to full whitelist
  const handleRefreshRuDomains = useCallback(async () => {
    setFetchingRefresh(true);
    setSaveError("");
    try {
      const fetched = await invoke<string[]>("fetch_whitelist_domains");
      setRuDomainsCache(fetched);
      setRuDomainsActive(fetched);
      if (displayEntries.includes(RU_DOMAINS_MARKER)) {
        await saveEntries(displayEntries, fetched);
      }
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setFetchingRefresh(false);
    }
  }, [displayEntries, saveEntries]);

  // Add missing RU-domains (update active to full whitelist)
  const handleUpdateRuDomains = useCallback(async () => {
    if (!displayEntries.includes(RU_DOMAINS_MARKER)) return;
    setRuDomainsActive(ruDomainsCache);
    await saveEntries(displayEntries, ruDomainsCache);
  }, [displayEntries, ruDomainsCache, saveEntries]);

  const handleClearAll = useCallback(async () => {
    setDisplayEntries([]);
    setSaving(true);
    setSaveError("");
    try {
      await invoke("save_exclusion_json", { domains: [] as string[] });
      if (configPath) {
        await invoke("save_exclusion_list", { configPath, domains: [] as string[] });
      }
      const currentSorted = JSON.stringify([] as string[]);
      setNeedsReconnect(currentSorted !== baselineFlat.current);
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }, [configPath]);

  const handleReconnect = useCallback(async () => {
    setReconnecting(true);
    setNeedsReconnect(false);
    try {
      await onReconnect();
      // After successful reconnect, update baseline to current state
      const flat = expandToFlat(displayEntries, ruDomainsActive);
      baselineFlat.current = JSON.stringify(flat.slice().sort());
    } finally {
      setReconnecting(false);
    }
  }, [onReconnect, displayEntries, ruDomainsActive, expandToFlat]);

  const addDomain = () => {
    const val = input.trim().toLowerCase();
    if (!val) return;
    if (displayEntries.includes(val)) {
      setDuplicateWarning(`Домен «${val}» уже есть в списке`);
      setTimeout(() => setDuplicateWarning(""), 3000);
      return;
    }
    if (displayEntries.includes(RU_DOMAINS_MARKER) && ruDomainsCache.includes(val)) {
      setDuplicateWarning(`Домен «${val}» уже включён в RU-домены`);
      setTimeout(() => setDuplicateWarning(""), 3000);
      return;
    }
    setDuplicateWarning("");
    saveEntries([...displayEntries, val], ruDomainsActive);
    setInput("");
    inputRef.current?.focus();
  };

  const removeEntry = (idx: number) => {
    const removed = displayEntries[idx];
    const newEntries = displayEntries.filter((_, i) => i !== idx);
    // If removing the RU-domains marker, clear active
    if (removed === RU_DOMAINS_MARKER) {
      setRuDomainsActive([]);
    }
    saveEntries(newEntries, removed === RU_DOMAINS_MARKER ? [] : ruDomainsActive);
  };

  if (!configPath) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 text-gray-600">
        <Globe className="w-8 h-8" />
        <p className="text-xs">Конфигурация не выбрана</p>
        <p className="text-[10px]">Настройте подключение на вкладке Настройки</p>
        {showImportBanner && jsonBackupDomains.length > 0 && (
          <div className="mt-3 px-3 py-2 rounded-lg bg-indigo-500/10 border border-indigo-500/30 text-center max-w-xs">
            <p className="text-[11px] text-indigo-300 mb-1">
              Найдено {jsonBackupDomains.length} сохранённых доменов
            </p>
            <p className="text-[10px] text-gray-500">
              Они будут автоматически подгружены в конфиг после настройки подключения.
            </p>
          </div>
        )}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-6 h-6 text-indigo-400 animate-spin" />
      </div>
    );
  }

  const hasRuMarker = displayEntries.includes(RU_DOMAINS_MARKER);

  return (
    <div className="flex-1 flex flex-col gap-3 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 shrink-0">
        <div className="p-2 rounded-lg bg-indigo-500/20">
          <GitBranch className="w-5 h-5 text-indigo-400" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-gray-200">
            {vpnMode === "selective" ? "Через VPN" : "Напрямую"}
          </h2>
          <p className="text-[10px] text-gray-500">
            {totalDomains} записей · {saving ? "сохранение..." : "авто-сохранение"}
          </p>
        </div>
        {/* Refresh RU-domains — only when already downloaded */}
        {whitelistLoaded && (
          <button
            onClick={handleRefreshRuDomains}
            disabled={saving || fetchingRefresh || fetchingDownload}
            className="p-1.5 rounded-md bg-surface-800/50 text-gray-400 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors disabled:opacity-50"
            title="Обновить список RU-доменов"
          >
            {fetchingRefresh ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          </button>
        )}
        {/* RU-домены button */}
        <button
          onClick={handleAddRuDomains}
          disabled={saving || fetchingDownload || fetchingRefresh || hasRuMarker}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-emerald-500/10 text-emerald-400 text-[11px] font-medium hover:bg-emerald-500/20 transition-colors disabled:opacity-50"
          title={hasRuMarker ? "RU-домены уже добавлены" : whitelistLoaded ? "Добавить RU-домены" : "Скачать и добавить RU-домены"}
        >
          {fetchingDownload ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : hasRuMarker ? (
            <Check className="w-3.5 h-3.5" />
          ) : whitelistLoaded ? (
            <Check className="w-3.5 h-3.5" />
          ) : (
            <Download className="w-3.5 h-3.5" />
          )}
          RU-домены
        </button>
        {displayEntries.length > 0 && (
          <button
            onClick={handleClearAll}
            disabled={saving}
            className="px-2.5 py-1 rounded-md bg-red-500/10 text-red-400 text-[11px] hover:bg-red-500/20 transition-colors disabled:opacity-50"
            title="Удалить все"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Reconnect banner */}
      {needsReconnect && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 shrink-0">
          <RefreshCw className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          <p className="flex-1 text-[11px] text-amber-300">
            {isActive ? "Список изменён — нужен перезапуск" : "Список изменён — применится при подключении"}
          </p>
          {isActive && (
            <button
              onClick={handleReconnect}
              disabled={reconnecting}
              className="px-2.5 py-1 rounded-md bg-amber-500/20 text-amber-300 text-[11px] font-medium hover:bg-amber-500/30 transition-colors disabled:opacity-50"
            >
              {reconnecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Переподключить"}
            </button>
          )}
        </div>
      )}

      {/* Import from JSON banner */}
      {showImportBanner && jsonBackupDomains.length > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-indigo-500/10 border border-indigo-500/30 shrink-0">
          <Upload className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
          <p className="flex-1 text-[11px] text-indigo-300">
            Найдено {jsonBackupDomains.length} ранее сохранённых доменов
          </p>
          <button
            onClick={handleImportFromJson}
            disabled={saving}
            className="px-2.5 py-1 rounded-md bg-indigo-500/20 text-indigo-300 text-[11px] font-medium hover:bg-indigo-500/30 transition-colors disabled:opacity-50"
          >
            Подгрузить
          </button>
          <button
            onClick={() => setShowImportBanner(false)}
            className="px-2 py-1 rounded-md text-gray-500 text-[11px] hover:text-gray-300 transition-colors"
          >
            ✕
          </button>
        </div>
      )}

      {/* Save error / info message */}
      {saveError && (
        <div className={`px-3 py-2 rounded-lg shrink-0 bg-red-500/10 border border-red-500/30`}>
          <p className="text-[11px] break-words text-red-400">{saveError}</p>
        </div>
      )}

      {/* Duplicate warning */}
      {duplicateWarning && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 shrink-0">
          <AlertCircle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          <p className="text-[11px] text-amber-300">{duplicateWarning}</p>
        </div>
      )}

      {/* Info */}
      {!needsReconnect && !showImportBanner && !saveError && (
        <div className="px-3 py-2 rounded-lg bg-surface-900/30 border border-white/5 shrink-0">
          <p className="text-[11px] text-gray-400">
            {vpnMode === "selective"
              ? "Режим: Напрямую. Домены ниже пойдут через VPN, остальной трафик — напрямую."
              : "Режим: Всё через VPN. Домены ниже пойдут напрямую, остальной трафик — через VPN."}
          </p>
        </div>
      )}

      {/* Input */}
      <div className="flex gap-2 shrink-0">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") addDomain(); }}
          placeholder="example.com, *.google.com, sub.domain.ru..."
          className="flex-1 px-3 py-2 rounded-lg bg-surface-900/50 border border-white/10 text-xs text-gray-200 placeholder-gray-600 focus:border-indigo-500/50 focus:outline-none font-mono"
        />
        <button
          onClick={addDomain}
          disabled={!input.trim()}
          className="px-3 py-2 rounded-lg bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30 transition-colors disabled:opacity-40 disabled:cursor-default"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      {/* Domain list */}
      <div className="flex-1 overflow-y-auto space-y-1 min-h-0 pr-1">
        {displayEntries.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-gray-600">
            <Globe className="w-8 h-8" />
            <p className="text-xs">Список пуст</p>
            <p className="text-[10px]">Добавьте домены выше</p>
          </div>
        ) : (
          displayEntries.map((entry, idx) => {
            const isRuMarker = entry === RU_DOMAINS_MARKER;
            return (
              <div
                key={`${entry}-${idx}`}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border group ${
                  isRuMarker
                    ? "bg-emerald-500/5 border-emerald-500/20"
                    : "bg-surface-900/30 border-white/5"
                }`}
              >
                {isRuMarker ? (
                  <List className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                ) : (
                  <Globe className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                )}
                <span className={`flex-1 text-xs truncate ${isRuMarker ? "text-emerald-300 font-medium" : "text-gray-300 font-mono"}`}>
                  {isRuMarker ? "RU-домены" : entry}
                </span>
                {isRuMarker && ruDomainsActive.length > 0 && (
                  <span className="text-[9px] text-emerald-400/60 bg-emerald-500/10 px-1.5 py-0.5 rounded">
                    {ruDomainsActive.length} доменов
                  </span>
                )}
                {isRuMarker && ruDomainsMissing > 0 && (
                  <button
                    onClick={handleUpdateRuDomains}
                    disabled={saving}
                    className="flex items-center gap-1 text-[9px] text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 px-1.5 py-0.5 rounded transition-colors disabled:opacity-50"
                    title={`Доступно ${ruDomainsMissing} новых доменов`}
                  >
                    <Plus className="w-2.5 h-2.5" />
                    +{ruDomainsMissing}
                  </button>
                )}
                <button
                  onClick={() => removeEntry(idx)}
                  className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-red-500/10 transition-all"
                  title="Удалить"
                >
                  <Trash2 className="w-3.5 h-3.5 text-gray-500 hover:text-red-400" />
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export default RoutingPanel;
