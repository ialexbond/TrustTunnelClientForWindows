import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { ArrowUpCircle, Download } from "lucide-react";
import { Card, CardHeader } from "../../shared/ui/Card";
import { Button } from "../../shared/ui/Button";
import { Badge } from "../../shared/ui/Badge";
import { Select } from "../../shared/ui/Select";
import { useConfirm } from "../../shared/ui/useConfirm";
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

  const confirm = useConfirm();
  const [upgradeLoading, setUpgradeLoading] = useState(false);

  if (!serverInfo) return null;

  // Filter out versions older than MIN_VERSION — they're unstable.
  const filteredVersions = availableVersions.filter(v => semverGte(stripV(v), MIN_VERSION));

  const currentClean = stripV(serverInfo.version || "");
  const selectedClean = stripV(selectedVersion || "");
  // E-7: Install must only be offered for a REAL version present in the picker
  // and different from the installed one. A literal "unknown"/empty selection
  // must never reach the install command (`server_upgrade`). Guard on the
  // resolved tag being one of the filtered options.
  const isRealSelection =
    !!selectedClean &&
    selectedClean !== "unknown" &&
    filteredVersions.some((v) => stripV(v) === selectedClean);
  const canInstall = isRealSelection && selectedClean !== currentClean;
  const isDowngrade = canInstall && !semverGte(selectedClean, currentClean);
  const latestClean = filteredVersions.length > 0 ? stripV(filteredVersions[0]) : "";
  const hasUpdate = latestClean && latestClean !== currentClean;

  const handleUpgrade = async () => {
    const ok = await confirm({
      title: t("server.version.confirm_title"),
      message: t(
        isDowngrade
          ? "server.version.confirm_message_downgrade"
          : "server.version.confirm_message",
        { version: `v${selectedClean}` },
      ),
      variant: isDowngrade ? "danger" : "warning",
      // §K CTA-03: action-verb confirm label instead of the generic
      // «Подтвердить» — «Установить» (or «Установить старую версию» on a
      // downgrade) so the confirm button states the action it performs.
      confirmText: t(
        isDowngrade
          ? "server.version.confirm_install_downgrade"
          : "server.version.confirm_install",
      ),
      cancelText: t("buttons.cancel"),
    });
    if (!ok) return;
    setUpgradeLoading(true);
    try {
      await invoke("server_upgrade", {
        ...state.sshParams,
        version: selectedVersion,
      });
      state.pushSuccess(
        t("server.version.upgrade_success", { version: `v${selectedClean}` }),
      );
      await state.loadServerInfo(true);
    } catch (e) {
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

      {/* A-1/CC-6: version picker is the shared Select (full keyboard nav +
       * combobox/listbox ARIA + tokens) — replaces the prior hand-rolled
       * dropdown (fake hover, no keyboard nav, no combobox role). The Select's
       * check marks the SELECTED option; the installed version is shown by the
       * separate "current version" badge above. Options carry the raw tag as
       * value so setSelectedVersion keeps the `v…` form the install flow uses. */}
      {filteredVersions.length > 0 && (
        <div className="flex gap-2 items-center">
          <div style={{ width: "240px" }}>
            <Select
              value={selectedVersion || ""}
              onChange={(e) => setSelectedVersion(e.target.value)}
              placeholder={t("server.version.latest")}
              options={filteredVersions.map((v) => ({
                value: v,
                label: `v${stripV(v)}`,
              }))}
            />
          </div>

          {canInstall && (
            <Button
              variant="primary"
              size="sm"
              icon={<Download className="w-3.5 h-3.5" />}
              loading={upgradeLoading}
              disabled={upgradeLoading}
              onClick={handleUpgrade}
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
