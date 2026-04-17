import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { X, Copy, Download, Loader2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { Modal } from "../../shared/ui/Modal";
import { Button } from "../../shared/ui/Button";

/**
 * UserConfigModal — Phase 14 Plan 01 STUB.
 *
 * This file ships the props contract and a static visual placeholder for
 * the UsersSection storybook mockup (14-01). Plan 04 will replace the
 * internals with the real invoke() + clipboard + save() flow. Do not use
 * `_deeplinkOverride`, `_forceLoading`, or `_forceError` in production
 * code paths — they are Storybook-only escape hatches so stories can
 * demonstrate every visual state without depending on backend SSH.
 *
 * Structure mirrors 14-UI-SPEC Surface 2:
 *   - X close button (top-right, absolute)
 *   - QR code (240×240, clickable to copy image per D-09)
 *   - "Scan in the TrustTunnel mobile app" caption
 *   - Read-only deeplink input with inline Copy action
 *   - Primary Download button (fullWidth)
 *
 * Close policy (D-10): backdrop click + Escape + X icon. No "Done" CTA.
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
  /** Storybook-only: force the loading state (spinner + skeleton). */
  _forceLoading?: boolean;
  /** Storybook-only: force the error state with the provided message. */
  _forceError?: string;
}

export function UserConfigModal({
  isOpen,
  username,
  onClose,
  _deeplinkOverride,
  _forceLoading,
  _forceError,
}: UserConfigModalProps) {
  const { t } = useTranslation();
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Auto-focus the close button once the enter animation settles.
  useEffect(() => {
    if (!isOpen) return;
    const timer = setTimeout(() => {
      closeButtonRef.current?.focus();
    }, 250);
    return () => clearTimeout(timer);
  }, [isOpen]);

  if (!isOpen) return null;

  // Placeholder deeplink for stub rendering; Plan 04 invokes the SSH command.
  const deeplink =
    _deeplinkOverride ??
    (username
      ? `tt://example.com/config?user=${username}&token=placeholder`
      : "");

  return (
    <Modal isOpen={isOpen} onClose={onClose} closeOnBackdrop closeOnEscape>
      <button
        ref={closeButtonRef}
        type="button"
        aria-label={t("buttons.close")}
        onClick={onClose}
        className="absolute top-3 right-3 p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors focus-visible:shadow-[var(--focus-ring)] outline-none"
      >
        <X className="w-4 h-4" />
      </button>

      {_forceLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2
            className="w-8 h-8 animate-spin"
            style={{ color: "var(--color-accent-500)" }}
          />
        </div>
      ) : _forceError ? (
        <p
          className="text-xs py-4 text-center"
          style={{ color: "var(--color-status-error)" }}
        >
          {_forceError}
        </p>
      ) : (
        <>
          <div className="flex justify-center">
            <button
              type="button"
              aria-label={t("server.users.qr_click_to_copy")}
              className="rounded-md p-2 cursor-pointer hover:opacity-100 focus-visible:shadow-[var(--focus-ring)] outline-none transition-opacity"
              style={{ opacity: 0.85 }}
            >
              <QRCodeSVG
                value={deeplink}
                size={240}
                bgColor="transparent"
                fgColor="currentColor"
                level="M"
                style={{ color: "var(--color-text-primary)" }}
              />
            </button>
          </div>

          <p
            className="text-xs text-center mt-[var(--space-2)]"
            style={{ color: "var(--color-text-muted)" }}
          >
            {t("server.export.scan_qr")}
          </p>

          <div className="relative mt-[var(--space-4)]">
            <input
              type="text"
              readOnly
              value={deeplink}
              aria-label={t("server.users.deeplink_aria")}
              className="h-8 w-full pl-3 pr-10 text-sm font-mono rounded-[var(--radius-md)] border border-[var(--color-input-border)] bg-[var(--color-input-bg)] text-[var(--color-text-primary)] outline-none focus-visible:border-[var(--color-input-focus)] focus-visible:shadow-[var(--focus-ring)]"
            />
            <button
              type="button"
              aria-label={t("server.users.copy_deeplink_tooltip")}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition-colors focus-visible:shadow-[var(--focus-ring)] outline-none"
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
          </div>

          <Button
            variant="primary"
            fullWidth
            icon={<Download className="w-3.5 h-3.5" />}
            className="mt-[var(--space-3)]"
          >
            {t("server.users.download_config")}
          </Button>
        </>
      )}
    </Modal>
  );
}
