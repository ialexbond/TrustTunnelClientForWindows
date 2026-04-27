import { useTranslation } from "react-i18next";
import { Copy, FileText } from "lucide-react";
import { Modal } from "../../shared/ui/Modal";
import { Button } from "../../shared/ui/Button";
import { useSnackBar } from "../../shared/ui/SnackBarContext";

export interface RawTomlModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Raw TOML content to display read-only. */
  content: string;
  /** Optional title override; defaults to «Показать сырой TOML». */
  title?: string;
  /** Optional filename badge (e.g. "vpn.toml") shown next to title. */
  fileLabel?: string;
}

/**
 * Phase 15 readonly raw-TOML preview modal.
 *
 * Lazy-mounted by AdvancedConfigAccordion when user clicks «Показать сырой TOML».
 * Read-only by design (Plan 05 — Phase 15 D-2 hybrid recommendation): для actual
 * field edits user uses Quick Settings (Plan 04) или per-section Modals (этот же
 * Plan 05 — VpnTomlSectionsModal). Raw editing — SSH-only, hint copy explains это.
 *
 * **T-03 invariant (Modal lifecycle):** Этот компонент НЕ делает early-return null
 * при `isOpen=false` — Modal primitive самостоятельно управляет 200ms exit-анимацией.
 * См. Modal.tsx JSDoc + memory/v3/design-system/known-issues.md #10.
 */
export function RawTomlModal({
  isOpen,
  onClose,
  content,
  title,
  fileLabel = "vpn.toml",
}: RawTomlModalProps) {
  const { t } = useTranslation();
  const pushSnack = useSnackBar();

  const handleCopy = async () => {
    // Optional-chain guards jsdom + http://insecure pages where clipboard is undefined.
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(content);
        pushSnack(t("server.config.copied_raw_toml"));
      } catch {
        pushSnack(t("server.config.copy_failed"), "error");
      }
    } else {
      pushSnack(t("server.config.copy_unsupported"), "error");
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title ?? t("server.config.show_raw_toml")}
      size="lg"
    >
      <div className="space-y-4">
        {/* File label + Copy button row */}
        <div className="flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-2 text-caption text-[var(--color-text-secondary)]">
            <FileText className="w-3.5 h-3.5" aria-hidden="true" />
            <span className="font-mono">{fileLabel}</span>
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void handleCopy()}
            aria-label={t("server.config.copy_raw_toml")}
          >
            <Copy className="w-3.5 h-3.5 mr-1.5" />
            {t("server.config.copy_raw_toml")}
          </Button>
        </div>

        {/* Raw TOML content — scrollable <pre> */}
        <pre
          data-testid="raw-toml-content"
          className="text-mono-sm whitespace-pre overflow-auto p-[var(--space-3)] rounded-[var(--radius-md)]"
          style={{
            backgroundColor: "var(--color-bg-primary)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-primary)",
            maxHeight: "60vh",
          }}
        >
          {content || t("server.config.empty_not_loaded")}
        </pre>

        {/* Readonly hint */}
        <p className="text-body-sm text-[var(--color-text-muted)]">
          {t("server.config.raw_toml_readonly_hint")}
        </p>

        {/* Footer — close button */}
        <div className="flex justify-end pt-2">
          <Button variant="secondary" onClick={onClose}>
            {t("buttons.close")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
