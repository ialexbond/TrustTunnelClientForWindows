import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ServerInfo } from "./useServerState";

/**
 * Domain hook for version-selection state.
 * Loads available versions on mount, auto-selects current installed version
 * when server info is known. Actions (upgrade) live in VersionSection and
 * call invoke() + useConfirm() directly.
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
