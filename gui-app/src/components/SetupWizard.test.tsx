import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../shared/i18n";
import SetupWizard from "./SetupWizard";
import { makeWizardState } from "./wizard/testHelpers";

// Mock useWizardState so we can control which step is returned
const mockWizardState = makeWizardState();
vi.mock("./wizard/useWizardState", () => ({
  useWizardState: () => mockWizardState,
}));

// Mock individual step components for isolation
vi.mock("./wizard/WelcomeStep", () => ({
  WelcomeStep: () => <div data-testid="welcome-step">WelcomeStep</div>,
}));
vi.mock("./wizard/ServerStep", () => ({
  ServerStep: () => <div data-testid="server-step">ServerStep</div>,
}));
vi.mock("./wizard/CheckingStep", () => ({
  CheckingStep: () => <div data-testid="checking-step">CheckingStep</div>,
}));
vi.mock("./wizard/FoundStep", () => ({
  FoundStep: () => <div data-testid="found-step">FoundStep</div>,
}));
vi.mock("./wizard/EndpointStep", () => ({
  EndpointStep: () => <div data-testid="endpoint-step">EndpointStep</div>,
}));
vi.mock("./wizard/DeployingStep", () => ({
  DeployingStep: () => <div data-testid="deploying-step">DeployingStep</div>,
}));
vi.mock("./wizard/FetchingStep", () => ({
  FetchingStep: () => <div data-testid="fetching-step">FetchingStep</div>,
}));
vi.mock("./wizard/DoneStep", () => ({
  DoneStep: () => <div data-testid="done-step">DoneStep</div>,
}));
vi.mock("./wizard/ErrorStep", () => ({
  ErrorStep: () => <div data-testid="error-step">ErrorStep</div>,
}));
vi.mock("./wizard/StepBar", () => ({
  StepBar: () => <div data-testid="step-bar">StepBar</div>,
}));

describe("SetupWizard", () => {
  const defaultProps = {
    onSetupComplete: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
    // Reset to welcome step
    Object.assign(mockWizardState, makeWizardState({ step: "welcome" }));
  });

  it("renders WelcomeStep when step is welcome", () => {
    Object.assign(mockWizardState, makeWizardState({ step: "welcome" }));
    render(<SetupWizard {...defaultProps} />);
    expect(screen.getByTestId("welcome-step")).toBeInTheDocument();
  });

  it("renders ServerStep when step is server", () => {
    Object.assign(mockWizardState, makeWizardState({ step: "server" }));
    render(<SetupWizard {...defaultProps} />);
    expect(screen.getByTestId("server-step")).toBeInTheDocument();
  });

  it("renders CheckingStep when step is checking", () => {
    Object.assign(mockWizardState, makeWizardState({ step: "checking" }));
    render(<SetupWizard {...defaultProps} />);
    expect(screen.getByTestId("checking-step")).toBeInTheDocument();
  });

  it("renders FoundStep when step is found", () => {
    Object.assign(mockWizardState, makeWizardState({ step: "found" }));
    render(<SetupWizard {...defaultProps} />);
    expect(screen.getByTestId("found-step")).toBeInTheDocument();
  });

  it("renders EndpointStep when step is endpoint", () => {
    Object.assign(mockWizardState, makeWizardState({ step: "endpoint" }));
    render(<SetupWizard {...defaultProps} />);
    expect(screen.getByTestId("endpoint-step")).toBeInTheDocument();
  });

  it("renders DeployingStep when step is deploying", () => {
    Object.assign(mockWizardState, makeWizardState({ step: "deploying" }));
    render(<SetupWizard {...defaultProps} />);
    expect(screen.getByTestId("deploying-step")).toBeInTheDocument();
  });

  it("renders FetchingStep when step is fetching", () => {
    Object.assign(mockWizardState, makeWizardState({ step: "fetching" }));
    render(<SetupWizard {...defaultProps} />);
    expect(screen.getByTestId("fetching-step")).toBeInTheDocument();
  });

  it("renders DoneStep when step is done", () => {
    Object.assign(mockWizardState, makeWizardState({ step: "done" }));
    render(<SetupWizard {...defaultProps} />);
    expect(screen.getByTestId("done-step")).toBeInTheDocument();
  });

  it("renders ErrorStep when step is error", () => {
    Object.assign(mockWizardState, makeWizardState({ step: "error" }));
    render(<SetupWizard {...defaultProps} />);
    expect(screen.getByTestId("error-step")).toBeInTheDocument();
  });

  it("renders uninstalling step with spinner when status is not ok", () => {
    Object.assign(mockWizardState, makeWizardState({
      step: "uninstalling",
      deploySteps: { uninstall: { step: "uninstall", status: "running", message: "" } },
    }));
    render(<SetupWizard {...defaultProps} />);
    expect(screen.getByTestId("step-bar")).toBeInTheDocument();
    expect(screen.getByText(i18n.t("wizard.uninstalling.title"))).toBeInTheDocument();
  });

  it("renders uninstalling step with check icon when status is ok", () => {
    Object.assign(mockWizardState, makeWizardState({
      step: "uninstalling",
      deploySteps: { uninstall: { step: "uninstall", status: "ok", message: "Uninstalled successfully" } },
    }));
    render(<SetupWizard {...defaultProps} />);
    expect(screen.getByText(i18n.t("wizard.uninstalling.success"))).toBeInTheDocument();
    expect(screen.getByText("Uninstalled successfully")).toBeInTheDocument();
  });

  it("renders uninstalling step with default description when no message", () => {
    Object.assign(mockWizardState, makeWizardState({
      step: "uninstalling",
      deploySteps: { uninstall: { step: "uninstall", status: "running", message: "" } },
    }));
    render(<SetupWizard {...defaultProps} />);
    expect(screen.getByText(i18n.t("wizard.uninstalling.description"))).toBeInTheDocument();
  });

  it("falls back to WelcomeStep for unknown step", () => {
    Object.assign(mockWizardState, makeWizardState({ step: "unknown_step" as any }));
    render(<SetupWizard {...defaultProps} />);
    expect(screen.getByTestId("welcome-step")).toBeInTheDocument();
  });
});
