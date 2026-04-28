import { useState, useEffect, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { parse } from "smol-toml";
import { formatError } from "../../../shared/utils/formatError";
import {
  buildSchemaFromBundle,
  applyEditToParsed,
  computeRawContent,
  type FileSchemaTree,
  type DefaultsMap,
  type DisruptSet,
} from "./schema-builder";
import {
  splitRulesByOwnership,
  mergeRulesEntries,
  type RuleEntry,
} from "./rules-merge";
import type {
  ConfigBundle,
  ConfigFileName,
  DirtyFieldRecord,
} from "./types";

/**
 * Phase 15.1 — Main hook for schema-driven Configuration tab.
 *
 * Owns:
 *   - 4 file schema trees (vpn / hosts / rules / credentials)
 *   - Dirty Map<pathKey, DirtyFieldRecord>
 *   - Loading / error state
 *   - Save batch orchestration (sequential + stop-on-first-failure)
 *
 * Invariants:
 *   - Single SSH channel (Pitfall 4) — only `server_get_config_bundle` invoke for load
 *   - WR-03 cancelled pattern — guards stale data overwrite
 *   - D-2.3 rules.toml frontend pre-merge — fresh read + ownership split + merge
 *   - D-29 — bundle.credentialsToml stays in-memory only, NEVER serialized в activity.log
 *   - D-4.1 batch save sequential per file (no parallel)
 *   - D-8.1 stop-on-first-failure (file N fails → files 1..N-1 stay saved + restart NOT fired)
 */

export interface SshParams {
  host: string;
  port: string | number;
  user: string;
  password: string;
  keyPath?: string;
  keyData?: string;
}

export interface UseTomlConfigStateOptions {
  /** Skip auto-load на mount (used for storybook). */
  skipAutoLoad?: boolean;
  /** Override defaults map (Plan 15.1-05 production map; tests can inject). */
  defaultsMaps: Record<ConfigFileName | "credentials", DefaultsMap>;
  /** Override disrupt sets (Plan 15.1-05 production set). */
  disruptSets: Record<ConfigFileName | "credentials", DisruptSet>;
}

export interface SaveBatchResult {
  success: boolean;
  savedFiles: ConfigFileName[];
  failedFile?: ConfigFileName;
  error?: string;
}

export interface TomlConfigState {
  /** Bundle from last load. null if never loaded or load failed. */
  bundle: ConfigBundle | null;
  /** Schema trees per file — derived from bundle + defaults map + disrupt set. */
  trees: Record<ConfigFileName | "credentials", FileSchemaTree> | null;
  /** Edited parsed objects per file (Map keyed by ConfigFileName + "credentials"). */
  editedParsed: Record<ConfigFileName | "credentials", Record<string, unknown>> | null;
  loading: boolean;
  error: string | null;
  /** Dirty fields by path joined with dots. */
  dirtyFields: Map<string, DirtyFieldRecord>;
  /** Total dirty count. */
  dirtyCount: number;
  /** True if any dirty field has isDisruptHigh=true (D-4.4 conditional disrupt warning). */
  hasDisruptHighField: boolean;
  /** Set of dirty file names (which files need to be saved). */
  dirtyFiles: Set<ConfigFileName>;
  /** Manually trigger reload — used by retry flow + cross-tab event handler. */
  reloadBundle: () => Promise<void>;
  /** Update a field value (called by SchemaFieldRenderer dispatch). */
  setFieldValue: (
    fileName: ConfigFileName | "credentials",
    path: string[],
    value: unknown,
  ) => void;
  /** Discard all dirty fields, restore from original bundle. */
  discardAll: () => void;
  /** Save batch — sequential per file with stop-on-first-failure (D-8.1). */
  saveAll: () => Promise<SaveBatchResult>;
}

export function useTomlConfigState(
  sshParams: SshParams,
  options: UseTomlConfigStateOptions,
): TomlConfigState {
  const [bundle, setBundle] = useState<ConfigBundle | null>(null);
  const [trees, setTrees] = useState<Record<
    ConfigFileName | "credentials",
    FileSchemaTree
  > | null>(null);
  const [editedParsed, setEditedParsed] = useState<Record<
    ConfigFileName | "credentials",
    Record<string, unknown>
  > | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [dirtyFields, setDirtyFields] = useState<Map<string, DirtyFieldRecord>>(
    new Map(),
  );

  // Derived: dirty count + hasDisruptHigh + dirtyFiles
  const dirtyCount = dirtyFields.size;
  const dirtyFiles = useMemo<Set<ConfigFileName>>(() => {
    const set = new Set<ConfigFileName>();
    for (const record of dirtyFields.values()) {
      if (
        record.fileName === "vpn" ||
        record.fileName === "hosts" ||
        record.fileName === "rules"
      ) {
        set.add(record.fileName);
      }
      // credentials read-only — never appears in dirty (D-2.1 enforcement at type level)
    }
    return set;
  }, [dirtyFields]);
  const hasDisruptHighField = useMemo<boolean>(() => {
    if (!trees) return false;
    for (const [pathKey, record] of dirtyFields.entries()) {
      const fileName = record.fileName;
      const tree = trees[fileName];
      if (!tree) continue;
      const schema = tree.flatMap.get(pathKey);
      if (schema?.isDisruptHigh) return true;
    }
    return false;
  }, [dirtyFields, trees]);

  // ── LOAD ──
  const loadBundle = useCallback(
    async (cancelled: { current: boolean }): Promise<void> => {
      try {
        setLoading(true);
        setError(null);
        // SINGLE SSH CHANNEL — Pitfall 4 invariant (ONE invoke for all 4 files)
        const fetched = await invoke<ConfigBundle>("server_get_config_bundle", {
          ...sshParams,
        });
        if (cancelled.current) return;
        setBundle(fetched);
        // Build schema trees per file
        const builtTrees = buildSchemaFromBundle(
          fetched,
          options.defaultsMaps,
          options.disruptSets,
        );
        setTrees(builtTrees);
        // Initialize editedParsed from raw TOML strings
        const initialEdited: Record<
          ConfigFileName | "credentials",
          Record<string, unknown>
        > = {
          vpn: parseSafe(fetched.vpnToml),
          hosts: parseSafe(fetched.hostsToml),
          rules: parseSafe(fetched.rulesToml),
          credentials: parseSafe(fetched.credentialsToml),
        };
        setEditedParsed(initialEdited);
        // Reset dirty
        setDirtyFields(new Map());
      } catch (e) {
        if (cancelled.current) return;
        setError(formatError(e));
      } finally {
        // Lint no-unsafe-finally: avoid `return` from finally block (would mask
        // any unhandled exception from try). Guard with explicit if-check on
        // cancellation flag — same WR-03 semantics, lint-clean shape.
        if (!cancelled.current) {
          setLoading(false);
        }
      }
    },
    [sshParams, options.defaultsMaps, options.disruptSets],
  );

  // Effect: load on mount + sshParams change
  useEffect(() => {
    if (options.skipAutoLoad) {
      setLoading(false);
      return;
    }
    const cancelled = { current: false };
    void loadBundle(cancelled);
    return () => {
      cancelled.current = true;
    };
  }, [loadBundle, options.skipAutoLoad]);

  const reloadBundle = useCallback(async (): Promise<void> => {
    const cancelled = { current: false };
    await loadBundle(cancelled);
  }, [loadBundle]);

  // ── EDIT ──
  const setFieldValue = useCallback(
    (
      fileName: ConfigFileName | "credentials",
      path: string[],
      value: unknown,
    ): void => {
      if (fileName === "credentials") {
        // D-2.1 type-level guard — credentials read-only, no edit possible
        return;
      }
      if (!editedParsed || !bundle) return;

      const pathKey = path.join(".");
      // Lookup before-value from CURRENT parsed (not original — supports edit→discard→edit)
      const fileParsed = editedParsed[fileName];
      let cursor: unknown = fileParsed;
      for (const segment of path.slice(0, -1)) {
        if (
          typeof cursor === "object" &&
          cursor !== null &&
          segment in (cursor as object)
        ) {
          cursor = (cursor as Record<string, unknown>)[segment];
        } else {
          cursor = undefined;
          break;
        }
      }
      const lastKey = path[path.length - 1];
      const before =
        typeof cursor === "object" && cursor !== null && lastKey in (cursor as object)
          ? (cursor as Record<string, unknown>)[lastKey]
          : undefined;

      // Apply edit
      const newParsed = applyEditToParsed(fileParsed, path, value);
      setEditedParsed((prev) => {
        if (!prev) return prev;
        return { ...prev, [fileName]: newParsed };
      });

      // Update dirty map
      setDirtyFields((prev) => {
        const next = new Map(prev);
        // If new value matches original bundle value → remove dirty
        const originalParsed = parseFileFromBundle(bundle, fileName);
        const originalValue = lookupValue(originalParsed, path);
        if (deepEqual(value, originalValue)) {
          next.delete(pathKey);
        } else {
          next.set(pathKey, {
            before,
            after: value,
            fileName: fileName as ConfigFileName,
          });
        }
        return next;
      });
    },
    [editedParsed, bundle],
  );

  const discardAll = useCallback((): void => {
    if (!bundle) return;
    // Reset editedParsed from original bundle
    const initialEdited: Record<
      ConfigFileName | "credentials",
      Record<string, unknown>
    > = {
      vpn: parseSafe(bundle.vpnToml),
      hosts: parseSafe(bundle.hostsToml),
      rules: parseSafe(bundle.rulesToml),
      credentials: parseSafe(bundle.credentialsToml),
    };
    setEditedParsed(initialEdited);
    setDirtyFields(new Map());
  }, [bundle]);

  // ── SAVE ──
  const saveAll = useCallback(async (): Promise<SaveBatchResult> => {
    if (!editedParsed || !bundle) {
      return { success: false, savedFiles: [], error: "Bundle not loaded" };
    }
    const filesToSave: ConfigFileName[] = Array.from(dirtyFiles);
    const savedFiles: ConfigFileName[] = [];

    for (const fileName of filesToSave) {
      try {
        let rawContent: string;
        if (fileName === "rules") {
          // D-2.3 — fresh read + frontend pre-merge
          const freshBundle = await invoke<ConfigBundle>(
            "server_get_config_bundle",
            { ...sshParams },
          );
          const freshRulesParsed = parseSafe(freshBundle.rulesToml) as {
            rule?: RuleEntry[];
          };
          const freshRulesEntries = freshRulesParsed.rule ?? [];
          const { usersOwned, other } = splitRulesByOwnership(freshRulesEntries);
          const editedRules =
            (editedParsed.rules.rule as RuleEntry[] | undefined) ?? [];
          // From edited: take only Config-owned (filter out stale Users-owned).
          const { configOwned: newConfigOwned } = splitRulesByOwnership(editedRules);
          const merged = mergeRulesEntries(usersOwned, newConfigOwned, other);
          rawContent = computeRawContent({ rule: merged });
        } else {
          rawContent = computeRawContent(editedParsed[fileName]);
        }

        await invoke<void>("server_save_config_file", {
          ...sshParams,
          fileName,
          rawContent,
        });
        savedFiles.push(fileName);
      } catch (e) {
        // D-8.1 stop-on-first-failure — return partial result, NO restart
        return {
          success: false,
          savedFiles,
          failedFile: fileName,
          error: formatError(e),
        };
      }
    }

    // All files saved — fire restart
    try {
      await invoke<void>("server_restart_service", { ...sshParams });
    } catch (e) {
      // Restart failed — files saved but service may not be reloaded
      // Caller decides UX (e.g., snackbar warning); return success with notice
      return {
        success: true,
        savedFiles,
        error: `Service restart failed: ${formatError(e)}`,
      };
    }

    // Successful complete batch — clear dirty
    setDirtyFields(new Map());
    // Reload bundle so trees reflect saved state
    const cancelled = { current: false };
    await loadBundle(cancelled);

    return { success: true, savedFiles };
  }, [editedParsed, bundle, dirtyFiles, sshParams, loadBundle]);

  return {
    bundle,
    trees,
    editedParsed,
    loading,
    error,
    dirtyFields,
    dirtyCount,
    hasDisruptHighField,
    dirtyFiles,
    reloadBundle,
    setFieldValue,
    discardAll,
    saveAll,
  };
}

// ── Helpers (file-internal) ──

function parseSafe(raw: string | undefined | null): Record<string, unknown> {
  try {
    return parse(raw || "") as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseFileFromBundle(
  bundle: ConfigBundle,
  fileName: ConfigFileName | "credentials",
): Record<string, unknown> {
  const raw =
    fileName === "vpn"
      ? bundle.vpnToml
      : fileName === "hosts"
        ? bundle.hostsToml
        : fileName === "rules"
          ? bundle.rulesToml
          : bundle.credentialsToml;
  return parseSafe(raw);
}

function lookupValue(parsed: Record<string, unknown>, path: string[]): unknown {
  let cursor: unknown = parsed;
  for (const segment of path) {
    if (
      typeof cursor === "object" &&
      cursor !== null &&
      segment in (cursor as object)
    ) {
      cursor = (cursor as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return cursor;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a === "object" && typeof b === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}
