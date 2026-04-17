import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { X, Copy, Download, Loader2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { Modal } from "../../shared/ui/Modal";
import { Button } from "../../shared/ui/Button";
import { ErrorBanner } from "../../shared/ui/ErrorBanner";
import { useSnackBar } from "../../shared/ui/SnackBarContext";
import { useActivityLog } from "../../shared/hooks/useActivityLog";
import { formatError } from "../../shared/utils/formatError";
import { cn } from "../../shared/lib/cn";

/**
 * UserConfigModal — Phase 14 Plan 04 production implementation.
 *
 * Used from two entry points (D-07):
 *   1. Click on the FileText icon in a user row (UsersSection).
 *   2. Automatic open after a successful add_server_user invoke.
 *
 * Flow:
 *   - On open: invoke("server_export_config_deeplink") to fetch the tt:// URL.
 *   - QR is clickable (D-09): rasterizes SVG to PNG via canvas, writes the
 *     image to the clipboard with ClipboardItem. Falls back gracefully to
 *     copy-text when ClipboardItem is unavailable.
 *   - Read-only deeplink input + inline Copy icon writes text via
 *     navigator.clipboard.writeText.
 *   - Download button: fetch_server_config → save() dialog → copy_file.
 *
 * Close policy (D-10): backdrop click + Escape + X icon. No "Done" CTA.
 *
 * Security invariants (D-29):
 *   - Password values and deeplink content NEVER appear in activityLog payloads.
 *   - Only `user=<name>` is logged — usernames are non-sensitive.
 *
 * Storybook-only props `_deeplinkOverride`, `_forceLoading`, `_forceError`
 * are escape hatches so stories can demonstrate every state without a
 * backend. Production call sites never pass these.
 */
export interface UserConfigModalProps {
  isOpen: boolean;
  username: string | null;
  sshParams: {
    host: string;
    port: number;
    user: string;
    password: string;
    keyPath?: string;
  };
  onClose: () => void;
  /** Storybook-only: bypass backend deeplink fetch. */
  _deeplinkOverride?: string;
  /** Storybook-only: force the loading state (spinner). */
  _forceLoading?: boolean;
  /** Storybook-only: force the error state with the provided message. */
  _forceError?: string;
}

export function UserConfigModal({
  isOpen,
  username,
  sshParams,
  onClose,
  _deeplinkOverride,
  _forceLoading,
  _forceError,
}: UserConfigModalProps) {
  const { t } = useTranslation();
  const pushSuccess = useSnackBar();
  const { log: activityLog } = useActivityLog();

  const [deeplink, setDeeplink] = useState<string | null>(null);
  const [deeplinkLoading, setDeeplinkLoading] = useState(false);
  const [deeplinkError, setDeeplinkError] = useState<string | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);

  const qrContainerRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // ── Shared deeplink fetch (used by effect + Retry) — WR-04 deduplication. ──
  // WR-05: depend on primitives (host/port/user) rather than the sshParams object
  // reference, so non-memoized parents don't trigger extra fetches. Parent
  // currently memoizes sshParams in useServerState, but this is defense in depth.
  // WR-06: the cancelled-flag helper is closed over by useEffect to drop stale
  // replies when username/sshParams change mid-flight.
  const { host: sshHost, port: sshPort, user: sshUser, password: sshPassword, keyPath: sshKeyPath } = sshParams;
  const fetchDeeplink = useCallback(
    async (isCancelled?: () => boolean) => {
      if (!username) return;
      setDeeplinkLoading(true);
      setDeeplinkError(null);
      try {
        const link = await invoke<string>("server_export_config_deeplink", {
          host: sshHost,
          port: sshPort,
          user: sshUser,
          password: sshPassword,
          keyPath: sshKeyPath,
          clientName: username,
        });
        if (!isCancelled?.()) setDeeplink(link);
      } catch (e) {
        if (!isCancelled?.()) setDeeplinkError(formatError(e));
      } finally {
        if (!isCancelled?.()) setDeeplinkLoading(false);
      }
    },
    [username, sshHost, sshPort, sshUser, sshPassword, sshKeyPath],
  );

  // ── Fetch deeplink when opening ──
  useEffect(() => {
    if (!isOpen || !username) {
      setDeeplink(null);
      setDeeplinkError(null);
      setDeeplinkLoading(false);
      return;
    }
    // Storybook escape hatches short-circuit the invoke path.
    if (_forceLoading || _forceError !== undefined) {
      setDeeplinkLoading(false);
      return;
    }
    if (_deeplinkOverride !== undefined) {
      setDeeplink(_deeplinkOverride);
      setDeeplinkError(null);
      setDeeplinkLoading(false);
      return;
    }
    let cancelled = false;
    void fetchDeeplink(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [isOpen, username, _deeplinkOverride, _forceLoading, _forceError, fetchDeeplink]);

  // ── Auto-focus X button on open (Modal primitive does not trap focus) ──
  useEffect(() => {
    if (!isOpen) return;
    const timer = setTimeout(() => closeButtonRef.current?.focus(), 250);
    return () => clearTimeout(timer);
  }, [isOpen]);

  // ── Retry deeplink fetch after an error (WR-04 dedup). ──
  const handleRetry = () => {
    void fetchDeeplink();
  };

  // ── Copy deeplink text (D-23) ──
  const handleCopyLink = async () => {
    if (!deeplink || !username) return;
    try {
      await navigator.clipboard.writeText(deeplink);
      activityLog("USER", `user.config.link_copied user=${username}`);
      pushSuccess(t("server.users.link_copied"));
    } catch (e) {
      activityLog("ERROR", `user.config.link_copy_failed err=${formatError(e)}`);
    }
  };

  // ── Copy QR as PNG image to clipboard (D-09) ──
  const handleCopyQr = async () => {
    if (!deeplink || !username) return;

    // Feature-detect: fallback to text-copy when ClipboardItem is unavailable.
    if (typeof ClipboardItem === "undefined") {
      try {
        await navigator.clipboard.writeText(deeplink);
        activityLog(
          "USER",
          `user.config.link_copied user=${username} fallback=no-clipboarditem`,
        );
        pushSuccess(t("server.users.link_copied"));
      } catch (e) {
        activityLog(
          "ERROR",
          `user.config.qr_copy_failed err=${formatError(e)}`,
        );
      }
      return;
    }

    const svg = qrContainerRef.current?.querySelector("svg");
    if (!svg) return;

    try {
      const svgData = new XMLSerializer().serializeToString(svg);
      const svgBlob = new Blob([svgData], {
        type: "image/svg+xml;charset=utf-8",
      });
      const svgUrl = URL.createObjectURL(svgBlob);

      // WR-01: try/finally guarantees revokeObjectURL on every path
      // (including img.onerror reject and canvas.toBlob reject).
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 240;
        canvas.height = 240;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        // Paint white background — без fillRect PNG может выглядеть чёрным
        // при paste в некоторых target-приложениях (alpha handling в Paint).
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, 240, 240);

        const img = new Image();
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error("QR image load failed"));
          img.src = svgUrl;
        });
        ctx.drawImage(img, 0, 0, 240, 240);

        const blob: Blob = await new Promise((resolve, reject) => {
          canvas.toBlob((b) => {
            if (b) resolve(b);
            else reject(new Error("Canvas toBlob returned null"));
          }, "image/png");
        });

        await navigator.clipboard.write([
          new ClipboardItem({ "image/png": blob }),
        ]);
        activityLog("USER", `user.config.qr_copied user=${username}`);
        pushSuccess(t("server.users.qr_copied"));
      } finally {
        URL.revokeObjectURL(svgUrl);
      }
    } catch (e) {
      activityLog("ERROR", `user.config.qr_copy_failed err=${formatError(e)}`);
      // Graceful fallback: copy text so the user at least gets something.
      try {
        await navigator.clipboard.writeText(deeplink);
        pushSuccess(t("server.users.link_copied"));
      } catch {
        // Silent — nothing else we can do.
      }
    }
  };

  // ── Download .toml file (D-27) ──
  const handleDownload = async () => {
    if (!username) return;
    setIsDownloading(true);
    activityLog("USER", `user.config.download_initiated user=${username}`);
    try {
      const path = await invoke<string>("fetch_server_config", {
        ...sshParams,
        clientName: username,
      });
      const dest = await save({
        defaultPath: `trusttunnel_${username}.toml`,
        filters: [{ name: "TOML Config", extensions: ["toml"] }],
      });
      if (dest) {
        await invoke("copy_file", { source: path, destination: dest });
        activityLog("STATE", `user.config.downloaded user=${username}`);
        pushSuccess(t("server.users.config_saved", { user: username }));
      }
      // dest === null → user cancelled save dialog — silently return.
    } catch (e) {
      activityLog("ERROR", `user.config.download_failed err=${formatError(e)}`);
      pushSuccess(formatError(e), "error");
    } finally {
      setIsDownloading(false);
    }
  };

  // ── Storybook state overrides (props take priority over runtime state) ──
  const effectiveLoading = _forceLoading ?? deeplinkLoading;
  const effectiveError = _forceError ?? deeplinkError;
  const effectiveDeeplink = effectiveError ? null : deeplink ?? "";

  if (!isOpen) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      closeOnBackdrop
      closeOnEscape
      size="md"
      className="relative"
    >
      {/* X close button — absolute top-right (D-10, D-11). */}
      <button
        ref={closeButtonRef}
        type="button"
        aria-label={t("buttons.close")}
        onClick={onClose}
        className={cn(
          "absolute top-3 right-3 p-1 rounded",
          "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]",
          "focus-visible:shadow-[var(--focus-ring)] outline-none",
          "transition-colors",
        )}
      >
        <X className="w-4 h-4" />
      </button>

      {effectiveLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2
            className="w-8 h-8 animate-spin"
            style={{ color: "var(--color-accent-500)" }}
          />
        </div>
      ) : effectiveError ? (
        <div className="py-4">
          <ErrorBanner severity="error" message={effectiveError} />
          <Button
            variant="secondary"
            onClick={handleRetry}
            className="mt-[var(--space-3)]"
          >
            {t("buttons.retry")}
          </Button>
        </div>
      ) : effectiveDeeplink ? (
        <>
          {/* QR code — clickable, copies PNG to clipboard (D-09). */}
          <div className="flex justify-center">
            <button
              type="button"
              aria-label={t("server.users.qr_click_to_copy")}
              onClick={() => void handleCopyQr()}
              className={cn(
                "rounded-md p-2 transition-all cursor-pointer",
                "hover:opacity-100 active:scale-[0.98]",
                "focus-visible:shadow-[var(--focus-ring)] outline-none",
              )}
              style={{ opacity: 0.85 }}
            >
              <div ref={qrContainerRef}>
                <QRCodeSVG
                  value={effectiveDeeplink}
                  size={240}
                  bgColor="transparent"
                  fgColor="currentColor"
                  level="M"
                  style={{ color: "var(--color-text-primary)" }}
                />
              </div>
            </button>
          </div>

          {/* Caption under QR. */}
          <p
            className="text-xs text-center mt-[var(--space-2)]"
            style={{ color: "var(--color-text-muted)" }}
          >
            {t("server.export.scan_qr")}
          </p>

          {/* Deeplink read-only input with Copy icon. */}
          <div className="relative mt-[var(--space-4)]">
            <input
              type="text"
              readOnly
              value={effectiveDeeplink}
              aria-label={t("server.users.deeplink_aria")}
              onFocus={(e) => e.currentTarget.select()}
              className={cn(
                "h-8 w-full pl-3 pr-10 text-sm font-mono rounded-[var(--radius-md)]",
                "border border-[var(--color-input-border)]",
                "bg-[var(--color-input-bg)]",
                "text-[var(--color-text-primary)]",
                "outline-none",
                "focus-visible:border-[var(--color-input-focus)] focus-visible:shadow-[var(--focus-ring)]",
              )}
            />
            <button
              type="button"
              aria-label={t("server.users.copy_deeplink_tooltip")}
              onClick={() => void handleCopyLink()}
              className={cn(
                "absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded",
                "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]",
                "focus-visible:shadow-[var(--focus-ring)] outline-none",
                "transition-colors",
              )}
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Download button. */}
          <Button
            variant="primary"
            fullWidth
            icon={
              isDownloading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Download className="w-3.5 h-3.5" />
              )
            }
            loading={isDownloading}
            disabled={isDownloading}
            onClick={() => void handleDownload()}
            className="mt-[var(--space-3)]"
          >
            {t("server.users.download_config")}
          </Button>
        </>
      ) : null}
    </Modal>
  );
}
