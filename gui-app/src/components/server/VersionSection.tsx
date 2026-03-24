import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowUpCircle,
  Download,
  ChevronDown,
  Check,
} from "lucide-react";
import { Card, CardHeader } from "../../shared/ui/Card";
import { Button } from "../../shared/ui/Button";
import { Badge } from "../../shared/ui/Badge";
import { Tooltip } from "../../shared/ui/Tooltip";
import type { ServerState } from "./useServerState";

interface Props {
  state: ServerState;
}

function stripV(v: string): string {
  return v.replace(/^v/, "");
}

export function VersionSection({ state }: Props) {
  const { t } = useTranslation();
  const {
    serverInfo,
    availableVersions,
    selectedVersion,
    setSelectedVersion,
    actionLoading,
    sshParams,
    runAction,
  } = state;

  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dropdownOpen]);

  if (!serverInfo) return null;

  const currentClean = stripV(serverInfo.version || "");
  const selectedClean = stripV(selectedVersion || "");
  const canInstall = selectedClean && selectedClean !== currentClean;

  const latestClean = availableVersions.length > 0 ? stripV(availableVersions[0]) : "";
  const latestIsCurrent = latestClean === currentClean;

  const getDisplayLabel = () => {
    if (!selectedVersion) return t("server.version.latest");
    const sv = stripV(selectedVersion);
    const isCurrent = sv === currentClean;
    const isLatest = availableVersions.length > 0 && selectedVersion === availableVersions[0];
    // Trigger button text
    if (isLatest && isCurrent) return `${t("server.version.latest_full")} ${t("server.version.current_label")}`;
    if (isCurrent) return `v${sv} ${t("server.version.current_label")}`;
    if (isLatest) return t("server.version.latest_full");
    return `v${sv}`;
  };

  return (
    <Card>
      <CardHeader
        title={t("server.version.title")}
        icon={<ArrowUpCircle className="w-3.5 h-3.5" />}
      />

      <div className="flex items-center gap-2 mb-3">
        <span className="text-xs" style={{ color: "var(--color-text-secondary)" }}>
          {t("server.version.current")}:
        </span>
        <Badge variant="accent" size="md">v{currentClean || "?"}</Badge>
      </div>

      {/* Custom dropdown + install button */}
      {availableVersions.length > 0 && (
        <div className="flex gap-2 items-center">
          <div className="relative" ref={dropdownRef} style={{ width: "240px" }}>
            {/* Trigger button */}
            <button
              onClick={() => setDropdownOpen(!dropdownOpen)}
              className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-[var(--radius-md)] text-xs cursor-pointer transition-all outline-none"
              style={{
                backgroundColor: "var(--color-bg-elevated)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text-primary)",
                height: "34px",
              }}
            >
              <span className="truncate">{getDisplayLabel()}</span>
              <ChevronDown
                className="w-3.5 h-3.5 shrink-0 transition-transform duration-200"
                style={{
                  color: "var(--color-text-muted)",
                  transform: dropdownOpen ? "rotate(180deg)" : "rotate(0deg)",
                }}
              />
            </button>

            {/* Dropdown menu */}
            {dropdownOpen && (
              <div
                className="absolute z-50 mt-1 w-full max-h-52 overflow-hidden rounded-[var(--radius-lg)] shadow-xl"
                style={{
                  backgroundColor: "var(--color-bg-elevated)",
                  border: "1px solid var(--color-border)",
                  boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
                }}
              >
                <div className="max-h-52 overflow-y-auto" style={{ padding: "4px 4px 4px 4px" }}>
                  {availableVersions.map((v, i) => {
                    const vClean = stripV(v);
                    const isSelected = v === selectedVersion;
                    const isCurrent = vClean === currentClean;
                    return (
                      <button
                        key={v}
                        onClick={() => { setSelectedVersion(v); setDropdownOpen(false); }}
                        className="w-full flex items-center justify-between px-2.5 py-1.5 text-xs transition-colors rounded-[var(--radius-md)]"
                        style={{
                          backgroundColor: isSelected ? "rgba(99, 102, 241, 0.1)" : "transparent",
                          color: isSelected ? "var(--color-accent-500)" : "var(--color-text-primary)",
                        }}
                        onMouseEnter={(e) => {
                          if (!isSelected) (e.currentTarget as HTMLButtonElement).style.backgroundColor = "var(--color-bg-hover)";
                        }}
                        onMouseLeave={(e) => {
                          if (!isSelected) (e.currentTarget as HTMLButtonElement).style.backgroundColor = "transparent";
                        }}
                      >
                        <span>
                          {i === 0
                            ? (isCurrent
                                ? `${t("server.version.latest_full")} ${t("server.version.current_label")}`
                                : t("server.version.latest_full"))
                            : (isCurrent ? `v${vClean} ${t("server.version.current_label")}` : `v${vClean}`)
                          }
                        </span>
                        {isSelected && <Check className="w-3 h-3 shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {canInstall && (
            <Tooltip text={t("server.version.install_wip")}>
              <div>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Download className="w-3.5 h-3.5" />}
                  disabled
                  className="shrink-0"
                  style={{ height: "34px", whiteSpace: "nowrap" }}
                >
              {t("server.version.install_version")}
            </Button>
              </div>
            </Tooltip>
          )}
        </div>
      )}
    </Card>
  );
}
