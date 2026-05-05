import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { X, ShieldCheck, RefreshCw, RotateCw } from "lucide-react";
import { Modal } from "../../shared/ui/Modal";
import { Button } from "../../shared/ui/Button";
import { Badge } from "../../shared/ui/Badge";
import { useConfirm } from "../../shared/ui/useConfirm";
import { formatError } from "../../shared/utils/formatError";
import { cn } from "../../shared/lib/cn";
import type { ServerState } from "./useServerState";
import type { useSecurityState } from "./useSecurityState";
import { parseCertInfo, daysUntil, pluralRu, type CertInfo } from "./certUtils";

/**
 * P1-9 + P1-10 #R+#3 — CertModal compound.
 *
 * Replaces inline-Card CertSection (which broke 4-cards summary pattern).
 * SecuritySection card 4 теперь = summary + «Подробнее» CTA → opens this Modal.
 *
 * Internal layout = 4 информативных блока (compressed из 8 label-value rows
 * прежней CertSection):
 *   1. Issuer + Subject (compact: «Let's Encrypt R3 • *.example.com»)
 *   2. Validity period («Действителен: 15 фев — 16 мая • 67 дней осталось»)
 *   3. Fingerprint + Copy button (P2-13 mini-fix here)
 *   4. Auto-renewal toggle (D-5.3)
 *
 * Action footer: [Обновить сейчас] (для Let's Encrypt only)
 *
 * Modal lifecycle T-03 — НЕ early-return null, Modal primitive owns 200ms exit.
 */

// pluralRu extracted to certUtils.ts (BUG-26 — was duplicated в CertSection + CertModal).

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
  const parts: string[] = [];
  if (years > 0) parts.push(`${years}y`);
  if (months > 0) parts.push(`${months}mo`);
  if (days > 0 && years === 0) parts.push(`${days}d`);
  if (parts.length === 0) parts.push(`${totalDays}d`);
  return parts.join(" ");
}

/**
 * Format ISO date / OpenSSL date string в human-readable «15 фев 2026».
 * Falls back на raw input если parse fail.
 */
