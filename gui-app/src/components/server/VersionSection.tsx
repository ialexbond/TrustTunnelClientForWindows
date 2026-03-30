import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  ArrowUpCircle,
  Download,
  ChevronDown,
  Check,
} from "lucide-react";
import { Card, CardHeader } from "../../shared/ui/Card";
import { Button } from "../../shared/ui/Button";
import { Badge } from "../../shared/ui/Badge";
import { useDropdownPortal } from "../../shared/hooks/useDropdownPortal";
import { colors } from "../../shared/ui/colors";
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
  } = state;

  const dropdown = useDropdownPortal();

  if (!serverInfo) return null;

  const currentClean = stripV(serverInfo.version || "");
  const selectedClean = stripV(selectedVersion || "");
  const canInstall = selectedClean && selectedClean !== currentClean;
  const latestClean = availableVersions.length > 0 ? stripV(availableVersions[0]) : "";
  const hasUpdate = latestClean && latestClean !== currentClean;

  const getDisplayLabel = () => {
    if (!selectedVersion) return t("server.version.latest");
    return `v${stripV(selectedVersion)}`;
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
        {hasUpdate && (
          <Badge variant="success" size="md">{t("server.version.update_badge")}</Badge>
        )}
      </div>

      {/* Custom dropdown + install button */}
      {availableVersions.length > 0 && (
        <div className="flex gap-2 items-center">
          <div className="relative" ref={dropdown.containerRef} style={{ width: "240px" }}>
            {/* Trigger button */}
            <button
              ref={dropdown.triggerRef}
              onClick={dropdown.toggle}
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
                  transform: dropdown.open ? "rotate(180deg)" : "rotate(0deg)",
                }}
              />
            </button>

            {/* Dropdown menu — portal so it renders under sidebar */}
            {dropdown.open && createPortal(
              <div
                ref={dropdown.portalRef}
                style={{
                  ...dropdown.style,
                  backgroundColor: "var(--color-bg-elevated)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "var(--radius-lg)",
                  boxShadow: colors.dropdownShadow,
                  overflow: "hidden",
                }}
              >
                <div className="max-h-52 overflow-y-auto" style={{ padding: "4px" }}>
                  {availableVersions.map((v) => {
                    const vClean = stripV(v);
                    const isSelected = v === selectedVersion;
                    const isCurrent = vClean === currentClean;
                    return (
                      <button
                        key={v}
                        onClick={() => { setSelectedVersion(v); dropdown.close(); }}
                        className="w-full flex items-center justify-between px-2.5 py-1.5 text-xs transition-colors rounded-[var(--radius-md)]"
                        style={{
                          backgroundColor: isSelected ? colors.accentBg : "transparent",
                          color: isSelected ? "var(--color-accent-500)" : "var(--color-text-primary)",
                        }}
                        onMouseEnter={(e) => {
                          if (!isSelected) (e.currentTarget as HTMLButtonElement).style.backgroundColor = "var(--color-bg-hover)";
                        }}
                        onMouseLeave={(e) => {
                          if (!isSelected) (e.currentTarget as HTMLButtonElement).style.backgroundColor = "transparent";
                        }}
                      >
                        <span>v{vClean}</span>
                        {isCurrent && <Check className="w-3 h-3 shrink-0" style={{ color: "var(--color-success-500)" }} />}
                      </button>
                    );
                  })}
                </div>
              </div>,
              document.body
            )}
          </div>

          {canInstall && (
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
          )}
        </div>
      )}
    </Card>
  );
}
