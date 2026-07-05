import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { QRCodeSVG } from "qrcode.react";
import { Copy } from "lucide-react";
import { Modal } from "../../shared/ui/Modal";
import { Button } from "../../shared/ui/Button";
import { ActionInput } from "../../shared/ui/ActionInput";
import { Tooltip } from "../../shared/ui/Tooltip";
import { Skeleton } from "../../shared/ui/Skeleton";
import { ErrorBanner } from "../../shared/ui/ErrorBanner";
import { useSnackBar } from "../../shared/ui/SnackBarContext";
import { formatError } from "../../shared/utils/formatError";
import type { ConfigSummary } from "../../shared/hooks/useConfigList";

/**
 * `ConfigQr` (production, Phase 15 Plan 03) — the «QR-код конфигурации» modal on the
 * «Подключение» tab. Opened from a config card's «…» overflow menu → «QR-код» (D-09).
 *
 * Built from the locked story `ConfigQr.stories.tsx` (owner-approved via Phase 10/11 UAT):
 * a config-name heading, a QR (displayed for scanning; clicking it copies the tt:// link —
 * the image-clipboard path was removed as it did not work in the WebView2), a read-only
 * «Ссылка» field carrying the deeplink with an inline copy icon, copy confirmations via the
 * shared SnackBar, and a «Закрыть» button.
 *
 * The ONE difference from the Control-Panel `UserConfigModal` QR (besides no «Скачать» button,
 * no warning label): the deeplink here is generated LOCALLY from THIS config's own data by the
 * plain (non-SSH) Tauri command `export_config_deeplink_local` (D-01) — the receiving device
 * needs no server round-trip. NEVER invoke any `server_export_config_deeplink*` (SSH) path.
 *
 * Decisions honoured:
 *   - D-01: link source is the LOCAL command only, never an SSH invoke.
 *   - D-07: no security/warning label — only the neutral locked caption.
 *   - D-08: copy-only — no «Скачать конфиг» / save-to-file button.
 *   - D-29: no link/config/credential is written to any log channel (this modal logs nothing).
 *
 * Close/lifecycle: mirrors UserConfigModal — the deeplink/loading/error state is NOT cleared on
 * `!isOpen` (Modal runs a 200ms exit animation and the content must stay rendered during it);
 * a delayed cleanup effect resets it 200ms after close so the modal never blanks mid-fade.
 */
export interface ConfigQrProps {
  isOpen: boolean;
  /** The config to transfer — `.name` feeds the heading, `.path` feeds the invoke arg. */
  config: ConfigSummary;
  onClose: () => void;
}

