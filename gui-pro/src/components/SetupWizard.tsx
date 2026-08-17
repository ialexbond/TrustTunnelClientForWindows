import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, CheckCircle2 } from "lucide-react";
import { useWizardState } from "./wizard/useWizardState";
import { StepBar } from "./wizard/StepBar";
import { FoundStep } from "./wizard/FoundStep";
import { EndpointStep } from "./wizard/EndpointStep";
import { DeployingStep } from "./wizard/DeployingStep";
import { DoneStep } from "./wizard/DoneStep";
import { ErrorStep } from "./wizard/ErrorStep";
import { RecoveryStep } from "./wizard/RecoveryStep";
import type { SetupWizardProps } from "./wizard/types";

// 06-uat: the install wizard no longer contains an SSH-credentials screen or a
// server-installation probe screen. SSH authorization happens ONLY in the Control
// Panel; the wizard is always launched from a connected Control Panel («Установить»)
// in installEntry mode and reads its SSH secret from the per-host keyring store, so
// the old `server` (ServerStep) and `checking` (CheckingStep) screens — and the
// `fetch` flow (FetchingStep, «Забрать с сервера») — were removed end-to-end. The
// machine states still exist (kept inert for the Phase-5 invariance suites) but are
// unreachable from this router. Reachable screens: endpoint → deploying → done/error,
// plus `found` (server already installed → reinstall/manage) and the out-of-flow
// `recovery` fork (interrupted-install safety net) — neither shows an SSH login form.
function SetupWizard({ onSetupComplete, onClose, onBusyChange }: SetupWizardProps) {
  const { t } = useTranslation();
  // onClose threaded into the hook so screens (Done/Found post-install nav, an
  // auth-secret-miss fallback) can close the overlay instead of routing to a deleted
  // server screen (D-01 / Pitfall 3 / 06-uat SSH-removal).
  const wizard = useWizardState({ onSetupComplete, onClose });

  // INSTALL-LOCK (16-12): report the must-not-interrupt steps up to App so it can
  // lock the bottom tab nav. `deploying` = protocol install running; `uninstalling`
  // = delete/reset running. Any other step is safe to navigate away from. Also
  // fire `false` on unmount so a torn-down wizard never leaves the nav stuck locked.
  const busy = wizard.step === "deploying" || wizard.step === "uninstalling";
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);

  switch (wizard.step) {
    case "found":
      return <FoundStep {...wizard} />;
    case "uninstalling": {
      const step = wizard.deploySteps["uninstall"];
      // Uninstalling — restyled to the v3.0 hero pattern (D-05; UI-SPEC "Uninstalling"
      // row + PATTERNS "SetupWizard.tsx uninstalling block" = the CheckingStep hero).
      // The 32px spinner/check carries the step status color (danger while running,
      // success on ok), heading -> .text-display-sm, desc -> .text-body. The
      // step?.status branch, the StepBar wrapper, and the wizard.uninstalling.* copy
      // are unchanged — presentation-only. Token color classes, no inline style/hex.
      return (
        <>
          <StepBar step={wizard.step} />
          <div className="flex-1 flex items-center justify-center p-6">
            <div className="max-w-sm w-full text-center space-y-5">
              {step?.status === "ok" ? (
                <CheckCircle2 className="w-8 h-8 mx-auto text-[var(--color-success-fg)]" />
              ) : (
                <Loader2 className="w-8 h-8 animate-spin mx-auto text-[var(--color-danger-fg)]" />
              )}
              <div className="space-y-1">
                <h2 id="wizard-heading" className="text-display-sm text-[var(--color-text-primary)]">
                  {step?.status === "ok" ? t('wizard.uninstalling.success') : t('wizard.uninstalling.title')}
                </h2>
                <p className="text-body text-[var(--color-text-muted)]">
                  {t('wizard.uninstalling.description')}
                </p>
              </div>
            </div>
          </div>
        </>
      );
    }
    case "endpoint":
      return <EndpointStep {...wizard} />;
    case "deploying":
      return <DeployingStep {...wizard} />;
    case "done":
      return <DoneStep {...wizard} />;
    case "error":
      return <ErrorStep {...wizard} />;
    case "recovery":
      return <RecoveryStep {...wizard} />;
    default:
      // 06-uat: the install-only wizard enters at the settings screen. Any unknown /
      // legacy persisted step (incl. a stale "server"/"checking"/"welcome") falls back
      // to EndpointStep — never a deleted SSH-credentials component.
      return <EndpointStep {...wizard} />;
  }
}

export default SetupWizard;
