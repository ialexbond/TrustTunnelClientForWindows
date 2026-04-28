/* eslint-disable react-refresh/only-export-components -- module-level configTabDirtyRef is co-located with the orchestrator by design (Phase 15-07 carry-forward pattern для ServerTabs navigate-away guard). */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openExternalUrl } from "@tauri-apps/plugin-shell";
import { ExternalLink } from "lucide-react";

import { Button } from "../../shared/ui/Button";
import { Skeleton } from "../../shared/ui/Skeleton";
import { Toggle } from "../../shared/ui/Toggle";
import { useSnackBar } from "../../shared/ui/SnackBarContext";
import { useActivityLog } from "../../shared/hooks/useActivityLog";
import { cn } from "../../shared/lib/cn";

import { DirtyChangesBanner } from "./DirtyChangesBanner";
import {
  useTomlConfigState,
  type SshParams,
  type SaveBatchResult,
} from "./config/useTomlConfigState";
import { LazyAccordionSection } from "./config/LazyAccordionSection";
import { SchemaFieldRenderer } from "./config/SchemaFieldRenderer";
import { QuickSettingsCard } from "./config/QuickSettingsCard";
import { useSaveFlowDialog, type DiffRow } from "./config/SaveFlowDialog";
import { RetryBanner } from "./config/RetryBanner";
import { CredentialsPreview } from "./config/CredentialsPreview";
import { Badge } from "../../shared/ui/Badge";
import { DEFAULTS_MAPS, DISRUPT_SETS } from "./config/schema";
import type {
  TomlFieldSchema,
  ConfigBundle,
  ConfigFileName,
} from "./config/types";

/**
 * Phase 15.1 — Schema-driven Configuration tab orchestrator (REQ-15.0).
 *
 * Owns:
 *   - Top-level layout: DirtyChangesBanner + RetryBanner + QuickSettingsCard +
 *     4 LazyAccordionSection (vpn/hosts/credentials/rules) + Save footer + docs link
 *   - Save flow orchestration via useSaveFlowDialog hook + SaveFlowDialog Modal
 *     (D-4.3 visible diff таблица + D-4.4 disrupt warning) — Promise<boolean> imperative API.
 *   - Navigate-away guard registration via configTabDirtyRef module ref
 *     (D-14.1; ServerTabs reads).
 *
 * Storybook escape hatch (D-PRE-4 single Screen story):
 *   - _storybook flag bypasses real invoke + uses _mockBundle
 *   - _forceLoading shows skeleton
 *   - _forceError shows error state
 */

/** Module-level ref for ServerTabs navigate-away guard (Phase 15-07 carry-forward pattern). */
export const configTabDirtyRef: { current: boolean } = { current: false };

export interface ConfigurationTabProps {
  sshParams: SshParams;
  /** Switch active tab — used by credentials.toml "Edit in Users" button. */
  onNavigateToTab: (tabId: "users") => void;
  // Storybook escape hatches (D-PRE-4):
  _storybook?: boolean;
  _mockBundle?: ConfigBundle;
  _forceLoading?: boolean;
  _forceError?: string;
}

