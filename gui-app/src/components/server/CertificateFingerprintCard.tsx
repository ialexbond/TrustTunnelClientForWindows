import { useState, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, ShieldCheck, AlertTriangle } from "lucide-react";
import { Button } from "../../shared/ui/Button";
import { NumberInput } from "../../shared/ui/NumberInput";
import { cn } from "../../shared/lib/cn";
import { formatError } from "../../shared/utils/formatError";
import { formatFingerprintForDisplay } from "../../shared/utils/userAdvanced";
import { useActivityLog } from "../../shared/hooks/useActivityLog";

/** Default TLS port for TrustTunnel endpoints per PROTOCOL.md §2 (443). */
const DEFAULT_CERT_PORT = 443;

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
  /** SSH params forwarded to server_fetch_endpoint_cert (for pool lookup). */
  sshParams: {
    host: string;
    port: number;
    user: string;
    password: string;
    keyPath?: string;
  };
  /**
   * FQDN or IP to probe for TLS cert. If empty/omitted, falls back to sshParams.host.
   * Typically the Custom SNI from the deeplink section, so fingerprint matches what
   * the Light client will see during handshake.
   */
  customSni?: string;
  /**
   * TLS port for the endpoint probe. Defaults to 443 (TrustTunnel default per PROTOCOL.md §2).
   */
  endpointPort?: number;
  /**
   * Called when cert is successfully loaded.
   * @param derB64 - base64-encoded DER chain (leaf + intermediates, to embed in deeplink TLV 0x08)
   * @param fingerprint - human-readable SHA-256 hex fingerprint (leaf only)
   * @param isSystemVerifiable - FIX-OO-7: true when the chain already verifies
   *   against the OS root store. UserModal uses this to strip the cert from
   *   the deeplink payload — a ~3 KB chain would otherwise overflow QR code
   *   capacity (binary mode ECC-M caps at ~2.3 KB). The sidecar's own
   *   platform verifier takes over at connect time.
   */
  onFingerprintLoaded: (derB64: string, fingerprint: string, isSystemVerifiable: boolean) => void;
  /** Called when cert is cleared (user toggles off externally, etc.) */
  onClear: () => void;
  disabled?: boolean;
  /**
   * CRIT-2: pre-loaded fingerprint & DER to hydrate the success state
   * without re-probing. Used in Edit mode: UserModal fetches
   * users-advanced.toml, gets back the pin the user saved, passes both
   * values in. Without this the card always boots into the «Загрузить»
   * idle state on reopen, even though the cert is already pinned in
   * storage and embedded in the deeplink.
   */
  initialFingerprint?: string | null;
  initialDerB64?: string | null;
  initialIsSystemVerifiable?: boolean;
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
  // FIX-OO-7: backend-computed flag; true when the chain verified against
  // the OS root store during the probe.
  isSystemVerifiable: boolean;
}

