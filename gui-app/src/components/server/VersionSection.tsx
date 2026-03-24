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

  const getDisplayLabel = () => {
    if (!selectedVersion) return t("server.version.latest");
    const sv = stripV(selectedVersion);
    const isCurrent = sv === currentClean;
    const isLatest = availableVersions.length > 0 && selectedVersion === availableVersions[0];
    if (isLatest && isCurrent) return `v${sv} · ${t("server.version.current_label")}`;
    if (isLatest) return `v${sv} · ${t("server.version.latest")}`;
    if (isCurrent) return `v${sv} · ${t("server.version.current_label")}`;
    return `v${sv}`;
  };

  return (
    <Card>
      <CardHeader
        title={t("server.version.title")}
        icon={<ArrowUpCircle className="w-3.5 h-3.5" />}
      />

      <div className="flex items-center gap-3 mb-3">
        <span className="text-xs" style={{ color: "var(--color-text-secondary)" }}>
          {t("server.version.current")}:{" "}
          <strong style={{ color: "var(--color-text-primary)" }}>v{currentClean || "?"}</strong>
        </span>
      </div>

      {/* Custom dropdown + install button */}
      {availableVersions.length > 0 && (
        <div className="flex gap-2 items-center">
          <div className="relative" ref={dropdownRef} style={{ minWidth: "180px" }}>
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
                className="absolute z-50 mt-1 w-full max-h-52 overflow-y-auto rounded-[var(--radius-lg)] py-1 shadow-xl"
                style={{
                  backgroundColor: "var(--color-bg-secondary)",
                  border: "1px solid var(--color-border)",
                }}
              >
                {availableVersions.map((v, i) => {
                  const vClean = stripV(v);
                  const isSelected = v === selectedVersion;
                  const isCurrent = vClean === currentClean;
                  return (
                    <button
                      key={v}
                      onClick={() => { setSelectedVersion(v); setDropdownOpen(false); }}
                      className="w-full flex items-center justify-between px-3 py-1.5 text-xs transition-colors"
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
                        {i === 0 ? `${t("server.version.latest")} · v${vClean}` : `v${vClean}`}
                        {isCurrent ? ` · ${t("server.version.current_label")}` : ""}
                      </span>
                      {isSelected && <Check className="w-3 h-3 shrink-0" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {canInstall && (
            <Button
              variant="secondary"
              size="sm"
              icon={<Download className="w-3.5 h-3.5" />}
              loading={actionLoading === "Установка версии"}
              onClick={() =>
                runAction("Установка версии", () =>
                  invoke("server_upgrade", { ...sshParams, version: selectedVersion })
                )
              }
              className="shrink-0"
              style={{ height: "34px", whiteSpace: "nowrap" }}
            >
              {t("server.version.install_version")}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}
