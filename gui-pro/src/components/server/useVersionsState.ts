import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ServerInfo } from "./useServerState";

/**
 * Domain hook for version-selection state.
 * Loads available versions on mount, auto-selects current installed version
 * when server info is known.
 *
 * WR-04 (Phase 25): its only consumer, `VersionSection`, was deleted — it had been
 * unreachable since Phase 15.1 (its sole render site was inside the removed
 * «Конфигурация сервера» wrapper) and the live version-picker surface is
 * `ProtocolUpdateSection` in «Сервис», which drives `update_sidecar` instead.
 * Nothing reads `availableVersions` / `selectedVersion` today, so the
 * `server_get_available_versions` request below is already a no-op fetch — that
 * predates the deletion and is NOT changed by it. Removing the hook means removing
 * its fields from the shared `ServerState`, which is a wider refactor than this
 * review fix owns; it is tracked in `.planning/BACKLOG.md` (bucket D) instead of
 * being half-done here.
 */
export function useVersionsState(serverInfo: ServerInfo | null) {
  const [availableVersions, setAvailableVersions] = useState<string[]>([]);
  const [selectedVersion, setSelectedVersion] = useState("");
  const [showVersions, setShowVersions] = useState(false);

  // Load list of releases once.
  useEffect(() => {
    invoke<string[]>("server_get_available_versions")
      .then((versions) => {
        setAvailableVersions(versions);
        if (versions.length > 0) setSelectedVersion(versions[0]);
      })
      .catch(() => {});
  }, []);

  // When server info arrives, switch selection to the installed version.
  useEffect(() => {
    if (!serverInfo?.version || availableVersions.length === 0) return;
    const currentV = serverInfo.version.replace(/^v/, "");
    const match = availableVersions.find((v) => v.replace(/^v/, "") === currentV);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot sync auto-selection of installed version when serverInfo arrives; deferring would briefly show stale selection
    if (match) setSelectedVersion(match);
  }, [serverInfo?.version, availableVersions]);

  return {
    availableVersions,
    selectedVersion,
    setSelectedVersion,
    showVersions,
    setShowVersions,
  };
}

export type VersionsState = ReturnType<typeof useVersionsState>;
