import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { Copy, Download } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { Modal } from "../../shared/ui/Modal";
import { Button } from "../../shared/ui/Button";
import { Skeleton } from "../../shared/ui/Skeleton";
import { Tooltip } from "../../shared/ui/Tooltip";
import { ErrorBanner } from "../../shared/ui/ErrorBanner";
import { useSnackBar } from "../../shared/ui/SnackBarContext";
import { useActivityLog } from "../../shared/hooks/useActivityLog";
import { formatError } from "../../shared/utils/formatError";
import { cn } from "../../shared/lib/cn";
import { fromServerResponse as advancedFromServer } from "../../shared/utils/userAdvanced";
import { buildConfigFileName } from "../../shared/utils/configFileName";
import { readCachedCountryCode } from "./useServerGeoIp";

/**
 * UserConfigModal — Phase 14 Plan 04 production implementation.
 *
 * Used from two entry points (D-07):
 *   1. Click on the FileText icon in a user row (UsersSection).
 *   2. Automatic open after a successful add_server_user invoke.
 *
 * Flow:
 *   - On open: invoke("server_export_config_deeplink") to fetch the tt:// URL.
 *   - QR is displayed for scanning; clicking it copies the tt:// link as TEXT (D-09).
 *     The image-clipboard path was removed — it did not work in the WebView2.
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
  /**
   * FIX-W: skip the backend fetch and show this deeplink directly. Used when
   * the caller already produced a deeplink (e.g. UserModal handleSave
   * regenerated it with edited TLV params) and we need to surface THAT exact
   * one — fetching again via `server_export_config_deeplink` would return
   * the basic deeplink without the session-scoped TLV additions.
   */
  preloadedDeeplink?: string;
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
  preloadedDeeplink,
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
        const sshArgs = {
          host: sshHost,
          port: sshPort,
          user: sshUser,
          password: sshPassword,
          keyPath: sshKeyPath,
        };
        // FIX-NN: close+reopen FileText used to re-fetch via basic export,
        // stripping every TLV the user saved on Add/Edit. Probe our sidecar
        // file first — if advanced params are persisted we regenerate the
        // deeplink with them baked in; otherwise fall back to the basic
        // path so pre-FIX-NN servers keep working.
        const advancedRaw = await invoke<unknown>("server_get_user_advanced", {
          ...sshArgs,
          username,
        }).catch(() => null);
        const advanced = advancedFromServer(advancedRaw);
        const link = advanced
          ? await invoke<string>("server_export_config_deeplink_advanced", {
              ...sshArgs,
              clientName: username,
              customSni: advanced.customSni || null,
              name: advanced.displayName || null,
              upstreamProtocol:
                advanced.upstreamProtocol !== "auto"
                  ? advanced.upstreamProtocol
                  : null,
              antiDpi: advanced.antiDpi,
              skipVerification: advanced.skipVerification,
              // FIX-OO-7: we don't have the is_system_verifiable flag
              // after a reopen (users-advanced.toml only stores the cert
              // bytes). Size-gate as a defensive proxy — anything above
              // ~2 KB base64 (≈ 1.5 KB decoded) cannot fit in a QR code
              // binary-mode payload + the other TLVs, so skip embedding
              // and let the sidecar use its platform verifier. Self-signed
              // single-leaf certs are typically well under this threshold.
              pinCertificateDer: advanced.pinCert &&
                advanced.certDerB64 &&
                advanced.certDerB64.length < 2048
                ? advanced.certDerB64
                : null,
              dnsUpstreams: advanced.dnsUpstreams,
            })
          : await invoke<string>("server_export_config_deeplink", {
              ...sshArgs,
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
  // NOTE: on close (!isOpen) we DO NOT clear state — Modal primitive runs a
  // 200ms exit animation and the content must stay rendered during it.
  // A delayed reset is triggered in the cleanup effect below.
  useEffect(() => {
    if (!isOpen || !username) return;
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
    // FIX-W: caller already handed us a deeplink (e.g. post-Edit regenerate).
    // Skip the backend roundtrip — fetching would return the BASIC deeplink
    // without the edited TLV params and overwrite what the user actually
    // came here to see.
    if (preloadedDeeplink) {
      setDeeplink(preloadedDeeplink);
      setDeeplinkError(null);
      setDeeplinkLoading(false);
      return;
    }
    let cancelled = false;
    void fetchDeeplink(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [
    isOpen,
    username,
    preloadedDeeplink,
    _deeplinkOverride,
    _forceLoading,
    _forceError,
    fetchDeeplink,
  ]);

  // ── Delayed cleanup after close ──
  // Runs 200ms after isOpen flips to false — matches Modal exit animation.
  // Keeps deeplink+loading+error rendered during the fade-out so the modal
  // doesn't empty itself while transitioning away.
  useEffect(() => {
    if (isOpen) return;
    const timer = setTimeout(() => {
      setDeeplink(null);
      setDeeplinkError(null);
      setDeeplinkLoading(false);
    }, 200);
    return () => clearTimeout(timer);
  }, [isOpen]);

  // ── Initial focus is now owned by the Modal primitive (09-05): on open it
  // focuses the first focusable inside the content box (the canonical close
  // button). The hand-rolled auto-focus effect + ref were removed in 09-23 when
  // this modal adopted Modal's showCloseButton. ──

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

  // ── Click the QR → copy the deeplink as TEXT (D-09). The QR image-clipboard path was
  //    removed: neither the web ClipboardItem nor the native writeImage worked reliably in
  //    the Tauri WebView2 (owner UAT: it kept copying the link anyway), so clicking the QR
  //    copies the link — the QR stays on screen for scanning. D-29: the activity log never
  //    carries the link payload. ──
  const handleCopyQr = async () => {
    if (!deeplink || !username) return;
    try {
      await navigator.clipboard.writeText(deeplink);
      activityLog("USER", `user.config.link_copied user=${username}`);
      pushSuccess(t("server.users.link_copied"));
    } catch (e) {
      activityLog("ERROR", `user.config.qr_copy_failed err=${formatError(e)}`);
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
        // #22: the Users-tab download does not render the wizard deploy progress UI, so it
        // passes the unstamped generation (0 = "accept everywhere", no listener impact).
        opId: 0,
        // Brand the on-disk config `[<CC>_]TrustTunnel_<username>.toml` consistently with
        // the Save-As default below, so the file fetch_server_config writes carries the
        // country prefix too. Best-effort cached GeoIP (undefined when unknown).
        countryCode: readCachedCountryCode(sshHost) || undefined,
        // Phase 19 UAT: the download is a SAVE action, not "add to app" — stage the fetched config
        // into the OS temp dir (NOT the app data dir) so the folder-as-truth adoption scan never
        // turns it into an unwanted Connection-tab card and it can't overwrite a tracked config.
        stageToTemp: true,
      });
      // UAT (06-uat fix 14): branded, consistent default name
      // `[COUNTRY_]TrustTunnel_<username>.toml` (matching the wizard DoneStep save).
      // The country prefix is BEST-EFFORT — read synchronously from the already-cached
      // GeoIP for this host (no fetch, never blocks the save); omitted gracefully when
      // not readily available.
      const country = readCachedCountryCode(sshHost);
      const dest = await save({
        defaultPath: buildConfigFileName(username, country),
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

  // NOTE: no early `return null` on !isOpen — Modal primitive manages its own
  // mounted/animating lifecycle (200ms exit animation). Returning null here
  // would unmount the tree instantly and kill the exit transition.
  // Block all close paths while download is in flight — user triggered a
  // mutating server action (fetch_server_config + save dialog + copy_file)
  // and must wait for its completion/error before dismissing the modal.
  // (Read-only deeplink copy doesn't block — it's clipboard-only, no server state change.)
  return (
    <Modal
      isOpen={isOpen}
      onClose={isDownloading ? undefined : onClose}
      closeOnBackdrop={!isDownloading}
      closeOnEscape={!isDownloading}
      size="md"
      showCloseButton
      // D-10, D-11: close via X / backdrop / Escape, all blocked while a config
      // download is in flight (a half-finished export must not be dismissable).
      closeButtonDisabled={isDownloading}
    >
      {effectiveLoading ? (
        // Skeleton, отражающий финальный layout (QR + caption + deeplink + download).
        // Модалка всегда показывает одни и те же 4 блока, поэтому скелетон
        // статически повторяет их пропорции — предотвращает CLS при догрузке.
        <div aria-busy="true" aria-label={t("common.loading")}>
          <div className="flex justify-center">
            <Skeleton
              variant="card"
              width={240}
              height={240}
              data-testid="qr-skeleton"
            />
          </div>
          <div className="flex justify-center mt-[var(--space-2)]">
            <Skeleton width={180} height={14} data-testid="caption-skeleton" />
          </div>
          <Skeleton
            className="mt-[var(--space-4)] w-full"
            height={32}
            data-testid="deeplink-skeleton"
          />
          <Skeleton
            className="mt-[var(--space-4)] w-full"
            height={36}
            data-testid="download-skeleton"
          />
        </div>
      ) : effectiveError ? (
        // Owner UAT: the Retry action is full-width (like the Download button),
        // not a centred content-width button — banner + button align as one column.
        <div className="flex flex-col gap-[var(--space-3)] py-4">
          <ErrorBanner
            variant="error"
            message={effectiveError}
            className="w-full"
          />
          <Button variant="secondary" fullWidth onClick={handleRetry}>
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
                "rounded-md p-2 transition-transform cursor-pointer",
                "active:scale-[0.98]",
                "focus-visible:shadow-[var(--focus-ring)] outline-none",
              )}
            >
              <div>
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
          <p className="text-sm text-center mt-[var(--space-2)] text-[var(--color-text-muted)]">
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
            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center leading-none">
              <Tooltip text={t("server.users.copy_deeplink_tooltip")}>
                <button
                  type="button"
                  aria-label={t("server.users.copy_deeplink_tooltip")}
                  onClick={() => void handleCopyLink()}
                  className={cn(
                    "p-1 rounded flex items-center",
                    "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]",
                    "focus-visible:shadow-[var(--focus-ring)] outline-none",
                    "transition-[color,transform] duration-[var(--transition-fast)]",
                    "active:scale-[0.92]"
                  )}
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
              </Tooltip>
            </div>
          </div>

          {/* Download button. Button primitive itself renders a Loader2 when loading=true. */}
          <Button
            variant="primary"
            fullWidth
            icon={<Download className="w-3.5 h-3.5" />}
            loading={isDownloading}
            disabled={isDownloading}
            onClick={() => void handleDownload()}
            className="mt-[var(--space-4)]"
          >
            {t("server.users.download_config")}
          </Button>
        </>
      ) : null}
    </Modal>
  );
}
