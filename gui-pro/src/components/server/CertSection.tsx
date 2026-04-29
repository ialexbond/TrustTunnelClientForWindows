import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  ShieldCheck,
  Info,
  RefreshCw,
  RotateCw,
} from "lucide-react";
import { Card, CardHeader } from "../../shared/ui/Card";
import { Button } from "../../shared/ui/Button";
import { Badge } from "../../shared/ui/Badge";
import { Tooltip } from "../../shared/ui/Tooltip";
import { useConfirm } from "../../shared/ui/useConfirm";
import { formatError } from "../../shared/utils/formatError";
import type { ServerState } from "./useServerState";
import { useSecurityState } from "./useSecurityState";
import { parseCertInfo, daysUntil, truncateFingerprint, type CertInfo } from "./certUtils";

interface Props {
  state: ServerState;
  /**
   * Phase 16 Plan 05 — Optional shared `useSecurityState` instance. When the
   * parent (e.g. `SecuritySection.tsx` 4-cards layout) already owns a hook
   * instance, it should pass it here so the auto-renewal toggle reads the
   * same `certbotTimerStatus` snapshot. When omitted (legacy 12.5 layout,
   * standalone tests, Storybook stories without SecuritySection wrapper) the
   * auto-renewal block is hidden — feature is unavailable until the
   * SecuritySection-owned `useSecurityState` is wired in.
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

function formatDaysHuman(totalDays: number, lang: string): string {
  if (totalDays <= 0) return lang === "ru" ? "Истёк" : "Expired";

  const years = Math.floor(totalDays / 365);
  const months = Math.floor((totalDays % 365) / 30);
  const days = totalDays % 30;

  if (lang === "ru") {
    const parts: string[] = [];
    if (years > 0) parts.push(pluralRu(years, "год", "года", "лет"));
    if (months > 0) parts.push(pluralRu(months, "месяц", "месяца", "месяцев"));
    if (days > 0 && years === 0) parts.push(pluralRu(days, "день", "дня", "дней"));
    if (parts.length === 0) parts.push(pluralRu(totalDays, "день", "дня", "дней"));
    return parts.join(" ");
  }

  // English
  const parts: string[] = [];
  if (years > 0) parts.push(`${years}y`);
  if (months > 0) parts.push(`${months}mo`);
  if (days > 0 && years === 0) parts.push(`${days}d`);
  if (parts.length === 0) parts.push(`${totalDays}d`);
  return parts.join(" ");
}

export function CertSection({ state, security }: Props) {
  const { t, i18n } = useTranslation();
  const { sshParams, certRaw: preloadedCert, setCertRaw: setPreloadedCert } = state;
  const confirm = useConfirm();

  const [renewLoading, setRenewLoading] = useState(false);
  const [, setRenewStatus] = useState<string>("");

  const certInfo = preloadedCert ? parseCertInfo(preloadedCert) : null;

  // Phase 16 Plan 05 — auto-renewal state lives in the optional shared
  // `useSecurityState` instance passed by SecuritySection. When omitted
  // (legacy callers / tests), `security` is undefined → auto-renewal block
  // is hidden via short-circuit below.
  useEffect(() => {
    if (!security) return;
    void security.loadCertbotTimerStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- depend on host primitive only
  }, [sshParams.host]);

  const loadCert = async () => {
    try {
      const raw = await invoke<unknown>("server_get_cert_info", sshParams);
      setPreloadedCert(raw);
    } catch (e) {
      state.pushSuccess(formatError(e), "error");
    }
  };

  const handleRenew = async () => {
    const ok = await confirm({
      title: t("server.cert.renew"),
      message: t("server.cert.renew_confirm_message"),
      variant: "warning",
      confirmText: t("server.cert.renew"),
      cancelText: t("buttons.cancel"),
    });
    if (!ok) return;
    setRenewLoading(true);
    setRenewStatus(t("server.cert.renew_progress_connecting"));
    let succeeded = false;
    try {
      setRenewStatus(t("server.cert.renew_progress_renewing"));
      await invoke("server_renew_cert", sshParams);
      succeeded = true;
    } catch (e) {
      const raw = formatError(e);
      // Translate cryptic backend codes to human-readable messages
      let msg: string;
      if (raw.includes("CERT_RENEW_FAILED|1")) {
        msg = t("server.cert.error_certbot_failed");
      } else if (raw.includes("CERT_RENEW_FAILED|2") || raw.includes("CERT_RENEW_FAILED|124")) {
        // Exit code 2 = certbot error (often rate limit); 124 = timeout killed by `timeout` command
        msg = t("server.cert.error_rate_limit");
      } else {
        msg = t("server.cert.error_generic", { detail: raw });
      }
      state.pushSuccess(msg, "error");
    } finally {
      // Always reload cert info — even if certbot returned an error (e.g. rate limit),
      // the cert file may have been updated by a previous successful run + our copy logic.
      setRenewStatus(t("server.cert.renew_progress_reloading"));
      await new Promise(r => setTimeout(r, 2000));
      await loadCert();
      setRenewStatus("");
      setRenewLoading(false);
      if (succeeded) state.pushSuccess(t("server.cert.renewed"));
    }
  };

  const daysLeft = certInfo?.notAfter ? daysUntil(certInfo.notAfter) : null;

  const certTypeBadge = (type: CertInfo["certType"]) => {
    switch (type) {
      case "lets_encrypt":
        return <Badge variant="success" size="sm">Let's Encrypt</Badge>;
      case "self_signed":
        return <Badge variant="warning" size="sm">{t("server.cert.self_signed")}</Badge>;
      default:
        return <Badge variant="neutral" size="sm">{t("server.cert.unknown")}</Badge>;
    }
  };

  if (!certInfo) return null;

  return (
    <Card>
      <CardHeader
        title={t("server.cert.title")}
        icon={<ShieldCheck className="w-3.5 h-3.5" />}
        action={
          <Tooltip text={t("server.cert.tooltip")}>
            <Info className="w-3.5 h-3.5 cursor-help" style={{ color: "var(--color-text-muted)" }} />
          </Tooltip>
        }
      />

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs" style={{ color: "var(--color-text-secondary)" }}>{t("server.cert.type")}</span>
          {certTypeBadge(certInfo.certType)}
        </div>

        {certInfo.domain && (
          <div className="flex items-center justify-between">
            <span className="text-xs" style={{ color: "var(--color-text-secondary)" }}>{t("server.cert.domain")}</span>
            <Badge
              variant={certInfo.certType === "lets_encrypt" ? "success" : certInfo.certType === "self_signed" ? "warning" : "neutral"}
              size="sm"
            >
              {certInfo.domain}
            </Badge>
          </div>
        )}

        {certInfo.notAfter && (
          <div className="flex items-center justify-between">
            <span className="text-xs" style={{ color: "var(--color-text-secondary)" }}>{t("server.cert.expires")}</span>
            <div className="flex items-center gap-2">
              {daysLeft !== null && (
                <Badge
                  variant={daysLeft <= 7 ? "danger" : daysLeft <= 30 ? "warning" : "success"}
                  size="sm"
                >
                  {formatDaysHuman(daysLeft, i18n.language)}
                </Badge>
              )}
            </div>
          </div>
        )}

        {/* Phase 16 Plan 05 — additive cert detail rows (D-5.1).
            Each row only renders when backend supplied the field — old backend
            responses skipping these continue to render the legacy 4 rows
            unchanged (R-9 backwards-compat invariant). */}
        {certInfo.subjectCn && (
          <div className="flex items-center justify-between">
            <span className="text-xs" style={{ color: "var(--color-text-secondary)" }}>
              {t("server.cert.subject_cn_label")}
            </span>
            <code className="text-mono-sm" data-testid="cert-subject-cn">
              {certInfo.subjectCn}
            </code>
          </div>
        )}
        {certInfo.issuerSummary && (
          <div className="flex items-center justify-between">
            <span className="text-xs" style={{ color: "var(--color-text-secondary)" }}>
              {t("server.cert.issuer_label")}
            </span>
            <span className="text-xs" data-testid="cert-issuer-summary">
              {certInfo.issuerSummary}
            </span>
          </div>
        )}
        {certInfo.notBefore && (
          <div className="flex items-center justify-between">
            <span className="text-xs" style={{ color: "var(--color-text-secondary)" }}>
              {t("server.cert.not_before_label")}
            </span>
            <code className="text-mono-sm" data-testid="cert-not-before">
              {certInfo.notBefore}
            </code>
          </div>
        )}
        {certInfo.sha256Fingerprint && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs shrink-0" style={{ color: "var(--color-text-secondary)" }}>
              {t("server.cert.fingerprint_label")}
            </span>
            <code
              className="text-mono-sm cursor-help truncate text-right"
              title={certInfo.sha256Fingerprint}
              data-testid="cert-fingerprint"
            >
              {truncateFingerprint(certInfo.sha256Fingerprint)}
            </code>
          </div>
        )}

        <div className="flex items-center justify-between">
          <span className="text-xs" style={{ color: "var(--color-text-secondary)" }}>{t("server.cert.auto_renew")}</span>
          <Badge variant={certInfo.autoRenew ? "success" : "neutral"} size="sm">
            {certInfo.autoRenew ? t("server.cert.configured") : t("server.cert.not_configured")}
          </Badge>
        </div>

        {/* Phase 16 Plan 05 — Auto-renewal toggle (D-5.3).
            Only renders when SecuritySection passed a `security` hook instance.
            Legacy 12.5 callers (no `security` prop) continue with the static
            "configured" badge above (driven by certInfo.autoRenew). */}
        {security && (
          <div
            className="pt-3 border-t"
            style={{ borderColor: "var(--color-border)" }}
            data-testid="cert-auto-renewal-section"
          >
            {security.certbotTimerStatus?.auto_renewal_active ? (
              <div
                className="flex items-center gap-2 text-body-sm"
                style={{ color: "var(--color-status-connected)" }}
                data-testid="auto-renewal-active"
              >
                <span aria-hidden="true">✓</span>
                <span>{t("server.cert.auto_renewal_enabled")}</span>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-2">
                <span className="text-body-sm" style={{ color: "var(--color-text-muted)" }}>
                  {t("server.cert.auto_renewal_not_setup")}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<RotateCw className="w-3 h-3" />}
                  onClick={() => void security.enableCertbotTimer()}
                  loading={security.isBusy("enable-certbot-timer")}
                  disabled={security.isBusy("enable-certbot-timer")}
                  data-testid="enable-auto-renewal-button"
                >
                  {t("server.cert.enable_auto_renewal_button")}
                </Button>
              </div>
            )}
          </div>
        )}

        {certInfo.certType === "lets_encrypt" && (
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw className="w-3.5 h-3.5" />}
            loading={renewLoading}
            disabled={renewLoading}
            onClick={handleRenew}
          >
            {t("server.cert.renew")}
          </Button>
        )}
      </div>

    </Card>
  );
}
