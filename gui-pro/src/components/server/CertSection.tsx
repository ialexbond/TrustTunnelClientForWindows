import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { ShieldCheck } from "lucide-react";
import { Card } from "../../shared/ui/Card";
import { Button } from "../../shared/ui/Button";
import { StatusIndicator } from "../../shared/ui/StatusIndicator";
import { Skeleton } from "../../shared/ui/Skeleton";
import { formatError } from "../../shared/utils/formatError";
import type { ServerState } from "./useServerState";
import { useSecurityState } from "./useSecurityState";
import { parseCertInfo, daysUntil } from "./certUtils";
import { pluralRu } from "../../shared/lib/pluralRu";
import { CertModal } from "./CertModal";

/**
 * P1-9 + P1-10 #R+#3 — CertSection summary card matching 4-cards pattern.
 *
 * Replaces inline-Card layout (которая ломала визуальную симметрию с
 * Firewall/Fail2Ban/SSH-key cards). Теперь рендерит compact summary:
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │  🛡 TLS Сертификат  ● Действителен 67 дней     [Подробнее]│
 *   │     Let's Encrypt R3 • *.example.com                     │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Click «Подробнее» → opens CertModal с полным detail (4 информативных
 * блока: issuer/subject + validity + fingerprint+copy + auto-renewal +
 * renew action).
 */

interface Props {
  state: ServerState;
  /**
   * Shared `useSecurityState` instance (REQUIRED post BUG-02). Parent
   * SecuritySection (4-cards layout) owns the hook и passes it здесь так
   * что CertModal reads same `certbotTimerStatus` snapshot.
   *
   * BUG-02 fix: ранее этот prop был optional с `useSecurityState` fallback
   * локально — но React hooks вызываются unconditionally, поэтому fallback
   * hook ВСЕГДА запускался даже когда passedSecurity был provided. Result:
   * 2× `security_get_status` SSH invokes на каждый mount, занимающие 2/5
   * permits в CHANNEL_OPEN_GATE semaphore.
   *
   * Now required — каждый caller обязан передавать shared instance. Test
   * fixtures + Storybook stories передают mock объект.
   */
  security: ReturnType<typeof useSecurityState>;
}

// pluralRu extracted to certUtils.ts (BUG-26 — was duplicated в CertSection + CertModal).

function shortDays(totalDays: number, lang: string): string {
  if (totalDays <= 0) return lang === "ru" ? "Истёк" : "Expired";
  return lang === "ru" ? pluralRu(totalDays, "день", "дня", "дней") : `${totalDays}d`;
}

/**
 * Format absolute expiration date в human-readable «16 мая 2026 г.».
 * Falls back на raw input если parse fail (defensive).
 */
