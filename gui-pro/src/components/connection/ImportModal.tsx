import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { FileUp, Link2 } from "lucide-react";
import { cn } from "../../shared/lib/cn";
import { Modal } from "../../shared/ui/Modal";
import { Input } from "../../shared/ui/Input";
import { Button } from "../../shared/ui/Button";
import { ErrorBanner } from "../../shared/ui/ErrorBanner";
import { DropOverlay } from "../../shared/ui/DropOverlay";
import { useSnackBar } from "../../shared/ui/SnackBarContext";
// IN-41: reuse the Russian one/few/many helper for the multi-file batch toast — same declined
// «конфиг» copy as the drag-drop path (useFileDrop). English uses the i18next _one/_other key.
import { pluralRu } from "../../shared/lib/pluralRu";

/**
 * Production ImportModal — the SINGLE point through which a config is added to the
 * «Подключение» tab (D-06). Pixel-mirrors `ImportModal.stories.tsx`: two compact tiles
 * («Из файла» / «По ссылке»), inline link-format validation (tt:// | trusttunnel://),
 * errors-in-modal (the modal STAYS OPEN, never a flyaway toast), and the in-flight
 * lock (× / backdrop / Escape all disabled while importing).
 *
 * PARTIAL-IMPORT UX (D-09): a multi-file «Из файла» batch where SOME files fail keeps the result
 * IN-MODAL — a WARNING banner («Добавлено N конфига, не удалось — M», counts via pluralRu), a list
 * of ONLY the failed files each with a short reason, and «Повторить» that retries ONLY the failed
 * items (the successful configs are already committed to the list). An all-failed batch (ok===0) is
 * a pure error: a RED banner + «Повторить», no success snackbar. A success snackbar fires only when
 * nothing failed. Ported 1:1 from the story's `PartialResult` shape (kept reusable for the 19-04
 * drag-drop parity port).
 *
 * The import ALWAYS goes through the backend `import_config_from_string`, which writes a
 * UNIQUE filename + appends a manifest entry (never overwrites). A host+user duplicate is
 * ALWAYS auto-added as a copy «<base> (копия N)» on EVERY door (file / link / drag) — there is
 * NO copy/replace choice modal and never an overwrite (IN-36; the old `{ kind: "duplicate" }`
 * round-trip + the `resolution` param were removed).
 *
 * SECURITY INVARIANT (deeplink-never-auto): a `tt://` link may PREFILL the field (the user
 * clicked a link in a browser/chat), but the import fires ONLY on an explicit
 * «Импортировать» click — never automatically on open. The disabled-until-clicked button
 * IS the visible guarantee.
 */

interface ImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called after a successful import (added / replaced) with the destination path so the
   *  parent can reload the list + highlight the new card. */
  onImported: (path: string) => void;
  /** Deep-link URL to PREFILL the link field (deeplink-never-auto: prefill only). */
  initialUrl?: string;
  /** Whether a file is currently dragged over the window (parent owns useFileDrop). */
  isDragging?: boolean;
  /**
   * Phase 14 (D-13): a seamless A→B switch is in flight (App-owned FE-only flag). While it is true
   * the import is LOCKED — importing mid-switch adds a config and may auto-promote/open a competing
   * flow that races the in-flight swap. OR'd into the existing importDisabled + the entry tiles'
   * disabled; the existing in-flight (loading) lock is unchanged. Re-enables atomically on settle.
   */
  isSwitching?: boolean;
  /**
   * 19-04 (Q3 / D-09): open the modal DIRECTLY into the rich partial view, seeded with a drag-drop
   * config-partial outcome (the successful configs are already promoted by the App-level drop path;
   * this carries the failed rows + the retained items for «Повторить»). Reuses the SAME render path
   * + retry-only-failed helper as the picker path — the two doors are pixel-identical. null / omitted =
   * a normal (picker/link) open. deeplink-never-auto: seeding shows a REPORT, never an auto-import.
   */
  seededPartial?: SeededPartial | null;
  /**
   * WR-05 (19-fix): report the in-flight batch state up to the App so the document-level drop
   * handler (useFileDrop) can GATE new drops while a picker/link/retry batch is running — a drop
   * landing mid-batch would interleave two pipelines whose finishBatch results overwrite each
   * other. The App wires this into useFileDrop's `isBusy`. Drops while the modal is merely OPEN
   * (resting tiles / a settled partial view) are still allowed — a second partial drop MERGES into
   * the existing partial (see the seed effect) instead of wiping the retained retry items.
   */
  onLoadingChange?: (loading: boolean) => void;
}

