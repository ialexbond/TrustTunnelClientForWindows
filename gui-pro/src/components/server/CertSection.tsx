import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { ShieldCheck } from "lucide-react";
import { Card } from "../../shared/ui/Card";
import { Button } from "../../shared/ui/Button";
import { StatusIndicator } from "../../shared/ui/StatusIndicator";
import { formatError } from "../../shared/utils/formatError";
import type { ServerState } from "./useServerState";
import { useSecurityState } from "./useSecurityState";
import { parseCertInfo, daysUntil } from "./certUtils";
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
   * Optional shared `useSecurityState` instance. When parent (SecuritySection
   * 4-cards layout) already owns a hook instance, it passes it here so
   * CertModal reads the same `certbotTimerStatus` snapshot. When omitted
   * (legacy callers, standalone tests), CertModal будет иметь свой instance.
   */
  security?: ReturnType<typeof useSecurityState>;
}

function pluralRu(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100;
  const lastDigit = abs % 10;
  if (abs >= 11 && abs <= 19) return `${n} ${many}`;
  if (lastDigit === 1) return `${n} ${one}`;
  if (lastDigit >= 2 && lastDigit <= 4) return `${n} ${few}`;
  return `${n} ${many}`;
}

function shortDays(totalDays: number, lang: string): string {
  if (totalDays <= 0) return lang === "ru" ? "Истёк" : "Expired";
  return lang === "ru" ? pluralRu(totalDays, "день", "дня", "дней") : `${totalDays}d`;
}

export function CertSection({ state, security: passedSecurity }: Props) {
  const { t, i18n } = useTranslation();
  const fallbackSecurity = useSecurityState(state.sshParams, state.pushSuccess, state.onPortChanged);
  const security = passedSecurity ?? fallbackSecurity;
  const [modalOpen, setModalOpen] = useState(false);

  const { sshParams, certRaw: preloadedCert, setCertRaw: setPreloadedCert } = state;
  const certInfo = preloadedCert ? parseCertInfo(preloadedCert) : null;

  // Auto-load cert info on mount if not yet present.
  useEffect(() => {
    if (preloadedCert) return;
    invoke<unknown>("server_get_cert_info", sshParams)
      .then(setPreloadedCert)
      .catch((e) => state.pushSuccess(formatError(e), "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- depend on host primitive only
  }, [sshParams.host]);

  // Pre-fetch certbot timer status on mount (so Modal renders без spinner).
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
    return `${issuer} • ${sub}`;
  }, [certInfo, t]);

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
