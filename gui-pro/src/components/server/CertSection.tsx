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
import { parseCertInfo, daysUntil, pluralRu } from "./certUtils";
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
    const issuer = certInfo.issuerSummary
      ?? (certInfo.certType === "lets_encrypt" ? "Let's Encrypt" : t("server.cert.unknown"));
    const sub = certInfo.subjectCn || certInfo.domain || "—";
    // Show absolute expiration date alongside issuer + domain так чтобы
    // пользователь видел КОГДА истекает (не только относительное «67 дней»).
    const expires = certInfo.notAfter
      ? t("server.security.summary.cert_subtitle_expires", {
          date: formatExpiryDate(certInfo.notAfter, i18n.language),
        })
      : null;
    return expires ? `${issuer} • ${sub} • ${expires}` : `${issuer} • ${sub}`;
  }, [certInfo, i18n.language, t]);

  const statusVariant: "success" | "warning" | "danger" | "neutral" = useMemo(() => {
    if (!certInfo) return "neutral";
    if (daysLeft === null) return "warning";
    if (daysLeft <= 7) return "danger";
    if (daysLeft <= 30) return "warning";
    return "success";
  }, [certInfo, daysLeft]);

  const statusLabel = useMemo(() => {
    if (!certInfo) return t("server.security.summary.cert_status_loading");
    if (daysLeft === null) return t("server.security.summary.cert_status_unknown");
    if (daysLeft <= 0) return t("server.security.summary.cert_status_expired");
    return t("server.security.summary.cert_status_valid", { days: shortDays(daysLeft, i18n.language) });
  }, [certInfo, daysLeft, i18n.language, t]);

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
              <p className="text-caption truncate" style={{ color: "var(--color-text-muted)" }}>
                {subtitle}
              </p>
            </div>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setModalOpen(true)}
            disabled={!certInfo}
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