/** A compact entry tile (icon + label + caption) — the modal's primary affordance. */
function EntryTile({
  icon,
  label,
  caption,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  caption: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex flex-col items-center justify-center gap-[var(--space-1)]",
        "rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg-elevated)]",
        "px-[var(--space-3)] py-[var(--space-4)] text-center transition-colors",
        "hover:border-[var(--color-border-hover)] hover:bg-[var(--color-bg-hover)]",
        "focus-visible:shadow-[var(--focus-ring)] outline-none",
        "disabled:opacity-[var(--opacity-disabled)] disabled:cursor-not-allowed disabled:pointer-events-none",
      )}
    >
      <span className="text-[var(--color-accent-interactive)]">{icon}</span>
      <span className="text-sm font-medium text-[var(--color-text-primary)]">{label}</span>
      <span className="text-xs text-[var(--color-text-muted)]">{caption}</span>
    </button>
  );
}

/**
 * CA-3: surface an import failure to a log sink instead of the old bare `catch {}`.
 *
 * D-29 (SACRED): the config content carries the user's host / username / PASSWORD. We log ONLY
 * a SANITIZED trail — a short reason (the Error message, which is a backend status string, never
 * the file body) plus the file BASENAME (not the full path, not the content). The config content
 * / the decoded TOML is NEVER passed here. The literal password token is not written into any
 * comment either (comment-text discipline, T-17-06). The mirror is DEV-BUILD-ONLY (same
 * `import.meta.env.DEV` gate as the vpn-log F12 mirror, D-11) so a release build never streams it.
 */
function logImportFailure(reason: unknown, fileLabel?: string): void {
  if (!import.meta.env.DEV) return;
  const msg = reason instanceof Error ? reason.message : String(reason);
  const where = fileLabel ? ` [${fileLabel}]` : "";
  // DEV-only import-failure mirror (CA-3); gated off in release. console.error is permitted by the
  // no-console rule (only console.log is flagged), so no disable directive is needed here.
  console.error(`[import] failed${where}: ${msg}`);
}

/** The two import-failure kinds — mirrors the story's `DemoError` reason set (D-10). A file-pick
 *  failure is always `invalid-file` (the picker only yields file paths); `invalid-link` exists for
 *  the link/deeplink door + the 19-04 drag-drop parity port. */
export type ImportFailKind = "invalid-file" | "invalid-link";

/** In-modal partial-import result (D-09): `ok` configs were committed to the list, the rest failed
 *  and are listed so the user can retry ONLY those. `ok === 0` is not a partial — it is a pure error
 *  (red banner, no success snackbar). Shape matches `ImportModal.stories.tsx` `PartialResult` so the
 *  render path stays reusable for the 19-04 drag-drop parity port. */
export interface PartialResult {
  ok: number;
  failed: { label: string; reason: ImportFailKind }[];
}

/** A single retryable import unit — the seam that lets ONE batch pipeline + the retry-only-failed UX
 *  serve BOTH import doors (19-04). `label` is the display/basename (the ONLY thing ever surfaced or
 *  logged — never the config content / password, D-29); `run` performs the import and resolves to the
 *  destination path (or throws on failure). The file-picker door builds these from OS paths
 *  (read_config_file_for_import → import_config_from_string); the drag-drop door builds them from the
 *  retained dropped File (import_dropped_content) — «Повторить» re-runs the SAME source, never a new
 *  payload (T-19-31). */
