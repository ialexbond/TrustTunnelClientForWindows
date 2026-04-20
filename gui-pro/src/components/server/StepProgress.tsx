import { Fragment } from "react";
import { Loader2, Check, X, Circle } from "lucide-react";

interface StepProgressProps {
  steps: { key: string; label: string }[];
  currentStep: number; // 0-based index of the active step
  status: "active" | "error" | "completed"; // status of currentStep
}

export function StepProgress({ steps, currentStep, status }: StepProgressProps) {
  return (
    <div className="flex items-center w-full py-2">
      {steps.map((step, i) => {
        // Determine step state
        let stepStatus: "pending" | "active" | "done" | "error";
        if (i < currentStep) stepStatus = "done";
        else if (i === currentStep) {
          stepStatus = status === "error" ? "error" : status === "completed" ? "done" : "active";
        } else stepStatus = "pending";

        // Connector line before this step (not before first)
        const connector = i > 0 && (
          <div
            className="flex-1 h-0.5 mx-1"
            style={{
              backgroundColor: i <= currentStep
                ? "var(--color-status-connected)"
                : "var(--color-border)",
            }}
          />
        );

        // Icon
        let icon;
        if (stepStatus === "active") icon = <Loader2 className="w-4 h-4 animate-spin" style={{ color: "var(--color-accent-interactive)" }} />;
        else if (stepStatus === "done") icon = <Check className="w-4 h-4" style={{ color: "var(--color-status-connected)" }} />;
        else if (stepStatus === "error") icon = <X className="w-4 h-4" style={{ color: "var(--color-status-error)" }} />;
        else icon = <Circle className="w-3 h-3" style={{ color: "var(--color-text-muted)" }} />;

        // Label color
        let labelColor: string;
        if (stepStatus === "active") labelColor = "var(--color-accent-interactive)";
        else if (stepStatus === "error") labelColor = "var(--color-status-error)";
        else labelColor = "var(--color-text-muted)";

        return (
          <Fragment key={step.key}>
            {connector}
            <div className="flex flex-col items-center gap-1" style={{ minWidth: 48 }}>
              <div className="flex items-center justify-center w-5 h-5">
                {icon}
              </div>
              <span className="text-[10px] text-center leading-tight" style={{ color: labelColor }}>
                {step.label}
              </span>
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
