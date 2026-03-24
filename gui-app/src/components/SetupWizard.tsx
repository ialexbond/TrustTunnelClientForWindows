import { useTranslation } from "react-i18next";
import { Loader2, CheckCircle2 } from "lucide-react";
import { useWizardState } from "./wizard/useWizardState";
import { StepBar } from "./wizard/StepBar";
import { WelcomeStep } from "./wizard/WelcomeStep";
import { ServerStep } from "./wizard/ServerStep";
import { CheckingStep } from "./wizard/CheckingStep";
import { FoundStep } from "./wizard/FoundStep";
import { EndpointStep } from "./wizard/EndpointStep";
import { DeployingStep } from "./wizard/DeployingStep";
import { FetchingStep } from "./wizard/FetchingStep";
import { DoneStep } from "./wizard/DoneStep";
import { ErrorStep } from "./wizard/ErrorStep";
import type { SetupWizardProps } from "./wizard/types";

function SetupWizard({ onSetupComplete, resetToWelcomeRef }: SetupWizardProps) {
  const { t } = useTranslation();
  const wizard = useWizardState({ onSetupComplete, resetToWelcomeRef });

  switch (wizard.step) {
    case "welcome":
      return <WelcomeStep {...wizard} />;
    case "server":
      return <ServerStep {...wizard} />;
    case "checking":
      return <CheckingStep {...wizard} />;
    case "found":
      return <FoundStep {...wizard} />;
    case "uninstalling": {
      const step = wizard.deploySteps["uninstall"];
      return (
        <>
          <StepBar step={wizard.step} isFetchMode={wizard.isFetchMode} />
          <div className="flex-1 flex items-center justify-center p-6">
            <div className="max-w-sm w-full text-center space-y-5">
              {step?.status === "ok" ? (
                <CheckCircle2 className="w-10 h-10 mx-auto" style={{ color: "var(--color-success-500)" }} />
              ) : (
                <Loader2 className="w-10 h-10 animate-spin mx-auto" style={{ color: "var(--color-danger-500)" }} />
              )}
              <div className="space-y-1">
                <h2 className="text-lg font-bold">
                  {step?.status === "ok" ? t('wizard.uninstalling.success') : t('wizard.uninstalling.title')}
                </h2>
                <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                  {step?.message || t('wizard.uninstalling.description')}
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
    case "fetching":
      return <FetchingStep {...wizard} />;
    case "done":
      return <DoneStep {...wizard} />;
    case "error":
      return <ErrorStep {...wizard} />;
    default:
      return <WelcomeStep {...wizard} />;
  }
}

export default SetupWizard;
