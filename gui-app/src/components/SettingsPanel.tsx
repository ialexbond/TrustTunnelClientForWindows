import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Settings, FolderOpen, Save, Eye, EyeOff, Minus, Plus, Shield, Terminal, Lock, RefreshCw, HelpCircle, Trash2 } from "lucide-react";
import type { VpnConfig, VpnStatus } from "../App";
import { DangerZone } from "./settings/DangerZone";

interface SettingsPanelProps {
  configPath: string;
  onConfigChange: (config: VpnConfig) => void;
  status: VpnStatus;
  onReconnect: () => Promise<void>;
  onSwitchToSetup: () => void;
  onClearConfig: () => void;
  onVpnModeChange?: (mode: string) => void;
}

interface ClientConfig {
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


function Tooltip({ text, children }: { text: string; children: React.ReactNode }) {
  const [show, setShow] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);

  const positionTip = useCallback((tip: HTMLDivElement | null) => {
    const tr = triggerRef.current;
    if (!tip || !tr) return;

    const trRect = tr.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    const pad = 8;

    // Horizontal: centre on trigger, clamp to viewport
    let left = trRect.left + trRect.width / 2 - tipRect.width / 2;
    if (left < pad) left = pad;
    if (left + tipRect.width > window.innerWidth - pad) left = window.innerWidth - pad - tipRect.width;

    // Vertical: above if space, otherwise below
    const above = trRect.top - tipRect.height - 6 >= pad;
    const top = above ? trRect.top - tipRect.height - 6 : trRect.bottom + 6;

    tip.style.left = left + "px";
    tip.style.top = top + "px";
    tip.style.visibility = "visible";
  }, []);

  return (
    <div className="relative inline-flex" ref={triggerRef}
      onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}
    >
      {children}
      {show && createPortal(
        <div
          ref={positionTip}
          className="fixed z-[9999] w-56 px-2.5 py-2
                     bg-gray-900 border border-white/10 rounded-lg shadow-xl pointer-events-none"
          style={{ visibility: "hidden" }}
        >
          <p className="text-[10px] text-gray-300 leading-relaxed whitespace-normal">{text}</p>
        </div>,
        document.body,
      )}
    </div>
  );
}

