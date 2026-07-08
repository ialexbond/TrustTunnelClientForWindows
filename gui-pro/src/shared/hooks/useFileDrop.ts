import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type { AppTab, VpnStatus } from "../types";
// IN-41: reuse the established Russian one/few/many helper so the batch toast declines «конфиг»
// («Добавлено 2 конфига» / «Добавлено 5 конфигов»). English uses i18next _one/_other keys instead.
import { pluralRu } from "../lib/pluralRu";

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
          // IN-57: the backend returns i18n key codes for routing-import failures
          // (routing.import_too_large / routing.import_invalid) so they show localized, not raw
          // English on a Russian UI. Any other error passes through verbatim.
          pushSuccess(msg.startsWith("routing.import_") ? t(msg) : msg, "error");
        }
      }

      // Promote/refresh ONCE after the batch: onConfigImported (promoteImportedConfig) is
      // idempotent and reloads the whole manifest, so EVERY new card appears even though only one
      // path is passed (at most one config is activated, per IN-18).
      if (lastConfigPath) onConfigImported(lastConfigPath);
      if (routingCount > 0) onRoutingImported();

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
            i18n.language === "ru"
              ? `Добавлено ${pluralRu(configCount, "конфиг", "конфига", "конфигов")}`
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
  }, [isBlocked, onConfigImported, onRoutingImported, pushSuccess, t, i18n.language, activeTab]);

  return { isDragging };
}
