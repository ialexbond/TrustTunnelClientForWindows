import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * `useConfigFileGone` — «the one config this surface is bound to has left the disk».
 *
 * WHY THIS EXISTS (G-30.1-01, from the 30.1 UAT).
 * Plan 30.1-03 fixed the raw-path-comparison class so that a config file deleted OUTSIDE the app is
 * noticed and the dangling «active» pointer is cleared. T-14 confirmed that. What it also exposed:
 * the per-config settings modal the owner had open for that config STAYED open, still offering
 * «Сохранить» against a `.toml` that no longer exists. The card behind it had already vanished from
 * the list — the folder is the source of truth and `list_configs` prunes what is gone — so the app
 * was showing an editor for something it had itself just decided does not exist.
 *
 * WHY IT ASKS THE BACKEND INSTEAD OF READING THE LIST.
 * «The open path is no longer in `visibleConfigs`» looks like the obvious signal and is the wrong
 * one, in two ways that both end in the app telling the user a file was deleted when it was not:
 *   - `useConfigList` CLEARS the list when `list_configs` itself fails (27 D-15) — an unreadable
 *     manifest would read as «every config was deleted»;
 *   - `dedupeConfigsByIdentity` collapses same-server twins and the winner is ACTIVE-PATH-AWARE, so
 *     connecting to the twin moves the surviving card's path while both files sit on disk.
 * `config_file_exists` is a plain `Path::is_file()` on the exact path the surface holds. It cannot
 * be confused by either, and it distinguishes «deleted» from «corrupt» — which matters, because the
 * app already has a separate, differently-worded state for a file that is present but unparseable
 * (`ConfigEditView`'s `loadError`), and the two ask the user to do different things.
 *
 * It also keeps this hook out of the rule-7 class the phase swept: there is NO path comparison here
 * at all, raw or normalized. The event only says «something in the config dir changed»; the answer
 * comes from the filesystem.
 *
 * WHEN IT RE-CHECKS. On open, and on every `configs-changed` / `config-file-changed`. The first is
 * the data-dir watcher (`manifest::start_configs_watcher`) and fires for ANY `.toml` — the one the
 * modal is bound to need not be the active config. The second is the active-file lifecycle event and
 * is watched too because the PP-5 self-echo window can suppress `configs-changed` while
 * `config-file-changed` still fires. Neither payload is inspected; both simply mean «re-ask».
 *
 * FAILURE IS «PRESENT», DELIBERATELY. The flag flips to true only when the command answers a literal
 * `false`. A rejected invoke, an undefined reply, a test harness that does not know the command — all
 * leave the surface alone. Claiming a deletion that did not happen would be worse than the bug this
 * closes: it would push the user to close a pane over an edit they could still have saved.
 *
 * @param configPath the `.toml` this surface is bound to, or null/empty when nothing is open.
 * @returns true once the backend has said the file is not there.
 */
export function useConfigFileGone(configPath: string | null | undefined): boolean {
  const [gone, setGone] = useState(false);

  useEffect(() => {
    if (!configPath) return;
    let cancelled = false;

    const check = async () => {
      try {
        const exists = await invoke<boolean>("config_file_exists", { configPath });
        if (cancelled) return;
        // Strict `=== false`: see «failure is present» above. A restore flips it back — the file is
        // on disk again, `list_configs` re-adopts it (folder-as-truth), and the surface is honest.
        setGone(exists === false);
      } catch {
        // Deliberately silent and deliberately non-mutating. D-29: nothing about the config is
        // logged here, and an unanswered question is not evidence of a deletion.
      }
    };

    void check();

    const unlistenConfigs = listen("configs-changed", () => {
      void check();
    });
    const unlistenActive = listen("config-file-changed", () => {
      void check();
    });

    return () => {
      cancelled = true;
      // The verdict belongs to THIS path and dies with it. Resetting here rather than at the top of
      // the effect is not a style choice: `react-hooks/set-state-in-effect` (error, no warnings
      // budget) forbids a synchronous setState in the effect BODY, and the cleanup runs first on a
      // path change, so the next config is checked from a clean slate instead of inheriting a
      // «файл удалён» state that was never about it.
      setGone(false);
      void unlistenConfigs.then((off) => off());
      void unlistenActive.then((off) => off());
    };
  }, [configPath]);

  return gone;
}
