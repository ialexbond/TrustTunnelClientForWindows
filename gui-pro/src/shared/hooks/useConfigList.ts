import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * One config entry as the Rust `list_configs` command returns it (a non-secret
 * `ConfigSummary`). Mirrors `commands/manifest.rs::ConfigSummary` — id/name/host/display_host/user
 * + the manifest order/last_used flags. The password is NEVER part of this shape (D-29).
 */
export interface ConfigSummary {
  id: string;
  name: string;
  /** The RAW endpoint hostname — the DEDUP / same-server-identity key (FE `identityKey` in
   *  dedupeConfigsByIdentity.ts, Rust find_duplicate_by_host_user + identity_key_of). Never used
   *  for the card display: it may be a fake TLS-SNI name (e.g. trusttunnel.local) for a bare-IP
   *  server. Keep dedup readers on this field. */
  host: string;
  /** 16-07 (gap 5a): the value the Connection-tab card SHOWS — IP-preferring. For a bare-IP
   *  endpoint carrying a fake SNI hostname this is the real IP (from addresses[0]), so the
   *  `isIpAddress` branch renders the «IP» glyph; a real domain keeps the domain + globe. Display
   *  ONLY — NEVER a dedup key. Mirrors the Rust `display_host` field 1:1. */
  display_host: string;
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
 * It also exposes `error` (27 D-15): a boolean saying THAT the list could not be read, so the tab
 * can tell «не удалось прочитать» apart from «серверов пока нет». Set by `reload()` only — see the
 * two catch blocks below for why `refresh()` stays silent.
 *
 * The mount load is once-guarded against React 19 StrictMode's double-invoke (Pitfall 3):
 * a `useRef` flag makes the initial fetch fire exactly once even though the effect runs
 * twice in dev. The manifest is the source of truth — this hook never reads localStorage
 * for the list.
 */
export function useConfigList() {
  const [configs, setConfigs] = useState<ConfigSummary[]>([]);
  const [loading, setLoading] = useState(true);
  // 27 D-15: THE READ FAILED — that, and nothing more.
  //
  // Before this, a failed read and an empty manifest were the same value to the app, so the UI drew
  // «серверов пока нет» over a failure. The servers exist; they just could not be read, and the two
  // deserve different surfaces (the design's `load-failed` state, with a «Повторить» button).
  //
  // A BOOLEAN, not the caught value. D-05 / EW-02: the consumer renders a localized heading and the
  // raw backend string never reaches the screen — the contract `ServerUnavailablePlate` already
  // holds. Keeping a message here would make leaking it a one-line mistake away; a flag makes it
  // impossible.
  const [error, setError] = useState(false);
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
      setError(false); // the list has just been read; whatever failed before is no longer true
      hasLoadedRef.current = true; // first successful load done → future reloads are silent/in-place
    } catch {
      // 27 D-15 OVERTURNED THE OLD CHOICE HERE. This catch used to clear the list and stay silent,
      // with a comment saying the surface "deliberately degrades to no configs rather than crashing
      // the tab". That degraded state turned out to be a LIE on screen: the tab rendered «серверов
      // пока нет» while the manifest was unreadable, and the design's `load-failed` state — the one
      // with a «Повторить» button — could never appear, because nothing in the app knew the
      // difference. So the failure is now reported. The list is still cleared, exactly as before;
      // only the silence is gone.
      setConfigs([]);
      setError(true);
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
      setError(false); // a successful read in EITHER leg clears the channel
    } catch {
      // Keep the previous list on a transient read failure (no skeleton, no clear).
      //
      // 27 D-15: and deliberately NO setError(true) here either. This leg fires on window focus and
      // on the IN-31 fs-watcher, with a good list already on screen; reporting a blipped background
      // re-read would paint «не удалось прочитать» over content the user is looking at and can
      // still use. The error channel belongs to reload(), which is the leg that clears the list.
    }
  }, []);

  useEffect(() => {
    if (didLoadRef.current) return;
    didLoadRef.current = true;
    void reload();
  }, [reload]);

  // EVERY instance follows the configs folder, not just the one whose screen did the mutating.
  //
  // The bug this closes (owner, 28-UAT): delete a config on «Подключение» and the
  // «Порядок переключения» list in «Настройки» went on showing it — the deleted server still had a
  // row, just greyed and unnumbered. Two facts made that inevitable. The tabs stay MOUNTED (IN-11,
  // hidden via opacity/visibility), so the Settings panel never re-mounts and never re-fetches; and
  // the `configs-changed` listener lived in `useConfigMutations`, which only the Connection tab
  // uses. So a second `useConfigList` instance loaded once at startup and was never told anything
  // again. It was not showing stale data by accident — nothing in the app could reach it.
  //
  // Putting the listener HERE rather than in another consumer is the point: the folder is the
  // source of truth, so following it belongs to the hook that reads it, and every present and
  // future consumer inherits that for free. A consumer that also refreshes on its own (the
  // Connection tab does) just re-reads a list it already has — cheap, and never wrong.
  //
  // `refresh` (silent), never `reload`: this fires on background events, and the skeleton would
  // unmount the scrolled list and reset its scroll position (IN-29 / IN-47).
  useEffect(() => {
    const unlisten = listen("configs-changed", () => {
      void refresh();
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, [refresh]);

  // ADDITIVE: `error` joins the four fields that were already here, under their existing names.
  // Every consumer destructures, so nothing else needs editing — `npm run typecheck` is the proof.
  return { configs, reload, refresh, loading, error };
}
