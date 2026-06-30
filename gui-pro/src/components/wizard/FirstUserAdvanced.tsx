import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, ChevronDown, Info } from "lucide-react";
import { Input } from "../../shared/ui/Input";
import { Toggle } from "../../shared/ui/Toggle";
import { CharCounter } from "../../shared/ui/CharCounter";
import { DnsUpstreamsInput } from "../server/DnsUpstreamsInput";
import { validateDisplayName } from "../../shared/utils/userValidators";
import type { DeeplinkFields } from "../server/useUserFormState";

/**
 * FirstUserAdvanced — the collapsed «Дополнительно» block for the FIRST VPN user
 * created during install (EndpointStep), closing D-11 / C-04.
 *
 * UAT (06-uat fix 3): the block previously reused the Users-tab `DeeplinkSection`
 * VERBATIM, exposing 8 controls. That was too much for the one-button install flow,
 * and several of those controls don't apply at install time. The first-user block is
 * now TRIMMED to the three controls that make sense during a fresh install, rendered
 * directly with the SAME shared primitives DeeplinkSection uses so look + validation
 * stay identical:
 *
 *   1. Защита от DPI    — Toggle bound to deeplink.antiDpi
 *   2. Имя конфига       — label + CharCounter + Input with validateDisplayName
 *   3. DNS серверы      — DnsUpstreamsInput bound to deeplink.dnsUpstreams
 *
 * REMOVED from the first-user block (user decision): custom SNI + allowlist chips,
 * skip-verification, pin-certificate + fingerprint card, upstream-protocol segmented,
 * and the CIDR field (CIDR is removed from the wizard — it isn't applied at install
 * anyway). The effective SNI is AUTO-FILLED from the Let's Encrypt domain at
 * config-export time (replacing the manual Custom SNI input).
 *
 * POSTURE (C-04): the removed toggles keep their safe DEFAULT_DEEPLINK values
 * (skipVerification=false, pinCert=none, upstreamProtocol="h2") because the first-user
 * deeplink is seeded from DEFAULT_DEEPLINK in useWizardState; the backend only writes
 * them when non-default, so the on-the-wire result is unchanged from today's defaults.
 *
 * ARCHITECTURE: every field here is an OPTIONAL deeplink-TLV parameter applied at
 * CONFIG-EXPORT time (the DoneStep deeplink/QR), NOT at install time. The install
 * writes ONLY credentials.toml (username + password). So this block configures the
 * FIRST USER'S EXPORTED CONFIG and NEVER blocks the one-button install — no field is
 * marked required `*` and none gates canDeploy.
 *
 * Props-only / presentational: the value + single-field updater are owned by
 * useWizardState (session-only — D-29 / T-06-32). COLLAPSED by default; expanding
 * reveals a non-blocking optional banner steering the non-technical user.
 */

export interface FirstUserAdvancedProps {
  /** Current first-user deeplink TLV field values (from useWizardState). */
  deeplink: DeeplinkFields;
  /** Type-safe single-field updater (from useWizardState.updateFirstUserAdvanced). */
  updateField: <K extends keyof DeeplinkFields>(
    key: K,
    value: DeeplinkFields[K],
  ) => void;
}

export function FirstUserAdvanced({
  deeplink,
  updateField,
}: FirstUserAdvancedProps) {
  const { t } = useTranslation();
  // COLLAPSED by default (D-11): the non-technical user sees a one-button install;
  // the advanced posture is opt-in.
  const [open, setOpen] = useState(false);
  // IN-05: useId() instead of a hard-coded DOM id so the label↔input association is
  // unique even if this block is ever mounted more than once on a page.
  const displayNameId = useId();

  // Reuse the Users-tab display-name validator (userValidators) so the first user gets
  // the SAME UX-level validation — the AUTHORITATIVE boundary is the backend whitelist
  // on the existing export command. Pure (value) => i18nKey | "".
  const localDisplayNameError = validateDisplayName(deeplink.displayName);

  return (
    <div className="space-y-2 pt-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-xs transition-colors text-[var(--color-text-muted)]"
      >
        {/* UAT (06-uat fix 4): disclosure-standard chevron — collapsed ChevronRight (▶),
            expanded ChevronDown (▼). Matches the EndpointStep «Дополнительно» toggle. */}
        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        {t('wizard.endpoint.first_user_advanced_label')}
      </button>

      {open && (
        <div className="space-y-3">
          {/* Non-blocking optional banner (D-11): steers the non-technical user that
              nothing below is required and can be changed later in «Пользователи». */}
          <div
            role="note"
            className="flex items-start gap-2 p-2 rounded-[var(--radius-lg)] bg-[var(--color-accent-tint-08)] border border-[var(--color-accent-tint-20)]"
          >
            <Info className="w-4 h-4 shrink-0 mt-0.5 text-[var(--color-accent-500)]" />
            <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">
              {t('wizard.endpoint.first_user_advanced_banner')}
            </p>
          </div>

          {/* The trimmed 3-field set, rendered with the SAME primitives the Users-tab
              DeeplinkSection uses so look + validation stay identical. */}
          <div className="flex flex-col gap-[var(--space-4)]">
            {/* 1. Anti-DPI (D-5: ON by default) */}
            <Toggle
              checked={deeplink.antiDpi}
              onChange={(v) => updateField("antiDpi", v)}
              label={t("server.users.toggle_anti_dpi")}
              description={t("server.users.toggle_anti_dpi_help")}
            />

            {/* 2. Display name with CharCounter aligned right above the field */}
            <div>
              <div className="flex items-baseline justify-between mb-1.5">
                <label
                  htmlFor={displayNameId}
                  className="block text-sm font-medium text-[var(--color-text-secondary)]"
                >
                  {t("server.users.field_display_name")}
                </label>
                <CharCounter value={deeplink.displayName.length} max={64} />
              </div>
              <Input
                id={displayNameId}
                value={deeplink.displayName}
                onChange={(e) => updateField("displayName", e.target.value.slice(0, 64))}
                placeholder={t("server.users.field_display_name_placeholder")}
                aria-label={t("server.users.field_display_name")}
                // Same Chrome-autofill / password-manager suppression as the Users tab.
                autoComplete="off"
                data-lpignore="true"
                data-1p-ignore="true"
                data-form-type="other"
                helperText={
                  localDisplayNameError ? undefined : t("server.users.field_display_name_hint")
                }
                error={localDisplayNameError ? t(localDisplayNameError) : undefined}
              />
            </div>

            {/* 3. DNS upstreams (D-4: dns_upstreams 0x0D) — never blocks install, so the
                error sink is intentionally inert here (the backend whitelist re-validates). */}
            <DnsUpstreamsInput
              label={t("server.users.field_dns_upstreams")}
              value={deeplink.dnsUpstreams}
              onChange={(entries) => updateField("dnsUpstreams", entries)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
