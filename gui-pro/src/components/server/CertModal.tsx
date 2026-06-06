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

// P UAT 2026-05-04 — formatDateHuman + formatDaysHuman moved to module-level
// helpers (used in JSX inline для validity period text).

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
  // H-04 (Plan 15): tracks whether the modal is still mounted. handleRenew's
  // `finally` waits an unconditional 2s before reloading the cert + firing the
  // success toast; if the user closes the server tab during that window the
  // setters would otherwise run on a dead modal (ghost success toast + parent
  // cert-state mutation). The cleanup effect flips this to false on unmount.
  const isMountedRef = useRef(true);
  const [renewLoading, setRenewLoading] = useState(false);
  const { sshParams, certRaw: preloadedCert, setCertRaw: setPreloadedCert } = state;
  const certInfo: CertInfo | null = preloadedCert ? parseCertInfo(preloadedCert) : null;

  // H-04 (Plan 15): mark unmounted so the post-renew 2s settle in handleRenew's
  // `finally` cannot fire setters on a dead modal. Runs once for the component
  // lifetime (mount → unmount), independent of the open/close animation.
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

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
      // H-04 (Plan 15): the SSH round-trip can outlive the modal — guard the
      // parent cert-state mutation so a late resolution doesn't write into a
      // closed modal's parent.
      if (isMountedRef.current) setPreloadedCert(raw);
    } catch (e) {
      if (isMountedRef.current) state.pushSuccess(formatError(e), "error");
    }
  };

  // P UAT 2026-05-04: handleVerifyRenewal removed — «Проверить» button удалён.
  // Если auto-renewal toggle зелёный, значит systemd timer activated. Дополнительная
  // dry-run кнопка дублирует уже видимый success state.

  // P UAT 2026-05-04: показываем certbot output (success + error) в Modal'е.
  // Default closed — user сам открывает «Подробности» если хочет посмотреть.
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
    setRenewDetailsOpen(false);
    let succeeded = false;
    try {
      const output = await invoke<string>("server_renew_cert", sshParams);
      succeeded = true;
      setRenewOutput({ kind: "success", text: output || t("server.cert.no_output_placeholder") });
      // Default closed — user сам click'нёт «Подробности» если хочет посмотреть лог.
    } catch (e) {
      const raw = formatError(e);
      // Backend now returns "SSH_CERT_RENEW_FAILED|<code><output_tail>".
      // Separator  (Information Separator One) — ASCII 31.
      let detailsText: string;
      let toastMsg: string;
      // eslint-disable-next-line no-control-regex -- ASCII 31 (Unit Separator) intentional delimiter
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
      // Default closed — user click'ает «Подробности» если хочет посмотреть лог.
    } finally {
      // H-04 (Plan 15): wait out the 2s settle so the server has applied the new
      // cert before we re-read it — but bail if the modal unmounted in the
      // meantime. Without this guard loadCert() (parent setCertRaw), the loading
      // reset, and the success toast all fired on a dead modal, producing a ghost
      // toast + a cert-state mutation after the user already left.
      await new Promise((r) => setTimeout(r, 2000));
      if (isMountedRef.current) {
        await loadCert();
      }
      if (isMountedRef.current) {
        setRenewLoading(false);
        if (succeeded) state.pushSuccess(t("server.cert.renewed"));
      }
    }
  };

  const daysLeft = certInfo?.notAfter ? daysUntil(certInfo.notAfter) : null;
  // P UAT 2026-05-04: validity tone — color hint inline (green/orange/red text)
  // вместо прежнего Badge. Дни рендерятся в одну строку с датами.
  const validityTone: string =
    daysLeft === null
      ? "var(--color-text-muted)"
      : daysLeft <= 7
        ? "var(--color-status-error)"
        : daysLeft <= 30
          ? "var(--color-status-warning)"
          : "var(--color-status-connected)";

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
          {/* Block 1 — Issuer + Subject (compact). P UAT 2026-05-04: дублирующий
              «Let's Encrypt» Badge удалён — issuer text уже несёт ту же информацию.
              Self-signed + unknown остались как Badge (там это semantic warning,
              не дубликат). */}
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
            {certInfo.certType !== "lets_encrypt" && (
              <div className="mt-1">
                {certInfo.certType === "self_signed" ? (
                  <Badge variant="warning" size="sm">{t("server.cert.self_signed")}</Badge>
                ) : (
                  <Badge variant="neutral" size="sm">{t("server.cert.unknown")}</Badge>
                )}
              </div>
            )}
          </section>

          {/* Block 2 — Validity period (notBefore — notAfter • дни остались).
              BUG-12 fix: при missing notBefore (older backend, self-signed cert
              без этого field) показываем только notAfter с префиксом «до».
              P UAT 2026-05-04: Badge удалён — дни рендерятся inline с датами,
              цвет hint меняется (success/warning/error) per validityTone. */}
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
              {daysLeft !== null && (
                <span className="ml-2" style={{ color: validityTone }}>
                  ({formatDaysHuman(daysLeft, i18n.language)})
                </span>
              )}
            </div>
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
                className="flex items-center gap-2 text-body-sm"
                style={{ color: "var(--color-status-connected)" }}
                data-testid="auto-renewal-active"
              >
                <span aria-hidden="true">✓</span>
                <span>{t("server.cert.auto_renewal_enabled")}</span>
                {/* P UAT 2026-05-04: «Проверить» button удалён — если toggle
                    зелёный, systemd timer activated. Дополнительный dry-run
                    просто дублирует уже видимый success state. */}
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

              {/* UAT 2026-05-23: expandable «Подробности» shows certbot output
                  ONLY for the ERROR case. The success path used to render the
                  same toggle ("server.cert.renew_success_details_label") but
                  (a) the i18n key was never localized and leaked as a raw
                  string, and (b) the certbot success log is unrelated noise
                  to the user (they see the new validity period in the card
                  above). Errors still need the details — that's where the
                  user finds rate-limit / DNS / port-conflict diagnostics. */}
              {renewOutput && renewOutput.kind === "error" && (
                <div className="mt-3" data-testid="cert-renew-details">
                  <button
                    type="button"
                    className="text-caption flex items-center gap-1.5"
                    style={{ color: "var(--color-status-danger)" }}
                    onClick={() => setRenewDetailsOpen((v) => !v)}
                    aria-expanded={renewDetailsOpen}
                  >
                    <span aria-hidden="true">{renewDetailsOpen ? "▾" : "▸"}</span>
                    {t("server.cert.renew_error_details_label")}
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