export function CertificateFingerprintCard({
  sshParams,
  customSni,
  endpointPort = DEFAULT_CERT_PORT,
  onFingerprintLoaded,
  onClear,
  disabled = false,
  initialFingerprint,
  initialDerB64,
  initialIsSystemVerifiable,
  _forceLoading,
  _forceError,
  _forceFingerprint,
}: CertificateFingerprintCardProps) {
  const { t } = useTranslation();
  const { log: activityLog } = useActivityLog();
  // CRIT-2: seed the fetchedCert state from the parent-provided props so the
  // card mounts into the success-state (fingerprint + Отвязать/Обновить) when
  // the user reopens Edit on a pin that was previously saved. chainLen isn't
  // persisted separately; we reconstruct a usable approximation from DER size
  // later at render time. The seed runs only on initial mount — subsequent
  // prop changes go through onFingerprintLoaded/onClear (otherwise revert
  // would fight the live fetch state).
  const [fetchedCert, setFetchedCert] = useState<FetchedCert | null>(() => {
    if (initialFingerprint && initialDerB64) {
      return {
        fingerprint: initialFingerprint,
        derB64: initialDerB64,
        chainLen: 0, // unknown — hide the chain-count line when 0
        isSystemVerifiable: initialIsSystemVerifiable === true,
      };
    }
    return null;
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Editable endpoint port (FIX-B): some installations listen on non-443 TLS
  // ports (e.g. 8443 behind a reverse proxy). User can override the default.
  const [portInput, setPortInput] = useState<string>(String(endpointPort));
  // FIX-O: auto-detect port from vpn.toml. Runs once at mount — if the server
  // exposes a non-443 listen_address we prefill it so the user never has to
  // guess. Silent failure keeps 443 as the default. User edits override detection.
  const userEditedPortRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    // Promise.resolve() wraps both real Promises AND mocked/undefined returns
    // from test/storybook stubs — without it the tests that don't set up a
    // pending invoke blow up on `.then` of undefined.
    Promise.resolve(
      invoke<string>("server_get_config", {
        host: sshParams.host,
        port: sshParams.port,
        user: sshParams.user,
        password: sshParams.password,
        keyPath: sshParams.keyPath,
      }),
    )
      .then((toml) => {
        if (cancelled || userEditedPortRef.current) return;
        if (typeof toml !== "string") return;
        const m = toml.match(/listen_address\s*=\s*"[^"]*:(\d+)"/);
        if (m) {
          const detected = Number.parseInt(m[1], 10);
          if (Number.isInteger(detected) && detected >= 1 && detected <= 65535) {
            setPortInput(String(detected));
          }
        }
      })
      .catch(() => {
        /* silent — keep the manually entered / default port */
      });
    return () => {
      cancelled = true;
    };
    // Intentional one-shot: SSH params don't actually change between renders
    // of a mounted card (UserModal recreates the component when mode/user changes).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePortInputChange = (next: string) => {
    userEditedPortRef.current = true;
    setPortInput(next);
  };

  const parsedPort = Number.parseInt(portInput, 10);
  const portValid =
    Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535;

  const handleFetch = useCallback(async () => {
    if (_forceLoading) return;
    if (!portValid) {
      setError(t("server.users.cert_port_invalid"));
      return;
    }
    // FIX-OO-13: probe TCP-connects to the user's endpoint (sshParams.host)
    // regardless of Custom SNI — that's the real server. The `sni_host` param
    // (the TLS ClientHello SNI) is where Custom SNI actually belongs: for
    // anti-DPI setups it's a decoy domain the server whitelists in
    // `allowed_sni`. Pre-FIX the probe used Custom SNI for BOTH fields, so
    // entering `cdn.example.com` caused the probe to resolve + connect to
    // Cloudflare (never the endpoint), and Pin Certificate appeared broken
    // for any SNI value other than the server's own hostname.
    const destinationHost = sshParams.host;
    const sniHost = (customSni?.trim() || sshParams.host).trim();
    setLoading(true);
    setError(null);
    activityLog(
      "USER",
      `user.cert.fetch_initiated host=${destinationHost} sni=${sniHost} port=${parsedPort}`,
    );
    try {
      const result = await invoke<{
        leaf_der_b64?: string;
        fingerprint_hex?: string;
        chain_len?: number;
        is_system_verifiable?: boolean;
      } | null>("server_fetch_endpoint_cert", {
        host: sshParams.host,
        port: sshParams.port,
        user: sshParams.user,
        password: sshParams.password,
        keyPath: sshParams.keyPath,
        hostname: destinationHost,
        certPort: parsedPort,
        sniHost,
      });

      // Defensive null check — backend may return null on transport-level failures
      if (!result || !result.fingerprint_hex || !result.leaf_der_b64) {
        activityLog("ERROR", "user.cert.fetch_failed reason=invalid_response");
        setError(t("server.users.cert_fetch_error_invalid_response"));
        return;
      }

      const cert: FetchedCert = {
        fingerprint: result.fingerprint_hex,
        derB64: result.leaf_der_b64,
        chainLen: result.chain_len ?? 0,
        isSystemVerifiable: result.is_system_verifiable === true,
      };
      setFetchedCert(cert);
      // Log fingerprint prefix + chain/verifiability flags — enough to
      // diagnose QR-overflow or verify-path issues without leaking the
      // full hash into activity.log.
      activityLog(
        "STATE",
        `user.cert.fetch_completed fp_prefix=${cert.fingerprint.slice(0, 8)}` +
          ` chain_len=${cert.chainLen} system_verifiable=${cert.isSystemVerifiable}`,
      );
      onFingerprintLoaded(cert.derB64, cert.fingerprint, cert.isSystemVerifiable);
    } catch (e) {
      const raw = formatError(e);
      const lower = raw.toLowerCase();
      activityLog("ERROR", `user.cert.fetch_failed err=${raw.slice(0, 120)}`);
      // Map common error patterns → localized user-friendly messages.
      // Order matters — more specific patterns first so connection-level
      // errors aren't misclassified as TLS handshake failures.
      let key = "server.users.cert_fetch_error_generic";
      if (
        lower.includes("hostname is an ip address") ||
        lower.includes("typically require a domain")
      ) {
        key = "server.users.cert_fetch_error_needs_fqdn";
      } else if (lower.includes("timeout") || lower.includes("timed out")) {
        key = "server.users.cert_fetch_error_timeout";
      } else if (
        lower.includes("connection refused") ||
        lower.includes("os error 10061") || // Windows WSAECONNREFUSED
        lower.includes("econnrefused") ||
        lower.includes("tcp connect")
      ) {
        key = "server.users.cert_fetch_error_connection_refused";
      } else if (
        lower.includes("unreachable") ||
        lower.includes("network") ||
        lower.includes("os error 10051") // WSAENETUNREACH
      ) {
        key = "server.users.cert_fetch_error_unreachable";
      } else if (lower.includes("handshake eof") || lower.includes("tls handshake eof")) {
        key = "server.users.cert_fetch_error_tls_eof";
      } else if (lower.includes("handshake") || lower.includes("tls") || lower.includes("invalid certificate")) {
        key = "server.users.cert_fetch_error_tls_handshake";
      }
      setError(key === "server.users.cert_fetch_error_generic" ? t(key, { error: raw }) : t(key));
    } finally {
      setLoading(false);
    }
  }, [sshParams, customSni, parsedPort, portValid, onFingerprintLoaded, _forceLoading, activityLog, t]);

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
                {/* C: backend emits lowercase hex без separators, а derive
                    раньше клал uppercase-with-colons — помощник нормализует
                    оба варианта в AA:BB:CC группировку для отображения. */}
                {formatFingerprintForDisplay(effectiveFingerprint)}
              </p>
              {effectiveChainLen !== null && effectiveChainLen > 0 && (
                <p className="text-xs mt-1 text-[var(--color-text-muted)]">
                  Chain: {effectiveChainLen} {effectiveChainLen === 1 ? "cert" : "certs"}
                </p>
              )}
            </div>
          </div>
          {/* FIX-P: success state used to re-render «Загрузить с endpoint» as
              the only action, but that button was wired to `handleClear` —
              a confusing mismatch (label said "load", click unpinned).
              Replace with two purpose-built actions: [Отвязать] clears the
              pin, [Обновить] re-fetches the cert on the same host+port. */}
          <div className="flex items-center gap-[var(--space-2)]">
            {/* FIX-BB: danger-outline reads clearly as "destructive action"
                (red border + red text), unlike the old ghost variant that
                looked disabled. Title explains exactly what happens: clears
                the pinned bytes AND drops the pin toggle, returning the
                deeplink to its un-pinned state. */}
            <Button
              type="button"
              variant="danger-outline"
              size="sm"
              onClick={handleClear}
              disabled={disabled}
              title={t("server.users.cert_unpin_tooltip")}
              data-testid="cert-unpin-btn"
            >
              {t("server.users.cert_unpin_btn")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void handleFetch()}
              disabled={disabled || !portValid}
              title={t("server.users.cert_refresh_tooltip")}
              data-testid="cert-refresh-btn"
            >
              {t("server.users.cert_refresh_btn")}
            </Button>
          </div>
        </>
      ) : effectiveError ? (
        <>
          {/* Error state */}
          <div className="flex items-start gap-2 text-sm text-[var(--color-status-error)]">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
            <span className="break-words">{effectiveError}</span>
          </div>
          <div className="flex items-end gap-2">
            <div className="w-24 shrink-0">
              <label
                htmlFor="cert-port-retry"
                className="block text-xs mb-1 text-[var(--color-text-secondary)]"
              >
                {t("server.users.cert_port_label")}
              </label>
              <NumberInput
                value={portInput}
                onChange={handlePortInputChange}
                min={1}
                max={65535}
                maxLength={5}
                errorDisplay="none"
                disabled={disabled}
                aria-label={t("server.users.cert_port_label")}
              />
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void handleFetch()}
              disabled={disabled || !portValid}
            >
              {t("buttons.retry")}
            </Button>
          </div>
        </>
      ) : (
        /* Idle state: short help + port input + fetch button */
        <>
          <p className="text-xs text-[var(--color-text-muted)]">
            {t("server.users.cert_fetch_help")}
          </p>
          <div className="flex items-end gap-2">
            <div className="w-24 shrink-0">
              <label
                htmlFor="cert-port-idle"
                className="block text-xs mb-1 text-[var(--color-text-secondary)]"
              >
                {t("server.users.cert_port_label")}
              </label>
              <NumberInput
                value={portInput}
                onChange={handlePortInputChange}
                min={1}
                max={65535}
                maxLength={5}
                errorDisplay="none"
                disabled={disabled}
                aria-label={t("server.users.cert_port_label")}
              />
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void handleFetch()}
              disabled={disabled || !portValid}
              data-testid="cert-fetch-btn"
            >
              {t("server.users.cert_fetch_btn")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
