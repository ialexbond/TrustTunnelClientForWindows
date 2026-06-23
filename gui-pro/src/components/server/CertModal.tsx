import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { ShieldCheck, RefreshCw, RotateCw } from "lucide-react";
import { Modal } from "../../shared/ui/Modal";
import { Button } from "../../shared/ui/Button";
import { Badge } from "../../shared/ui/Badge";
import { useConfirm } from "../../shared/ui/useConfirm";
import { formatError } from "../../shared/utils/formatError";
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

/**
 * UAT-F09 (owner 6.11): detect a certbot no-op ("not yet due for renewal").
 *
 * certbot renew without --force-renewal exits 0 and prints recognizable
 * not-due lines when nothing was renewed (the cert still has >30 days). The
 * renew success path must NOT show the green «Сертификат успешно обновлён»
 * toast in that case — it lies about a renewal that did not happen. We match a
 * few stable substrings certbot emits (case-insensitive), defensively covering
 * the common phrasings across certbot versions.
 */
function isCertbotNoOp(output: string): boolean {
  if (!output) return false;
  const lower = output.toLowerCase();
  return (
    lower.includes("not yet due for renewal") ||
    lower.includes("not due for renewal") ||
    lower.includes("no renewals were attempted") ||
    lower.includes("no renewal was attempted") ||
    lower.includes("cert not yet due for renewal")
  );
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

  // T-03 — initial focus is now owned by the Modal primitive (09-05 focus
  // management): on open it focuses the first focusable inside the content box
  // (the canonical close button), so the hand-rolled auto-focus effect + ref
  // were removed in 09-23 when this modal adopted Modal's showCloseButton.

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
  // UAT-F09 (owner 6.11): the renew result can be one of three outcomes.
  // `not_due` is a CORRECT no-op — certbot renew without --force-renewal does
  // nothing while >30 days remain (commit cb7adb2c dropped --force-renewal to
  // spare Let's Encrypt rate limits). We must NOT claim a renewal happened in
  // that case; we show a neutral message instead of the green success toast.
  const [renewOutput, setRenewOutput] = useState<{ kind: "success" | "error" | "not_due"; text: string } | null>(null);
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
    // UAT-F09 (owner 6.11): distinguish an actual renewal from a correct no-op.
    // Only an actual renewal gets the green success toast; a no-op gets a
    // neutral info message so we never falsely claim the cert was refreshed.
    let wasNoOp = false;
    try {
      const output = await invoke<string>("server_renew_cert", sshParams);
      succeeded = true;
      wasNoOp = isCertbotNoOp(output);
      setRenewOutput({
        kind: wasNoOp ? "not_due" : "success",
        text: output || t("server.cert.no_output_placeholder"),
      });
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
        // UAT-F09 (owner 6.11): only an ACTUAL renewal gets the green success
        // toast. A no-op (cert still valid) must not claim a renewal happened —
        // the SnackBar only has success(green)/error(red) tones, so a "neutral"
        // toast is impossible without touching that shared component (out of
        // this plan's scope). Instead we suppress the toast on a no-op and
        // surface the truthful neutral message in-modal (the `not_due` block
        // rendered below), so the user is never told it was renewed.
        if (succeeded && !wasNoOp) {
          state.pushSuccess(t("server.cert.renewed"));
        }
      }
    }
  };

  // UAT-F09: the validity date shown in the in-modal not-due message. Reuses
  // the parsed cert (the no-op did not change it). Omitted when unparseable so
  // we never leak a raw "{{date}}" placeholder.
  const renewNotDueDate = (() => {
    const notAfter = certInfo?.notAfter;
    if (!notAfter) return null;
    const d = new Date(notAfter);
    return Number.isNaN(d.getTime()) ? null : formatDateHuman(notAfter, i18n.language);
  })();

  // R2-F06 (Plan 09-36): the cert is MISSING/unreadable when the backend
  // `present` flag is false, or (old backend, present undefined) when there is
  // no readable notAfter. Used to avoid gluing the always-known domain onto the
  // «Неизвестно» issuer line for a cert that is not actually there (R2-F07).
  const certMissing =
    certInfo != null &&
    (certInfo.present === false || (certInfo.present === undefined && !certInfo.notAfter));

  const daysLeft = certInfo?.notAfter ? daysUntil(certInfo.notAfter) : null;

  // R2-F04 (Plan 09-36): the STATIC pre-click renew hint copy. Uses the already-
  // computed renewNotDueDate (parsed notAfter) — date variant when parseable,
  // no-date variant otherwise. Shown ABOVE the «Обновить сейчас» button on every
  // render (before any click), so the user gets renew guidance up front.
  const renewHint = renewNotDueDate
    ? t("server.cert.renew_hint", { date: renewNotDueDate })
    : t("server.cert.renew_hint_no_date");
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
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="md"
      showCloseButton
      // a11y (review a11y-3): Modal applies an unconditional focus-trap, so the
      // trapped container must be announced as a NAMED dialog (role + accessible
      // name via aria-labelledby → the visible <h2>). Mirrors UserModal.
      role="dialog"
      ariaModal
      ariaLabelledby="cert-modal-title"
    >
      <div className="flex items-center gap-2 mb-3">
        <ShieldCheck
          className="w-5 h-5"
          style={{ color: "var(--color-accent-interactive)" }}
          aria-hidden="true"
        />
        <h2 id="cert-modal-title" className="text-title">{t("server.cert.title")}</h2>
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
              {/* R2-F07 (Plan 09-36): do NOT glue the always-known domain onto the
                  «Неизвестно» issuer when the cert is MISSING — a known address
                  beside an unknown cert reads as contradictory. The address is
                  shown as its own neutral fact below instead. */}
              {!certMissing && (certInfo.subjectCn || certInfo.domain) ? (
                <span style={{ color: "var(--color-text-muted)" }}>
                  {" • "}
                  <span className="font-mono text-mono-sm">{certInfo.subjectCn || certInfo.domain}</span>
                </span>
              ) : null}
            </div>
            {/* R2-F07: the configured server address as a standalone neutral
                element when the cert is missing (domain comes from hosts.toml,
                always known, independent of the cert read). */}
            {certMissing && certInfo.domain ? (
              <div
                className="text-body-sm mt-1"
                style={{ color: "var(--color-text-muted)" }}
                data-testid="cert-modal-address-line"
              >
                {t("server.security.summary.cert_address", { domain: certInfo.domain })}
              </div>
            ) : null}
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
              {/* R2-F04 (Plan 09-36): STATIC pre-click renew hint. Shown on every
                  render (before any click), using the pre-computed renewNotDueDate
                  — date variant when parseable, no-date variant otherwise. Gives
                  renew guidance up front so the user does not have to click first
                  to learn the cert is still valid. The post-click `not_due`
                  confirmation below is kept as an inline confirmation. */}
              <p
                className="mb-3 text-body-sm"
                style={{ color: "var(--color-text-secondary)" }}
                data-testid="cert-renew-hint"
              >
                {renewHint}
              </p>
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
              {/* R3-F04 (Plan 09-39, owner 2026-06-23): the post-click no-op
                  («ещё действителен, обновление не требуется») inline block was
                  DROPPED as redundant — the pre-click `cert-renew-hint` above
                  already conveys the same thing before the user clicks. The
                  no-op DETECTION is preserved upstream: handleRenew still sets
                  renewOutput.kind === "not_due" via isCertbotNoOp(output) and
                  the `if (succeeded && !wasNoOp)` guard still suppresses the
                  false green «Сертификат успешно обновлён» toast on a no-op.
                  Only this VISUAL block is removed; the suppression stays. */}

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
