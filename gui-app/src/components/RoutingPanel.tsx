import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  GitBranch, Globe, Monitor, MapPin, Plus, Trash2, Download,
  RefreshCw, Loader2, Check, X, Shield, AlertTriangle,
  ToggleLeft, ToggleRight, Database
} from "lucide-react";

// ─── Types (mirrors Rust structs) ──────────────────────

interface RoutingRule {
  type: string; // "ip" | "domain" | "geoip" | "geosite" | "process"
  value: string;
  enabled: boolean;
}

interface RoutingRules {
  mode: string; // "general" | "selective"
  rules: RoutingRule[];
}

interface GeodataSource {
  id: string;
  name: string;
  description: string;
  type: string;
}

interface GeodataFileStatus {
  id: string;
  name: string;
  description: string;
  type: string;
  downloaded: boolean;
  entry_count: number;
  updated_at: string | null;
}

interface ProcessInfo {
  pid: number;
  name: string;
}

// ─── Autocomplete suggestions ──────────────────────────

const AUTOCOMPLETE_PREFIXES = [
  { prefix: "geoip:", label: "GeoIP категория", icon: "🌍" },
  { prefix: "geosite:", label: "GeoSite категория", icon: "🔗" },
  { prefix: "process:", label: "Процесс", icon: "⚙️" },
];

const QUICK_ADD_RULES: { label: string; type: string; value: string }[] = [
  { label: "🇷🇺 Все IP России", type: "geoip", value: "geoip-ru" },
  { label: "🇷🇺 Заблок. IP (РКН)", type: "geoip", value: "geoip-ru-blocked" },
  { label: "🇷🇺 Заблок. домены (РКН)", type: "geosite", value: "geosite-ru-blocked" },
  { label: "🚫 Блок рекламы", type: "geosite", value: "geosite-category-ads-all" },
  { label: "🏠 Локальные сети", type: "geoip", value: "geoip-private" },
  { label: "🪟 Win телеметрия", type: "geosite", value: "geosite-win-spy" },
];

// Preset: General mode — all traffic through VPN, Russian IPs go direct
const PRESET_RU_DIRECT: { mode: string; rules: { type: string; value: string }[] } = {
  mode: "general",
  rules: [
    { type: "geoip", value: "geoip-ru" },
    { type: "geoip", value: "geoip-private" },
  ],
};

// Preset: Selective mode — only blocked sites through VPN
const PRESET_RU_UNBLOCK: { mode: string; rules: { type: string; value: string }[] } = {
  mode: "selective",
  rules: [
    { type: "geoip", value: "geoip-ru-blocked" },
    { type: "geosite", value: "geosite-ru-blocked" },
  ],
};

// ─── Rule type detection ───────────────────────────────

function detectRuleType(input: string): { type: string; value: string } {
  const trimmed = input.trim();
  if (trimmed.startsWith("geoip:")) return { type: "geoip", value: trimmed.slice(6) };
  if (trimmed.startsWith("geosite:")) return { type: "geosite", value: trimmed.slice(8) };
  if (trimmed.startsWith("process:")) return { type: "process", value: trimmed.slice(8) };
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(\/\d{1,2})?$/.test(trimmed)) return { type: "ip", value: trimmed };
  if (/^[a-f0-9:]+\/\d{1,3}$/i.test(trimmed)) return { type: "ip", value: trimmed }; // IPv6 CIDR
  return { type: "domain", value: trimmed };
}

function ruleTypeIcon(type: string) {
  switch (type) {
    case "ip": return <MapPin className="w-3.5 h-3.5 text-amber-400" />;
    case "domain": return <Globe className="w-3.5 h-3.5 text-emerald-400" />;
    case "geoip": return <Shield className="w-3.5 h-3.5 text-blue-400" />;
    case "geosite": return <Database className="w-3.5 h-3.5 text-purple-400" />;
    case "process": return <Monitor className="w-3.5 h-3.5 text-indigo-400" />;
    default: return <GitBranch className="w-3.5 h-3.5 text-gray-400" />;
  }
}

