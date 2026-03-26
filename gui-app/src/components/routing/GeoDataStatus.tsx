import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { Database, Download, RefreshCw, Loader2 } from "lucide-react";
import { Card, CardHeader, Badge, Button } from "../../shared/ui";
import type { GeoDataStatus as GeoDataStatusType } from "./useRoutingState";

interface GeoDataProgressPayload {
  file: string;
  downloaded_bytes: number;
  total_bytes: number;
  percent: number;
  step: string;
}

interface GeoDataStatusProps {
  status: GeoDataStatusType;
  downloading: boolean;
  onDownload: () => Promise<void>;
}

export function GeoDataStatusCard({ status, downloading, onDownload }: GeoDataStatusProps) {
  const { t } = useTranslation();
  const [progress, setProgress] = useState<GeoDataProgressPayload | null>(null);

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
      const timer = setTimeout(() => setProgress(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [downloading]);

  const badgeVariant: "success" | "warning" | "danger" = status.downloaded
    ? "success"
    : "danger";

  const badgeLabel = status.downloaded
    ? t("routing.geodataReady")
    : t("routing.geodataMissing");

  return (
    <Card padding="md">
      <CardHeader
        title={t("routing.geodataTitle")}
        description={t("routing.geodataDescription")}
        icon={<Database className="w-4 h-4" />}
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
                  ? "var(--color-success-500)"
                  : "var(--color-danger-500)",
              }}
            />
            <span className="text-[11px]" style={{ color: "var(--color-text-secondary)" }}>
              GeoIP
            </span>
            {status.geoip_categories_count > 0 && (
              <span className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>
                ({status.geoip_categories_count} {t("routing.categories")})
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <div
              className="w-2 h-2 rounded-full"
              style={{
                backgroundColor: status.geosite_exists
                  ? "var(--color-success-500)"
                  : "var(--color-danger-500)",
              }}
            />
            <span className="text-[11px]" style={{ color: "var(--color-text-secondary)" }}>
              GeoSite
            </span>
            {status.geosite_categories_count > 0 && (
              <span className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>
                ({status.geosite_categories_count} {t("routing.categories")})
              </span>
            )}
          </div>
        </div>

        {status.downloaded && (
          <div className="flex items-center gap-3">
            {status.version && (
              <span className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>
                {t("routing.geodataVersion")}: {status.version}
              </span>
            )}
            {status.downloaded_at && (
              <span className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>
                {t("routing.geodataDate")}: {new Date(Number(status.downloaded_at)).toLocaleDateString()}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Progress bar and status text during download */}
      {downloading && progress && (
        <div className="mb-3 space-y-1.5">
          {/* Progress bar */}
          {progress.total_bytes > 0 && (
            <div
              className="w-full h-1.5 rounded-full overflow-hidden"
              style={{ backgroundColor: "var(--color-bg-primary)" }}
            >
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{
                  width: `${progress.percent}%`,
                  backgroundColor: "var(--color-accent)",
                }}
              />
            </div>
          )}
          {/* Step text */}
          <p
            className="text-[11px] font-mono"
            style={{ color: "var(--color-text-secondary)" }}
          >
            {progress.step}
          </p>
        </div>
      )}

      {/* Download / Update button */}
      <Button
        variant={status.downloaded ? "secondary" : "primary"}
        size="sm"
        loading={downloading}
        icon={
          downloading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : status.downloaded ? (
            <RefreshCw className="w-3.5 h-3.5" />
          ) : (
            <Download className="w-3.5 h-3.5" />
          )
        }
        onClick={onDownload}
        disabled={downloading}
      >
        {downloading
          ? (progress?.step || t("routing.downloading"))
          : status.downloaded
            ? t("routing.updateGeodata")
            : t("routing.downloadGeodata")}
      </Button>
    </Card>
  );
}
