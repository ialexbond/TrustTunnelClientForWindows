import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type { VpnStatus } from "../types";

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
}: UseFileDropOptions) {
  const { t } = useTranslation();
  const [isDragging, setIsDragging] = useState(false);
  const dragCounter = useRef(0);

  const isBlocked = useCallback(() => {
    if (isBusy) return t("drop.busy_deploying", "Cannot import during active operation");
    if (status === "connecting") return t("drop.busy_connecting", "Cannot import while connecting");
    if (status === "disconnecting") return t("drop.busy_disconnecting", "Cannot import while disconnecting");
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

      const file = files[0];
      const fileName = file.name.toLowerCase();

      if (!fileName.endsWith(".toml") && !fileName.endsWith(".json")) {
        pushSuccess(t("drop.unsupported_format", "Unsupported file format. Use .toml or .json"), "error");
        return;
      }

      try {
        const content = await file.text();

        const result = await invoke<FileDropResult>("import_dropped_content", {
          content,
          fileName: file.name,
        });

        if (result.file_type === "config" && result.config_path) {
          onConfigImported(result.config_path);
          pushSuccess(t("drop.config_imported", "VPN config imported"));
        } else if (result.file_type === "routing") {
          onRoutingImported();
          pushSuccess(t("drop.routing_imported", "Routing rules imported"));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        pushSuccess(msg, "error");
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
  }, [isBlocked, onConfigImported, onRoutingImported, pushSuccess, t]);

  return { isDragging };
}
