import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Globe, Download, RefreshCw, Check } from "lucide-react";
import { Card, CardHeader, Badge, Button, ProgressBar } from "../../shared/ui";
import { Toggle } from "../../shared/ui/Toggle";
import type { GeoDataStatus as GeoDataStatusType } from "./useRoutingState";

interface GeoDataProgressPayload {
  file: string;
  downloaded_bytes: number;
  total_bytes: number;
  percent: number;
  step: string;
}

interface GeoUpdateCheck {
  update_available: boolean;
  current_tag: string | null;
  latest_tag: string | null;
}

interface GeoDataStatusProps {
  status: GeoDataStatusType;
  downloading: boolean;
  onDownload: () => Promise<void>;
}

export function GeoDataStatusCard({ status, downloading, onDownload }: GeoDataStatusProps) {
  const { t } = useTranslation();
  const [progress, setProgress] = useState<GeoDataProgressPayload | null>(null);
  const [updateCheck, setUpdateCheck] = useState<GeoUpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);
  // Background auto-update on/off (canon parity, audit P-1). Gates the 30-min auto-check below; the
  // manual "Проверить обновления" button always works regardless. Session-local (matches the design
  // canon, which keeps it as local state) — persistence can follow later.
  const [autoUpdate, setAutoUpdate] = useState(true);

  // Listen for progress events
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<GeoDataProgressPayload>("geodata-progress", (event) => {
      setProgress(event.payload);
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  // Clear progress when download finishes
  useEffect(() => {
    if (!downloading) {
      const timer = setTimeout(() => setProgress(null), 2000);
      return () => clearTimeout(timer);
    }
  }, [downloading]);

  const checkUpdates = useCallback(async () => {
    setChecking(true);
    try {
      const result = await invoke<GeoUpdateCheck>("check_geodata_updates");
      setUpdateCheck(result);
    } catch (e) {
      console.error("Update check failed:", e);
    } finally {
      setChecking(false);
    }
  }, []);

  // After download completes, reset update check and re-check
  const [wasDownloading, setWasDownloading] = useState(false);
  useEffect(() => {
    if (downloading) {
      setWasDownloading(true);
    } else if (wasDownloading) {
      setWasDownloading(false);
      setUpdateCheck(null);
      // Re-check for updates after download completes
      checkUpdates();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [downloading]);

  // Check for updates on mount if already downloaded
  useEffect(() => {
    if (status.downloaded && !updateCheck && !checking) {
      checkUpdates();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.downloaded]);

  // Auto-check for updates every 30 minutes — ONLY while auto-update is on (P-1 toggle).
  useEffect(() => {
    if (!status.downloaded || !autoUpdate) return;
    const interval = setInterval(() => {
      checkUpdates();
    }, 30 * 60 * 1000);
    return () => clearInterval(interval);
  }, [status.downloaded, checkUpdates, autoUpdate]);

  // Translate progress step strings from Rust to i18n
  const translateStep = (step: string): string => {
    if (step === "Connecting...") return t("routing.geodata.connecting");
    if (step === "Done!") return t("routing.geodata.done");
    if (step === "Parsing categories...") return t("routing.geodata.parsing");
    if (step.includes("downloaded")) return t("routing.geodata.downloaded", { file: step.split(" ")[0] });
    if (step.includes("Retry")) return t("routing.geodata.retry");
    if (step.includes("MB")) return step;
    return step;
  };

  // Format release tag for display: "202603260521" → "26.03.2026"
  const formatTag = (tag: string): string => {
    if (tag.length === 12) {
      const y = tag.slice(0, 4);
      const m = tag.slice(4, 6);
      const d = tag.slice(6, 8);
      return `${d}.${m}.${y}`;
    }
    return tag;
  };

  // Determine button state
  const hasUpdate = status.downloaded && updateCheck?.update_available;

  // Badge
  const badgeVariant: "success" | "warning" | "danger" =
    hasUpdate ? "warning" : status.downloaded ? "success" : "danger";
  const badgeLabel = hasUpdate
    ? t("routing.geodataUpdateAvailable", "Доступно обновление")
    : status.downloaded
      ? t("routing.geodataReady")
      : t("routing.geodataMissing");

  return (
    <Card padding="md">
      <CardHeader
        title={t("routing.geodataTitle")}
        description={t("routing.geodataDescription")}
        icon={<Globe className="w-4 h-4" />}
        action={
          <Badge variant={badgeVariant} size="sm">
            {badgeLabel}
          </Badge>
        }
      />

      {/* Status details */}
      <div className="space-y-2 mb-3">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <div
              className="w-2 h-2 rounded-full"
              style={{
                backgroundColor: status.geoip_exists
                  ? "var(--color-success-fg)"
                  : "var(--color-danger-fg)",
              }}
            />
            <span className="text-xs" style={{ color: "var(--color-text-secondary)" }}>
              GeoIP
            </span>
            {status.geoip_categories_count > 0 && (
              <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                ({status.geoip_categories_count})
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <div
              className="w-2 h-2 rounded-full"
              style={{
                backgroundColor: status.geosite_exists
                  ? "var(--color-success-fg)"
                  : "var(--color-danger-fg)",
              }}
            />
            <span className="text-xs" style={{ color: "var(--color-text-secondary)" }}>
              GeoSite
            </span>
            {status.geosite_categories_count > 0 && (
              <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                ({status.geosite_categories_count})
              </span>
            )}
          </div>

          {/* Current version tag */}
          {status.release_tag && (
            <span className="text-xs ml-auto" style={{ color: "var(--color-text-muted)" }}>
              v{formatTag(status.release_tag)}
            </span>
          )}
        </div>
      </div>

      {/* Progress during download */}
      {downloading && progress && (
        <div className="mb-3">
          {/* R21-03 (DEBT-RAWPRIM): the hand-rolled track+fill <div> pair (inline
              width math on a bare div) is replaced by the shared ProgressBar so the
              download progress gets role=progressbar + aria-value* for free and the
              track/fill styling flows from the design system (D-01: visual/structural
              port, zero behavior change — same downloading && progress gate, same
              percent value, same translated step caption below). */}
          <ProgressBar
            value={progress.percent}
            max={100}
            size="sm"
            color="accent"
            label={translateStep(progress.step)}
          />
          <p className="text-xs mt-1" style={{ color: "var(--color-text-muted)" }}>
            {translateStep(progress.step)}
          </p>
        </div>
      )}

      {/* Auto-update toggle (canon parity, audit P-1) — only meaningful once geodata exists. Turning it
          off stops the 30-min background auto-check above; the manual button below still works. */}
      {status.downloaded && (
        <div className="mb-3 pb-3 border-b" style={{ borderColor: "var(--color-border)" }}>
          <Toggle
            checked={autoUpdate}
            onChange={setAutoUpdate}
            label={t("routing.geodataAutoUpdate")}
            description={autoUpdate ? t("routing.geodataAutoUpdateOn") : t("routing.geodataAutoUpdateOff")}
          />
        </div>
      )}

      {/* Action button */}
      {(() => {
        // Downloading in progress
        if (downloading) {
          return (
            <Button variant="primary" size="sm" fullWidth loading disabled>
              {t("routing.downloading", "Загрузка...")}
            </Button>
          );
        }

        // Not downloaded — show download button
        if (!status.downloaded) {
          return (
            <Button
              variant="primary"
              size="sm"
              fullWidth
              icon={<Download className="w-3.5 h-3.5" />}
              onClick={onDownload}
            >
              {t("routing.downloadGeodata")}
            </Button>
          );
        }

        // Downloaded + update available
        if (updateCheck?.update_available && updateCheck.latest_tag) {
          return (
            <Button
              variant="primary"
              size="sm"
              fullWidth
              icon={<Download className="w-3.5 h-3.5" />}
              onClick={onDownload}
            >
              {`${t("routing.updateGeodata")} → v${formatTag(updateCheck.latest_tag)}`}
            </Button>
          );
        }

        // Downloaded + confirmed up to date
        if (updateCheck && !updateCheck.update_available) {
          return (
            <Button variant="secondary" size="sm" fullWidth disabled icon={<Check className="w-3.5 h-3.5" />}>
              {t("routing.geodataUpToDate", "Актуальная версия")}
            </Button>
          );
        }

        // Downloaded + checking or not yet checked — show check button
        return (
          <Button
            variant="secondary"
            size="sm"
            fullWidth
            loading={checking}
            icon={<RefreshCw className="w-3.5 h-3.5" />}
            onClick={checkUpdates}
            disabled={checking}
          >
            {checking
              ? t("routing.checkingUpdates", "Проверка...")
              : t("routing.checkUpdates", "Проверить обновления")}
          </Button>
        );
      })()}
    </Card>
  );
}
