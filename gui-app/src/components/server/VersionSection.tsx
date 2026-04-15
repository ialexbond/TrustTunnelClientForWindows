import { useState } from "react";
import { createPortal } from "react-dom";
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
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { useDropdownPortal } from "../../shared/hooks/useDropdownPortal";
import { formatError } from "../../shared/utils/formatError";
import type { ServerState } from "./useServerState";

interface Props {
  state: ServerState;
}

function stripV(v: string): string {
  return v.replace(/^v/, "");
}

const MIN_VERSION = "1.0.17";

/** True if version a >= b (semver comparison). */
function semverGte(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) return true;
    if (na < nb) return false;
  }
  return true; // equal
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
  const [upgradeLoading, setUpgradeLoading] = useState(false);
  const [confirmUpgrade, setConfirmUpgrade] = useState(false);

  if (!serverInfo) return null;

  // Filter out versions older than MIN_VERSION — they're unstable.
  const filteredVersions = availableVersions.filter(v => semverGte(stripV(v), MIN_VERSION));

  const currentClean = stripV(serverInfo.version || "");
  const selectedClean = stripV(selectedVersion || "");
  const canInstall = selectedClean && selectedClean !== currentClean;
  const isDowngrade = canInstall && !semverGte(selectedClean, currentClean);
  const latestClean = filteredVersions.length > 0 ? stripV(filteredVersions[0]) : "";
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
        <Badge variant="neutral" size="md">v{currentClean || "?"}</Badge>
        {hasUpdate && (
          <Badge variant="success" size="md">{t("server.version.update_badge")}</Badge>
        )}
      </div>

      {/* Custom dropdown + install button */}
      {filteredVersions.length > 0 && (
        <div className="flex gap-2 items-center">
          <div className="relative" ref={dropdown.containerRef} style={{ width: "240px" }}>
            {/* Trigger button */}
            <button
              ref={dropdown.triggerRef}
              onClick={dropdown.toggle}
              className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-[var(--radius-md)] text-xs cursor-pointer transition-all outline-none focus-visible:shadow-[var(--focus-ring)]"
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
                  boxShadow: "var(--shadow-lg)",
                  overflow: "hidden",
                }}
              >
                <div className="max-h-52 overflow-y-auto" style={{ padding: "4px" }}>
                  {filteredVersions.map((v) => {
                    const vClean = stripV(v);
                    const isSelected = v === selectedVersion;
                    const isCurrent = vClean === currentClean;
                    return (
                      <button
                        key={v}
                        onClick={() => { setSelectedVersion(v); dropdown.close(); }}
                        className="w-full flex items-center justify-between px-2.5 py-1.5 text-xs transition-colors rounded-[var(--radius-md)]"
                        style={{
                          backgroundColor: isSelected ? "var(--color-accent-tint-10)" : "transparent",
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
              variant="primary"
              size="sm"
              icon={<Download className="w-3.5 h-3.5" />}
              loading={upgradeLoading}
              disabled={upgradeLoading}
              onClick={() => setConfirmUpgrade(true)}
              className="shrink-0"
              style={{ height: "34px", whiteSpace: "nowrap" }}
            >
              {t("server.version.install_version")}
            </Button>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmUpgrade}
        title={t("server.version.confirm_title")}
        message={t(isDowngrade ? "server.version.confirm_message_downgrade" : "server.version.confirm_message", { version: `v${selectedClean}` })}
        confirmLabel={t("buttons.confirm")}
        cancelLabel={t("buttons.cancel")}
        variant={isDowngrade ? "danger" : "warning"}
        loading={upgradeLoading}
        onCancel={() => { if (!upgradeLoading) setConfirmUpgrade(false); }}
        onConfirm={async () => {
          setUpgradeLoading(true);
          try {
            await invoke("server_upgrade", { ...state.sshParams, version: selectedVersion });
            setConfirmUpgrade(false);
            state.pushSuccess(t("server.version.upgrade_success", { version: `v${selectedClean}` }));
            // Reload server info to reflect new version
            await state.loadServerInfo(true);
          } catch (e) {
            setConfirmUpgrade(false);
            const raw = formatError(e);
            let msg: string;
            if (raw.includes("UPGRADE_FAILED|")) {
              const parts = raw.split("|");
              const hint = parts.slice(2).join("|") || "";
              msg = t("server.version.upgrade_error", { hint });
            } else {
              msg = raw;
            }
            state.pushSuccess(msg, "error");
          } finally {
            setUpgradeLoading(false);
          }
        }}
      />
    </Card>
  );
}
