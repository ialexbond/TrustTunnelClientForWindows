import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type { AppTab, VpnStatus } from "../types";
// IN-41: reuse the established Russian one/few/many helper so the batch toast declines «конфиг»
// («Добавлено 2 конфига» / «Добавлено 5 конфигов»). English uses i18next _one/_other keys instead.
import { pluralRu } from "../lib/pluralRu";
// 19-04 (Q3 / D-09): reuse the SAME PartialResult / ImportItem / SeededPartial shapes the picker path
// (ImportModal, Plan 03) exported, so a config-partial DROP surfaces the identical rich in-modal UX
// instead of per-file flyaway toasts. Type-only import — no runtime coupling to the component.
import type { PartialResult, ImportItem, SeededPartial } from "../../components/connection/ImportModal";

interface FileDropResult {
  file_type: "config" | "routing";
  config_path?: string;
  routing_rules?: unknown;
}

interface UseFileDropOptions {
  status: VpnStatus;
  onConfigImported: (configPath: string) => void;
  onRoutingImported: () => void;
  pushSuccess: (message: string, variant?: "success" | "error") => void;
  /**
   * 19-04 (Q3 / D-09): a CONFIG drop batch that partly fails routes HERE instead of firing a per-file
   * flyaway error toast for each failed config. The App opens the ImportModal seeded with this partial
   * (failed list + «Повторить») — the SAME rich in-modal UX as the file-picker path. The successful
   * configs are still promoted via onConfigImported; a fully-successful drop keeps its batch snackbar;
   * the routing (.json) failure path is UNCHANGED. When omitted (defensive — the hook used without the
   * modal), config failures fall back to the legacy per-file error toast so they are never lost.
   */
  onConfigPartial?: (partial: SeededPartial) => void;
  isBusy?: boolean;
  /**
   * IN-16: the active tab, used to gate the accepted format so the drop overlay's label stays
   * truthful. «Подключение» accepts ONLY a `.toml` config; «Маршрутизация» ONLY `.json` routing
   * rules. Any other tab (or `undefined`) keeps the format-agnostic behavior (both accepted,
   * routed by content).
   */
  activeTab?: AppTab;
}

/**
 * HTML5 drag-and-drop hook.
 * Works with dragDropEnabled: false in tauri.conf.json.
 * Reads file content via FileReader and sends to Rust for import.
 */