function Toggle({
  value,
  onChange,
  label,
  description,
  tooltip,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
  tooltip?: string;
}) {
  return (
    <div
      className="flex items-center justify-between py-1.5 cursor-pointer group"
      onClick={() => onChange(!value)}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-1">
          <span className="text-xs text-gray-200 group-hover:text-white transition-colors">
            {label}
          </span>
          {tooltip && (
            <Tooltip text={tooltip}>
              <HelpCircle className="w-3 h-3 text-gray-600 hover:text-gray-400 transition-colors shrink-0 cursor-help"
                onClick={(e) => e.stopPropagation()} />
            </Tooltip>
          )}
        </div>
        {description && (
          <p className="text-[10px] text-gray-500 mt-0.5">{description}</p>
        )}
      </div>
      <div
        className="relative w-9 h-5 rounded-full shrink-0 ml-3 transition-colors"
        style={{ backgroundColor: value ? "var(--color-toggle-on)" : "var(--color-toggle-off)" }}
      >
        <div
          className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
            value ? "translate-x-[18px]" : "translate-x-0.5"
          }`}
        />
      </div>
    </div>
  );
}

function SettingsPanel({
  configPath,
  onConfigChange,
  status,
  onReconnect,
  onSwitchToSetup,
  onClearConfig,
  onVpnModeChange,
}: SettingsPanelProps) {
  const [config, setConfig] = useState<ClientConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [localPath, setLocalPath] = useState(configPath);
  const [reloadKey, setReloadKey] = useState(0);
  const [showPass, setShowPass] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  // Snapshot of config at last load/save for dirty comparison
  const savedSnapshot = useRef<string>("");
  const dirty = config ? JSON.stringify(config) !== savedSnapshot.current : false;

  useEffect(() => {
    setLocalPath(configPath);
    setReloadKey((k) => k + 1);
    if (!configPath) {
      setConfig(null);
      setError("");
      savedSnapshot.current = "";
    }
  }, [configPath]);

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

  const handleSave = useCallback(async (reconnect = false) => {
    if (!config || !localPath) return;
    setSaving(true);
    setError("");
    try {
      // Always force system DNS on (required for full-tunnel mode)
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
        await onReconnect();
      }
      if (!reconnect) {
        setJustSaved(true);
        setTimeout(() => setJustSaved(false), 2000);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [config, localPath, onConfigChange, status, onReconnect]);

  // Auto-save when VPN is not active
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!dirty || !config || !localPath) return;
    if (status === "connected" || status === "connecting") return;
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => {
      handleSave(false);
    }, 600);
    return () => { if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current); };
  }, [dirty, config, localPath, status, handleSave]);

  return (
    <div className="glass-card overflow-hidden h-full">
    <div className="p-3 flex flex-col gap-2 overflow-y-auto h-full">
      <div className="flex items-center gap-2">
        <Settings className="w-3.5 h-3.5 text-indigo-400" />
        <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400">
          Настройки
        </h2>
      </div>

      {/* Config file path */}
      <div>
        <label className="block text-[10px] text-gray-500 mb-1">
          Файл конфигурации
        </label>
        <div className="flex gap-1.5">
          <input
            type="text"
            value={localPath}
            onChange={(e) => setLocalPath(e.target.value)}
            onBlur={() => {
              onConfigChange({ configPath: localPath, logLevel: config?.loglevel || "info" });
            }}
            className="flex-1 bg-white/5 border border-white/10 rounded-lg px-2.5 py-1 text-[11px]
                       text-gray-200 placeholder-gray-600 focus:outline-none focus:border-indigo-500/50
                       focus:ring-1 focus:ring-indigo-500/25 transition-colors"
            placeholder="trusttunnel_client.toml"
          />
          <button
            onClick={async () => {
              // Open dialog in the directory of the current config file
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
            }}
            className="p-1.5 bg-white/5 border border-white/10 rounded-lg
                       hover:bg-white/10 transition-colors text-gray-400 hover:text-gray-200"
            title="Выбрать файл"
          >
            <FolderOpen className="w-3 h-3" />
          </button>
        </div>
      </div>

      {error && (
        <div className="text-[10px] text-red-400 bg-red-400/10 rounded px-2 py-1">
          {error}
        </div>
      )}

      {config && (
        <div className="space-y-2 flex-1">
          {/* Connection */}
          <div className="space-y-1.5">
            <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Подключение</span>
            <div>
              <label className="block text-[10px] text-gray-500 mb-0.5">Хост</label>
              <input
                type="text"
                value={config.endpoint?.hostname || ""}
                readOnly
                disabled
                className="w-full bg-white/5 border border-white/10 rounded-lg px-2.5 py-1 text-[11px]
                           text-gray-400 cursor-default opacity-70"
              />
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <div>
                <label className="block text-[10px] text-gray-500 mb-0.5">Логин</label>
                <input
                  type="text"
                  value={config.endpoint?.username || ""}
                  readOnly
                  disabled
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-2.5 py-1 text-[11px]
                             text-gray-400 cursor-default opacity-70"
                />
              </div>
              <div>
                <label className="block text-[10px] text-gray-500 mb-0.5">Пароль</label>
                <div className="relative">
                  <input
                    type={showPass ? "text" : "password"}
                    value={config.endpoint?.password || ""}
                    readOnly
                    disabled
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-2.5 py-1 pr-7 text-[11px]
                               text-gray-400 cursor-default opacity-70"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPass(!showPass)}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
                  >
                    {showPass ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* VPN Mode */}
          <div className="border-t border-white/5 pt-2">
            <label className="block text-[10px] text-gray-500 mb-1">Режим VPN</label>
            <div className="grid grid-cols-2 gap-1">
              <button
                onClick={() => { updateField("vpn_mode", "general"); onVpnModeChange?.("general"); }}
                className={`px-2 py-1.5 rounded-lg text-[11px] font-medium transition-all border ${
                  config.vpn_mode === "general"
                    ? "bg-indigo-500/20 border-indigo-500/50 text-indigo-300"
                    : "bg-white/5 border-white/10 text-gray-400 hover:text-gray-200"
                }`}
              >
                Всё через VPN
              </button>
              <button
                onClick={() => { updateField("vpn_mode", "selective"); onVpnModeChange?.("selective"); }}
                className={`px-2 py-1.5 rounded-lg text-[11px] font-medium transition-all border ${
                  config.vpn_mode === "selective"
                    ? "bg-indigo-500/20 border-indigo-500/50 text-indigo-300"
                    : "bg-white/5 border-white/10 text-gray-400 hover:text-gray-200"
                }`}
              >
                Напрямую
              </button>
            </div>
            <p className="text-[9px] text-gray-600 mt-0.5">
              {config.vpn_mode === "general"
                ? "Весь трафик через VPN, кроме исключений"
                : "Весь трафик напрямую, кроме указанных маршрутов"}
            </p>
          </div>

          {/* Advanced */}
          <div className="border-t border-white/5 pt-2 space-y-1.5">
            <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Дополнительно</span>
            <div className="grid grid-cols-2 gap-1.5">
              <div>
                <label className="block text-[10px] text-gray-500 mb-0.5">MTU</label>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => updateField("listener.tun.mtu_size", Math.max(576, (config.listener?.tun?.mtu_size || 1280) - 10))}
                    className="p-1 rounded-md bg-white/5 border border-white/10 text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
                  >
                    <Minus className="w-3 h-3" />
                  </button>
                  <input
                    type="number"
                    value={config.listener?.tun?.mtu_size || 1280}
                    onChange={(e) => updateField("listener.tun.mtu_size", Number(e.target.value))}
                    className="flex-1 min-w-0 bg-white/5 border border-white/10 rounded-lg px-2.5 py-1 text-[11px] text-center
                               text-gray-200 focus:outline-none focus:border-indigo-500/50
                               focus:ring-1 focus:ring-indigo-500/25 transition-colors"
                  />
                  <button
                    onClick={() => updateField("listener.tun.mtu_size", Math.min(9000, (config.listener?.tun?.mtu_size || 1280) + 10))}
                    className="p-1 rounded-md bg-white/5 border border-white/10 text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
                  >
                    <Plus className="w-3 h-3" />
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-[10px] text-gray-500 mb-0.5">Протокол</label>
                <div className="grid grid-cols-2 gap-1">
                  {(["http2", "http3"] as const).map((proto) => (
                    <button
                      key={proto}
                      onClick={() => updateField("endpoint.upstream_protocol", proto)}
                      className={`px-2 py-1 rounded-lg text-[11px] font-medium transition-all border ${
                        (config.endpoint?.upstream_protocol || "http2") === proto
                          ? "bg-indigo-500/20 border-indigo-500/50 text-indigo-300"
                          : "bg-white/5 border-white/10 text-gray-400 hover:text-gray-200"
                      }`}
                    >
                      {proto === "http2" ? "HTTP/2" : "HTTP/3"}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Save button — always visible */}
          <div className="pt-2 border-t border-white/5">
            <button
              onClick={() => handleSave(status === "connected" || status === "connecting")}
              disabled={!dirty || saving}
              className={`w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all ${
                dirty
                  ? "bg-indigo-500 hover:bg-indigo-400 text-white"
                  : "bg-white/5 text-gray-500 cursor-not-allowed"
              }`}
            >
              <Save className="w-3.5 h-3.5" />
              {saving
                ? "Сохранение..."
                : dirty
                ? (status === "connected" || status === "connecting"
                    ? "Сохранить и переподключить"
                    : "Сохранить")
                : justSaved
                ? "Сохранено ✔"
                : "Настройки сохранены"}
            </button>
          </div>

          {/* Toggles */}
          <div className="border-t border-white/5 pt-2 space-y-0.5">
            <Toggle
              label="Kill Switch"
              description="Блокировать интернет при обрыве VPN"
              value={config.killswitch_enabled}
              onChange={(v) => updateField("killswitch_enabled", v)}
              tooltip="При потере VPN-соединения весь интернет-трафик блокируется, чтобы ваши данные не утекли в обход VPN. Рекомендуется держать включённым для максимальной безопасности."
            />
            <Toggle
              label="Anti-DPI"
              description="Обход блокировок DPI"
              value={config.endpoint?.anti_dpi || false}
              onChange={(v) => updateField("endpoint.anti_dpi", v)}
              tooltip="Маскирует VPN-трафик под обычный HTTPS, чтобы обойти системы глубокого анализа пакетов (DPI), которые используют провайдеры и госорганы для блокировки VPN."
            />
            <Toggle
              label="Post-Quantum"
              description="Постквантовая криптография"
              value={config.post_quantum_group_enabled}
              onChange={(v) => updateField("post_quantum_group_enabled", v)}
              tooltip="Использует алгоритмы шифрования, устойчивые к атакам квантовых компьютеров. Защищает ваши данные от расшифровки в будущем. Немного увеличивает время подключения."
            />
            <Toggle
              label="IPv6"
              description="Разрешить IPv6 трафик через VPN"
              value={config.endpoint?.has_ipv6 || false}
              onChange={(v) => updateField("endpoint.has_ipv6", v)}
              tooltip="Разрешает маршрутизацию IPv6-трафика через VPN-туннель. Если ваш провайдер или сервер не поддерживают IPv6, оставьте выключенным — это избежит проблем с подключением."
            />
          </div>

          {/* DNS Upstreams */}
          <div className="border-t border-white/5 pt-2 space-y-1.5">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">DNS Upstreams</span>
              <Tooltip text="Кастомные DNS-серверы для запросов через VPN. Несколько серверов работают как резервные: если первый не отвечает, используется следующий. Поддерживаются шифрованные протоколы DoT, DoH, DoQ для защиты DNS-запросов от перехвата провайдером.">
                <HelpCircle className="w-3 h-3 text-gray-600 hover:text-gray-400 transition-colors cursor-help" />
              </Tooltip>
            </div>
            {(config.dns_upstreams || []).map((upstream, idx) => (
              <div key={idx} className="flex items-center gap-1">
                <input
                  type="text"
                  value={upstream}
                  onChange={(e) => {
                    const arr = [...(config.dns_upstreams || [])];
                    arr[idx] = e.target.value;
                    updateField("dns_upstreams", arr);
                  }}
                  className="flex-1 bg-white/5 border border-white/10 rounded-lg px-2.5 py-1 text-[11px]
                             text-gray-200 placeholder-gray-600 focus:outline-none focus:border-indigo-500/50
                             focus:ring-1 focus:ring-indigo-500/25 transition-colors"
                  placeholder="8.8.8.8:53 / tls://1.1.1.1 / https://dns.example/dns-query"
                />
                <button
                  onClick={() => {
                    const arr = [...(config.dns_upstreams || [])];
                    arr.splice(idx, 1);
                    updateField("dns_upstreams", arr);
                  }}
                  className="p-1 rounded-md text-gray-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                  title="Удалить"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}
            <button
              onClick={() => {
                const arr = [...(config.dns_upstreams || []), ""];
                updateField("dns_upstreams", arr);
              }}
              className="w-full flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg text-[10px]
                         text-gray-400 hover:text-gray-200 border border-dashed border-white/10
                         hover:border-white/20 hover:bg-white/5 transition-all"
            >
              <Plus className="w-3 h-3" />
              Добавить DNS
            </button>
          </div>

          {/* Utilities — coming soon */}
          <div className="border-t border-white/5 pt-2 space-y-1.5">
            <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Утилиты сервера</span>
            <div className="rounded-lg border border-white/5 bg-white/[0.02] p-3 space-y-2 opacity-50 pointer-events-none select-none">
              <p className="text-[10px] text-gray-500 text-center mb-2">В разработке — будет доступно в будущих обновлениях</p>
              <div className="grid grid-cols-2 gap-2">
                <div className="flex items-center gap-2 px-2.5 py-2 rounded-lg bg-white/[0.03] border border-white/5">
                  <Shield className="w-3.5 h-3.5 text-gray-600 shrink-0" />
                  <div>
                    <p className="text-[11px] text-gray-500 font-medium">Firewall</p>
                    <p className="text-[9px] text-gray-600">Настройка правил</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 px-2.5 py-2 rounded-lg bg-white/[0.03] border border-white/5">
                  <Lock className="w-3.5 h-3.5 text-gray-600 shrink-0" />
                  <div>
                    <p className="text-[11px] text-gray-500 font-medium">Fail2Ban</p>
                    <p className="text-[9px] text-gray-600">Защита от брутфорса</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 px-2.5 py-2 rounded-lg bg-white/[0.03] border border-white/5">
                  <RefreshCw className="w-3.5 h-3.5 text-gray-600 shrink-0" />
                  <div>
                    <p className="text-[11px] text-gray-500 font-medium">WARP</p>
                    <p className="text-[9px] text-gray-600">Cloudflare WARP</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 px-2.5 py-2 rounded-lg bg-white/[0.03] border border-white/5">
                  <Terminal className="w-3.5 h-3.5 text-gray-600 shrink-0" />
                  <div>
                    <p className="text-[11px] text-gray-500 font-medium">SSH порт</p>
                    <p className="text-[9px] text-gray-600">Смена порта SSH</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Danger Zone */}
          <DangerZone onSwitchToSetup={onSwitchToSetup} onClearConfig={onClearConfig} />
        </div>
      )}

      {!config && !error && (
        <div className="flex-1 flex items-center justify-center text-gray-600 text-xs">
          Укажите путь к конфигу...
        </div>
      )}
    </div>
    </div>
  );
}

export default SettingsPanel;
