import { useTranslation } from "react-i18next";
import {
  User, Lock, Globe, Mail,
  AlertTriangle, ChevronRight, ChevronDown, Rocket, FileKey, Upload,
  Shuffle, Shield,
} from "lucide-react";
// cn helper for the segmented 407/405 control (mirrors DeeplinkSection's joined-button pattern).
import { cn } from "../../shared/lib/cn";
// UAT (06-uat fix 2): the three cert-type cards use a matched MingCute SVG set
// (Lucide-only rule explicitly waived by the user for these icons) so all three
// cards share one visual family — green check / yellow shield / neutral file-key.
import { CertLetsEncryptIcon, CertSelfSignedIcon, CertProvidedIcon } from "./CertIcons";
import { StepBar } from "./StepBar";
import { Input } from "../../shared/ui/Input";
import { ActionInput } from "../../shared/ui/ActionInput";
import { ActionPasswordInput } from "../../shared/ui/ActionPasswordInput";
import { Button } from "../../shared/ui/Button";
import { Tooltip } from "../../shared/ui/Tooltip";
import { generateUsername, generatePassword } from "../../shared/utils/credentialGenerator";
import { FirstUserAdvanced } from "./FirstUserAdvanced";
import { Toggle } from "../../shared/ui/Toggle";
import type { WizardState } from "./useWizardState";

