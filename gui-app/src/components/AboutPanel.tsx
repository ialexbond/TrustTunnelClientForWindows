import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Shield, Github, Download, RefreshCw, Loader2, CheckCircle2, Sparkles, ArrowUpCircle } from "lucide-react";
import type { UpdateInfo } from "../shared/types";
import { open } from "@tauri-apps/plugin-shell";
import { useSuccessQueue } from "../shared/hooks/useSuccessQueue";
import { SnackBar } from "../shared/ui/SnackBar";

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
  const { successQueue, pushSuccess, shiftSuccess } = useSuccessQueue();

  useEffect(() => {
    const unlisten = listen<UpdateProgressPayload>("update-progress", (event) => {
      setUpdateProgress(event.payload);
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  const handleSelfUpdate = async () => {
    if (!updateInfo.downloadUrl) return;
    setUpdating(true);
    setUpdateProgress({ stage: "download", percent: 0, message: "Подготовка..." });
    try {
      await invoke("self_update", { downloadUrl: updateInfo.downloadUrl });
    } catch (e) {
      pushSuccess(String(e), "error");
      setUpdating(false);
      setUpdateProgress(null);
    }
  };

  return (
    <div className="flex-1 flex items-center justify-center p-6 overflow-auto">
      <div className="max-w-lg w-full space-y-5">

        {/* Logo + Name */}
        <div className="flex flex-col items-center gap-3">
          <div
            className="p-4 rounded-2xl"
            style={{ backgroundColor: "var(--color-accent-500)", boxShadow: "0 8px 24px rgba(99, 102, 241, 0.25)" }}
          >
            <Shield className="w-12 h-12 text-white" />
          </div>
          <h1 className="text-2xl font-bold tracking-wide" style={{ color: "var(--color-text-primary)" }}>
            TrustTunnel
          </h1>
          <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>
            Client for Windows · v{updateInfo.currentVersion || "2.0.0"}
          </p>
        </div>

        {/* Description */}
        <div
          className="rounded-xl p-5 space-y-3"
          style={{ backgroundColor: "var(--color-bg-surface)", border: "1px solid var(--color-border)" }}
        >
          <h2 className="text-sm font-semibold" style={{ color: "var(--color-text-primary)" }}>
            О программе
          </h2>
          <p className="text-xs leading-relaxed" style={{ color: "var(--color-text-secondary)" }}>
            TrustTunnel — VPN-протокол, разработанный компанией AdGuard.
            Данное приложение — неофициальный клиент для Windows,
            позволяющий автоматически развернуть VPN-сервер на удалённой машине
            через SSH и подключиться к нему.
          </p>
          <div
            className="flex items-start gap-2 rounded-lg p-3 mt-2"
            style={{ backgroundColor: "var(--color-bg-elevated)", border: "1px solid var(--color-border)" }}
          >
            <Sparkles className="w-4 h-4 shrink-0 mt-0.5" style={{ color: "var(--color-accent-400)" }} />
            <p className="text-[11px] leading-relaxed" style={{ color: "var(--color-text-secondary)" }}>
              Клиентское приложение было полностью создано
              с помощью <span className="font-medium" style={{ color: "var(--color-accent-500)" }}>вайб-кодинга</span> —
              метода разработки, при котором AI-ассистент пишет код
              на основе описания задач на естественном языке.
            </p>
          </div>
        </div>

        {/* Update section */}
        <div
          className="rounded-xl p-5 space-y-3"
          style={{ backgroundColor: "var(--color-bg-surface)", border: "1px solid var(--color-border)" }}
        >
          <h2 className="text-sm font-semibold" style={{ color: "var(--color-text-primary)" }}>
            Обновления
          </h2>

          {updating && updateProgress ? (
            <div className="space-y-2">
              <div
                className="flex items-center gap-3 rounded-lg p-3"
                style={{ backgroundColor: "rgba(99, 102, 241, 0.08)", border: "1px solid rgba(99, 102, 241, 0.2)" }}
              >
                <Loader2 className="w-5 h-5 animate-spin shrink-0" style={{ color: "var(--color-accent-500)" }} />
                <p className="text-xs font-medium" style={{ color: "var(--color-accent-500)" }}>
                  {updateProgress.message}
                </p>
              </div>
              <div className="w-full rounded-full h-1.5 overflow-hidden" style={{ backgroundColor: "var(--color-bg-hover)" }}>
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{ width: `${updateProgress.percent}%`, backgroundColor: "var(--color-accent-500)" }}
                />
              </div>
            </div>
          ) : updateInfo.available ? (
            <div className="space-y-2">
              <div
                className="flex items-center gap-3 rounded-lg p-3"
                style={{ backgroundColor: "rgba(16, 185, 129, 0.08)", border: "1px solid rgba(16, 185, 129, 0.2)" }}
              >
                <Download className="w-5 h-5 shrink-0" style={{ color: "var(--color-success-500)" }} />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium" style={{ color: "var(--color-success-500)" }}>
                    Доступна версия {updateInfo.latestVersion}
                  </p>
                  {updateInfo.releaseNotes && (
                    <p className="text-[11px] mt-1 truncate" style={{ color: "var(--color-text-muted)" }}>
                      {updateInfo.releaseNotes.split("\n")[0]}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleSelfUpdate}
                  disabled={!updateInfo.downloadUrl}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 h-8 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
                  style={{ backgroundColor: "rgba(16, 185, 129, 0.1)", color: "var(--color-success-500)" }}
                >
                  <ArrowUpCircle className="w-3.5 h-3.5" />
                  Обновить автоматически
                </button>
                <button
                  onClick={onOpenDownload}
                  className="shrink-0 flex items-center gap-1.5 px-3 h-8 rounded-lg text-xs font-medium transition-colors"
                  style={{ backgroundColor: "var(--color-bg-hover)", color: "var(--color-text-secondary)" }}
                  title="Скачать вручную из браузера"
                >
                  <Download className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ) : (
            <div
              className="flex items-center gap-3 rounded-lg p-3"
              style={{ backgroundColor: "var(--color-bg-elevated)", border: "1px solid var(--color-border)" }}
            >
              <CheckCircle2 className="w-5 h-5 shrink-0" style={{ color: "var(--color-success-500)" }} />
              <p className="text-xs" style={{ color: "var(--color-text-secondary)" }}>
                У вас установлена актуальная версия
              </p>
            </div>
          )}

          <button
            onClick={onCheckUpdates}
            disabled={updateInfo.checking || updating}
            className="w-full flex items-center justify-center gap-2 px-4 h-8 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
            style={{
              backgroundColor: "var(--color-bg-hover)",
              color: "var(--color-text-primary)",
              border: "1px solid var(--color-border)",
            }}
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
            className="flex items-center gap-1.5 text-xs transition-colors"
            style={{ color: "var(--color-text-muted)" }}
          >
            <Github className="w-3.5 h-3.5" />
            GitHub
          </button>
          <span style={{ color: "var(--color-border-active)" }}>|</span>
          <span className="text-[11px]" style={{ color: "var(--color-text-muted)" }}>
            Протокол &copy; AdGuard · Клиент &copy; {new Date().getFullYear()} ialexbond
          </span>
        </div>
      </div>
      <SnackBar messages={successQueue} onShown={shiftSuccess} />
    </div>
  );
}

export default AboutPanel;
