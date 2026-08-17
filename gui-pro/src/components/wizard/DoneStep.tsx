import { useTranslation } from "react-i18next";
import { CheckCircle2, ChevronRight, Download, Plug, AlertTriangle } from "lucide-react";
import { Button } from "../../shared/ui/Button";
import type { WizardState } from "./useWizardState";

export function DoneStep(w: WizardState) {
  const { t } = useTranslation();

  // UAT #20 (06-uat): the «Адрес сервера» card and the one-time password-reveal card
  // were REMOVED from the Done screen. The auto-generated first-user password already
  // lives in the saved/downloaded .toml config (so no on-screen reveal is needed), and
  // the server address + self-signed CN note were noise on the terminal success screen.
  // Done now shows only: hero, title, description, the config-file card, the (info-only)
  // reachability warning, and the action buttons. The generated password is still
  // session-only and never logged (D-29) — it is simply no longer surfaced here.

  // DoneStep — success hero on the v3.0 onboarding language (D-05; UI-SPEC "Done"
  // row). The 64px success square keeps `--color-success-fg` + `--shadow-lg` (the
  // onboarding shadow rule); heading moves to `.text-display-sm`, body to `.text-body`,
  // and the config-path card to `--text-mono-sm` token classes. The completion behavior
  // — `onSetupComplete` + the `tt_navigate_after_setup` intent — is UNCHANGED (the dead
  // welcome preamble was already dropped in Plan 03). Token color classes only; no hex.
  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <div className="max-w-sm w-full text-center space-y-5">
        <div className="mx-auto w-16 h-16 rounded-[var(--radius-xl)] flex items-center justify-center bg-[var(--color-success-500)] shadow-[var(--shadow-lg)]">
          {/* Token color on a colored hero (matches ServerStep): text-white is a
              hardcoded #fff and would lose contrast if --color-text-inverse is ever
              remapped for a custom theme (CLAUDE.md: colors via tokens, no hex). */}
          <CheckCircle2 className="w-8 h-8 text-[var(--color-text-inverse)]" />
        </div>

        <div className="space-y-1.5">
          <h2 id="wizard-heading" className="text-display-sm text-[var(--color-success-fg)]">{t('wizard.done.title')}</h2>
          <p className="text-body text-[var(--color-text-secondary)]">
            {/* 06-uat: deploy-only wizard — the fetch-completion copy was removed. */}
            {t('wizard.done.deploy_description')}
          </p>
        </div>

        {w.configPath && (
          <div className="glass-card p-3 text-left">
            <p className="text-body-sm mb-0.5 text-[var(--color-text-muted)]">{t('wizard.done.config_file_label')}</p>
            <p className="text-mono-sm font-mono break-all text-[var(--color-text-primary)]">{w.configPath}</p>
          </div>
        )}

        {/* C-09 / D-16 (06-15): soft post-install reachability warning. A best-effort
            outbound TLS probe (now retried, fix_17) found port 443 unreachable from
            outside (a still-starting service or a cloud Security Group / provider firewall
            is the usual cause). It is purely INFORMATIONAL — it sits ABOVE the action
            stack and MUST NOT disable, hide, or reorder «Перейти к панели управления» (the
            D-03 single primary CTA). fix_18 (06-uat): the «Понятно» dismiss button was
            REMOVED — the user found it crooked/pointless and wants the warning to simply
            stay as an info banner. The panel now persists (info-only); that is intended.
            Mirrors the ErrorStep calm warning-tint panel; token classes only, no hex. */}
        {w.reachabilityWarning && (
          <div className="text-left p-3 rounded-[var(--radius-xl)] bg-[var(--color-warning-tint-08)] border border-[var(--color-warning-tint-20)]">
            <p className="text-body-sm leading-relaxed flex items-start gap-1.5 text-[var(--color-text-secondary)]">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-[var(--color-warning-fg)]" />
              <span>{t('wizard.done.reachability_warning')}</span>
            </p>
          </div>
        )}

        <div className="space-y-2 w-full">
          {w.configPath ? (
            <>
              {/* R-7: «Добавить конфиг» is the PRIMARY next step after a successful install
                  (owner). The freshly-installed config is ALREADY saved to the app config
                  folder (deploy_export_config, same filename scheme as Save-As). This button is
                  the EXPLICIT «add this config» action: it registers the config as a card in
                  «Подключение» (register=true) and navigates there. «Перейти к панели управления»
                  (secondary, below) does NOT register — leaving to the panel no longer drops an
                  unwanted card into «Подключение» (BACKLOG auto-add-config fix). */}
              <Button
                variant="primary"
                size="sm"
                fullWidth
                icon={<Plug className="w-4 h-4" />}
                onClick={() => {
                  // App.tsx reads this key in onSetupComplete and switches activeTab to
                  // «connection» (a valid AppTab member). register=true → onSetupComplete
                  // registers the config (add_config) + closes the overlay.
                  localStorage.setItem("tt_navigate_after_setup", "connection");
                  w.onSetupComplete(w.configPath, true);
                }}
              >
                {t('wizard.done.add_config')}
              </Button>
              {/* Secondary: leave to the control panel WITHOUT adding a card. No register flag
                  (defaults false) → the install finishes, the config stays on disk, but nothing
                  is dropped into «Подключение» (BACKLOG auto-add-config fix). */}
              <Button
                variant="secondary"
                size="sm"
                fullWidth
                icon={<ChevronRight className="w-4 h-4" />}
                onClick={() => w.onSetupComplete(w.configPath)}
              >
                {t('wizard.done.go_to_panel')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                fullWidth
                icon={<Download className="w-4 h-4" />}
                onClick={w.handleSaveAs}
              >
                {t('buttons.save_as')}
              </Button>
            </>
          ) : (
            // No exported config (edge) → «Перейти к панели управления» stays the primary
            // (and only) action. onSetupComplete closes the overlay (App setWizardActive).
            <Button
              variant="primary"
              size="sm"
              fullWidth
              icon={<ChevronRight className="w-4 h-4" />}
              onClick={() => w.onSetupComplete(w.configPath)}
            >
              {t('wizard.done.go_to_panel')}
            </Button>
          )}
          {/* UAT (06-uat fix 2): the first-user QR/deeplink button was removed here — the
              deeplink/QR stays reachable from the Users tab. «На главную» (to_home) was
              already removed (UAT 2026-06-19): it duplicated the overlay × close. The × is
              the single close affordance. */}
        </div>
      </div>
    </div>
  );
}
