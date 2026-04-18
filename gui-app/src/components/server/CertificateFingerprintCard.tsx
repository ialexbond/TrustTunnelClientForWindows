import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, ShieldCheck, AlertTriangle } from "lucide-react";
import { Button } from "../../shared/ui/Button";
import { cn } from "../../shared/lib/cn";
import { formatError } from "../../shared/utils/formatError";

/**
 * CertificateFingerprintCard — D-6 certificate pinning UI sub-component.
 *
 * Shows inside UserModal «Параметры deeplink» when toggle_pin_cert is ON.
 *
 * Flow:
 *   1. Rendered when pinCert=true (controlled by parent Toggle).
 *   2. «Загрузить с endpoint» button → invoke server_fetch_endpoint_cert.
 *   3. On success: shows SHA-256 fingerprint + chain length, stores DER bytes.
 *   4. On error: shows error message + retry button.
 *   5. onFingerprintLoaded(derB64, fingerprint) called when cert loaded.
 *
 * Security: NoopVerifier is used server-side (user is pinning DER bytes, not
 * validating CA trust). Fingerprint displayed so user can visually confirm.
 *
 * Storybook-only props _forceLoading, _forceError, _forceFingerprint
 * allow all states to be demonstrated without a backend.
 */
export interface CertificateFingerprintCardProps {
  /** SSH params forwarded to server_fetch_endpoint_cert. */
  sshParams: {
    host: string;
    port: number;
    user: string;
    password: string;
    keyPath?: string;
  };
  /**
   * Called when cert is successfully loaded.
   * @param derB64 - base64-encoded DER bytes (to embed in deeplink TLV 0x08)
   * @param fingerprint - human-readable SHA-256 hex fingerprint
   */
  onFingerprintLoaded: (derB64: string, fingerprint: string) => void;
  /** Called when cert is cleared (user toggles off externally, etc.) */
  onClear: () => void;
  disabled?: boolean;
  /** Storybook: force loading state. */
  _forceLoading?: boolean;
  /** Storybook: force error state. */
  _forceError?: string;
  /** Storybook: force loaded fingerprint. */
  _forceFingerprint?: string;
}

interface FetchedCert {
  fingerprint: string;
  derB64: string;
  chainLen: number;
}

export function CertificateFingerprintCard({
  sshParams,
  onFingerprintLoaded,
  onClear,
  disabled = false,
  _forceLoading,
  _forceError,
  _forceFingerprint,
}: CertificateFingerprintCardProps) {
  const { t } = useTranslation();
  const [fetchedCert, setFetchedCert] = useState<FetchedCert | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFetch = useCallback(async () => {
    if (_forceLoading) return;
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<{ leaf_der_b64: string; fingerprint_hex: string; chain_len: number }>(
        "server_fetch_endpoint_cert",
        {
          host: sshParams.host,
          port: sshParams.port,
          user: sshParams.user,
          password: sshParams.password,
          keyPath: sshParams.keyPath,
        }
      );
      const cert: FetchedCert = {
        fingerprint: result.fingerprint_hex,
        derB64: result.leaf_der_b64,
        chainLen: result.chain_len,
      };
      setFetchedCert(cert);
      onFingerprintLoaded(cert.derB64, cert.fingerprint);
    } catch (e) {
      setError(formatError(e));
    } finally {
      setLoading(false);
    }
  }, [sshParams, onFingerprintLoaded, _forceLoading]);

  const handleClear = useCallback(() => {
    setFetchedCert(null);
    setError(null);
    onClear();
  }, [onClear]);

  // Storybook overrides
  const effectiveLoading = _forceLoading ?? loading;
  const effectiveError = _forceError ?? error;
  const effectiveFingerprint = _forceFingerprint ?? fetchedCert?.fingerprint ?? null;
  const effectiveChainLen = fetchedCert?.chainLen ?? null;

  return (
    <div
      className={cn(
        "rounded-[var(--radius-md)] border border-[var(--color-border)]",
        "p-[var(--space-3)] bg-[var(--color-bg-elevated)]",
        "flex flex-col gap-[var(--space-2)]",
      )}
      data-testid="cert-fingerprint-card"
    >
      {effectiveLoading ? (
        <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
          <Loader2 className="w-4 h-4 animate-spin shrink-0" aria-hidden="true" />
          <span>{t("server.users.cert_fetching")}</span>
        </div>
      ) : effectiveFingerprint ? (
        <>
          {/* Success state: fingerprint displayed */}
          <div className="flex items-start gap-2">
            <ShieldCheck
              className="w-4 h-4 shrink-0 mt-0.5 text-[var(--color-status-connected)]"
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-[var(--font-weight-semibold)] text-[var(--color-text-secondary)] mb-1">
                {t("server.users.cert_fingerprint")}
              </p>
              <p
                className="text-xs font-mono break-all text-[var(--color-text-primary)]"
                data-testid="cert-fingerprint-value"
              >
                {effectiveFingerprint}
              </p>
              {effectiveChainLen !== null && (
                <p className="text-xs mt-1 text-[var(--color-text-muted)]">
                  Chain: {effectiveChainLen} {effectiveChainLen === 1 ? "cert" : "certs"}
                </p>
              )}
            </div>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleClear}
            disabled={disabled}
          >
            {t("server.users.cert_fetch_btn")}
          </Button>
        </>
      ) : effectiveError ? (
        <>
          {/* Error state */}
          <div className="flex items-start gap-2 text-sm text-[var(--color-status-error)]">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
            <span className="break-words">{effectiveError}</span>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void handleFetch()}
            disabled={disabled}
          >
            {t("buttons.retry")}
          </Button>
        </>
      ) : (
        /* Idle state: fetch button */
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => void handleFetch()}
          disabled={disabled}
          data-testid="cert-fetch-btn"
        >
          {t("server.users.cert_fetch_btn")}
        </Button>
      )}
    </div>
  );
}