function formatExpiryDate(raw: string, lang: string): string {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  try {
    return new Intl.DateTimeFormat(lang, {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(d);
  } catch {
    return raw;
  }
}

export function CertSection({ state, security }: Props) {
  const { t, i18n } = useTranslation();
  const [modalOpen, setModalOpen] = useState(false);

  const { sshParams, certRaw: preloadedCert, setCertRaw: setPreloadedCert } = state;
  const certInfo = preloadedCert ? parseCertInfo(preloadedCert) : null;
  // UAT-6: a missing/unreadable cert can arrive as a non-null payload with an
  // empty notAfter — parseCertInfo then returns a non-null object (certType
  // unknown), so `disabled={!certInfo}` left the «Подробнее» CTA enabled, opening
  // a details modal for a cert that is not there. Gate "do we actually have a
  // cert" on readability (a present notAfter), not on certInfo being non-null.
  const hasReadableCert = !!certInfo?.notAfter;
  // R2-F06 (Plan 09-36): distinguish a MISSING/unreadable cert from a present-
  // but-unrecognized-type one. Prefer the backend `present` flag when defined
  // (cert_code == 0); fall back to the notAfter readability heuristic for an old
  // backend that omits `present`. A missing cert gets its own honest label and
  // its address rendered as a separate neutral fact (R2-F07) — not «Неизвестно»
  // glued to a known domain (the contradictory shape).
  const certMissing =
    certInfo != null && (certInfo.present === false || (certInfo.present === undefined && !hasReadableCert));
  // Loading state — fetch ещё не завершён (preloadedCert === null AND
  // mount-effect ещё в полёте). Показываем Skeleton card.
  const [certFetched, setCertFetched] = useState(preloadedCert !== null);

  // Auto-load cert info on mount if not yet present.
  // BUG-09 fix: cancel signal pattern — если user меняет host пока invoke
  // в полёте, старый response не должен записать ОЛДовый cert в новый host slot.
  useEffect(() => {
    if (preloadedCert) {
      setCertFetched(true);
      return;
    }
    const signal = { cancelled: false };
    invoke<unknown>("server_get_cert_info", sshParams)
      .then((raw) => {
        if (!signal.cancelled) setPreloadedCert(raw);
      })
      .catch((e) => {
        if (!signal.cancelled) state.pushSuccess(formatError(e), "error");
      })
      .finally(() => {
        if (!signal.cancelled) setCertFetched(true);
      });
    return () => {
      signal.cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- depend on host primitive only
  }, [sshParams.host]);

  // Pre-fetch certbot timer status on mount (so Modal renders без spinner).
  // BUG-09 fix: hook's loadCertbotTimerStatus through `run()` already handles
  // cancellation internally (через busy-state guards). Just don't await here.
  useEffect(() => {
    void security.loadCertbotTimerStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- depend on host primitive only
  }, [sshParams.host]);

  const daysLeft = certInfo?.notAfter ? daysUntil(certInfo.notAfter) : null;

  const subtitle = useMemo(() => {
    if (!certInfo) return t("server.security.summary.cert_subtitle_loading");
    // R2-F07 (Plan 09-36): for a MISSING cert the subtitle describes the cert
    // STATE only — the configured address is rendered separately below as its
    // own neutral «Адрес сервера: <domain>» element (so a known address is not
    // glued onto an unknown cert via «issuer • domain • …»). Returning null here
    // lets the render swap in the dedicated address element instead.
    if (certMissing) return null;
    // CP-1 (16-09): show the certificate TYPE + the domain-or-IP ONCE — never the
    // host name twice. For a self-signed cert the issuer CN == subject CN (both
    // «trusttunnel.local»), so the old `${issuer} • ${sub}` rendered the host
    // twice and NEVER surfaced the type. certInfo.certType is already parsed —
    // surface it as the leading segment instead of issuerSummary. This is a
    // long-standing, repeatedly-requested fix (16-UAT-ROUND3 gap CP-1).
    const certTypeLabel =
      certInfo.certType === "self_signed"
        ? t("server.cert.self_signed")
        : certInfo.certType === "lets_encrypt"
          ? t("server.cert.lets_encrypt")
          : t("server.cert.unknown");
    // CP-1d (owner 2026-07-05): the displayed address is CERT-TYPE-AWARE.
    // - self_signed → the server IP (sshParams.host). The cert CN is the internal
    //   SNI placeholder «trusttunnel.local», so show the real connect address.
    // - lets_encrypt → the DOMAIN the cert was issued for (subjectCn / domain);
    //   the SSH host may be a bare IP, but an LE cert is always for a domain.
    // - custom / unknown → whatever the cert was actually issued to — read from the
    //   cert subject (subjectCn), which may be an IP OR a domain. The app surfaces
    //   the cert's own subject rather than guessing.
    const domainOrIp =
      certInfo.certType === "self_signed"
        ? (sshParams.host || certInfo.subjectCn || certInfo.domain || "—")
        : (certInfo.subjectCn || certInfo.domain || sshParams.host || "—");
    // Show absolute expiration date alongside type + domain так чтобы
    // пользователь видел КОГДА истекает (не только относительное «67 дней»).
    const expires = certInfo.notAfter
      ? t("server.security.summary.cert_subtitle_expires", {
          date: formatExpiryDate(certInfo.notAfter, i18n.language),
        })
      : null;
    return expires
      ? `${certTypeLabel} • ${domainOrIp} • ${expires}`
      : `${certTypeLabel} • ${domainOrIp}`;
  }, [certInfo, certMissing, sshParams.host, i18n.language, t]);

  // R2-F07 (Plan 09-36): the configured server address as a standalone neutral
  // fact, shown when the cert is missing (the domain comes from hosts.toml and
  // is always known, independent of the cert read). Null when there is no
  // domain to show or the cert is present (the normal subtitle covers it).
  const addressLine = useMemo(() => {
    if (!certMissing || !certInfo?.domain) return null;
    return t("server.security.summary.cert_address", { domain: certInfo.domain });
  }, [certMissing, certInfo?.domain, t]);

  const statusVariant: "success" | "warning" | "danger" | "neutral" = useMemo(() => {
    // UAT-6: a cert without a readable notAfter is neutral, not a warning band —
    // a missing cert is not "expiring soon", it is simply absent.
    if (!hasReadableCert) return "neutral";
    if (daysLeft === null) return "warning";
    if (daysLeft <= 7) return "danger";
    if (daysLeft <= 30) return "warning";
    return "success";
  }, [hasReadableCert, daysLeft]);

  const statusLabel = useMemo(() => {
    // R2-F06 (Plan 09-36): a MISSING/unreadable cert reads as an explicit
    // «Сертификат не найден / не читается» — not the ambiguous «Неизвестно».
    if (certMissing) return t("server.security.summary.cert_status_missing");
    // «Неизвестно» is now reserved for a PRESENT-but-unrecognized cert: the
    // fetch settled, the cert is there, but its validity/type is unreadable.
    if (!hasReadableCert) return t("server.security.summary.cert_status_unknown");
    if (daysLeft === null) return t("server.security.summary.cert_status_unknown");
    if (daysLeft <= 0) return t("server.security.summary.cert_status_expired");
    return t("server.security.summary.cert_status_valid", { days: shortDays(daysLeft, i18n.language) });
  }, [certMissing, hasReadableCert, daysLeft, i18n.language, t]);

  // Initial fetch ещё не завершён → Skeleton placeholder. После fetch
  // (success или fail) показываем actual card даже если certInfo === null
  // (subtitle покажет «Загрузка...» или fallback).
  if (!certFetched) {
    return (
      <Card data-testid="cert-summary-card-loading">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <Skeleton variant="circle" width={20} height={20} rounded />
            <div className="flex-1 min-w-0 space-y-2">
              <Skeleton variant="line" height={14} width="40%" />
              <Skeleton variant="line" height={12} width="70%" />
            </div>
          </div>
          <Skeleton variant="card" height={32} width={96} />
        </div>
      </Card>
    );
  }

  return (
    <>
      <Card data-testid="cert-summary-card">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <ShieldCheck
              className="w-5 h-5 shrink-0"
              style={{ color: "var(--color-accent-interactive)" }}
              aria-hidden="true"
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="text-subtitle">{t("server.security.summary.cert_card_title")}</h3>
                <StatusIndicator status={statusVariant} size="sm" label={statusLabel} />
              </div>
              {/* R2-F07: a missing cert shows the address as its own neutral
                  element (addressLine) instead of the cert-state subtitle, so a
                  known address is never glued onto an unknown cert.
                  R3-F03 (Plan 09-39): the owner could not SEE the explicit
                  «не найден / не читается» status — after the domain-separation
                  the prominent text line became the ADDRESS and the status lived
                  only as the small StatusIndicator dot label. Render the missing
                  status as its OWN visible text line ABOVE the address so BOTH
                  are legible. Stays neutral (a missing cert is absent, not
                  expiring) and uses the muted token like the address line. */}
              {certMissing ? (
                <>
                  <p
                    className="text-caption truncate"
                    style={{ color: "var(--color-text-secondary)" }}
                    data-testid="cert-status-label"
                  >
                    {statusLabel}
                  </p>
                  {addressLine && (
                    <p
                      className="text-caption truncate"
                      style={{ color: "var(--color-text-muted)" }}
                      data-testid="cert-address-line"
                    >
                      {addressLine}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-caption truncate" style={{ color: "var(--color-text-muted)" }}>
                  {subtitle}
                </p>
              )}
            </div>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setModalOpen(true)}
            disabled={!hasReadableCert}
            data-testid="cert-configure-button"
          >
            {t("server.security.summary.configure_button")}
          </Button>
        </div>
      </Card>

      <CertModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        state={state}
        security={security}
      />
    </>
  );
}
