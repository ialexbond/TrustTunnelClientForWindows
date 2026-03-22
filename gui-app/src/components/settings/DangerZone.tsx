import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AlertTriangle, Eye, EyeOff, Loader2, Trash2, Download } from "lucide-react";

interface DangerZoneProps {
  onSwitchToSetup: () => void;
  onClearConfig: () => void;
}

export function DangerZone({ onSwitchToSetup, onClearConfig }: DangerZoneProps) {
  const [expanded, setExpanded] = useState(false);
  const [phase, setPhase] = useState<"idle" | "confirming" | "checking" | "uninstalling" | "not_found">("idle");
  const [host, setHost] = useState(() => {
    try { const raw = localStorage.getItem("trusttunnel_wizard"); return raw ? JSON.parse(raw).host || "" : ""; } catch { return ""; }
  });
  const [port, setPort] = useState(() => {
    try { const raw = localStorage.getItem("trusttunnel_wizard"); return raw ? JSON.parse(raw).port || "22" : "22"; } catch { return "22"; }
  });
  const [user, setUser] = useState(() => {
    try { const raw = localStorage.getItem("trusttunnel_wizard"); return raw ? JSON.parse(raw).sshUser || "root" : "root"; } catch { return "root"; }
  });
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [result, setResult] = useState<"" | "ok" | "error">("");
  const [resultMsg, setResultMsg] = useState("");

  useEffect(() => {
    const unlisten = listen<{ step: string; status: string; message: string }>(
      "deploy-step",
      (event) => {
        if (event.payload.step === "uninstall") {
          if (event.payload.status === "ok") {
            setPhase("idle");
            invoke("vpn_disconnect").catch(() => {});
            onClearConfig();
            onSwitchToSetup();
          } else if (event.payload.status === "error") {
            setPhase("idle");
            setResult("error");
            setResultMsg(event.payload.message);
          }
        }
      }
    );
    return () => { unlisten.then((f) => f()); };
  }, [onClearConfig, onSwitchToSetup]);

  const handleConfirm = async () => {
    if (!host || !password) return;
    setPhase("checking");
    setResult("");
    setResultMsg("");
    try {
      const info = await invoke<{ installed: boolean; version: string; service_active: boolean }>(
        "check_server_installation",
        { host, port: parseInt(port), user, password }
      );
      if (!info.installed) {
        setPhase("not_found");
      } else {
        setPhase("uninstalling");
        await invoke("uninstall_server", { host, port: parseInt(port), user, password });
      }
    } catch (e) {
      setPhase("idle");
      setResult("error");
      setResultMsg(String(e));
    }
  };

  const dangerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState(0);

  useEffect(() => {
    if (expanded && contentRef.current) {
      setContentHeight(contentRef.current.scrollHeight + 16);
    }
  }, [expanded]);

  const handleToggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next) {
      setTimeout(() => dangerRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }), 350);
    }
  };

  return (
    <div ref={dangerRef} className="pt-3">
      <button
        onClick={handleToggle}
        className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[11px] font-medium
                   text-red-400/60 hover:text-red-400 border border-red-500/10 hover:border-red-500/30
                   hover:bg-red-500/5 transition-all"
      >
        <AlertTriangle className="w-3 h-3" />
        Опасная зона
      </button>
      <div
        className="overflow-hidden transition-all duration-300 ease-in-out"
        style={{ maxHeight: expanded ? (contentHeight || 600) + "px" : "0px", opacity: expanded ? 1 : 0 }}
      >
        <div ref={contentRef} className="mt-2 space-y-2 p-2.5 rounded-lg border border-red-500/20 bg-red-500/5">
          <p className="text-[10px] text-red-300/80 leading-relaxed">
            Полностью удалить TrustTunnel с сервера: остановка сервиса, удаление файлов и конфигурации.
          </p>
          <div className="grid grid-cols-3 gap-1.5">
            <input type="text" value={host} onChange={(e) => setHost(e.target.value)}
              placeholder="IP сервера" className="col-span-2 bg-white/5 border border-white/10 rounded px-2 py-1 text-[10px] text-gray-200 placeholder-gray-600" />
            <input type="text" value={port} onChange={(e) => setPort(e.target.value)}
              placeholder="22" className="bg-white/5 border border-white/10 rounded px-2 py-1 text-[10px] text-gray-200 placeholder-gray-600" />
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <input type="text" value={user} onChange={(e) => setUser(e.target.value)}
              placeholder="root" className="bg-white/5 border border-white/10 rounded px-2 py-1 text-[10px] text-gray-200 placeholder-gray-600" />
            <div className="relative">
              <input type={showPw ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)}
                placeholder="Пароль SSH" className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 pr-7 text-[10px] text-gray-200 placeholder-gray-600" />
              <button type="button" onClick={() => setShowPw(!showPw)}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
                {showPw ? <EyeOff className="w-2.5 h-2.5" /> : <Eye className="w-2.5 h-2.5" />}
              </button>
            </div>
          </div>

          {result === "error" && (
            <p className="text-[10px] text-red-400">{resultMsg}</p>
          )}

          {phase === "not_found" && (
            <div className="p-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 space-y-2">
              <p className="text-[11px] text-amber-300 font-medium text-center">VPN не найден на сервере</p>
              <p className="text-[10px] text-amber-300/60 text-center">TrustTunnel не установлен на этом сервере. Хотите установить?</p>
              <div className="flex gap-2">
                <button onClick={() => { setPhase("idle"); setExpanded(false); }}
                  className="flex-1 px-3 py-1.5 rounded-lg text-[11px] text-gray-400 border border-white/10 hover:bg-white/5 transition-all">
                  Нет
                </button>
                <button onClick={() => {
                  setPhase("idle");
                  try {
                    const raw = localStorage.getItem("trusttunnel_wizard");
                    const obj = raw ? JSON.parse(raw) : {};
                    obj.host = host; obj.port = port; obj.sshUser = user; obj.sshPassword = password; obj.wizardStep = "endpoint";
                    localStorage.setItem("trusttunnel_wizard", JSON.stringify(obj));
                  } catch { /* ignore */ }
                  onClearConfig();
                  onSwitchToSetup();
                }}
                  className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 rounded-lg text-[11px] font-medium bg-indigo-500/30 border border-indigo-500/50 text-indigo-300 hover:bg-indigo-500/40 transition-all">
                  <Download className="w-3 h-3" />
                  Установить
                </button>
              </div>
            </div>
          )}

          {phase === "confirming" && (
            <div className="p-2.5 rounded-lg border border-red-500/30 bg-red-500/10 space-y-2">
              <p className="text-[11px] text-red-300 font-medium text-center">Вы уверены? Это действие необратимо.</p>
              <p className="text-[10px] text-red-300/60 text-center">Сервис будет остановлен, все файлы TrustTunnel будут удалены с сервера. Текущее VPN-подключение будет разорвано.</p>
              <div className="flex gap-2">
                <button onClick={() => setPhase("idle")}
                  className="flex-1 px-3 py-1.5 rounded-lg text-[11px] text-gray-400 border border-white/10 hover:bg-white/5 transition-all">
                  Отмена
                </button>
                <button onClick={handleConfirm}
                  className="flex-1 px-3 py-1.5 rounded-lg text-[11px] font-medium bg-red-500/30 border border-red-500/50 text-red-300 hover:bg-red-500/40 transition-all">
                  Да, удалить
                </button>
              </div>
            </div>
          )}

          {(phase === "checking" || phase === "uninstalling") && (
            <div className="flex items-center justify-center gap-2 py-2">
              <Loader2 className="w-4 h-4 text-red-400 animate-spin" />
              <span className="text-[11px] text-red-300">
                {phase === "checking" ? "Проверка сервера..." : "Удаление..."}
              </span>
            </div>
          )}

          {phase === "idle" && (
            <button onClick={() => setPhase("confirming")} disabled={!host || !password}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium
                         bg-red-500/20 border border-red-500/40 text-red-400 hover:bg-red-500/30
                         disabled:opacity-40 disabled:cursor-not-allowed transition-all">
              <Trash2 className="w-3.5 h-3.5" />
              Удалить VPN с сервера
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
