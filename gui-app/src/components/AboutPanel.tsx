import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Shield,
  Github,
  Download,
  RefreshCw,
  Loader2,
  CheckCircle2,
  ArrowUpCircle,
  Heart,
  ExternalLink,
} from "lucide-react";
import type { UpdateInfo } from "../shared/types";
import { open } from "@tauri-apps/plugin-shell";
import { useSnackBar } from "../shared/ui/SnackBarContext";
import { colors } from "../shared/ui/colors";
import { formatError } from "../shared/utils/formatError";

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
  const { t } = useTranslation();
  const [updating, setUpdating] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<UpdateProgressPayload | null>(null);
  const pushSuccess = useSnackBar();

  // Translate update progress message keys from Rust
  const translateProgress = useCallback((payload: UpdateProgressPayload): UpdateProgressPayload => {
    const { message } = payload;
    if (message.startsWith("update.downloading|")) {
      const parts = message.split("|");
      return { ...payload, message: t("update.downloading", { downloaded: parts[1], total: parts[2] }) };
    }
    if (message.startsWith("update.")) {
      return { ...payload, message: t(message) };
    }
    return payload;
  }, [t]);

  useEffect(() => {
    const unlisten = listen<UpdateProgressPayload>("update-progress", (event) => {
      setUpdateProgress(translateProgress(event.payload));
    });
    return () => { unlisten.then((f) => f()); };
  }, [translateProgress]);

  const handleSelfUpdate = async () => {
    if (!updateInfo.downloadUrl) return;
    setUpdating(true);
    setUpdateProgress({ stage: "download", percent: 0, message: t("status.preparing") });
    try {
      await invoke("self_update", {
        downloadUrl: updateInfo.downloadUrl,
        expectedSha256: updateInfo.sha256 || null,
        language: localStorage.getItem("tt_language") || "ru",
        theme: localStorage.getItem("tt_theme") || "dark",
      });
    } catch (e) {
      pushSuccess(formatError(e), "error");
      setUpdating(false);
      setUpdateProgress(null);
    }
  };

  const version = updateInfo.currentVersion || "2.1.0";

  return (
    <div className="flex-1 flex flex-col items-center justify-center overflow-y-auto py-6 px-4">

      <div className="w-full max-w-sm space-y-5">
        {/* Logo + Name */}
        <div className="flex flex-col items-center gap-2">
          <div
            className="p-3.5 rounded-2xl shadow-lg"
            style={{ background: "linear-gradient(135deg, var(--color-accent-500), var(--color-accent-400))" }}
          >
            <Shield className="w-10 h-10 text-white" />
          </div>
          <div className="flex items-center gap-2 mt-1">
            <h1 className="text-xl font-bold tracking-wide" style={{ color: "var(--color-text-primary)" }}>
              TrustTunnel
            </h1>
            <span
              className="text-[10px] font-bold px-2 py-0.5 rounded"
              style={{ backgroundColor: colors.accentBg, color: "var(--color-accent-500)" }}
            >
              PRO
            </span>
          </div>
          <span
            className="text-[11px] font-mono px-2.5 py-0.5 rounded-full"
            style={{ backgroundColor: "var(--color-bg-hover)", color: "var(--color-text-muted)" }}
          >
            v{version} · Windows
          </span>
        </div>

        {/* Update card */}
        <div
          className="rounded-xl p-4 space-y-3"
          style={{ backgroundColor: "var(--color-bg-surface)", border: "1px solid var(--color-border)" }}
        >
          {updating && updateProgress ? (
            /* Downloading */
            <div className="space-y-2">
              <div
                className="flex items-center gap-3 rounded-lg p-3"
                style={{ backgroundColor: colors.accentBgSubtle, border: `1px solid ${colors.accentBorder}` }}
              >
                <Loader2 className="w-4 h-4 animate-spin shrink-0" style={{ color: "var(--color-accent-500)" }} />
                <p className="text-xs font-medium" style={{ color: "var(--color-accent-500)" }}>
                  {updateProgress.message}
                </p>
              </div>
              <div className="w-full rounded-full h-1 overflow-hidden" style={{ backgroundColor: "var(--color-bg-hover)" }}>
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{ width: `${updateProgress.percent}%`, backgroundColor: "var(--color-accent-500)" }}
                />
              </div>
            </div>
          ) : updateInfo.available ? (
            /* Update available */
            <div className="space-y-2.5">
              <div
                className="flex items-center gap-2.5 rounded-lg p-2.5"
                style={{ backgroundColor: colors.successBgSubtle, border: `1px solid ${colors.successBorder}` }}
              >
                <Download className="w-4 h-4 shrink-0" style={{ color: "var(--color-success-500)" }} />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium" style={{ color: "var(--color-success-500)" }}>
                    {t("about.update_available", { version: updateInfo.latestVersion })}
                  </p>
                  {updateInfo.releaseNotes && (
                    <p className="text-[11px] mt-0.5 truncate" style={{ color: "var(--color-text-muted)" }}>
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
                  style={{ backgroundColor: colors.successBg, color: "var(--color-success-500)" }}
                >
                  <ArrowUpCircle className="w-3.5 h-3.5" />
                  {t("buttons.auto_update")}
                </button>
                <button
                  onClick={onOpenDownload}
                  className="shrink-0 flex items-center gap-1.5 px-3 h-8 rounded-lg text-xs font-medium transition-colors"
                  style={{ backgroundColor: "var(--color-bg-hover)", color: "var(--color-text-secondary)" }}
                  title={t("buttons.download_from_browser")}
                >
                  <Download className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ) : (
            /* Up to date */
            <div
              className="flex items-center gap-2.5 rounded-lg p-2.5"
              style={{ backgroundColor: "var(--color-bg-elevated)", border: "1px solid var(--color-border)" }}
            >
              <CheckCircle2 className="w-4 h-4 shrink-0" style={{ color: "var(--color-success-500)" }} />
              <p className="text-xs" style={{ color: "var(--color-text-secondary)" }}>
                {t("about.up_to_date")}
              </p>
            </div>
          )}

          <button
            onClick={onCheckUpdates}
            disabled={updateInfo.checking || updating}
            className="w-full flex items-center justify-center gap-1.5 px-4 h-8 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
            style={{
              backgroundColor: "var(--color-bg-hover)",
              color: "var(--color-text-primary)",
              border: "1px solid var(--color-border)",
            }}
          >
            {updateInfo.checking ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {t("status.checking")}
              </>
            ) : (
              <>
                <RefreshCw className="w-3.5 h-3.5" />
                {t("buttons.check_updates")}
              </>
            )}
          </button>
        </div>

        {/* About description — compact */}
        <div
          className="rounded-xl p-4 text-xs leading-relaxed"
          style={{
            backgroundColor: "var(--color-bg-surface)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-secondary)",
          }}
        >
          <p>{t("about.description")}</p>
          <div
            className="flex items-start gap-2 rounded-lg p-2.5 mt-3"
            style={{ backgroundColor: "var(--color-bg-elevated)" }}
          >
            <Heart className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: "var(--color-accent-400)" }} />
            <p className="text-[11px] leading-relaxed">
              {t("about.vibe_coding")}
            </p>
          </div>
        </div>

        {/* Footer links */}
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={() => open("https://github.com/ialexbond/TrustTunnelClient")}
            className="flex items-center gap-1 text-[11px] transition-opacity hover:opacity-80"
            style={{ color: "var(--color-text-muted)" }}
          >
            <Github className="w-3 h-3" />
            GitHub
            <ExternalLink className="w-2.5 h-2.5 opacity-50" />
          </button>
          <span style={{ color: "var(--color-border)" }}>·</span>
          <span className="text-[11px]" style={{ color: "var(--color-text-muted)" }}>
            {t("about.copyright", { year: new Date().getFullYear() })}
          </span>
        </div>
      </div>
    </div>
  );
}

export default AboutPanel;