function ruleTypeLabel(type: string) {
  switch (type) {
    case "ip": return "IP/CIDR";
    case "domain": return "Домен";
    case "geoip": return "GeoIP";
    case "geosite": return "GeoSite";
    case "process": return "Процесс";
    default: return type;
  }
}

// ─── Main Component ────────────────────────────────────

function RoutingPanel() {
  const [rules, setRules] = useState<RoutingRules>({ mode: "general", rules: [] });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [input, setInput] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [geodataStatus, setGeodataStatus] = useState<GeodataFileStatus[]>([]);
  const [downloading, setDownloading] = useState<Record<string, boolean>>({});
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [showGeodata, setShowGeodata] = useState(false);
  const [geodataSources, setGeodataSources] = useState<GeodataSource[]>([]);
  const [dlProgress, setDlProgress] = useState<{ current: number; total: number; name: string; status: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  // Load rules on mount
  useEffect(() => {
    loadRules();
    loadGeodataInfo();
  }, []);

  // Listen for geodata download progress events
  useEffect(() => {
    const unlisten = listen<{ source_id: string; status: string; current: number; total: number; name?: string }>("geodata-progress", (event) => {
      const p = event.payload;
      if (p.status === "complete" || (p.status === "done" && p.total === 1)) {
        setDlProgress(null);
      } else {
        setDlProgress({ current: p.current, total: p.total, name: p.name || p.source_id, status: p.status });
      }
    });
    return () => { unlisten.then(f => f()); };
  }, []);

  const loadRules = async () => {
    try {
      setLoading(true);
      const data = await invoke<RoutingRules>("load_routing_rules");
      setRules(data);
    } catch (e) {
      console.warn("Failed to load routing rules:", e);
    } finally {
      setLoading(false);
    }
  };

  const loadGeodataInfo = async () => {
    try {
      const [status, sources] = await Promise.all([
        invoke<GeodataFileStatus[]>("get_geodata_status"),
        invoke<GeodataSource[]>("list_geodata_sources"),
      ]);
      setGeodataStatus(status);
      setGeodataSources(sources);
    } catch (e) {
      console.warn("Failed to load geodata info:", e);
    }
  };

  const saveRules = useCallback(async (newRules: RoutingRules) => {
    setRules(newRules);
    setSaving(true);
    try {
      await invoke("save_routing_rules", { rules: newRules });
    } catch (e) {
      console.error("Failed to save routing rules:", e);
    } finally {
      setSaving(false);
    }
  }, []);

  // ─── Mode toggle ─────────────────────────────────────

  const toggleMode = () => {
    const newMode = rules.mode === "general" ? "selective" : "general";
    saveRules({ ...rules, mode: newMode });
  };

  // ─── Add rule ────────────────────────────────────────

  const addRule = (type: string, value: string) => {
    if (!value.trim()) return;
    const exists = rules.rules.some(r => r.type === type && r.value === value);
    if (exists) return;
    const newRule: RoutingRule = { type, value: value.trim(), enabled: true };
    saveRules({ ...rules, rules: [...rules.rules, newRule] });
    setInput("");
    setShowSuggestions(false);
  };

  const applyPreset = (preset: { mode: string; rules: { type: string; value: string }[] }) => {
    const newRules = [...rules.rules];
    for (const r of preset.rules) {
      if (!newRules.some(existing => existing.type === r.type && existing.value === r.value)) {
        newRules.push({ type: r.type, value: r.value, enabled: true });
      }
    }
    saveRules({ ...rules, mode: preset.mode, rules: newRules });
  };

  const addFromInput = () => {
    if (!input.trim()) return;
    const { type, value } = detectRuleType(input);
    addRule(type, value);
  };

  const removeRule = (index: number) => {
    const newRules = rules.rules.filter((_, i) => i !== index);
    saveRules({ ...rules, rules: newRules });
  };

  const toggleRule = (index: number) => {
    const newRules = rules.rules.map((r, i) =>
      i === index ? { ...r, enabled: !r.enabled } : r
    );
    saveRules({ ...rules, rules: newRules });
  };

  // ─── Autocomplete ────────────────────────────────────

  const updateSuggestions = useCallback(async (value: string) => {
    if (!value) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }

    const items: string[] = [];

    // Prefix suggestions
    for (const { prefix } of AUTOCOMPLETE_PREFIXES) {
      if (prefix.startsWith(value.toLowerCase()) && value.length < prefix.length) {
        items.push(prefix);
      }
    }

    // GeoIP/GeoSite category suggestions
    if (value.startsWith("geoip:") || value.startsWith("geosite:")) {
      const query = value.includes(":") ? value.split(":")[1].toLowerCase() : "";
      const matchType = value.startsWith("geoip:") ? "geoip" : "geosite";
      const matching = geodataSources
        .filter(s => s.type === matchType && s.id.toLowerCase().includes(query))
        .map(s => `${matchType}:${s.id}`);
      items.push(...matching);
    }

    // Process suggestions
    if (value.startsWith("process:")) {
      const query = value.slice(8).toLowerCase();
      if (processes.length === 0) {
        try {
          const procs = await invoke<ProcessInfo[]>("list_running_processes");
          setProcesses(procs);
          items.push(...procs
            .filter(p => p.name.toLowerCase().includes(query))
            .slice(0, 15)
            .map(p => `process:${p.name}`)
          );
        } catch { /* ignore */ }
      } else {
        items.push(...processes
          .filter(p => p.name.toLowerCase().includes(query))
          .slice(0, 15)
          .map(p => `process:${p.name}`)
        );
      }
    }

    setSuggestions(items.slice(0, 20));
    setShowSuggestions(items.length > 0);
  }, [geodataSources, processes]);

  useEffect(() => {
    const timer = setTimeout(() => updateSuggestions(input), 150);
    return () => clearTimeout(timer);
  }, [input, updateSuggestions]);

  // Close suggestions on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (suggestionsRef.current && !suggestionsRef.current.contains(e.target as Node) &&
          inputRef.current && !inputRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // ─── Geodata download ────────────────────────────────

  const downloadSource = async (sourceId: string) => {
    setDownloading(prev => ({ ...prev, [sourceId]: true }));
    try {
      await invoke<string>("download_geodata", { sourceId });
      await loadGeodataInfo();
    } catch (e) {
      console.error("Download failed:", e);
    } finally {
      setDownloading(prev => ({ ...prev, [sourceId]: false }));
    }
  };

  const downloadAll = async () => {
    setDownloading(prev => ({ ...prev, __all: true }));
    try {
      await invoke<string>("download_all_geodata");
      await loadGeodataInfo();
    } catch (e) {
      console.error("Download all failed:", e);
    } finally {
      setDownloading(prev => ({ ...prev, __all: false }));
    }
  };

  // ─── Render ──────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-6 h-6 text-indigo-400 animate-spin" />
      </div>
    );
  }

  const enabledCount = rules.rules.filter(r => r.enabled).length;

  return (
    <div className="flex-1 flex flex-col gap-3 overflow-hidden">
      {/* Header + Mode toggle */}
      <div className="flex items-center gap-3 shrink-0">
        <div className="p-2 rounded-lg bg-indigo-500/20">
          <GitBranch className="w-5 h-5 text-indigo-400" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-gray-200">Маршрутизация</h2>
          <p className="text-[10px] text-gray-500">
            {enabledCount} активных правил · {saving ? "сохранение..." : "авто-сохранение"}
          </p>
        </div>

        {/* Mode toggle */}
        <button onClick={toggleMode} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-900/50 border border-white/5 hover:border-white/10 transition-colors">
          {rules.mode === "general" ? (
            <ToggleLeft className="w-4 h-4 text-blue-400" />
          ) : (
            <ToggleRight className="w-4 h-4 text-emerald-400" />
          )}
          <span className="text-[11px] font-medium text-gray-300">
            {rules.mode === "general" ? "General" : "Selective"}
          </span>
        </button>

        {/* Geodata button */}
        <button
          onClick={() => setShowGeodata(!showGeodata)}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-colors ${
            showGeodata ? "bg-indigo-500/20 text-indigo-300" : "bg-surface-900/50 border border-white/5 text-gray-400 hover:text-gray-300"
          }`}
        >
          <Database className="w-3.5 h-3.5" />
          GeoData
        </button>
      </div>

      {/* Mode description */}
      <div className="px-3 py-2 rounded-lg bg-surface-900/30 border border-white/5 shrink-0">
        {rules.mode === "general" ? (
          <p className="text-[11px] text-gray-400">
            <span className="text-blue-400 font-medium">General:</span> весь трафик идёт через VPN.
            Правила ниже — <span className="text-amber-300">исключения</span> (идут напрямую, без VPN).
          </p>
        ) : (
          <p className="text-[11px] text-gray-400">
            <span className="text-emerald-400 font-medium">Selective:</span> трафик идёт напрямую.
            Только правила ниже — <span className="text-emerald-300">через VPN</span>.
          </p>
        )}
      </div>

      {/* Geodata manager (collapsible) */}
      {showGeodata && (
        <div className="bg-surface-900/50 rounded-xl border border-white/5 p-3 space-y-2 shrink-0">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-gray-300">Базы данных GeoIP / GeoSite</h3>
            <button
              onClick={downloadAll}
              disabled={downloading.__all}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30 transition-colors disabled:opacity-50"
            >
              {downloading.__all ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
              Скачать все
            </button>
          </div>
          {/* Download progress bar */}
          {dlProgress && (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-gray-400 truncate">
                  {dlProgress.status === "downloading" ? "⬇" : dlProgress.status === "error" ? "❌" : "✅"}{" "}
                  {dlProgress.name}
                </span>
                <span className="text-gray-500 shrink-0">{dlProgress.current}/{dlProgress.total}</span>
              </div>
              <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                <div
                  className="h-full bg-indigo-500 rounded-full transition-all duration-300"
                  style={{ width: `${Math.round((dlProgress.current / dlProgress.total) * 100)}%` }}
                />
              </div>
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-40 overflow-y-auto">
            {geodataStatus.map((s) => (
              <div key={s.id} className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-white/[0.02] border border-white/5">
                {s.downloaded ? (
                  <Check className="w-3 h-3 text-emerald-400 shrink-0" />
                ) : (
                  <AlertTriangle className="w-3 h-3 text-amber-400 shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] font-medium text-gray-300 truncate">{s.name}</p>
                  <p className="text-[9px] text-gray-500 truncate">
                    {s.downloaded ? `${s.entry_count.toLocaleString()} записей` : "не скачан"}
                  </p>
                </div>
                <button
                  onClick={() => downloadSource(s.id)}
                  disabled={downloading[s.id]}
                  className="p-1 rounded hover:bg-white/5 transition-colors disabled:opacity-50"
                  title={s.downloaded ? "Обновить" : "Скачать"}
                >
                  {downloading[s.id] ? (
                    <Loader2 className="w-3 h-3 text-gray-400 animate-spin" />
                  ) : s.downloaded ? (
                    <RefreshCw className="w-3 h-3 text-gray-500" />
                  ) : (
                    <Download className="w-3 h-3 text-indigo-400" />
                  )}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Scenario presets */}
      <div className="flex flex-col sm:flex-row gap-2 shrink-0">
        <button
          onClick={() => applyPreset(PRESET_RU_DIRECT)}
          className="flex-1 flex flex-col gap-1 px-4 py-2.5 rounded-xl bg-gradient-to-r from-blue-500/15 to-indigo-500/15 border border-blue-500/20 hover:border-blue-500/40 transition-all text-left"
        >
          <span className="text-xs font-medium text-blue-200">🌐 Всё через VPN, RU напрямую</span>
          <span className="text-[10px] text-blue-400/60">
            General: весь трафик через VPN, российские IP идут напрямую.
            ChatGPT, Discord и др. — автоматически через VPN.
          </span>
        </button>
        <button
          onClick={() => applyPreset(PRESET_RU_UNBLOCK)}
          className="flex-1 flex flex-col gap-1 px-4 py-2.5 rounded-xl bg-gradient-to-r from-emerald-500/15 to-teal-500/15 border border-emerald-500/20 hover:border-emerald-500/40 transition-all text-left"
        >
          <span className="text-xs font-medium text-emerald-200">🔓 Только разблокировка</span>
          <span className="text-[10px] text-emerald-400/60">
            Selective: только заблокированные РКН сайты через VPN.
            Остальной трафик идёт напрямую — экономит ресурсы.
          </span>
        </button>
      </div>

      {/* Quick add buttons */}
      <div className="flex flex-wrap gap-1.5 shrink-0">
        {QUICK_ADD_RULES.map((q) => {
          const exists = rules.rules.some(r => r.type === q.type && r.value === q.value);
          return (
            <button
              key={q.value}
              onClick={() => addRule(q.type, q.value)}
              disabled={exists}
              className={`flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium transition-colors ${
                exists
                  ? "bg-white/5 text-gray-600 cursor-default"
                  : "bg-white/5 text-gray-400 hover:bg-indigo-500/20 hover:text-indigo-300"
              }`}
            >
              <Plus className="w-2.5 h-2.5" />
              {q.label}
            </button>
          );
        })}
      </div>

      {/* Rule input with autocomplete */}
      <div className="relative shrink-0">
        <div className="flex gap-2">
          <div className="flex-1 relative">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addFromInput();
                if (e.key === "Escape") setShowSuggestions(false);
              }}
              onFocus={() => { if (suggestions.length > 0) setShowSuggestions(true); }}
              placeholder="IP, домен, geoip:..., geosite:..., process:..."
              className="w-full px-3 py-2 rounded-lg bg-surface-900/50 border border-white/10 text-xs text-gray-200 placeholder-gray-600 focus:border-indigo-500/50 focus:outline-none"
            />
            {/* Suggestions dropdown */}
            {showSuggestions && suggestions.length > 0 && (
              <div
                ref={suggestionsRef}
                className="absolute top-full left-0 right-0 mt-1 bg-surface-900 border border-white/10 rounded-lg shadow-xl z-50 max-h-48 overflow-y-auto"
              >
                {suggestions.map((s, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      if (s.endsWith(":")) {
                        setInput(s);
                        inputRef.current?.focus();
                      } else {
                        const { type, value } = detectRuleType(s);
                        addRule(type, value);
                      }
                    }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-300 hover:bg-white/5 transition-colors text-left"
                  >
                    {ruleTypeIcon(detectRuleType(s).type)}
                    <span className="truncate">{s}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={addFromInput}
            disabled={!input.trim()}
            className="px-3 py-2 rounded-lg bg-indigo-500/20 text-indigo-300 text-xs font-medium hover:bg-indigo-500/30 transition-colors disabled:opacity-40 disabled:cursor-default"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Rules list */}
      <div className="flex-1 overflow-y-auto space-y-1 min-h-0">
        {rules.rules.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-gray-600">
            <GitBranch className="w-8 h-8" />
            <p className="text-xs">Нет правил маршрутизации</p>
            <p className="text-[10px]">Добавьте правила выше или используйте быстрые кнопки</p>
          </div>
        ) : (
          rules.rules.map((rule, index) => (
            <div
              key={`${rule.type}-${rule.value}-${index}`}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors ${
                rule.enabled
                  ? "bg-surface-900/30 border-white/5"
                  : "bg-surface-900/10 border-white/[0.02] opacity-50"
              }`}
            >
              {ruleTypeIcon(rule.type)}
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-gray-500 font-mono shrink-0">
                {ruleTypeLabel(rule.type)}
              </span>
              <span className="flex-1 text-xs text-gray-300 truncate min-w-0">
                {rule.value}
              </span>
              <button
                onClick={() => toggleRule(index)}
                className="p-1 rounded hover:bg-white/5 transition-colors"
                title={rule.enabled ? "Отключить" : "Включить"}
              >
                {rule.enabled ? (
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                ) : (
                  <X className="w-3.5 h-3.5 text-gray-500" />
                )}
              </button>
              <button
                onClick={() => removeRule(index)}
                className="p-1 rounded hover:bg-red-500/10 transition-colors"
                title="Удалить"
              >
                <Trash2 className="w-3.5 h-3.5 text-gray-500 hover:text-red-400" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default RoutingPanel;