function formatDateHuman(raw: string | undefined, lang: string): string {
  if (!raw) return "—";
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

export interface CertModalProps {
  isOpen: boolean;
  onClose: () => void;
  state: ServerState;
  security: ReturnType<typeof useSecurityState>;
}

export function CertModal({ isOpen, onClose, state, security }: CertModalProps) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [renewLoading, setRenewLoading] = useState(false);
  const { sshParams, certRaw: preloadedCert, setCertRaw: setPreloadedCert } = state;
  const certInfo: CertInfo | null = preloadedCert ? parseCertInfo(preloadedCert) : null;

  // T-03 — auto-focus close button on open.
  useEffect(() => {
    if (!isOpen) return;
    const timer = setTimeout(() => closeButtonRef.current?.focus(), 250);
    return () => clearTimeout(timer);
  }, [isOpen]);

  // T-03 — cleanup transient state на close.
  useEffect(() => {
    if (isOpen) return;
    const timer = setTimeout(() => {
      setRenewLoading(false);
    }, 200);
    return () => clearTimeout(timer);
  }, [isOpen]);

  const loadCert = async () => {
    try {
      const raw = await invoke<unknown>("server_get_cert_info", sshParams);
      setPreloadedCert(raw);
    } catch (e) {
      state.pushSuccess(formatError(e), "error");
    }
  };

  const handleVerifyRenewal = async () => {
    try {
      await security.verifyCertbotRenewal();
      // Success snack уже fired в hook
    } catch (e) {
      const raw = formatError(e);
      // Translate cryptic backend codes
      let msg: string;
      if (raw.includes("CERTBOT_DRY_RUN_FAILED|124")) {
        msg = t("server.cert.dry_run_timeout");
      } else if (raw.includes("CERTBOT_DRY_RUN_FAILED")) {
        const detail = raw.split("|").slice(2).join("|");
        msg = t("server.cert.dry_run_failed", { detail });
      } else {
        msg = t("server.cert.error_generic", { detail: raw });
      }
      state.pushSuccess(msg, "error");
    }
  };

  // P UAT 2026-05-04: показываем certbot output (success + error) в Modal'е.
  // User жаловался «посмотреть логи я не знаю где» — теперь expandable
  // блок «Подробности» прямо под renew button.
  const [renewOutput, setRenewOutput] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [renewDetailsOpen, setRenewDetailsOpen] = useState(false);

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
    setRenewOutput(null);
    let succeeded = false;
    try {
      const output = await invoke<string>("server_renew_cert", sshParams);
      succeeded = true;
      setRenewOutput({ kind: "success", text: output || t("server.cert.no_output_placeholder") });
      setRenewDetailsOpen(true);
    } catch (e) {
      const raw = formatError(e);
      // Backend now returns "SSH_CERT_RENEW_FAILED|<code><output_tail>".
      // Separator  (Information Separator One) — ASCII 31.
      let detailsText = "";
      let toastMsg: string;
      const m = /SSH_CERT_RENEW_FAILED\|(-?\d+)\x1F([\s\S]*)$/.exec(raw);
      if (m) {
        const exitCode = m[1];
        detailsText = m[2];
        if (exitCode === "1") toastMsg = t("server.cert.error_certbot_failed");
        else if (exitCode === "2" || exitCode === "124") toastMsg = t("server.cert.error_rate_limit");
        else toastMsg = t("server.cert.error_with_code", { code: exitCode });
      } else if (raw.includes("CERT_RENEW_FAILED|1")) {
        toastMsg = t("server.cert.error_certbot_failed");
        detailsText = raw;
      } else if (raw.includes("CERT_RENEW_FAILED|2") || raw.includes("CERT_RENEW_FAILED|124")) {
        toastMsg = t("server.cert.error_rate_limit");
        detailsText = raw;
      } else {
        toastMsg = t("server.cert.error_generic", { detail: raw });
        detailsText = raw;
      }
      state.pushSuccess(toastMsg, "error");
      setRenewOutput({ kind: "error", text: detailsText || raw });
      setRenewDetailsOpen(true);
    } finally {
      await new Promise((r) => setTimeout(r, 2000));
      await loadCert();
      setRenewLoading(false);
      if (succeeded) state.pushSuccess(t("server.cert.renewed"));
    }
  };

  const daysLeft = certInfo?.notAfter ? daysUntil(certInfo.notAfter) : null;
  const validityBadgeVariant: "success" | "warning" | "danger" =
    daysLeft === null ? "warning" : daysLeft <= 7 ? "danger" : daysLeft <= 30 ? "warning" : "success";

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="md" className="relative">
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

      <div className="flex items-center gap-2 mb-3">
        <ShieldCheck
          className="w-5 h-5"
          style={{ color: "var(--color-accent-interactive)" }}
          aria-hidden="true"
        />
        <h2 className="text-title">{t("server.cert.title")}</h2>
      </div>

      {!certInfo ? (
        <p className="text-body-sm" style={{ color: "var(--color-text-muted)" }}>
          {t("server.cert.no_cert")}
        </p>
      ) : (
        <div className="space-y-4">
          {/* Block 1 — Issuer + Subject (compact) */}
          <section>
            <div className="text-caption mb-1" style={{ color: "var(--color-text-secondary)" }}>
              {t("server.cert.block_issued_by")}
            </div>
            <div className="text-body">
              {certInfo.issuerSummary ?? (certInfo.certType === "lets_encrypt" ? "Let's Encrypt" : t("server.cert.unknown"))}
              {certInfo.subjectCn || certInfo.domain ? (
                <span style={{ color: "var(--color-text-muted)" }}>
                  {" • "}
                  <span className="font-mono text-mono-sm">{certInfo.subjectCn || certInfo.domain}</span>
                </span>
              ) : null}
            </div>
            <div className="mt-1">
              {certInfo.certType === "lets_encrypt" ? (
                <Badge variant="success" size="sm">Let's Encrypt</Badge>
              ) : certInfo.certType === "self_signed" ? (
                <Badge variant="warning" size="sm">{t("server.cert.self_signed")}</Badge>
              ) : (
                <Badge variant="neutral" size="sm">{t("server.cert.unknown")}</Badge>
              )}
            </div>
          </section>

          {/* Block 2 — Validity period (notBefore — notAfter + days remaining).
              BUG-12 fix: при missing notBefore (older backend, self-signed cert
              без этого field) показываем только notAfter с префиксом «до».
              Раньше rendered «— — May 16, 2026» (двойной dash). */}
          <section
            className="border-t pt-3"
            style={{ borderColor: "var(--color-border)" }}
          >
            <div className="text-caption mb-1" style={{ color: "var(--color-text-secondary)" }}>
              {t("server.cert.block_validity")}
            </div>
            <div className="text-body">
              {certInfo.notBefore ? (
                <>
                  {formatDateHuman(certInfo.notBefore, i18n.language)}
                  <span className="mx-2" style={{ color: "var(--color-text-muted)" }}>—</span>
                  {formatDateHuman(certInfo.notAfter, i18n.language)}
                </>
              ) : (
                <>
                  <span style={{ color: "var(--color-text-muted)" }}>{t("server.cert.until_prefix")} </span>
                  {formatDateHuman(certInfo.notAfter, i18n.language)}
                </>
              )}
            </div>
            {daysLeft !== null && (
              <div className="mt-1">
                <Badge variant={validityBadgeVariant} size="sm">
                  {formatDaysHuman(daysLeft, i18n.language)}
                </Badge>
              </div>
            )}
          </section>

          {/* P UAT 2026-05-04: SHA-256 fingerprint block убран — для end-user
              он бесполезен (домен и issuer уже в Block 1). Если admin'у нужен
              для верификации — может через ssh посмотреть `openssl x509 ...`. */}

          {/* Block 3 (was 4) — Auto-renewal toggle (D-5.3) */}
          <section
            className="border-t pt-3"
            style={{ borderColor: "var(--color-border)" }}
            data-testid="cert-auto-renewal-section"
          >
            <div className="text-caption mb-1" style={{ color: "var(--color-text-secondary)" }}>
              {t("server.cert.auto_renew")}
            </div>
            {security.certbotTimerStatus?.auto_renewal_active ? (
              <div
                className="flex items-center justify-between gap-2"
                data-testid="auto-renewal-active"
              >
                <div
                  className="flex items-center gap-2 text-body-sm"
                  style={{ color: "var(--color-status-connected)" }}
                >
                  <span aria-hidden="true">✓</span>
                  <span>{t("server.cert.auto_renewal_enabled")}</span>
                </div>
                {/* P UAT 2026-05-04 — Verify button: certbot renew --dry-run
                    fully simulates renewal без consume rate limit. User
                    видит что auto-renewal реально работает. */}
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void handleVerifyRenewal()}
                  loading={security.isBusy("verify-certbot")}
                  disabled={security.isBusy("verify-certbot")}
                  data-testid="verify-renewal-button"
                >
                  {t("server.cert.verify_renewal_button")}
                </Button>
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
          </section>

          {/* Action footer — Renew (Let's Encrypt only) */}
          {certInfo.certType === "lets_encrypt" && (
            <div className="border-t pt-3" style={{ borderColor: "var(--color-border)" }}>
              <div className="flex justify-end">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<RefreshCw className="w-3.5 h-3.5" />}
                  loading={renewLoading}
                  disabled={renewLoading}
                  onClick={() => void handleRenew()}
                  data-testid="cert-renew-button"
                >
                  {t("server.cert.renew")}
                </Button>
              </div>

              {/* P UAT 2026-05-04: expandable «Подробности» — certbot output после
                  renewal (success ИЛИ error). User'у нужно видеть что именно
                  произошло (rate limit, port conflict, DNS issue). */}
              {renewOutput && (
                <div className="mt-3" data-testid="cert-renew-details">
                  <button
                    type="button"
                    className="text-caption flex items-center gap-1.5"
                    style={{
                      color: renewOutput.kind === "error"
                        ? "var(--color-status-danger)"
                        : "var(--color-text-secondary)",
                    }}
                    onClick={() => setRenewDetailsOpen((v) => !v)}
                    aria-expanded={renewDetailsOpen}
                  >
                    <span aria-hidden="true">{renewDetailsOpen ? "▾" : "▸"}</span>
                    {renewOutput.kind === "error"
                      ? t("server.cert.renew_error_details_label")
                      : t("server.cert.renew_success_details_label")}
                  </button>
                  {renewDetailsOpen && (
                    <pre
                      className="mt-2 p-3 rounded-[var(--radius-sm)] text-mono-sm overflow-auto"
                      style={{
                        backgroundColor: "var(--color-bg-elevated)",
                        color: "var(--color-text-secondary)",
                        border: "1px solid var(--color-border)",
                        maxHeight: "240px",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                      }}
                      data-testid="cert-renew-output"
                    >
                      {renewOutput.text}
                    </pre>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