export interface ImportItem {
  label: string;
  run: () => Promise<string>;
}

/** A seed to open the modal DIRECTLY into the partial view (19-04): the drag-drop door hands the App
 *  the already-computed `ok` count + `failed` display rows + the retained `failedItems` for «Повторить».
 *  Passing it opens the ImportModal showing the SAME rich partial UX as the picker path — a report only,
 *  never an auto-import (deeplink-never-auto holds; opening seeded shows failures + «Повторить»). */
export interface SeededPartial {
  ok: number;
  failed: PartialResult["failed"];
  failedItems: ImportItem[];
}

/** Map a failure kind → its short i18n reason key for the compact failed-list rows (D-10). */
const REASON_KEY: Record<ImportFailKind, string> = {
  "invalid-file": "connection.import.reason_invalid_file",
  "invalid-link": "connection.import.reason_invalid_link",
};

export function ImportModal({ isOpen, onClose, onImported, initialUrl, isDragging = false, isSwitching = false, seededPartial = null, onLoadingChange }: ImportModalProps) {
  const { t, i18n } = useTranslation();
  const pushSnack = useSnackBar();

  const [link, setLink] = useState("");
  const [linkExpanded, setLinkExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  // An in-modal error banner (modal stays open). null = none.
  const [error, setError] = useState<string | null>(null);
  // D-09: a partial-batch outcome shown IN-MODAL when SOME (not all) picked files failed — the rich
  // story shape (ok count + the failed items with labels/reasons). null = no partial state.
  const [partial, setPartial] = useState<PartialResult | null>(null);
  // The failed ImportItems retained for «Повторить» (retry-only-failed, D-09) — kept SEPARATE from the
  // rendered PartialResult (which carries only the display label + reason) so the render path stays
  // the reusable story shape while retry still has the concrete items to re-run. 19-04: an ImportItem
  // abstracts the door (picker path vs. dropped file), so «Повторить» works identically for both.
  const [retryItems, setRetryItems] = useState<ImportItem[]>([]);

  // Prefill from a deep-link click — show the expanded link row but DO NOT import
  // (deeplink-never-auto). Seeding controlled state from props on open is the intended
  // pattern here (mirrors the wizard ImportConfigModal); the lint rule is about avoiding
  // render-loop setState, which this guarded one-shot is not.
  useEffect(() => {
    if (isOpen && initialUrl) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot deep-link prefill on open, not a render loop
      setLink(initialUrl);
      setLinkExpanded(true);
    }
  }, [isOpen, initialUrl]);

  // 19-04 (Q3 / D-09): open DIRECTLY into the rich partial view when the drag-drop door hands us a
  // seeded partial. The successful configs were already promoted App-side; here we only render the
  // failed rows + «Повторить» (retry re-runs the retained items). Same guarded one-shot pattern as the
  // deep-link prefill above — synchronizing render state with a prop on open, not a render loop.
  useEffect(() => {
    if (isOpen && seededPartial) {
      // WR-05 (19-fix): MERGE an incoming seed into an existing partial instead of REPLACING it. A
      // second config-partial drop while the modal already shows a partial used to overwrite
      // `partial`/`retryItems`, silently discarding the first batch's retained failed items (their
      // retry closures were gone — the user had to re-drop the originals). Appending preserves every
      // batch's failed rows + retry closures; the `ok` counts accumulate (they reflect the total
      // committed across drops). A fresh open (prev === null) seeds normally.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot drag-drop partial seed/merge on open, not a render loop
      setPartial((prev) =>
        prev
          ? { ok: prev.ok + seededPartial.ok, failed: [...prev.failed, ...seededPartial.failed] }
          : { ok: seededPartial.ok, failed: seededPartial.failed },
      );
      setRetryItems((prev) => [...prev, ...seededPartial.failedItems]);
    }
  }, [isOpen, seededPartial]);

  // WR-05 (19-fix): report the in-flight batch state up so the App can gate document-level drops
  // while a batch is running (prevents two batch pipelines from interleaving). Fires only on change.
  useEffect(() => {
    onLoadingChange?.(loading);
  }, [loading, onLoadingChange]);

  const resetState = useCallback(() => {
    setLink("");
    setLinkExpanded(false);
    setLoading(false);
    setError(null);
    setPartial(null);
    setRetryItems([]);
  }, []);

  const handleClose = useCallback(() => {
    if (loading) return; // a half-done import cannot be cancelled by closing
    // IN-02 (19-fix): the partial view has render PRECEDENCE — it is the top view whenever
    // `partial` is set (see the render branch order: `partial ? … : linkExpanded ? …`). So a ✕
    // over a visible partial must FULLY dismiss, not fall through to the IN-21 link back-step when
    // the modal also happens to be link-expanded (the deep-link-seeded + drop-partial combo). This
    // check mirrors the render precedence so close behavior matches what the user actually sees.
    if (partial) {
      resetState();
      onClose();
      return;
    }
    // IN-21: the «По ссылке» view is an INTERNAL view-state of THIS single modal (not a nested
    // modal). The corner ×, backdrop and Escape all route here, so from the link view a close must
    // step BACK to the file/link choice instead of dismissing the whole modal. Only the resting
    // choice view's close fully dismisses.
    if (linkExpanded) {
      setLinkExpanded(false);
      setLink("");
      setError(null);
      setPartial(null);
      setRetryItems([]);
      return;
    }
    resetState();
    onClose();
  }, [loading, partial, linkExpanded, resetState, onClose]);

  // Link-format validation: «Импортировать» is enabled ONLY for a well-formed tt:// /
  // trusttunnel:// link. Empty = disabled, no error. A non-empty non-matching value reddens
  // the field inline (distinct from the post-submit error banner).
  const trimmedLink = link.trim();
  const isValidLink = /^(tt|trusttunnel):\/\/.+/i.test(trimmedLink);
  const showLinkError = trimmedLink !== "" && !isValidLink;
  // Phase 14 (D-13): lock the import while a switch is in flight (in addition to the in-flight
  // `loading` lock + the link-validity gate) so a mid-switch import cannot race the swap.
  const importDisabled = loading || !isValidLink || isSwitching;

  /** Run the backend import for already-decoded TOML content. A host+user duplicate is
   *  AUTO-added as a copy «(копия N)» Rust-side (IN-36) — no prompt; on success: snackbar +
   *  onImported(path) + close. */
  const runImport = useCallback(
    async (content: string, source: string, originalFileName?: string) => {
      setLoading(true);
      setError(null);
      try {
        const path = await invoke<string>("import_config_from_string", {
          content,
          source,
          // Preserve the source file's original (branded) name when we have one so the
          // country-code prefix (which lives ONLY in the filename) survives; null for
          // clipboard/deeplink → backend keeps its content-derived branding.
          originalFileName: originalFileName ?? null,
        });
        pushSnack(t("connection.snackbar.config_added"));
        onImported(path);
        resetState();
        onClose();
      } catch (err) {
        // CA-3: mirror a SANITIZED trail (reason + source label — never `content`, D-29) before
        // showing the in-modal banner. Errors render IN-MODAL (the modal stays open) — never a
        // flyaway toast.
        logImportFailure(err, source);
        setError(
          source === "deeplink" || source === "clipboard-deeplink"
            ? t("connection.import.error_invalid_link")
            : t("connection.import.error_invalid_file"),
        );
        setLoading(false);
      }
    },
    [pushSnack, t, onImported, resetState, onClose],
  );

  /** Run a batch of ImportItems through the backend, one by one. Returns the batch outcome: the count
   *  committed, the per-item failures (label + kind) for the in-modal list, the failed ITEMS (retained
   *  for «Повторить»), and the last committed dest (for onImported). A host+user duplicate is
   *  AUTO-copied «(копия N)» Rust-side per file (IN-36). D-29: only the item label (basename) + reason
   *  is ever logged — never the file content / password. This is the SINGLE batch pipeline shared by
   *  both import doors (picker + drag-drop, 19-04). */
  const importItems = useCallback(
    async (items: ImportItem[]) => {
      let ok = 0;
      const failed: PartialResult["failed"] = [];
      const failedItems: ImportItem[] = [];
      let lastPath: string | undefined;
      for (const item of items) {
        try {
          const dest = await item.run();
          ok++;
          lastPath = dest;
        } catch (itemErr) {
          // CA-3: no silent `catch {}` — DEV-mirror a SANITIZED trail (reason + label only, D-29) and
          // record the failure for the in-modal failed list + retry. A batch failure is always a file
          // import failure → `invalid-file` (both doors carry files).
          failed.push({ label: item.label, reason: "invalid-file" });
          failedItems.push(item);
          logImportFailure(itemErr, item.label);
        }
      }
      return { ok, failed, failedItems, lastPath };
    },
    [],
  );

  /** Build the picker door's ImportItem from an OS path: read the file Rust-side, then import it. The
   *  basename is preserved as the originalFileName so the stored config keeps its branded
   *  «[<CC>_]TrustTunnel_<login>.toml» name, and is ALSO the only per-file label we surface/log (never
   *  the path body, never the config content — D-29). */
  const pathToItem = useCallback(
    (path: string): ImportItem => {
      const basename = path.split(/[\\/]/).pop() || path;
      return {
        label: basename,
        run: async () => {
          const content = await invoke<string>("read_config_file_for_import", { path });
          return invoke<string>("import_config_from_string", {
            content,
            source: "file",
            originalFileName: basename,
          });
        },
      };
    },
    [],
  );

  /** Resolve a finished batch (from the initial pick OR a «Повторить») into UI: commit the
   *  successful configs (onImported reloads the whole manifest, so passing the last dest suffices),
   *  then EITHER close with a success snackbar (nothing failed) OR keep the result IN-MODAL as a
   *  warning / all-failed PartialResult (never a flyaway toast, D-09). */
  const finishBatch = useCallback(
    (r: { ok: number; failed: PartialResult["failed"]; failedItems: ImportItem[]; lastPath?: string }) => {
      if (r.ok > 0 && r.lastPath) onImported(r.lastPath);
      if (r.failed.length === 0) {
        // Full success: one batch snackbar + close (unchanged behavior).
        pushSnack(
          r.ok === 1
            ? t("connection.snackbar.config_added")
            : // IN-05 (19-fix): the batch copy now lives in ru.json (config_added_batch) instead of a
              // hardcoded «Добавлено …» literal. Russian declension still comes from pluralRu (interpolated
              // as {{plural}}); English uses its own i18next _one/_other count key.
              i18n.language === "ru"
              ? t("connection.import.config_added_batch", {
                  plural: pluralRu(r.ok, "конфиг", "конфига", "конфигов"),
                })
              : t("drop.configs_added", { count: r.ok }),
        );
        resetState();
        onClose();
        return;
      }
      // Partial (ok>0) OR all-failed (ok===0): the result STAYS in the modal so the user sees WHICH
      // files failed and retries ONLY those. A success snackbar fires ONLY when nothing failed.
      setPartial({ ok: r.ok, failed: r.failed });
      setRetryItems(r.failedItems);
      setLoading(false);
    },
    [onImported, pushSnack, t, i18n, resetState, onClose],
  );

  /** «Из файла» — OS picker → read each picked file Rust-side → import them ALL. IN-42: the picker
   *  is MULTI-select (parity with drag-drop), so several configs add at once. The outcome (full
   *  success / partial / all-failed) is resolved by finishBatch (D-09). */
  const handlePickFile = useCallback(async () => {
    setError(null);
    setPartial(null);
    setRetryItems([]);
    let paths: string[];
    try {
      const picked = await open({
        multiple: true,
        filters: [{ name: "TrustTunnel Config", extensions: ["toml"] }],
      });
      // plugin-dialog returns string[] for multiple; normalize defensively (a shim may hand back
      // a bare string) and bail on cancel (null).
      paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    } catch (dialogErr) {
      // A failure to OPEN the picker (not a cancel — cancel resolves to null) is a real fault worth
      // a DEV trail; treat as "no files picked" for the flow. D-29-safe (no content here).
      logImportFailure(dialogErr, "picker");
      paths = [];
    }
    if (paths.length === 0) return;
    setLoading(true);
    finishBatch(await importItems(paths.map(pathToItem)));
  }, [importItems, pathToItem, finishBatch]);

  /** «Повторить» — re-run the import over ONLY the retained failed items (retry-only-failed, D-09).
   *  The already-committed configs are untouched; a fresh PartialResult reflects this attempt. Works
   *  identically for a picker batch and a drag-drop batch (19-04): each ImportItem re-runs its OWN
   *  source (a re-read of the picked path, or a re-run of the SAME dropped file — no new payload). */
  const handleRetry = useCallback(async () => {
    if (retryItems.length === 0) return;
    setError(null);
    setLoading(true);
    finishBatch(await importItems(retryItems));
  }, [retryItems, importItems, finishBatch]);

  /** «Импортировать» — decode the tt:// link, then route the decoded TOML through import. */
  const handleImportLink = useCallback(async () => {
    if (!isValidLink) return; // explicit-click guard; deeplink-never-auto
    setLoading(true);
    setError(null);
    try {
      const content = await invoke<string>("decode_deeplink", { url: trimmedLink });
      await runImport(content, "deeplink");
    } catch (err) {
      // CA-3: the decode failure was swallowed — mirror a sanitized trail (the tt:// link is opaque
      // ASCII, but log only the reason label, never the decoded content). D-29-safe.
      logImportFailure(err, "deeplink-decode");
      setError(t("connection.import.error_invalid_link"));
      setLoading(false);
    }
  }, [isValidLink, trimmedLink, runImport, t]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      role="dialog"
      ariaModal
      ariaLabelledby="import-modal-title"
      size="md"
      showCloseButton
      // During an in-flight import the modal must NOT be dismissable by ANY path.
      closeButtonDisabled={loading}
      closeOnBackdrop={!loading}
      closeOnEscape={!loading}
    >
      <h2
        id="import-modal-title"
        className="mb-[var(--space-3)] text-lg font-semibold text-[var(--color-text-primary)]"
      >
        {t("connection.import.title")}
      </h2>

      {/* Drag-hover surface (config-only). The body beneath is made non-interactive so the
          tiles can't be hovered THROUGH the overlay. */}
      <DropOverlay isDragging={isDragging} hint={t("drop.config_only_hint", "Только файл конфига в формате .toml")} />

      <div className={isDragging ? "pointer-events-none" : undefined}>
        {/* In-modal error (modal STAYS OPEN). */}
        {error && (
          <div className="mb-[var(--space-3)]">
            <ErrorBanner variant="error" message={error} onDismiss={() => setError(null)} />
          </div>
        )}

        {partial ? (
          /* D-09: rich partial-import result (ports ImportModal.stories.tsx). The successful configs
             are already committed to the list; the result STAYS in-modal — a WARNING banner (or a red
             all-failed banner when ok===0), a list of ONLY the failed files with a short reason, and
             «Повторить» that retries ONLY the failed items. Never a flyaway toast; a success snackbar
             fires only when nothing failed. */
          <div className="flex flex-col gap-[var(--space-3)]">
            <ErrorBanner
              // ErrorBanner's canonical `variant` prop (naming.md) drives the tint; the same kind is
              // ALSO surfaced as data-variant so behavior tests assert the kind, not a CSS class.
              variant={partial.ok === 0 ? "error" : "warning"}
              data-variant={partial.ok === 0 ? "error" : "warning"}
              message={
                partial.ok === 0
                  ? t("connection.import.all_failed", { total: partial.failed.length })
                  : t("connection.import.partial_ok_failed", {
                      // Russian падежи come from pluralRu («3 конфига»); English uses the i18next
                      // one/other count key — same split as the batch snackbar above.
                      ok_plural:
                        i18n.language === "ru"
                          ? pluralRu(partial.ok, "конфиг", "конфига", "конфигов")
                          : t("connection.import.config_count", { count: partial.ok }),
                      failed: partial.failed.length,
                    })
              }
            />
            {/* Only the FAILED items are listed — the imported ones are already in the list, so
                re-listing them would duplicate info. Each row: source label — short reason. */}
            <ul className="flex flex-col gap-[var(--space-1)] text-xs">
              {partial.failed.map((f, i) => (
                <li key={i} className="flex min-w-0 items-center gap-[var(--space-2)]">
                  <span className="min-w-0 truncate font-mono text-[var(--color-text-secondary)]">
                    {f.label}
                  </span>
                  <span aria-hidden className="shrink-0 select-none text-[var(--color-text-muted)]">
                    —
                  </span>
                  <span className="shrink-0 text-[var(--color-text-muted)]">
                    {t(REASON_KEY[f.reason])}
                  </span>
                </li>
              ))}
            </ul>
            {/* Only «Повторить» — the corner × already closes the modal, so a redundant done/cancel
                button is dropped. «Повторить» re-attempts ONLY the failed items (imported ones are
                saved) and is locked (spinner) while that retry is in flight. */}
            <div className="flex justify-end">
              <Button variant="primary" size="sm" loading={loading} onClick={handleRetry}>
                {t("connection.import.retry")}
              </Button>
            </div>
          </div>
        ) : linkExpanded ? (
          /* «По ссылке» expanded: ASCII-only Input + primary «Импортировать» on the right,
             enabled only for a valid tt:// / trusttunnel:// link. */
          <div className="flex flex-col gap-[var(--space-3)]">
            <Input
              label={t("connection.import.tile_link")}
              placeholder={t("connection.import.link_placeholder")}
              value={link}
              onChange={(e) => {
                // ASCII-only — a deeplink payload is base64/opaque ASCII, never cyrillic.
                setLink(e.target.value.replace(/[^\x20-\x7E]/g, ""));
              }}
              clearable
              disabled={loading}
              error={showLinkError ? t("connection.import.error_invalid_link") : undefined}
              helperText={t("connection.import.link_supported_hint")}
            />
            <div className="flex justify-end">
              <Button
                variant="primary"
                size="sm"
                loading={loading}
                disabled={importDisabled}
                onClick={handleImportLink}
              >
                {t("connection.import.cta")}
              </Button>
            </div>
          </div>
        ) : (
          /* Resting: two compact tiles side by side + drag hint. */
          <div className="flex flex-col gap-[var(--space-3)]">
            <div className="grid grid-cols-2 gap-[var(--space-3)]">
              <EntryTile
                icon={<FileUp className="h-6 w-6" />}
                label={t("connection.import.tile_file")}
                caption={t("connection.import.tile_file_hint")}
                onClick={handlePickFile}
                // D-13: «Из файла» imports directly on pick → lock it while switching too.
                disabled={loading || isSwitching}
              />
              <EntryTile
                icon={<Link2 className="h-6 w-6" />}
                label={t("connection.import.tile_link")}
                caption={t("connection.import.tile_link_hint")}
                onClick={() => setLinkExpanded(true)}
                // D-13: keep the door consistent — no entry into an import flow while switching.
                disabled={loading || isSwitching}
              />
            </div>
            <p className="text-center text-xs text-[var(--color-text-muted)]">
              {t("connection.import.drag_hint")}
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}
