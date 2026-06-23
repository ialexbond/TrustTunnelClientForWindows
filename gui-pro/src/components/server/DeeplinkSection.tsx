import { useTranslation } from "react-i18next";
import { Check, AlertTriangle } from "lucide-react";
import { Input } from "../../shared/ui/Input";
import { Toggle } from "../../shared/ui/Toggle";
import { CIDRPicker } from "../../shared/ui/CIDRPicker";
import { CharCounter } from "../../shared/ui/CharCounter";
import { CertificateFingerprintCard } from "./CertificateFingerprintCard";
import { DnsUpstreamsInput } from "./DnsUpstreamsInput";
import type { DeeplinkFields } from "./useUserFormState";
import { cn } from "../../shared/lib/cn";

/**
 * DeeplinkSection — the «Параметры deeplink» section of UserModal, extracted
 * Phase 04 Plan 11 (PANEL-03, D-04, one sub-component per commit).
 *
 * Props-only presentational component (mirrors UserFormFields /
 * CertificateFingerprintCard): all values + handlers arrive from
 * `useUserFormState` (threaded by UserModal). This is a PURE JSX move — the
 * rendered DOM, testids and aria are byte-identical to the in-place section so
 * the Phase 3 characterization net passes unedited (Pitfall 1). It renders
 * `useTranslation` internally like the other extracted server sub-components;
 * no extra wrapping element was introduced.
 *
 * Covers the 7 TLV fields surfaced in the UI (anti-DPI, display name, custom
 * SNI + allowlist hints + suggestions, upstream protocol, skip-verify, pin-cert
 * + CertificateFingerprintCard, DNS upstreams) plus the CIDR restriction.
 */

// UX-upstream-segmented: 2-way HTTP/2 / HTTP/3 picker. The "auto" union member
// is kept in DeeplinkFields (back-compat) but no longer surfaced as a segment.
// Moved here verbatim with the section it drives (the only consumer).
const UPSTREAM_SEGMENTS: { value: "h2" | "h3"; label: string }[] = [
  { value: "h2", label: "HTTP/2" },
  { value: "h3", label: "HTTP/3" },
];

export interface DeeplinkSectionProps {
  /** Current deeplink TLV field values (from useUserFormState). */
  deeplink: DeeplinkFields;
  /** Type-safe single-field updater (from useUserFormState). */
  updateDeeplink: <K extends keyof DeeplinkFields>(
    key: K,
    value: DeeplinkFields[K],
  ) => void;
  /** Global disabled flag (true while a submit is in flight). */
  isDisabled: boolean;
  /** Edit-mode per-user config still loading — disables CIDR/anti-DPI. */
  configLoading: boolean;
  /**
   * Cert type detected for the endpoint. Disables Pin Certificate / Skip
   * Verification when the server runs Let's Encrypt (system CAs verify).
   */
  serverCertType?: "self_signed" | "lets_encrypt" | "unknown";
  /** SSH connection params threaded into CertificateFingerprintCard. */
  sshParams: {
    host: string;
    port: number;
    user: string;
    password: string;
    keyPath?: string;
  };
  /** i18n key for the display-name validator, or "" when valid. */
  localDisplayNameError: string;
  /** i18n key for the custom-SNI validator, or "" when valid. */
  localCustomSniError: string;
  /** Allowlist match state for the typed custom SNI. */
  customSniAllowlistState: "ok" | "warn" | "idle";
  /** Suggestion chips (hostname + allowed_sni) from hosts.toml. */
  sniSuggestions: string[];
  /** Trimmed custom SNI — used to mark the active suggestion chip. */
  trimmedCustomSni: string;
  /** DNS upstreams validator error sink. */
  setDnsError: (value: boolean) => void;
  /** CIDR validator error sink. */
  setCidrError: (value: boolean) => void;
}