export function EndpointStep(w: WizardState) {
  const { t } = useTranslation();

  return (
    <>
      <StepBar step={w.step} />
      {/* UAT (06-uat fix F): the 64px Settings hero glyph was removed from this FORM
          screen — on an input-heavy screen it added visual weight without conveying
          anything the heading doesn't. The heading is kept. Hero glyphs stay on the
          STATUS screens (Done/Error/Checking/Deploying/…) where they convey state. */}
      <div className="flex-1 flex items-center justify-center p-4 overflow-y-auto">
        <div className="max-w-md w-full space-y-4">
          <div className="flex flex-col items-center text-center space-y-2">
            {/* Stable heading id matches the shared per-screen aria convention (UI-SPEC §A11y),
                same as ServerStep/CheckingStep. The overlay aria-labelledby resolves to App's
                own sr-only #wizard-dialog-title (Plan 06-03), independent of this id. */}
            <h2 id="wizard-heading" className="text-display-sm text-[var(--color-text-primary)]">
              {t('wizard.endpoint.title')}
            </h2>
          </div>

          {/* ── VPN Credentials ── */}
          <div className="glass-card p-3 space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-[var(--color-text-secondary)]">
              <User className="w-5 h-5" />
              {t('wizard.endpoint.vpn_credentials')}
            </div>
            {/* C-01 (D-11): the first VPN user now has the SAME generate/copy parity every
                other add-user surface has (AddUserForm.tsx:31-70). The plain Input/PasswordInput
                pair is replaced by ActionInput + ActionPasswordInput with a Shuffle re-roll and a
                copy action; both fields are seeded once on first mount (useWizardState credential
                seed). Username + password are marked required `*` — per CONFIGURATION.md/
                PROTOCOL.md v1.0.33 they are the ONLY install-required user fields (credentials.toml
                [[client]] = username+password). The onChange whitelist-strip regexes are kept
                VERBATIM (defense-in-depth; backend re-validates regardless). */}
            <div className="grid grid-cols-2 gap-2 items-start">
              <ActionInput
                label={<>{t('wizard.endpoint.login_label')} <span className="text-[var(--color-danger-fg)]" aria-hidden="true">*</span></>}
                value={w.vpnUsername}
                // ASVS V5 (T-06-05): input-layer whitelist-strip mirrors the backend
                // validate_vpn_username whitelist (sanitize.rs) EXACTLY — keep only
                // [a-zA-Z0-9._-]. Defense-in-depth: the IPC boundary re-validates regardless,
                // but stripping here means the field can never hold a value the deploy would
                // reject deep in the install. Must survive the raw-input → ActionInput
                // migration — never dropped.
                onChange={(e) => w.setVpnUsername(e.target.value.replace(/[^a-zA-Z0-9._-]/g, ""))}
                placeholder="vpnuser"
                autoFocus
                actions={[
                  <Tooltip key="gen" text={t("common.generate_username")}>
                    <button
                      type="button"
                      aria-label={t("common.generate_username")}
                      onClick={() => w.setVpnUsername(generateUsername())}
                      className="transition-colors hover:opacity-70 text-[var(--color-text-muted)]"
                    >
                      <Shuffle className="w-3 h-3" />
                    </button>
                  </Tooltip>,
                ]}
              />
              <ActionPasswordInput
                label={<>{t('wizard.endpoint.password_label')} <span className="text-[var(--color-danger-fg)]" aria-hidden="true">*</span></>}
                showLockIcon={false}
                value={w.vpnPassword}
                // ASVS V5 (T-06-05): mirror the backend validate_vpn_password whitelist
                // (sanitize.rs:59-67) EXACTLY — backslash, single quote and double quote are
                // rejected as SSH-heredoc-injection defense. Keeping them here would let a
                // value through frontend validation that then failed deep in deploy with an
                // opaque "invalid characters" AFTER connect+install. Strip them at the input so
                // the field can never hold a rejectable value. Re-attached onto the shared
                // ActionPasswordInput — never dropped; backend re-validates regardless.
                onChange={(e) => w.setVpnPassword(e.target.value.replace(/[^a-zA-Z0-9!@#$%^&*()_+\-=[\]{};:|,./<>?`~]/g, ""))}
                placeholder="••••••••"
                actions={[
                  <Tooltip key="gen" text={t("common.generate_password")}>
                    <button
                      type="button"
                      aria-label={t("common.generate_password")}
                      onClick={() => w.setVpnPassword(generatePassword())}
                      className="transition-colors hover:opacity-70 text-[var(--color-text-muted)]"
                    >
                      <Shuffle className="w-3 h-3" />
                    </button>
                  </Tooltip>,
                ]}
              />
            </div>

            {/* C-02 (06-13): duplicate first-user name on the reinstall-from-Found path.
                Rendered full-width BELOW the username/password grid (not cramped inside the
                narrow username column) AND blocks install via canDeploy. */}
            {w.isDuplicateVpnUsername && (
              <p
                className="text-xs mt-1 text-[var(--color-status-error)]"
                role="alert"
              >
                {t('wizard.endpoint.username_taken')}
              </p>
            )}

            {/* ── First-user «Дополнительно» (D-11, C-04) ──
                Collapsed-by-default block giving the FIRST user a TRIMMED advanced set:
                anti-DPI, display name, DNS upstreams (06-uat fix 3 — was the full 8-field
                Users-tab composition). The effective SNI is auto-filled from the LE domain
                in useWizardState. Everything here is OPTIONAL — install proceeds on
                username+password only; these are deeplink-TLV params applied at
                CONFIG-EXPORT time (DoneStep). It lives next to the credentials because it
                configures THIS user, not the server. The component owns its own collapse +
                non-blocking optional banner. */}
            {/* UAT (06-uat fix 3): the first-user advanced block is now 3 fields
                (anti-DPI / display name / DNS) — it no longer hosts the pin-cert
                fingerprint probe, so sshParams is no longer passed. */}
            <FirstUserAdvanced
              deeplink={w.firstUserAdvanced}
              updateField={w.updateFirstUserAdvanced}
            />
          </div>

          {/* ── TLS Certificate ── */}
          <div className="glass-card p-3 space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-[var(--color-text-secondary)]">
              <Lock className="w-5 h-5" />
              {t('wizard.endpoint.tls_certificate')}
            </div>
            {/* Cert-type 3-up choice = token-classed selectable cards (UI-SPEC §Color: selected
                state keeps the per-type accent/warning/success tint-08 fill + tint-40 ring; the
                unselected state is the surface/border resting style). Replaces the old inline
                style={{}} branch object with token utility classes. */}
            <div className="grid grid-cols-3 gap-1.5">
              {/* UAT (06-uat fix C): each card is a TOP-ALIGNED vertical stack
                  (flex-col items-start) — icon on its OWN line at the top, then the
                  title, then the subtitle where present. The old inline «icon left of a
                  wrapping title» layout produced a staircase because the three titles
                  wrapped to different line counts (and the custom card had no subtitle),
                  so the icons + titles sat at different heights. With the icon on its own
                  top line, all three icons + titles align regardless of title length; the
                  grid row already equalizes card height. Padding is p-2 on all three. */}
              {/* Let's Encrypt */}
              <button
                type="button"
                onClick={() => w.setCertType("letsencrypt")}
                className={
                  w.certType === "letsencrypt"
                    ? "p-2 rounded-[var(--radius-xl)] text-xs text-left transition-all flex flex-col items-start border border-[var(--color-success-tint-40)] bg-[var(--color-success-tint-08)] text-[var(--color-text-primary)]"
                    : "p-2 rounded-[var(--radius-xl)] text-xs text-left transition-all flex flex-col items-start border border-[var(--color-border)] bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)] hover:border-[var(--color-success-tint-40)] hover:bg-[var(--color-success-tint-08)]"
                }
              >
                <CertLetsEncryptIcon className="w-6 h-6 shrink-0 mb-1 text-[var(--color-success-fg)]" />
                <div className="font-medium">Let's Encrypt</div>
                <div className="text-xs mt-0.5 text-[var(--color-text-muted)]">{t('wizard.endpoint.le_recommended')}</div>
              </button>

              {/* Self-signed */}
              <button
                type="button"
                onClick={() => w.setCertType("selfsigned")}
                className={
                  w.certType === "selfsigned"
                    ? "p-2 rounded-[var(--radius-xl)] text-xs text-left transition-all flex flex-col items-start border border-[var(--color-warning-tint-40)] bg-[var(--color-warning-tint-08)] text-[var(--color-text-primary)]"
                    : "p-2 rounded-[var(--radius-xl)] text-xs text-left transition-all flex flex-col items-start border border-[var(--color-border)] bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)] hover:border-[var(--color-warning-tint-40)] hover:bg-[var(--color-warning-tint-08)]"
                }
              >
                <CertSelfSignedIcon className="w-6 h-6 shrink-0 mb-1 text-[var(--color-warning-fg)]" />
                <div className="font-medium">{t('wizard.endpoint.self_signed')}</div>
                <div className="text-xs mt-0.5 text-[var(--color-text-muted)]">{t('wizard.endpoint.self_signed_quick')}</div>
              </button>

              {/* Provided / Custom */}
              <button
                type="button"
                onClick={() => w.setCertType("provided")}
                className={
                  // Custom cert = NEUTRAL (gray) selection — not the brand accent (user
                  // request): LE green / self-signed yellow / custom gray.
                  w.certType === "provided"
                    ? "p-2 rounded-[var(--radius-xl)] text-xs text-left transition-all flex flex-col items-start border border-[var(--color-text-muted)] bg-[var(--color-bg-active)] text-[var(--color-text-primary)]"
                    : "p-2 rounded-[var(--radius-xl)] text-xs text-left transition-all flex flex-col items-start border border-[var(--color-border)] bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)] hover:border-[var(--color-text-muted)] hover:bg-[var(--color-bg-active)]"
                }
              >
                {/* UAT (06-uat fix 2b): the «Свой сертификат» subtitle was removed — the
                    card title alone is clear, and the hint added nothing the cert-path
                    fields below don't already explain. The Let's Encrypt / Self-signed
                    subtitles are kept (they convey the recommendation/trade-off). */}
                <CertProvidedIcon className="w-6 h-6 shrink-0 mb-1 text-[var(--color-text-muted)]" />
                <div className="font-medium">{t('wizard.endpoint.provided_cert')}</div>
              </button>
            </div>

            {/* Self-signed warning */}
            {w.certType === "selfsigned" && (
              <div className="flex items-start gap-2 p-2 rounded-[var(--radius-lg)] bg-[var(--color-status-connecting-bg)] border border-[var(--color-status-connecting-border)]">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-[var(--color-warning-fg)]" />
                <p className="text-xs leading-relaxed text-[var(--color-warning-fg)]">
                  {t('wizard.endpoint.self_signed_warning')}
                </p>
              </div>
            )}

            {/* Let's Encrypt fields */}
            {w.certType === "letsencrypt" && (
              <div className="space-y-2">
                <Input
                  // UAT (06-uat fix 1): domain is REQUIRED for Let's Encrypt (canDeploy
                  // gates non-empty + valid LE target), so it carries the same «*» marker
                  // as the username/password fields above. aria-hidden because the
                  // requirement is enforced by canDeploy, not announced per-field.
                  label={<>{t('labels.domain_name')} <span className="text-[var(--color-danger-fg)]" aria-hidden="true">*</span></>}
                  icon={<Globe className="w-4 h-4" />}
                  value={w.domain}
                  onChange={(e) => w.setDomain(e.target.value)}
                  placeholder="vpn.example.com"
                  // C-08 (06-09): a structurally-invalid LE target (.local/.test/no-dot…)
                  // is rejected AT THE FORM via leDomainError, mirroring the backend check
                  // (deploy.rs) — so an invalid domain disables «Установить» here, not
                  // minutes into the install.
                  error={w.leDomainError ? t('wizard.endpoint.le_domain_invalid') : undefined}
                  helperText={w.host
                    ? t('wizard.endpoint.dns_record_help', { host: w.host })
                    : t('wizard.endpoint.dns_record_help_no_host')}
                />
                <Input
                  type="email"
                  // UAT (06-uat fix 1): a non-empty valid email is now a deliberate UX
                  // requirement (canDeploy gates email.trim().length > 0), so the field
                  // carries the «*». NOTE the backend still treats email as optional
                  // (--register-unsafely-without-email) — this requirement is UX-only.
                  label={<>{t('wizard.endpoint.email_label')} <span className="text-[var(--color-danger-fg)]" aria-hidden="true">*</span></>}
                  icon={<Mail className="w-4 h-4" />}
                  value={w.email}
                  onChange={(e) => w.setEmail(e.target.value)}
                  placeholder="you@example.com"
                  error={w.email.trim() && !w.isValidEmail(w.email) ? t('wizard.endpoint.email_invalid') : undefined}
                  helperText={t('wizard.endpoint.certificate_email_help')}
                />
              </div>
            )}

            {/* Provided cert fields */}
            {w.certType === "provided" && (
              <div className="space-y-2">
                <Input
                  label={t('wizard.endpoint.cert_chain_path')}
                  icon={<Upload className="w-4 h-4" />}
                  value={w.certChainPath}
                  onChange={(e) => w.setCertChainPath(e.target.value)}
                  placeholder="/etc/ssl/certs/cert.pem"
                  helperText={t('wizard.endpoint.cert_chain_path_help')}
                />
                <Input
                  label={t('wizard.endpoint.cert_key_path')}
                  icon={<FileKey className="w-4 h-4" />}
                  value={w.certKeyPath}
                  onChange={(e) => w.setCertKeyPath(e.target.value)}
                  placeholder="/etc/ssl/private/key.pem"
                  helperText={t('wizard.endpoint.cert_key_path_help')}
                />
              </div>
            )}
          </div>

          {/* ── Защита сервера (WIZARD-06 / D-01) ──
              Two install-time toggles, both default ON, so a non-technical operator
              provisions a secure baseline without opting in. Section mirrors the
              «TLS Certificate» glass-card pattern above (uppercase label row + leading
              icon); the Shield carries the section icon, so the reused Toggles get no
              per-row icon. D-03: the post-install reconfigure surface is the existing
              Control-Panel → Security tab — NOT new client-Settings toggles. */}
          <div className="glass-card p-3 space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-[var(--color-text-secondary)]">
              <Shield className="w-5 h-5" />
              {t('wizard.endpoint.server_protection')}
            </div>
            {/* Toggle reused verbatim — its visible `label` auto-forwards to the
                role="switch" accessible name (Toggle D-03.2), so no extra aria-label;
                `description` renders as the muted helper sub-text. */}
            <Toggle
              checked={w.enableFirewall}
              onChange={w.setEnableFirewall}
              label={t('wizard.endpoint.firewall_label')}
              description={t('wizard.endpoint.firewall_help')}
            />
            <Toggle
              checked={w.enableFail2ban}
              onChange={w.setEnableFail2ban}
              label={t('wizard.endpoint.fail2ban_label')}
              description={t('wizard.endpoint.fail2ban_help')}
            />
          </div>

          {/* ── Advanced settings ── */}
          <button
            type="button"
            onClick={() => w.setShowAdvanced(!w.showAdvanced)}
            className="flex items-center gap-1.5 text-xs transition-colors text-[var(--color-text-muted)]"
          >
            {/* UAT (06-uat fix 4): disclosure-standard chevron direction — collapsed shows
                ChevronRight (▶), expanded shows ChevronDown (▼). */}
            {w.showAdvanced ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            {t('wizard.endpoint.advanced_settings')}
          </button>
          {w.showAdvanced && (
            <div className="glass-card p-3 space-y-3">
              <Input
                label={t('wizard.endpoint.listen_address_label')}
                value={w.listenAddress}
                onChange={(e) => w.setListenAddress(e.target.value)}
                placeholder="0.0.0.0:443"
                helperText={t('wizard.endpoint.listen_address_help')}
              />

              {/* D-10 (06-09): the 407/405 auth-failure chooser. UAT (06-uat fix 3): now uses
                  the SAME joined-button segmented control as the H2/H3 upstream selector
                  (DeeplinkSection) so the whole app's segmented choices read as one family —
                  NOT a raw <select>, so the value stays enum-constrained by construction; the
                  backend re-validates to 405|407 (validate_auth_status_code) regardless. The
                  role=radiogroup/radio + aria-checked + the i18n text labels + the
                  setAuthFailureStatusCode(407|405) onClick are PRESERVED verbatim. */}
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-[var(--color-text-primary)]">
                  {t('wizard.endpoint.auth_failure_label')}
                </p>
                <div
                  role="radiogroup"
                  aria-label={t('wizard.endpoint.auth_failure_label')}
                  className="flex rounded-[var(--radius-md)] border border-[var(--color-border)] overflow-hidden"
                >
                  {([407, 405] as const).map((code) => {
                    const active = w.authFailureStatusCode === code;
                    return (
                      <button
                        key={code}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => w.setAuthFailureStatusCode(code)}
                        className={cn(
                          "flex-1 flex items-center justify-center py-1.5 text-xs font-medium transition-colors",
                          "border-r border-[var(--color-border)] last:border-r-0",
                          "focus-visible:shadow-[var(--focus-ring)] outline-none",
                          active
                            ? "bg-[var(--color-accent-interactive)] text-[var(--color-on-accent)]"
                            : "bg-[var(--color-input-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]",
                        )}
                      >
                        {code === 407
                          ? t('wizard.endpoint.auth_failure_407')
                          : t('wizard.endpoint.auth_failure_405')}
                      </button>
                    );
                  })}
                </div>
                <p className="text-xs text-[var(--color-text-muted)]">{t('wizard.endpoint.auth_failure_help')}</p>
              </div>
            </div>
          )}

          {/* DNS warning */}
          {w.certType === "letsencrypt" && w.domain.trim() && (
            <div className="flex items-start gap-2 p-3 rounded-[var(--radius-xl)] bg-[var(--color-warning-tint-08)] border border-[var(--color-warning-tint-20)]">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-[var(--color-warning-fg)]" />
              <div className="text-xs leading-relaxed text-[var(--color-text-secondary)]">
                <span className="font-semibold text-[var(--color-warning-fg)]">{t('wizard.endpoint.dns_warning_important')}</span>{' '}
                {w.host
                  ? t('wizard.endpoint.dns_warning_text', { domain: w.domain, host: w.host })
                  : t('wizard.endpoint.dns_warning_text_no_host', { domain: w.domain })}
              </div>
            </div>
          )}

          <div className="flex gap-2 pt-1">
            {/* Fresh install (from the Control Panel «Установить») has no in-wizard
                server/«проверка» step before Settings, so its back action EXITS the
                wizard back to where the user came from (onClose → App closes the overlay)
                — never the old «server» connect screen. The reinstall-from-found path
                (cameFromFound / already-installed) still navigates back to «found». */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                if (w.cameFromFound || w.serverInfo?.installed) {
                  w.setCameFromFound(false);
                  w.setWizardStep("found");
                } else {
                  w.onClose?.();
                }
              }}
            >
              {w.cameFromFound || w.serverInfo?.installed ? t('buttons.back') : t('control.exit')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              className="flex-1"
              icon={<Rocket className="w-4 h-4" />}
              // C-05 reinstall consent: when the user arrived via FoundStep
              // «Переустановить» (cameFromFound=true), the deliberate reinstall IS the
              // consent to overwrite a DIVERGING vpn.toml/hosts.toml. A fresh install
              // (cameFromFound=false) keeps overwriteConfig=false. credentials.toml is
              // STILL preserved unconditionally by the backend regardless (D-02).
              onClick={() => w.handleDeploy({ overwriteConfig: w.cameFromFound })}
              disabled={!w.canDeploy}
            >
              {t('buttons.install')}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