export function ConfigQr({ isOpen, config, onClose }: ConfigQrProps) {
  const { t } = useTranslation();
  const pushSuccess = useSnackBar();

  const [deeplink, setDeeplink] = useState<string | null>(null);
  const [deeplinkLoading, setDeeplinkLoading] = useState(false);
  const [deeplinkError, setDeeplinkError] = useState<string | null>(null);

  const configPath = config.path;

  // ── Shared deeplink fetch (used by the open effect + Retry) ──
  // The ONLY data source is the LOCAL command (D-01). The `isCancelled` helper drops a stale
  // reply if the config/path changes mid-flight.
  const fetchDeeplink = useCallback(
    async (isCancelled?: () => boolean) => {
      setDeeplinkLoading(true);
      setDeeplinkError(null);
      try {
        const link = await invoke<string>("export_config_deeplink_local", {
          configPath,
        });
        if (!isCancelled?.()) {
          setDeeplink(link);
          setDeeplinkError(null);
        }
      } catch (e) {
        if (!isCancelled?.()) setDeeplinkError(formatError(e));
      } finally {
        if (!isCancelled?.()) setDeeplinkLoading(false);
      }
    },
    [configPath],
  );

  // ── Fetch on open (and when the target config path changes) ──
  // NOTE: on close (!isOpen) we DO NOT clear state — the delayed cleanup effect below runs
  // 200ms later, matching the Modal exit animation, so the content stays rendered mid-fade.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void fetchDeeplink(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [isOpen, fetchDeeplink]);

  // ── Delayed cleanup after close (200ms = Modal exit animation) ──
  useEffect(() => {
    if (isOpen) return;
    const timer = setTimeout(() => {
      setDeeplink(null);
      setDeeplinkError(null);
      setDeeplinkLoading(false);
    }, 200);
    return () => clearTimeout(timer);
  }, [isOpen]);

  const handleRetry = () => {
    void fetchDeeplink();
  };

  // ── Copy the deeplink as TEXT → success snackbar (D-29: never log the payload). ──
  const handleCopyLink = async () => {
    if (!deeplink) return;
    try {
      await navigator.clipboard.writeText(deeplink);
      pushSuccess(t("connection.snackbar.link_copied"));
    } catch {
      // Silent — clipboard may be unavailable; nothing sensitive to surface.
    }
  };

  // ── Click the QR → copy the deeplink as TEXT. The QR image-clipboard path was removed:
  //    neither the web ClipboardItem nor the native writeImage worked reliably in the
  //    Tauri WebView2 (owner UAT: it kept copying the link anyway), so clicking the QR (a
  //    large target) copies the link — the same as the «Ссылка» copy button. The QR itself
  //    stays on screen for scanning. ──
  const handleCopyQr = async () => {
    if (!deeplink) return;
    try {
      await navigator.clipboard.writeText(deeplink);
      pushSuccess(t("connection.snackbar.link_copied"));
    } catch {
      // Silent — clipboard may be unavailable; nothing sensitive to surface.
    }
  };

  return (
    // Single close affordance = the Modal's corner × icon (`showCloseButton`), aria-label «Закрыть»
    // (owner decision 2026-07-03: keep ONE close element, the icon — drop the footer «Закрыть»
    // button). Backdrop-click + Escape also dismiss (Modal defaults). B-12's
    // `getByRole("button", {name:"Закрыть"})` now resolves to the corner × (the only «Закрыть»).
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
      showCloseButton
      role="dialog"
      ariaLabelledby="config-qr-title"
      ariaModal
    >
      <h2
        id="config-qr-title"
        className="text-lg font-semibold text-[var(--color-text-primary)]"
      >
        {t("connection.qr.title")}
      </h2>
      {/* Config name — one line only; a too-long name clips with an ellipsis (…). `title` exposes
          the full name on hover. `min-w-0` keeps `truncate` working even if the Modal panel is a
          flex container (a flex item defaults to min-width:auto and would otherwise overflow). */}
      <p
        className="mt-0.5 min-w-0 truncate text-sm text-[var(--color-text-secondary)]"
        title={config.name}
      >
        {config.name}
      </p>

      {deeplinkLoading ? (
        // Skeleton mirroring the final layout (QR + caption + link) MINUS the download row
        // (D-08 copy-only) — a simpler skeleton than the CP modal's.
        <div aria-busy="true" aria-label={t("common.loading")}>
          <div className="mt-[var(--space-4)] flex justify-center">
            <Skeleton variant="card" width={196} height={196} data-testid="qr-skeleton" />
          </div>
          <div className="mt-[var(--space-4)] flex justify-center">
            <Skeleton width={180} height={14} data-testid="caption-skeleton" />
          </div>
          <Skeleton
            className="mt-[var(--space-4)] w-full"
            height={32}
            data-testid="link-skeleton"
          />
        </div>
      ) : deeplinkError ? (
        // Error → an ErrorBanner (role="alert" via the error variant) + a full-width Retry that
        // re-invokes the local command.
        <div className="mt-[var(--space-4)] flex flex-col gap-[var(--space-3)]">
          <ErrorBanner variant="error" message={deeplinkError} className="w-full" />
          <Button variant="secondary" fullWidth onClick={handleRetry}>
            {t("connection.qr.retry")}
          </Button>
        </div>
      ) : deeplink ? (
        <>
          {/* QR — clickable: copies the deeplink as TEXT (writeText), with a small press animation.
              The image-clipboard path was removed — it did not work in WebView2 (see handleCopyQr). */}
          <div className="mt-[var(--space-4)] flex justify-center">
            <button
              type="button"
              aria-label={t("connection.qr.qr_aria")}
              onClick={() => void handleCopyQr()}
              className="rounded-[var(--radius-md)] bg-[var(--color-bg-elevated)] p-[var(--space-4)] outline-none transition-transform duration-[var(--transition-fast)] active:scale-[0.98] focus-visible:shadow-[var(--focus-ring)]"
            >
              <div>
                <QRCodeSVG
                  value={deeplink}
                  size={196}
                  bgColor="transparent"
                  fgColor="currentColor"
                  level="M"
                  className="text-[var(--color-text-primary)]"
                />
              </div>
            </button>
          </div>

          <div className="mt-[var(--space-4)]">
            <label className="mb-1.5 block text-sm font-medium text-[var(--color-text-secondary)]">
              {t("connection.qr.link")}
            </label>
            {/* Copy is an icon INSIDE the field (ActionInput action). Click → clipboard + success
                snackbar (the canonical UserConfigModal pattern), with a small press animation. */}
            <ActionInput
              value={deeplink}
              readOnly
              aria-label={t("connection.qr.link_aria")}
              actions={[
                <Tooltip key="copy" text={t("connection.qr.copy_link")}>
                  <button
                    type="button"
                    aria-label={t("connection.qr.copy_link")}
                    onClick={() => void handleCopyLink()}
                    className="flex items-center rounded p-1 text-[var(--color-text-muted)] transition-[color,transform] duration-[var(--transition-fast)] hover:text-[var(--color-text-primary)] active:scale-[0.92]"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </Tooltip>,
              ]}
            />
          </div>

          {/* Neutral caption — NO security/warning label (D-07). */}
          <p className="mt-[var(--space-3)] text-xs text-[var(--color-text-muted)]">
            {t("connection.qr.hint")}
          </p>
        </>
      ) : null}
    </Modal>
  );
}
