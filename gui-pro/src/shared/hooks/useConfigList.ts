import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * One config entry as the Rust `list_configs` command returns it (a non-secret
 * `ConfigSummary`). Mirrors `commands/manifest.rs::ConfigSummary` — id/name/host/user +
 * the manifest order/last_used flags. The password is NEVER part of this shape (D-29).
 */
export interface ConfigSummary {
  id: string;
  name: string;
  host: string;
  user: string;
  path: string;
  order: number;
  last_used: boolean;
}

/**
 * `useConfigList` — owns the on-disk multi-config manifest list (Phase 11 foundation).
 *
 * It loads the manifest via `invoke("list_configs")` on mount and exposes a `reload()`
 * so mutations (import/delete/duplicate/rename/set-last-used — wired in later waves) can
 * refresh the list after the Rust side has atomically rewritten `configs.json`.
 *
 * The mount load is once-guarded against React 19 StrictMode's double-invoke (Pitfall 3):
 * a `useRef` flag makes the initial fetch fire exactly once even though the effect runs
 * twice in dev. The manifest is the source of truth — this hook never reads localStorage
 * for the list.
 */
export function useConfigList() {
  const [configs, setConfigs] = useState<ConfigSummary[]>([]);
  const [loading, setLoading] = useState(true);
  // Once-guard: StrictMode invokes the mount effect twice in dev. Without this the
  // initial list_configs would fire twice. reload() is the explicit re-fetch path.
  const didLoadRef = useRef(false);
  // IN-47: the loading SKELETON must be FIRST-LOAD-ONLY. It flips loading=true, and ConfigList
  // swaps the populated list for a 3-card skeleton inside the SAME scroll container — collapsing the
  // content height and clamping the user's scrollTop to 0. That was the dominant scroll-reset vector
  // (every mutation calls reload(): duplicate/delete/rename/save/import/install). So reload() flips
  // loading=true ONLY until the FIRST successful fetch; after that it re-fetches in place like
  // refresh() (React reconciles the keyed cards, scroll preserved by construction). Keying on "never
  // loaded yet" (not "currently empty") keeps the genuine first-load skeleton even for a manifest
  // built by migration that arrives after an empty initial load.
  const hasLoadedRef = useRef(false);

  const reload = useCallback(async () => {
    if (!hasLoadedRef.current) setLoading(true);
    try {
      const list = await invoke<ConfigSummary[]>("list_configs");
      setConfigs(list ?? []);
      hasLoadedRef.current = true; // first successful load done → future reloads are silent/in-place
    } catch {
      // A failed list read leaves the previous list intact; the empty-state still
      // renders when the list is empty. We deliberately do not surface a hard error
      // here — the surface degrades to "no configs" rather than crashing the tab.
      setConfigs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // IN-29 / N2: SILENT refresh — re-fetch the list WITHOUT flipping loading=true, so an automatic
  // refresh (window focus, the IN-31 fs-watcher) updates the cards in place and never swaps to the
  // loading skeleton. The skeleton unmounted the scrolled list and reset its scroll position
  // (the "scroll jumps on minimize" bug). reload() (with the skeleton) stays for the initial mount
  // + explicit reloads; refresh() is for every automatic, in-place update.
  const refresh = useCallback(async () => {
    try {
      const list = await invoke<ConfigSummary[]>("list_configs");
      setConfigs(list ?? []);
    } catch {
      // Keep the previous list on a transient read failure (no skeleton, no clear).
    }
  }, []);

  useEffect(() => {
    if (didLoadRef.current) return;
    didLoadRef.current = true;
    void reload();
  }, [reload]);

  return { configs, reload, refresh, loading };
}
