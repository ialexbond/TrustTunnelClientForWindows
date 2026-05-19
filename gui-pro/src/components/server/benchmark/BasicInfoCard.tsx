/**
 * BasicInfoCard — renders Section 1 (Basic Information) from Check.Place output.
 *
 * Shows labeled 2-column table (left=label, right=value mono).
 * Geo-discrepant warning chip shown prominently when actualRegion != registeredRegion.
 * Map URL clickable via Tauri plugin-shell open.
 */
import { useTranslation } from "react-i18next";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { MapPin, AlertTriangle } from "lucide-react";
import type { BasicInfo } from "./parser";

interface BasicInfoCardProps {
  data: BasicInfo;
}

function LabelRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[2fr_3fr] gap-2 items-start min-h-[22px] w-full">
      <span
        className="text-caption"
        style={{
          color: "var(--color-text-muted)",
          overflowWrap: "anywhere",
          wordBreak: "break-word",
        }}
      >
        {label}
      </span>
      <span className="text-mono-sm break-all" style={{ color: "var(--color-text-primary)" }}>
        {value}
      </span>
    </div>
  );
}

export function BasicInfoCard({ data }: BasicInfoCardProps) {
  const { t } = useTranslation();

  const handleMapOpen = async () => {
    if (data.mapUrl) {
      try {
        await shellOpen(data.mapUrl);
      } catch {
        // silent — map link is optional
      }
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {/* Geo-discrepant warning — rendered prominently if true */}
      {data.geoDiscrepant && (
        <div
          className="flex items-center gap-2 rounded-[var(--radius-sm)] px-3 py-2 text-body-sm font-medium"
          style={{
            background: "var(--color-status-warning-bg)",
            color: "var(--color-text-primary)",
            border: "1px solid var(--color-warning-500)",
          }}
        >
          <AlertTriangle
            className="w-4 h-4 shrink-0"
            style={{ color: "var(--color-warning-500)" }}
          />
          {t("server.utilities.benchmark.sections.basic.geo_discrepant_warning")}
        </div>
      )}

      {/* Fields table */}
      <div className="flex flex-col gap-1.5">
        {data.ip && (
          <LabelRow label="IP" value={data.ip} />
        )}
        {data.asn && (
          <LabelRow
            label={t("server.utilities.benchmark.sections.basic.asn")}
            value={data.asn}
          />
        )}
        {data.organization && (
          <LabelRow
            label={t("server.utilities.benchmark.sections.basic.organization")}
            value={data.organization}
          />
        )}
        {data.actualRegion && (
          <LabelRow
            label={t("server.utilities.benchmark.sections.basic.actual_region")}
            value={
              <span className="flex items-center gap-1.5">
                <span>[{data.actualRegion.countryCode}]</span>
                <span>{data.actualRegion.countryName}</span>
                {data.actualRegion.continentCode && (
                  <span style={{ color: "var(--color-text-muted)" }}>
                    · [{data.actualRegion.continentCode}] {data.actualRegion.continentName}
                  </span>
                )}
              </span>
            }
          />
        )}
        {data.registeredRegion && (
          <LabelRow
            label={t("server.utilities.benchmark.sections.basic.registered_region")}
            value={
              <span>
                [{data.registeredRegion.countryCode}] {data.registeredRegion.countryName}
              </span>
            }
          />
        )}
        {data.city && (
          <LabelRow
            label={t("server.utilities.benchmark.sections.basic.city")}
            value={data.city}
          />
        )}
        {data.timeZone && (
          <LabelRow
            label={t("server.utilities.benchmark.sections.basic.timezone")}
            value={data.timeZone}
          />
        )}
        {data.ptr && (
          <LabelRow label="PTR" value={data.ptr} />
        )}
        {data.mapUrl && (
          <LabelRow
            label={t("server.utilities.benchmark.sections.basic.map_link")}
            value={
              <button
                type="button"
                className="flex items-center gap-1 text-mono-sm underline underline-offset-2"
                style={{ color: "var(--color-accent-interactive)", background: "none", border: "none", cursor: "pointer", padding: 0 }}
                onClick={() => void handleMapOpen()}
              >
                <MapPin className="w-3 h-3" />
                {t("server.utilities.benchmark.sections.basic.map_link")}
              </button>
            }
          />
        )}
      </div>
    </div>
  );
}