export function DeeplinkSection({
  deeplink,
  updateDeeplink,
  isDisabled,
  configLoading,
  serverCertType,
  sshParams,
  localDisplayNameError,
  localCustomSniError,
  customSniAllowlistState,
  sniSuggestions,
  trimmedCustomSni,
  setDnsError,
  setCidrError,
}: DeeplinkSectionProps) {
  const { t } = useTranslation();

  return (
    <section aria-labelledby="section-deeplink">
      <p
        id="section-deeplink"
        className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide mb-[var(--space-3)]"
      >
        {t("server.users.section_deeplink")}
      </p>

      <div className="flex flex-col gap-[var(--space-4)]">
        {/* Anti-DPI toggle (D-5: ON by default) */}
        <Toggle
          checked={deeplink.antiDpi}
          onChange={(v) => updateDeeplink("antiDpi", v)}
          label={t("server.users.toggle_anti_dpi")}
          description={t("server.users.toggle_anti_dpi_help")}
          disabled={isDisabled || configLoading}
        />

        {/* Display name with CharCounter aligned right above the field (matches Input label styling: text-sm semibold) */}
        <div>
          <div className="flex items-baseline justify-between mb-1.5">
            <label
              htmlFor="user-modal-display-name"
              className="block text-sm font-medium text-[var(--color-text-secondary)]"
            >
              {t("server.users.field_display_name")}
            </label>
            <CharCounter value={deeplink.displayName.length} max={64} />
          </div>
          <Input
            id="user-modal-display-name"
            value={deeplink.displayName}
            onChange={(e) => updateDeeplink("displayName", e.target.value.slice(0, 64))}
            placeholder={t("server.users.field_display_name_placeholder")}
            aria-label={t("server.users.field_display_name")}
            disabled={isDisabled}
            // Chrome autofill heuristics залапали поле как «имя» —
            // всплывало «Сохранённые сведения». autoComplete="off" +
            // отсутствие name-атрибута даёт браузеру сигнал что
            // tracking/предложения не нужны. Для password-менеджеров
            // (1Password/LastPass) — спец data-атрибуты.
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

        {/* Custom SNI — WR-14.1-UAT-09: FQDN validation per D-4.
            M-01: plus inline check against `allowed_sni` in hosts.toml and
            a clickable suggestion chip rail so the user doesn't have to
            guess what the server will accept and hit the FIX-OO-14 rollback. */}
        <div>
          <Input
            label={t("server.users.field_custom_sni")}
            value={deeplink.customSni}
            onChange={(e) => updateDeeplink("customSni", e.target.value)}
            placeholder="cdn.example.com"
            aria-label={t("server.users.field_custom_sni")}
            disabled={isDisabled}
            // Та же причина что и у displayName — блокировать Chrome
            // autofill и password-менеджеры от предложения значений.
            autoComplete="off"
            data-lpignore="true"
            data-1p-ignore="true"
            data-form-type="other"
            helperText={
              localCustomSniError ? undefined : t("server.users.field_custom_sni_hint")
            }
            error={localCustomSniError ? t(localCustomSniError) : undefined}
          />

          {/* M-01: allowlist state — shown only when we actually have a list
              to compare against AND the format is valid (no point saying
              "not on the list" when the string isn't even a valid FQDN). */}
          {customSniAllowlistState === "ok" && (
            <p
              // CRIT-3: --color-status-success / --color-status-warning
              // don't exist in tokens.css — the colour fell through to
              // inherited text (white in dark theme, broken in light).
              // Use the canonical status tokens that auto-swap with theme.
              className="mt-1.5 text-xs flex items-center gap-1 text-[var(--color-status-connected)]"
              data-testid="sni-allowlist-ok"
            >
              <Check className="w-3 h-3" aria-hidden="true" />
              {t("server.users.custom_sni_allowed_ok")}
            </p>
          )}
          {customSniAllowlistState === "warn" && (
            <p
              // CRIT-4: same token-miss story — warning fell back to
              // inherited colour so the triangle and copy were invisible.
              className="mt-1.5 text-xs flex items-start gap-1 text-[var(--color-status-connecting)]"
              data-testid="sni-allowlist-warn"
            >
              <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" aria-hidden="true" />
              <span>{t("server.users.custom_sni_not_in_allowlist")}</span>
            </p>
          )}

          {/* M-01: suggestion chips — hostname + allowed_sni flattened.
              Rendered only when we actually fetched some; keeps the modal
              clean on fresh deploys where hosts.toml has only the main
              hostname and no allowed_sni entries yet. */}
          {sniSuggestions.length > 0 && (
            <div className="mt-2" data-testid="sni-suggestions">
              <p className="text-xs text-[var(--color-text-muted)] mb-1.5">
                {t("server.users.custom_sni_suggestions_label")}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {sniSuggestions.map((sni) => {
                  const isActive = sni === trimmedCustomSni;
                  return (
                    <button
                      key={sni}
                      type="button"
                      onClick={() => updateDeeplink("customSni", sni)}
                      disabled={isDisabled}
                      aria-pressed={isActive}
                      className={cn(
                        "px-2 py-0.5 text-xs rounded-full border transition-colors",
                        "focus-visible:shadow-[var(--focus-ring)] outline-none",
                        "disabled:opacity-[var(--opacity-disabled)] disabled:cursor-not-allowed",
                        // CRIT-5: `--color-accent` and `--color-surface`
                        // don't exist in tokens.css — the active chip lost
                        // its background in both themes, and the inactive
                        // chip had no surface colour in light mode. Switch
                        // to the canonical token names that actually resolve.
                        isActive
                          ? "bg-[var(--color-accent-interactive)] text-[var(--color-on-accent)] border-[var(--color-accent-interactive)]"
                          : "bg-[var(--color-bg-elevated)] text-[var(--color-text-secondary)] border-[var(--color-input-border)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-text-muted)]",
                      )}
                      data-testid={`sni-chip-${sni}`}
                    >
                      {sni}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* UX-upstream-segmented: 2-way toggle (HTTP/2 / HTTP/3) instead
            of a dropdown with «Авто» that mapped to the same h2 anyway.
            Pattern copied from SshConnectForm's auth-method picker. */}
        <div>
          <label className="block text-sm font-medium mb-1.5 text-[var(--color-text-secondary)]">
            {t("server.users.field_upstream_protocol")}
          </label>
          <div className="flex rounded-[var(--radius-md)] border border-[var(--color-border)] overflow-hidden">
            {UPSTREAM_SEGMENTS.map((seg) => {
              const active = deeplink.upstreamProtocol === seg.value;
              return (
                <button
                  key={seg.value}
                  type="button"
                  onClick={() => updateDeeplink("upstreamProtocol", seg.value)}
                  disabled={isDisabled}
                  aria-pressed={active}
                  className={cn(
                    "flex-1 flex items-center justify-center py-1.5 text-xs font-medium transition-colors",
                    "border-r border-[var(--color-border)] last:border-r-0",
                    "focus-visible:shadow-[var(--focus-ring)] outline-none",
                    "disabled:opacity-[var(--opacity-disabled)] disabled:cursor-not-allowed",
                    active
                      ? "bg-[var(--color-accent-interactive)] text-[var(--color-on-accent)]"
                      : "bg-[var(--color-input-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]",
                  )}
                  data-testid={`upstream-${seg.value}`}
                >
                  {seg.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Skip verification toggle.
            UX-le-disable: если сервер на Let's Encrypt — disable вместе с
            Pin Certificate, т.к. system trust store и так валидирует chain
            (DEEP_LINK.md §Security Considerations). Для self-signed /
            provided / unknown — toggle остаётся активным. */}
        <Toggle
          checked={deeplink.skipVerification}
          onChange={(v) => updateDeeplink("skipVerification", v)}
          label={t("server.users.toggle_skip_verify")}
          description={
            serverCertType === "lets_encrypt"
              ? t("server.users.toggle_le_not_needed")
              : t("server.users.toggle_skip_verify_warning")
          }
          disabled={isDisabled || serverCertType === "lets_encrypt"}
        />

        {/* Certificate pinning (D-6).
            FIX-AA: pinning requires a TLS handshake whose SNI matches the
            server cert's CN. If Custom SNI is empty and the connection
            host is an IP, the probe always fails — so we gate the toggle
            behind a non-empty Custom SNI rather than letting the user
            click into a dead-end error. Invalid SNI (validator reports
            error) also gates the toggle. */}
        <div>
          <Toggle
            checked={deeplink.pinCert}
            onChange={(v) => {
              updateDeeplink("pinCert", v);
              if (!v) {
                updateDeeplink("certDerB64", null);
                updateDeeplink("certFingerprint", null);
              }
            }}
            label={t("server.users.toggle_pin_cert")}
            description={
              serverCertType === "lets_encrypt"
                ? t("server.users.toggle_le_not_needed")
                : !deeplink.customSni.trim() || localCustomSniError
                ? t("server.users.toggle_pin_cert_needs_sni")
                : undefined
            }
            disabled={
              isDisabled ||
              serverCertType === "lets_encrypt" ||
              !deeplink.customSni.trim() ||
              Boolean(localCustomSniError)
            }
          />
          {deeplink.pinCert && (
            <div className="mt-2 ml-0">
              <CertificateFingerprintCard
                sshParams={sshParams}
                customSni={deeplink.customSni}
                // CRIT-2: hydrate the card's success-state from the saved
                // pin so Edit reopen shows the SHA-256 + Отвязать/Обновить
                // straight away, instead of «Загрузить endpoint» that made
                // the user re-probe every time.
                initialFingerprint={deeplink.certFingerprint}
                initialDerB64={deeplink.certDerB64}
                initialIsSystemVerifiable={deeplink.certIsSystemVerifiable}
                onFingerprintLoaded={(derB64, fingerprint, isSystemVerifiable) => {
                  updateDeeplink("certDerB64", derB64);
                  updateDeeplink("certFingerprint", fingerprint);
                  updateDeeplink("certIsSystemVerifiable", isSystemVerifiable);
                }}
                onClear={() => {
                  // FIX-BB: full unpin — drop the pinned bytes/fingerprint
                  // AND flip the toggle OFF, so the deeplink goes back to
                  // "no certificate pinning" instead of sitting in a
                  // pinCert=true + empty-cert limbo.
                  updateDeeplink("certDerB64", null);
                  updateDeeplink("certFingerprint", null);
                  updateDeeplink("certIsSystemVerifiable", false);
                  updateDeeplink("pinCert", false);
                }}
                disabled={isDisabled}
              />
            </div>
          )}
        </div>

        {/* DNS upstreams (D-4: dns_upstreams 0x0D) */}
        <DnsUpstreamsInput
          label={t("server.users.field_dns_upstreams")}
          value={deeplink.dnsUpstreams}
          onChange={(entries) => updateDeeplink("dnsUpstreams", entries)}
          onError={setDnsError}
          disabled={isDisabled}
        />

        {/* CIDR restriction (D-8). WR-14.1-UAT-08: propagate error → canSubmit.
            CIDR-requires-antiDpi: upstream rules.toml работает по
            «first-match wins, fall-through = allow». Чтобы CIDR
            реально блокировал — нужен prefix (client_random_prefix)
            как selector, иначе catch-all deny невозможно написать.
            Disable CIDR UI когда Anti-DPI OFF + показать hint. */}
        <CIDRPicker
          label={t("server.users.cidr_label")}
          value={deeplink.cidr}
          onChange={(v) => updateDeeplink("cidr", v)}
          onError={(errKey) => setCidrError(errKey.length > 0)}
          disabled={isDisabled || configLoading || !deeplink.antiDpi}
          helperText={
            !deeplink.antiDpi
              ? t("server.users.cidr_requires_anti_dpi")
              : undefined
          }
        />
      </div>
    </section>
  );
}
