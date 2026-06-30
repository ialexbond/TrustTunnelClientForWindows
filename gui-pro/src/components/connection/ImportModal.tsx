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
import { pluralRu } from "../server/certUtils";

/**
 * Production ImportModal — the SINGLE point through which a config is added to the
 * «Подключение» tab (D-06). Pixel-mirrors `ImportModal.stories.tsx`: two compact tiles
 * («Из файла» / «По ссылке»), inline link-format validation (tt:// | trusttunnel://),
 * errors-in-modal (the modal STAYS OPEN, never a flyaway toast), and the in-flight
 * lock (× / backdrop / Escape all disabled while importing).
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

export function ImportModal({ isOpen, onClose, onImported, initialUrl, isDragging = false }: ImportModalProps) {
  const { t, i18n } = useTranslation();
  const pushSnack = useSnackBar();

  const [link, setLink] = useState("");
  const [linkExpanded, setLinkExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  // An in-modal error banner (modal stays open). null = none.
  const [error, setError] = useState<string | null>(null);

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

  const resetState = useCallback(() => {
    setLink("");
    setLinkExpanded(false);
    setLoading(false);
    setError(null);
  }, []);

  const handleClose = useCallback(() => {
    if (loading) return; // a half-done import cannot be cancelled by closing
    // IN-21: the «По ссылке» view is an INTERNAL view-state of THIS single modal (not a nested
    // modal). The corner ×, backdrop and Escape all route here, so from the link view a close must
    // step BACK to the file/link choice instead of dismissing the whole modal. Only the resting
    // choice view's close fully dismisses.
    if (linkExpanded) {
      setLinkExpanded(false);
      setLink("");
      setError(null);
      return;
    }
    resetState();
    onClose();
  }, [loading, linkExpanded, resetState, onClose]);

  // Link-format validation: «Импортировать» is enabled ONLY for a well-formed tt:// /
  // trusttunnel:// link. Empty = disabled, no error. A non-empty non-matching value reddens
  // the field inline (distinct from the post-submit error banner).
  const trimmedLink = link.trim();
  const isValidLink = /^(tt|trusttunnel):\/\/.+/i.test(trimmedLink);
  const showLinkError = trimmedLink !== "" && !isValidLink;
  const importDisabled = loading || !isValidLink;

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
      } catch {
        // Errors render IN-MODAL (the modal stays open) — never a flyaway toast.
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

  /** «Из файла» — OS picker → read each picked file Rust-side → import them ALL. IN-42: the
   *  picker is MULTI-select (parity with drag-drop), so several configs add at once. Each file
   *  goes through `import_config_from_string`, which AUTO-copies a host+user duplicate «(копия N)»
   *  (IN-36) per file. On success: one batch snackbar + onImported(last) + close; if NONE imported,
   *  the error stays in the modal. */
  const handlePickFile = useCallback(async () => {
    setError(null);
    let paths: string[];
    try {
      const picked = await open({
        multiple: true,
        filters: [{ name: "TrustTunnel Config", extensions: ["toml"] }],
      });
      // plugin-dialog returns string[] for multiple; normalize defensively (a shim may hand back
      // a bare string) and bail on cancel (null).
      paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    } catch {
      paths = [];
    }
    if (paths.length === 0) return;
    setLoading(true);
    let okCount = 0;
    let lastPath: string | undefined;
    for (const path of paths) {
      try {
        const content = await invoke<string>("read_config_file_for_import", { path });
        // Preserve each file's original filename (basename) so the stored config keeps its branded
        // «[<CC>_]TrustTunnel_<login>.toml» name instead of a content-derived one.
        const basename = path.split(/[\\/]/).pop() || undefined;
        const dest = await invoke<string>("import_config_from_string", {
          content,
          source: "file",
          originalFileName: basename ?? null,
        });
        okCount++;
        lastPath = dest;
      } catch {
        // Skip a bad file and keep importing the rest; reported below only if NONE succeeded.
      }
    }
    if (okCount === 0) {
      setError(t("connection.import.error_invalid_file"));
      setLoading(false);
      return;
    }
    // onImported (promoteImportedConfig) is idempotent and reloads the whole manifest, so every new
    // card appears even though only the last path is passed.
    onImported(lastPath!);
    pushSnack(
      okCount === 1
        ? t("connection.snackbar.config_added")
        : i18n.language === "ru"
          ? `Добавлено ${pluralRu(okCount, "конфиг", "конфига", "конфигов")}`
          : t("drop.configs_added", { count: okCount }),
    );
    resetState();
    onClose();
  }, [t, i18n, onImported, pushSnack, resetState, onClose]);

  /** «Импортировать» — decode the tt:// link, then route the decoded TOML through import. */
  const handleImportLink = useCallback(async () => {
    if (!isValidLink) return; // explicit-click guard; deeplink-never-auto
    setLoading(true);
    setError(null);
    try {
      const content = await invoke<string>("decode_deeplink", { url: trimmedLink });
      await runImport(content, "deeplink");
    } catch {
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

        {linkExpanded ? (
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
                disabled={loading}
              />
              <EntryTile
                icon={<Link2 className="h-6 w-6" />}
                label={t("connection.import.tile_link")}
                caption={t("connection.import.tile_link_hint")}
                onClick={() => setLinkExpanded(true)}
                disabled={loading}
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
