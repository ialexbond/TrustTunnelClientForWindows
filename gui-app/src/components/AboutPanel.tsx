import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Shield, Github, Download, RefreshCw, Loader2, CheckCircle2, Sparkles, ArrowUpCircle } from "lucide-react";
import type { UpdateInfo } from "../App";
import { open } from "@tauri-apps/plugin-shell";

interface AboutPanelProps {
  updateInfo: UpdateInfo;
  onCheckUpdates: () => void;
  onOpenDownload: () => void;
}

interface UpdateProgressPayload {
  stage: string;
  percent: number;
  message: string;
}

function AboutPanel({ updateInfo, onCheckUpdates, onOpenDownload }: AboutPanelProps) {
  const [updating, setUpdating] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<UpdateProgressPayload | null>(null);
  const [updateError, setUpdateError] = useState("");

  useEffect(() => {
    const unlisten = listen<UpdateProgressPayload>("update-progress", (event) => {
      setUpdateProgress(event.payload);
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  const handleSelfUpdate = async () => {
    if (!updateInfo.downloadUrl) return;
    // Find the .zip asset URL — prefer zip over exe/msi
    setUpdating(true);
    setUpdateError("");
    setUpdateProgress({ stage: "download", percent: 0, message: "Подготовка..." });
    try {
      await invoke("self_update", { downloadUrl: updateInfo.downloadUrl });
    } catch (e) {
      setUpdateError(String(e));
      setUpdating(false);
      setUpdateProgress(null);
    }
  };

  return (
    <div className="flex-1 flex items-center justify-center p-6 overflow-auto">
      <div className="max-w-lg w-full space-y-6">
        {/* Logo + Name */}
        <div className="flex flex-col items-center gap-3">
          <div className="p-4 rounded-2xl bg-indigo-500/20 shadow-lg shadow-indigo-500/10">
            <Shield className="w-12 h-12 text-indigo-400" />
          </div>
          <h1 className="text-2xl font-bold tracking-wide">TrustTunnel Client for Windows</h1>
          <p className="text-sm text-gray-400">
            v{updateInfo.currentVersion || "1.0.0"}
          </p>
        </div>

        {/* Description */}
        <div className="bg-surface-900/50 rounded-xl border border-white/5 p-5 space-y-3">
          <h2 className="text-sm font-semibold text-gray-200">О программе</h2>
          <p className="text-xs text-gray-400 leading-relaxed">
            TrustTunnel — VPN-протокол, разработанный компанией AdGuard.
            Данное приложение — неофициальный клиент для Windows,
            позволяющий автоматически развернуть VPN-сервер на удалённой машине
            через SSH и подключиться к нему.
          </p>
          <div className="flex items-start gap-2 bg-white/5 rounded-lg p-3 mt-2">
            <Sparkles className="w-4 h-4 text-violet-400 shrink-0 mt-0.5" />
            <p className="text-[11px] text-gray-400 leading-relaxed">
              Клиентское приложение было полностью создано
              с помощью <span className="text-violet-300 font-medium">вайб-кодинга</span> —
              метода разработки, при котором AI-ассистент пишет код
              на основе описания задач на естественном языке.
            </p>
          </div>
        </div>

        {/* Update section */}
        <div className="bg-surface-900/50 rounded-xl border border-white/5 p-5 space-y-3">
          <h2 className="text-sm font-semibold text-gray-200">Обновления</h2>

          {updating && updateProgress ? (
            <div className="space-y-2">
              <div className="flex items-center gap-3 bg-indigo-500/10 border border-indigo-500/20 rounded-lg p-3">
                <Loader2 className="w-5 h-5 text-indigo-400 animate-spin shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-indigo-300 font-medium">
                    {updateProgress.message}
                  </p>
                </div>
              </div>
              <div className="w-full bg-white/10 rounded-full h-1.5 overflow-hidden">
                <div
                  className="h-full bg-indigo-500 rounded-full transition-all duration-300"
                  style={{ width: `${updateProgress.percent}%` }}
                />
              </div>
            </div>
          ) : updateInfo.available ? (
            <div className="space-y-2">
              <div className="flex items-center gap-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-3">
                <Download className="w-5 h-5 text-emerald-400 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-emerald-300 font-medium">
                    Доступна версия {updateInfo.latestVersion}
                  </p>
                  {updateInfo.releaseNotes && (
                    <p className="text-[11px] text-emerald-400/70 mt-1 truncate">
                      {updateInfo.releaseNotes.split("\n")[0]}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleSelfUpdate}
                  disabled={!updateInfo.downloadUrl}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition-colors disabled:opacity-50"
                >
                  <ArrowUpCircle className="w-3.5 h-3.5" />
                  Обновить автоматически
                </button>
                <button
                  onClick={onOpenDownload}
                  className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-white/5 text-gray-400 hover:bg-white/10 transition-colors"
                  title="Скачать вручную из браузера"
                >
                  <Download className="w-3.5 h-3.5" />
                </button>
              </div>
              {updateError && (
                <p className="text-[11px] text-red-400 break-words">{updateError}</p>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-3 bg-white/5 rounded-lg p-3">
              <CheckCircle2 className="w-5 h-5 text-gray-500 shrink-0" />
              <p className="text-xs text-gray-400">
                У вас установлена актуальная версия
              </p>
            </div>
          )}

          <button
            onClick={onCheckUpdates}
            disabled={updateInfo.checking || updating}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-xs font-medium bg-white/5 hover:bg-white/10 text-gray-300 transition-colors disabled:opacity-50"
          >
            {updateInfo.checking ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Проверка...
              </>
            ) : (
              <>
                <RefreshCw className="w-3.5 h-3.5" />
                Проверить обновления
              </>
            )}
          </button>
        </div>

        {/* Links */}
        <div className="flex items-center justify-center gap-4">
          <button
            onClick={() => open("https://github.com/ialexbond/TrustTunnelClient")}
            className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            <Github className="w-3.5 h-3.5" />
            GitHub
          </button>
          <span className="text-gray-700">|</span>
          <span className="text-[11px] text-gray-600">
            Протокол &copy; AdGuard · Клиент &copy; {new Date().getFullYear()} ialexbond
          </span>
        </div>
      </div>
    </div>
  );
}

export default AboutPanel;