export function useFileDrop({
  status,
  onConfigImported,
  onRoutingImported,
  pushSuccess,
  onConfigPartial,
  isBusy = false,
  activeTab,
}: UseFileDropOptions) {
  const { t, i18n } = useTranslation();
  const [isDragging, setIsDragging] = useState(false);
  const dragCounter = useRef(0);

  const isBlocked = useCallback(() => {
    if (isBusy) return t("drop.busy_deploying", "Cannot import during active operation");
    if (status === "connecting") return t("drop.busy_connecting", "Cannot import while connecting");
    if (status === "disconnecting") return t("drop.busy_disconnecting", "Cannot import while disconnecting");
    // IN-02: treat ALL in-flight states uniformly. The old check only blocked
    // connecting/disconnecting, letting a drop slip through during an auto-reconnect or
    // recovery window — inconsistent with the "no import during an active operation"
    // intent. reconnecting/recovering are equally in-flight, so block them too (reusing
    // the generic "active operation" message rather than drifting per-state copy).
    if (status === "reconnecting" || status === "recovering") {
      return t("drop.busy_deploying", "Cannot import during active operation");
    }
    return null;
  }, [status, isBusy, t]);

  useEffect(() => {
    const handleDragEnter = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter.current++;
      if (e.dataTransfer?.types.includes("Files")) {
        setIsDragging(true);
      }
    };

    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };

    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter.current--;
      if (dragCounter.current <= 0) {
        dragCounter.current = 0;
        setIsDragging(false);
      }
    };

    const handleDrop = async (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter.current = 0;
      setIsDragging(false);

      const blocked = isBlocked();
      if (blocked) {
        pushSuccess(blocked, "error");
        return;
      }

      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;

      const fileList = Array.from(files);

      // IN-24: import EVERY dropped file. The old code took only `files[0]`, so dropping
      // several configs at once added just one. Per-file format rejects and import errors are
      // surfaced immediately (preserving the single-file UX + tests); successes are accumulated
      // and reported ONCE as a batch summary so an N-file drop doesn't fire N toasts.
      let configCount = 0;
      let routingCount = 0;
      let lastConfigPath: string | undefined;
      // 19-04 (Q3 / D-09): accumulate CONFIG-file failures into the SAME PartialResult shape the picker
      // path uses, so a partial config batch opens the ImportModal (failed list + «Повторить») instead
      // of a burst of per-file flyaway error toasts. D-29: only the file NAME is retained — never the
      // config content / password. `configFailedItems` retains a retry closure per failed file that
      // re-runs the SAME dropped file (no new payload, T-19-31).
      const configFailed: PartialResult["failed"] = [];
      const configFailedItems: ImportItem[] = [];

      for (const file of fileList) {
        const fileName = file.name.toLowerCase();
        const isToml = fileName.endsWith(".toml");
        const isJson = fileName.endsWith(".json");

        if (!isToml && !isJson) {
          pushSuccess(t("drop.unsupported_format", "Unsupported file format. Use .toml or .json"), "error");
          continue;
        }

        // IN-16: per-tab format gating so the drop overlay's label is truthful. «Подключение»
        // accepts only a config (.toml); «Маршрутизация» only routing rules (.json). A file
        // dropped on the wrong tab is rejected and the loop CONTINUES with the rest. Other tabs
        // (activeTab undefined/other) stay format-agnostic.
        if (activeTab === "connection" && !isToml) {
          pushSuccess(t("drop.only_config_toml", "Здесь принимается только файл конфига .toml"), "error");
          continue;
        }
        if (activeTab === "routing" && !isJson) {
          pushSuccess(t("drop.only_routing_json", "Здесь принимается только файл правил .json"), "error");
          continue;
        }

        try {
          const content = await file.text();
          const result = await invoke<FileDropResult>("import_dropped_content", {
            content,
            fileName: file.name,
          });

          if (result.file_type === "config" && result.config_path) {
            // Phase 11: a dropped config ADDS to the multi-config manifest — it never overwrites.
            // The Rust import path already writes a unique filename + appends a manifest entry;
            // add_config guarantees the manifest tracks it (deduped by canonical path — no-op if
            // already present). Best-effort: a redundant failure is non-fatal.
            try {
              await invoke("add_config", { path: result.config_path });
            } catch {
              // The file is on disk + already manifest-tracked by the Rust import path.
            }
            configCount++;
            lastConfigPath = result.config_path;
          } else if (result.file_type === "routing") {
            routingCount++;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (isToml && onConfigPartial) {
            // 19-04 (Q3 / D-09): a CONFIG-file failure accumulates into the shared PartialResult
            // instead of a per-file flyaway toast — surfaced below via onConfigPartial (App opens the
            // ImportModal seeded with it). Retain a retry closure that re-runs the SAME dropped file
            // (re-reads its content + re-imports — no new/auto payload, T-19-31). D-29: label = the
            // file NAME only; the config content / password is never surfaced or logged here.
            configFailed.push({ label: file.name, reason: "invalid-file" });
            configFailedItems.push({
              label: file.name,
              run: async () => {
                const retryContent = await file.text();
                const retryResult = await invoke<FileDropResult>("import_dropped_content", {
                  content: retryContent,
                  fileName: file.name,
                });
                if (retryResult.file_type === "config" && retryResult.config_path) {
                  // Best-effort manifest add (idempotent) — mirrors the initial-drop path.
                  try {
                    await invoke("add_config", { path: retryResult.config_path });
                  } catch {
                    // Already manifest-tracked by the Rust import path.
                  }
                  return retryResult.config_path;
                }
                // Not a config on re-run → a config-import failure for the partial UX.
                throw new Error("import.not_a_config");
              },
            });
          } else {
            // Routing (.json) failures — UNCHANGED — keep the per-file error toast. IN-57: the backend
            // returns i18n key codes for routing-import failures (routing.import_too_large /
            // routing.import_invalid) so they show localized, not raw English on a Russian UI. Any
            // other error (or a config failure with NO onConfigPartial wired — defensive fallback)
            // passes through verbatim so it is never silently lost.
            pushSuccess(msg.startsWith("routing.import_") ? t(msg) : msg, "error");
          }
        }
      }

      // Promote/refresh ONCE after the batch: onConfigImported (promoteImportedConfig) is
      // idempotent and reloads the whole manifest, so EVERY new card appears even though only one
      // path is passed (at most one config is activated, per IN-18).
      if (lastConfigPath) onConfigImported(lastConfigPath);
      if (routingCount > 0) onRoutingImported();

      // 19-04 (Q3 / D-09): if any CONFIG file failed, route the config batch through the SAME rich
      // in-modal partial UX as the picker path — the App opens the ImportModal seeded with the failed
      // list + «Повторить». The successful configs are already promoted above, so their batch snackbar
      // is intentionally SUPPRESSED here (parity with the picker path, where a partial batch stays
      // in-modal and fires NO success snackbar). A fully-successful config drop falls through to the
      // unchanged snackbar path below. Any routing outcome in the same (mixed, off-gated-tab) batch is
      // still reported the usual way.
      if (configFailed.length > 0 && onConfigPartial) {
        onConfigPartial({ ok: configCount, failed: configFailed, failedItems: configFailedItems });
        if (routingCount === 1) {
          pushSuccess(t("drop.routing_imported", "Routing rules imported"));
        } else if (routingCount > 1) {
          pushSuccess(t("drop.configs_added_n", "Добавлено {{count}}", { count: routingCount }));
        }
        return;
      }

      const okCount = configCount + routingCount;
      if (okCount === 1) {
        pushSuccess(
          configCount === 1
            // IN-43: a single config says «Конфиг добавлен» on EVERY path — same key the modal
            // («Из файла» / «По ссылке») already uses. The old drop-only «Конфигурация VPN
            // импортирована» was the inconsistency the owner hit when adding through different doors.
            ? t("connection.snackbar.config_added")
            : t("drop.routing_imported", "Routing rules imported"),
        );
      } else if (okCount > 1) {
        // IN-41: decline the noun. An all-config batch (the «Подключение» case the owner reported)
        // → «Добавлено N конфига/конфигов» via pluralRu (ru) or the _one/_other key (en). A
        // routing-only or mixed batch (only reachable off the gated tabs) keeps the generic count.
        if (routingCount === 0) {
          pushSuccess(
            // IN-05 (19-fix): batch copy folded into the shared i18n key (config_added_batch) instead
            // of a hardcoded «Добавлено …» literal — same idiom as the picker path (ImportModal). ru
            // declension via pluralRu ({{plural}}); en uses its own count key.
            i18n.language === "ru"
              ? t("connection.import.config_added_batch", {
                  plural: pluralRu(configCount, "конфиг", "конфига", "конфигов"),
                })
              : t("drop.configs_added", { count: configCount }),
          );
        } else {
          pushSuccess(t("drop.configs_added_n", "Добавлено {{count}}", { count: okCount }));
        }
      }
    };

    document.addEventListener("dragenter", handleDragEnter);
    document.addEventListener("dragover", handleDragOver);
    document.addEventListener("dragleave", handleDragLeave);
    document.addEventListener("drop", handleDrop);

    return () => {
      document.removeEventListener("dragenter", handleDragEnter);
      document.removeEventListener("dragover", handleDragOver);
      document.removeEventListener("dragleave", handleDragLeave);
      document.removeEventListener("drop", handleDrop);
    };
  }, [isBlocked, onConfigImported, onRoutingImported, pushSuccess, onConfigPartial, t, i18n.language, activeTab]);

  return { isDragging };
}
