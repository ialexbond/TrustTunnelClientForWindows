import { useId } from "react";
import { useTranslation } from "react-i18next";
import {
  XCircle, AlertTriangle, ChevronUp, ChevronDown, Copy, ClipboardCheck,
} from "lucide-react";
import { Button } from "../../shared/ui/Button";
import { IconButton } from "../../shared/ui/IconButton";
import { translateSshError } from "../../shared/utils/translateSshError";
import type { WizardState } from "./useWizardState";

export function ErrorStep(w: WizardState) {
  const { t } = useTranslation();
  // Disclosure a11y contract (D-04 / UI-SPEC A11y): the "Подробнее" toggle owns
  // aria-expanded and aria-controls; the raw-log panel is a labelled role=region
  // with this id as its target.
  const logsRegionId = useId();

  // Smart error hints based on error message and deploy logs.
  //
  // UAT 2026-05-20 — re-ordered: port-in-use is checked FIRST and short-circuits
  // the letsencrypt hint. Old logic flagged letsencrypt on ANY certbot mention
  // — even successful logs ("Account registered", "Successfully received
  // certificate") — which then shadowed the real cause when the endpoint
  // crashed binding to port 443 ("Address in use").
  //
  // Also tightened letsencrypt detection: only triggers on explicit failure
  // keywords, not on background mentions of "certbot".
  const allText = [w.errorMessage, ...w.deployLogs.map(l => l.message)].join("\n").toLowerCase();
  const hints: string[] = [];
  if (allText.includes("address in use") || allText.includes("os error 98")) {
    // UAT 2026-05-20 — backend dumps `ss -tlnp` output when 443 is busy,
    // e.g. `users:(("nginx",pid=163333,fd=5))`. Pull the process name out so
    // we can blame the right culprit instead of the generic "old TrustTunnel"
    // line. Match common web/proxy servers; fall back to generic if nothing
    // recognised.
    const portHolderMatch = allText.match(/users:\(\("([a-z0-9_.-]+)"/i);
    const holder = portHolderMatch?.[1] ?? "";
    if (holder && holder !== "trusttunnel_endpoint") {
      hints.push(t('wizard.error.hint_port_held_by', { process: holder }));
    } else {
      hints.push(t('wizard.error.hint_port_in_use'));
    }
  }
  if (allText.includes("nxdomain") || (allText.includes("dns") && allText.includes("domain"))) {
    hints.push(t('wizard.error.hint_dns'));
  }
  const certbotFailed =
    allText.includes("certbot failed") ||
    allText.includes("challenge failed") ||
    // WR-07: parenthesise the `&&` sub-expressions inside the `||` chain so the
    // grouping is explicit (behavior is unchanged — `&&` already binds tighter).
    (allText.includes("acme") && allText.includes("fail")) ||
    ((allText.includes("letsencrypt") || allText.includes("let's encrypt")) && allText.includes("error"));
  if (certbotFailed) {
    if (!hints.length) hints.push(t('wizard.error.hint_letsencrypt'));
  }
  // UAT 2026-05-20 — certbot's challenge log carries the precise network
  // diagnostic; surface it instead of the generic "port 80 should be open"
  // line so the user knows whether to fix nginx (refused) or the upstream
  // firewall / cloud security group (timeout).
  if (allText.includes("timeout during connect") || (allText.includes("acme-challenge") && allText.includes("timeout"))) {
    hints.push(t('wizard.error.hint_port_80_timeout'));
  } else if (allText.includes("acme-challenge") && allText.includes("connection refused")) {
    hints.push(t('wizard.error.hint_port_80_refused'));
  } else if (allText.includes("port 80")) {
    hints.push(t('wizard.error.hint_port_80'));
  }
  if (allText.includes("connection refused") || allText.includes("connection timed out") || allText.includes("os error 10054") || allText.includes("os error 10060")) {
    hints.push(t('wizard.error.hint_unreachable'));
  }
  if (allText.includes("authentication") || allText.includes("auth failed") || allText.includes("permission denied")) {
    hints.push(t('wizard.error.hint_auth_failed'));
  }
  // C-05 (06-08): match the RAW marker (precise) rather than a keyword scan of the
  // logs. SSH_CONFIG_DIVERGES means the server already has a different config; the
  // user should reinstall to apply theirs — «Переустановить» does this safely
  // (overwriteConfig=true, credentials preserved). Safety net for any GENUINE
  // divergence; the normalizer suppresses the inert-legacy-key false-positive.
  if (w.errorMessage.startsWith("SSH_CONFIG_DIVERGES")) {
    hints.push(t('wizard.error.hint_config_diverges'));
  }
  // C-06 (06-14): port-80-busy on Let's Encrypt. deploy_configure now preserves the
  // install script's SSH_CERTBOT_PORT80_BUSY marker as the error code (not the opaque
  // SSH_CONFIG_CREATE_FAILED), so we key on the CODE (precise) — the marker text is
  // already lowercased into allText too. The fastest fix for a non-technical user with
  // no spare :80 is to switch to a self-signed certificate, so this is offered as the
  // PRIMARY action below (not just a hint).
  const isPort80Busy =
    w.errorMessage.startsWith("SSH_CERTBOT_PORT80_BUSY") ||
    allText.includes("ssh_certbot_port80_busy");
  if (isPort80Busy) {
    hints.push(t('wizard.error.hint_port_80_busy'));
  }

  return (
    <div className="flex-1 flex flex-col items-center overflow-y-auto p-6">
      <div className="max-w-sm w-full text-center space-y-5 my-auto">
        {/* D-04 hero: 64px danger square + 32px white XCircle + --shadow-lg
            (mirrors the onboarding hero square exactly; UI-SPEC §Friendly-error). */}
        <div className="mx-auto w-16 h-16 rounded-[var(--radius-xl)] flex items-center justify-center shrink-0 bg-[var(--color-danger-500)] shadow-[var(--shadow-lg)]">
          <XCircle className="w-8 h-8 text-[var(--color-text-inverse)]" />
        </div>

        {/* D-04 lead: ONE friendly sentence sourced from the (unchanged) hint
            engine — translateSshError(w.errorMessage, t). This is the lead, NOT
            raw shell output; the raw log lives behind the "Подробнее" disclosure
            below. D-29: translateSshError only ever surfaces the already-sanitized
            errorMessage. */}
        <div className="space-y-2">
          {/* Hero heading uses text-display-sm (32px) like every other wizard hero
              (D-05 "one family"; 06-UI-REVIEW typography finding): the error moment is
              the most important for clarity, so its heading must not read smaller than a
              ServerStep heading. Keeps the --color-status-error color. */}
          <h2 id="wizard-heading" className="text-display-sm text-[var(--color-status-error)]">{t('wizard.error.title')}</h2>
          <p className="text-body text-[var(--color-text-secondary)] break-words select-text cursor-text">
            {w.errorMessage ? translateSshError(w.errorMessage, t) : t('wizard.error.unknown')}
          </p>
        </div>

        {/* Hint banner — informational, NOT the lead. Restyled to a calm
            warning-tint panel. The hint computation above (Pitfall 4) is reused
            byte-for-byte. */}
        {hints.length > 0 && (
          <div className="text-left space-y-1.5 p-3 rounded-[var(--radius-xl)] bg-[var(--color-warning-tint-08)] border border-[var(--color-warning-tint-20)]">
            <p className="text-body-sm font-medium flex items-center gap-1.5 text-[var(--color-warning-500)]">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              {t('wizard.error.possible_cause')}
            </p>
            {hints.map((hint, i) => (
              <p key={i} className="text-body-sm leading-relaxed text-[var(--color-text-secondary)]">{hint}</p>
            ))}
          </div>
        )}

        {/* "Подробнее" disclosure (collapsed by default). The toggle carries
            aria-expanded + aria-controls; the raw-log panel is a labelled
            role=region rendering ONLY w.deployLogs — the already
            backend-sanitized stream (no new log source — D-29). */}
        {w.deployLogs.length > 0 && (
          <div className="text-left">
            {/* UAT (06-uat fix 11): «Подробнее» + chevron are LEFT-aligned. The toggle
                used to carry mx-auto, which centered it in the centered max-w-sm column;
                the expanded log region below is already text-left, so the toggle now
                matches it. The wrapper is text-left and the button is no longer auto-
                centered. */}
            <button
              type="button"
              onClick={() => w.setShowLogs(!w.showLogs)}
              aria-expanded={w.showLogs}
              aria-controls={logsRegionId}
              className="flex items-center gap-1.5 text-body-sm transition-colors text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
            >
              {w.showLogs ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              {w.showLogs ? t('wizard.error.details_hide') : t('wizard.error.details_show')}
            </button>
            {w.showLogs && (
              <div
                id={logsRegionId}
                role="region"
                aria-label={t('wizard.error.logs_region_label')}
                className="mt-1.5 p-2 rounded-[var(--radius-lg)] max-h-36 overflow-y-auto text-mono-sm space-y-0.5 text-left select-text cursor-text relative group bg-[var(--color-bg-elevated)]"
              >
                <IconButton
                  aria-label={t('wizard.error.copy_logs_tooltip')}
                  tooltip={t('wizard.error.copy_logs_tooltip')}
                  onClick={w.copyLogsToClipboard}
                  icon={w.copied
                    ? <ClipboardCheck className="w-4 h-4 text-[var(--color-success-500)]" />
                    : <Copy className="w-4 h-4" />}
                  className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100"
                />
                {w.deployLogs.map((log, i) => (
                  <div
                    key={i}
                    className={log.level === "error" ? "text-[var(--color-danger-500)]" : "text-[var(--color-text-muted)]"}
                  >
                    {log.message}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 06-uat: the install wizard is deploy-only — the fetch-mode retry/«Назад»→server
            branch and the fetch-retry «reinstall» prompt were removed with the SSH/fetch
            surface. Only the port-80-busy fast path and the deploy retry remain. */}
        {/* Two actions (port-80-busy) STACK full-width — side-by-side in the max-w-sm
            (384px) hero column cramped the long «Переключиться на самоподписанный» label
            onto two lines. A single action stays content-width, centered. */}
        <div className="flex flex-col items-center gap-2 w-full">
          {/* C-06 (06-14): for a port-80-busy Let's Encrypt failure the fastest fix
              is to redeploy with a self-signed certificate. Offer it as the PRIMARY
              action; «Повторить» drops to secondary (ghost). It reuses the same
              vetted deploy path (no new surface).
              WR-01: setCertType is async, so a same-tick setCertType("selfsigned")
              + handleDeploy() made handleDeploy read the STALE letsencrypt certType
              and re-hit the SAME port-80 failure. We still call setCertType so the
              UI reflects the switch, but pass overrideCertType to handleDeploy so the
              deploy uses self-signed atomically, not the not-yet-committed state. */}
          {isPort80Busy ? (
            <>
              <Button variant="primary" size="sm" fullWidth onClick={() => { w.setCertType("selfsigned"); w.handleDeploy({ overrideCertType: "selfsigned" }); }}>
                {t('wizard.error.switch_to_selfsigned')}
              </Button>
              <Button variant="ghost" size="sm" fullWidth onClick={() => w.handleDeploy()}>
                {t('buttons.retry')}
              </Button>
            </>
          ) : (
            // «Попробовать снова» returns to the Endpoint SETTINGS (data preserved)
            // instead of re-running the SAME failing install. handleRetryToEndpoint
            // invalidates the operation generation + clears the deploy state FIRST so a
            // still-streaming deploy / a pending rejection cannot re-show the error.
            <Button
              variant="primary"
              size="sm"
              onClick={w.handleRetryToEndpoint}
            >
              {t('buttons.retry')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
