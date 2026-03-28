import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { DeployingStep } from "./DeployingStep";
import { makeWizardState } from "./testHelpers";

describe("DeployingStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("renders deploying title and description", () => {
    const w = makeWizardState({ step: "deploying" });
    render(<DeployingStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.deploying.title"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("wizard.deploying.description"))).toBeInTheDocument();
  });

  it("renders deploy steps with pending status (empty circles)", () => {
    const w = makeWizardState({ step: "deploying", deploySteps: {} });
    const { container } = render(<DeployingStep {...w} />);
    // All steps should show as pending (no icon, just circle)
    const circles = container.querySelectorAll(".rounded-full");
    expect(circles.length).toBeGreaterThan(0);
  });

  it("renders step with progress status (spinner)", () => {
    const w = makeWizardState({
      step: "deploying",
      deploySteps: {
        connect: { step: "connect", status: "progress", message: "Connecting..." },
      },
    });
    const { container } = render(<DeployingStep {...w} />);
    expect(container.querySelector(".animate-spin")).toBeInTheDocument();
    expect(screen.getByText("Connecting...")).toBeInTheDocument();
  });

  it("renders step with ok status (checkmark)", () => {
    const w = makeWizardState({
      step: "deploying",
      deploySteps: {
        connect: { step: "connect", status: "ok", message: "Connected" },
      },
    });
    render(<DeployingStep {...w} />);
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("renders step with error status", () => {
    const w = makeWizardState({
      step: "deploying",
      deploySteps: {
        connect: { step: "connect", status: "error", message: "Failed to connect" },
      },
    });
    render(<DeployingStep {...w} />);
    expect(screen.getByText("Failed to connect")).toBeInTheDocument();
  });

  it("renders cancel button and calls handleCancelDeploy", () => {
    const handleCancelDeploy = vi.fn();
    const w = makeWizardState({ step: "deploying", handleCancelDeploy });
    render(<DeployingStep {...w} />);
    const cancelBtn = screen.getByText(i18n.t("buttons.cancel"));
    fireEvent.click(cancelBtn);
    expect(handleCancelDeploy).toHaveBeenCalledOnce();
  });

  it("shows cancelling text when cancellingDeploy is true", () => {
    const w = makeWizardState({ step: "deploying", cancellingDeploy: true });
    render(<DeployingStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.deploying.cancelling"))).toBeInTheDocument();
  });
});