export function ConfigurationTab({
  sshParams,
  onNavigateToTab,
  _storybook,
  _mockBundle: _mockBundleProp,
  _forceLoading,
  _forceError,
}: ConfigurationTabProps) {
  const { t } = useTranslation();
  const { confirmSave, SaveFlowDialogElement } = useSaveFlowDialog();
  const pushSnack = useSnackBar();
  const { log: activityLog } = useActivityLog();

  const config = useTomlConfigState(sshParams, {
    defaultsMaps: DEFAULTS_MAPS,
    disruptSets: DISRUPT_SETS,
    skipAutoLoad: _storybook,
    initialBundle: _storybook ? _mockBundleProp : undefined,
  });

  // Storybook overrides
  const loading = _forceLoading ?? config.loading;
  const error = _forceError ?? config.error;
  const trees = config.trees;
  const editedParsed = config.editedParsed;

  // Sync configTabDirtyRef для ServerTabs navigate-away guard (D-14.1).
  // useEffect (not assignment-during-render) per react-hooks/immutability —
  // ServerTabs reads on next setActiveTab call, so post-commit timing is OK.
  useEffect(() => {
    configTabDirtyRef.current = config.dirtyCount > 0;
  }, [config.dirtyCount]);

  // RetryBanner state
  const [retryState, setRetryState] = useState<{
    failedFile: ConfigFileName;
    savedCount: number;
    totalCount: number;
  } | null>(null);

  // D-6.1: per-file showAll toggle state (override hidden defaults-only fields).
  // По умолчанию false → SchemaFieldRenderer фильтрует isExplicit=false nodes.
  const [showAll, setShowAll] = useState<Record<ConfigFileName, boolean>>({
    vpn: false,
    hosts: false,
    rules: false,
  });

  // Helper: count default-only (isExplicit=false) fields in tree → footer label "(+N default)".
  const countDefaultOnly = (fileName: ConfigFileName): number => {
    if (!trees) return 0;
    let n = 0;
    for (const schema of trees[fileName].flatMap.values()) {
      if (!schema.isExplicit) n++;
    }
    return n;
  };

  // ── Schema getters for SchemaFieldRenderer slots ──
  const getQuickSchema = (path: string[]): TomlFieldSchema | undefined => {
    if (!trees) return undefined;
    return trees.vpn.flatMap.get(path.join("."));
  };

  const getTableChildSchemas = (parentPath: string[]): TomlFieldSchema[] => {
    if (!trees) return [];
    // Walk all 4 trees' flatMaps; find immediate children of parentPath.
    // For top-level (parentPath=[]) returns paths без точек.
    // For nested (parentPath=["a","b"]) returns paths "a.b.x" where remainder "x" has no dot.
    const parentKey = parentPath.join(".");
    const result: TomlFieldSchema[] = [];
    for (const tree of Object.values(trees)) {
      for (const [pathKey, schema] of tree.flatMap.entries()) {
        if (parentPath.length === 0) {
          if (!pathKey.includes(".")) result.push(schema);
        } else if (pathKey.startsWith(`${parentKey}.`)) {
          const remainder = pathKey.slice(parentKey.length + 1);
          if (!remainder.includes(".")) result.push(schema);
        }
      }
    }
    return result;
  };

  const getArrayEntrySchemas = (
    parentPath: string[],
    _entryIndex: number,
  ): TomlFieldSchema[] => {
    // For Phase 15.1 minimal — entries render их fields через children walking
    // (Plan 15.1-04 schema-builder may extend per-entry sub-trees later).
    void _entryIndex;
    return getTableChildSchemas(parentPath);
  };

  const fileNameForPath = (path: string[]): ConfigFileName | "credentials" => {
    // Heuristic: top-level segment maps. Plan 15.1-04 schema-builder doesn't
    // expose file-per-path directly, so we infer from common upstream keys.
    const top = path[0];
    if (
      top === "main_hosts" ||
      top === "ping_hosts" ||
      top === "speedtest_hosts" ||
      top === "reverse_proxy_hosts"
    ) {
      return "hosts";
    }
    if (top === "rule") return "rules";
    if (top === "client") return "credentials";
    return "vpn";
  };

  const onChangeAny = (path: string[], value: unknown) => {
    const fileName = fileNameForPath(path);
    config.setFieldValue(fileName, path, value);
  };

  // ── Save flow (D-4.1 + D-4.3 + D-4.4 + D-8.1) ──
  // Build diff rows from useTomlConfigState.dirtyFields. Map<pathKey, DirtyFieldRecord>
  // → DiffRow[] consumed by SaveFlowDialog.
  const computeDiffRows = (): DiffRow[] => {
    const rows: DiffRow[] = [];
    for (const [pathKey, record] of config.dirtyFields.entries()) {
      rows.push({
        pathKey,
        fileName: record.fileName,
        before: record.before,
        after: record.after,
      });
    }
    return rows;
  };

  const handleSaveClick = async () => {
    activityLog("USER", "config.save.attempt", "ConfigurationTab");
    const diffRows = computeDiffRows();
    // D-4.3: visible diff таблица [Файл / Поле / Было / Стало] +
    // D-4.4: conditional disrupt warning footer.
    const ok = await confirmSave(diffRows, config.hasDisruptHighField);
    if (!ok) {
      activityLog("USER", "config.save.cancelled", "ConfigurationTab");
      return;
    }

    // D-8.1 stop-on-first-failure save batch
    const result: SaveBatchResult = await config.saveAll();
    if (!result.success && result.failedFile) {
      setRetryState({
        failedFile: result.failedFile,
        savedCount: result.savedFiles.length,
        totalCount: config.dirtyFiles.size,
      });
      pushSnack(
        t("server.config.partial_save_snackbar", {
          n: result.savedFiles.length,
          total: config.dirtyFiles.size,
          file: `${result.failedFile}.toml`,
        }),
        "error",
      );
      activityLog(
        "USER",
        `config.save.partial saved=${result.savedFiles.length}/${config.dirtyFiles.size} failed=${result.failedFile}`,
        "ConfigurationTab",
      );
      return;
    }
    // Full success
    setRetryState(null);
    pushSnack(t("server.config.save_success"));
    activityLog(
      "USER",
      `config.save.success files=${result.savedFiles.join(",")}`,
      "ConfigurationTab",
    );
  };

  const handleDiscard = () => {
    activityLog("USER", "config.discard", "ConfigurationTab");
    config.discardAll();
    setRetryState(null);
  };

  const handleRetry = () => {
    setRetryState(null);
    void handleSaveClick();
  };

  const handleNavigateToUsers = () => {
    activityLog("USER", "config.navigate.users", "CredentialsPreview");
    onNavigateToTab("users");
  };

  const handleDocsClick = () => {
    void openExternalUrl(
      "https://github.com/TrustTunnel/TrustTunnel/blob/master/CONFIGURATION.md",
    ).catch(() => {});
  };

  // ── Render ──
  if (loading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton variant="card" height={120} />
        <Skeleton variant="line" width="100%" height={44} />
        <Skeleton variant="line" width="100%" height={44} />
        <Skeleton variant="line" width="100%" height={44} />
        <Skeleton variant="line" width="100%" height={44} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 py-8">
        <p className="text-body text-[var(--color-text-secondary)]">
          {t("server.config.error_load")}
        </p>
        <Button
          variant="secondary"
          onClick={() => void config.reloadBundle()}
        >
          {t("errors.retry", { defaultValue: "Повторить" })}
        </Button>
      </div>
    );
  }

  const dirtyCount = config.dirtyCount;

  return (
    <div className="flex flex-col gap-4">
      {/* DirtyChangesBanner (D-1.3) */}
      <DirtyChangesBanner
        changeCount={dirtyCount}
        onApply={dirtyCount > 0 ? handleSaveClick : undefined}
        onDiscard={dirtyCount > 0 ? handleDiscard : undefined}
      />

      {/* RetryBanner (D-8.1) */}
      {retryState && (
        <RetryBanner
          failedFile={retryState.failedFile}
          savedCount={retryState.savedCount}
          totalCount={retryState.totalCount}
          onRetry={handleRetry}
          onDismiss={() => setRetryState(null)}
        />
      )}

      {/* QuickSettingsCard (D-1.1) */}
      <QuickSettingsCard
        getSchema={getQuickSchema}
        onChange={(path, value) => onChangeAny(path, value)}
      />

      {/* 4 LazyAccordionSection — collapsed by default (D-PRE-2) */}
      {/* vpn.toml */}
      <LazyAccordionSection
        title="vpn.toml"
        badge={
          dirtyCount > 0 && config.dirtyFiles.has("vpn") ? (
            <Badge variant="warning" size="sm">
              {dirtyCount}
            </Badge>
          ) : undefined
        }
      >
        {trees && (
          <div className="flex flex-col gap-3">
            {getTableChildSchemas([])
              .filter((s) =>
                trees.vpn.flatMap.get(s.path.join(".")) === s
                  ? true
                  : false,
              )
              .map((childSchema) => (
                <SchemaFieldRenderer
                  key={childSchema.path.join(".")}
                  schema={childSchema}
                  showAll={showAll.vpn}
                  getTableChildSchemas={getTableChildSchemas}
                  getArrayEntrySchemas={getArrayEntrySchemas}
                  onChange={onChangeAny}
                  onAddArrayEntry={(path) => {
                    const current =
                      (childSchema.type as { value?: unknown[] }).value ?? [];
                    onChangeAny(path, [...current, {}]);
                  }}
                  onRemoveArrayEntry={(path, idx) => {
                    const current =
                      (childSchema.type as { value?: unknown[] }).value ?? [];
                    const next = current.filter((_, i) => i !== idx);
                    onChangeAny(path, next);
                  }}
                />
              ))}
            {/* D-6.1: показать все default-only поля */}
            <div className="px-1 pt-3 pb-1 mt-2 border-t border-[var(--color-border)]">
              <Toggle
                label={t("server.config.show_all_fields", {
                  n: countDefaultOnly("vpn"),
                  defaultValue: `Показать все поля (+${countDefaultOnly("vpn")} default)`,
                })}
                checked={showAll.vpn}
                onChange={(v) => setShowAll((s) => ({ ...s, vpn: v }))}
              />
            </div>
          </div>
        )}
      </LazyAccordionSection>

      {/* hosts.toml */}
      <LazyAccordionSection
        title="hosts.toml"
        badge={
          dirtyCount > 0 && config.dirtyFiles.has("hosts") ? (
            <Badge variant="warning" size="sm">
              {dirtyCount}
            </Badge>
          ) : undefined
        }
      >
        {trees && (
          <div className="flex flex-col gap-3">
            {getTableChildSchemas([])
              .filter((s) => trees.hosts.flatMap.get(s.path.join(".")) === s)
              .map((childSchema) => (
                <SchemaFieldRenderer
                  key={childSchema.path.join(".")}
                  schema={childSchema}
                  showAll={showAll.hosts}
                  getTableChildSchemas={getTableChildSchemas}
                  getArrayEntrySchemas={getArrayEntrySchemas}
                  onChange={onChangeAny}
                  onAddArrayEntry={(path) => {
                    const current =
                      (childSchema.type as { value?: unknown[] }).value ?? [];
                    onChangeAny(path, [...current, {}]);
                  }}
                  onRemoveArrayEntry={(path, idx) => {
                    const current =
                      (childSchema.type as { value?: unknown[] }).value ?? [];
                    const next = current.filter((_, i) => i !== idx);
                    onChangeAny(path, next);
                  }}
                />
              ))}
            {/* D-6.1: показать все default-only поля */}
            <div className="px-1 pt-3 pb-1 mt-2 border-t border-[var(--color-border)]">
              <Toggle
                label={t("server.config.show_all_fields", {
                  n: countDefaultOnly("hosts"),
                  defaultValue: `Показать все поля (+${countDefaultOnly("hosts")} default)`,
                })}
                checked={showAll.hosts}
                onChange={(v) => setShowAll((s) => ({ ...s, hosts: v }))}
              />
            </div>
          </div>
        )}
      </LazyAccordionSection>

      {/* credentials.toml — read-only preview (D-2.1) */}
      <LazyAccordionSection
        title="credentials.toml"
        badge={
          <Badge variant="neutral" size="sm">
            {t("server.config.readonly_label", {
              defaultValue: "ТОЛЬКО ЧТЕНИЕ",
            })}
          </Badge>
        }
      >
        <CredentialsPreview
          parsed={editedParsed?.credentials ?? null}
          onNavigateToUsers={handleNavigateToUsers}
        />
      </LazyAccordionSection>

      {/* rules.toml */}
      <LazyAccordionSection
        title="rules.toml"
        badge={
          dirtyCount > 0 && config.dirtyFiles.has("rules") ? (
            <Badge variant="warning" size="sm">
              {dirtyCount}
            </Badge>
          ) : undefined
        }
      >
        {trees && (
          <div className="flex flex-col gap-3">
            {getTableChildSchemas([])
              .filter((s) => trees.rules.flatMap.get(s.path.join(".")) === s)
              .map((childSchema) => (
                <SchemaFieldRenderer
                  key={childSchema.path.join(".")}
                  schema={childSchema}
                  showAll={showAll.rules}
                  getTableChildSchemas={getTableChildSchemas}
                  getArrayEntrySchemas={getArrayEntrySchemas}
                  onChange={onChangeAny}
                  onAddArrayEntry={(path) => {
                    const current =
                      (childSchema.type as { value?: unknown[] }).value ?? [];
                    onChangeAny(path, [...current, { action: "allow" }]);
                  }}
                  onRemoveArrayEntry={(path, idx) => {
                    const current =
                      (childSchema.type as { value?: unknown[] }).value ?? [];
                    const next = current.filter((_, i) => i !== idx);
                    onChangeAny(path, next);
                  }}
                />
              ))}
            {/* D-6.1: показать все default-only поля */}
            <div className="px-1 pt-3 pb-1 mt-2 border-t border-[var(--color-border)]">
              <Toggle
                label={t("server.config.show_all_fields", {
                  n: countDefaultOnly("rules"),
                  defaultValue: `Показать все поля (+${countDefaultOnly("rules")} default)`,
                })}
                checked={showAll.rules}
                onChange={(v) => setShowAll((s) => ({ ...s, rules: v }))}
              />
            </div>
          </div>
        )}
      </LazyAccordionSection>

      {/* SaveFlowDialog mount point — owns Modal lifecycle T-03 (D-4.3 + D-4.4) */}
      <SaveFlowDialogElement />

      {/* Save footer */}
      <div className="flex items-center justify-end gap-2 pt-2">
        <Button
          variant="danger-outline"
          onClick={handleDiscard}
          disabled={dirtyCount === 0}
        >
          {t("server.config.discard_changes")}
        </Button>
        <Button
          variant="primary"
          onClick={handleSaveClick}
          disabled={dirtyCount === 0}
        >
          {t("server.config.save_button")}
        </Button>
      </div>

      {/* Footer docs link (D-17.1) */}
      <div className="flex justify-center pt-3">
        <button
          type="button"
          onClick={handleDocsClick}
          className={cn(
            "inline-flex items-center gap-1 text-body-sm text-[var(--color-text-muted)]",
            "hover:text-[var(--color-text-secondary)] transition-colors",
            "focus-visible:shadow-[var(--focus-ring)] outline-none rounded-sm",
          )}
        >
          {t("server.config.docs_link")}
          <ExternalLink size={12} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
