import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import i18n from "../shared/i18n";
import SetupWizard from "./SetupWizard";
import { renderWithProviders as render } from "../test/test-utils";
import { makeWizardState } from "./wizard/testHelpers";

// Mock useWizardState so we can control which step is returned
const mockWizardState = makeWizardState();
vi.mock("./wizard/useWizardState", () => ({
  useWizardState: () => mockWizardState,
}));

// Mock individual step components for isolation.
// 06-uat: the install wizard no longer renders an SSH-login (ServerStep), a server-probe
// (CheckingStep) or a fetch-progress (FetchingStep) screen — those components are deleted.
// Reachable screens: endpoint → deploying → done/error, plus found + recovery + uninstalling.
vi.mock("./wizard/FoundStep", () => ({
  FoundStep: () => <div data-testid="found-step">FoundStep</div>,
}));
vi.mock("./wizard/EndpointStep", () => ({
  EndpointStep: () => <div data-testid="endpoint-step">EndpointStep</div>,
}));
vi.mock("./wizard/DeployingStep", () => ({
  DeployingStep: () => <div data-testid="deploying-step">DeployingStep</div>,
}));
vi.mock("./wizard/DoneStep", () => ({
  DoneStep: () => <div data-testid="done-step">DoneStep</div>,
}));
vi.mock("./wizard/ErrorStep", () => ({
  ErrorStep: () => <div data-testid="error-step">ErrorStep</div>,
}));
vi.mock("./wizard/RecoveryStep", () => ({
  RecoveryStep: () => <div data-testid="recovery-step">RecoveryStep</div>,
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
    // 06-uat: install-only wizard opens on the Settings (endpoint) screen.
    Object.assign(mockWizardState, makeWizardState({ step: "endpoint" }));
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

  it("renders RecoveryStep when step is recovery", () => {
    Object.assign(mockWizardState, makeWizardState({ step: "recovery" }));
    render(<SetupWizard {...defaultProps} />);
    expect(screen.getByTestId("recovery-step")).toBeInTheDocument();
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
    expect(screen.getByText(i18n.t("wizard.uninstalling.description"))).toBeInTheDocument();
  });

  it("renders uninstalling step with default description when no message", () => {
    Object.assign(mockWizardState, makeWizardState({
      step: "uninstalling",
      deploySteps: { uninstall: { step: "uninstall", status: "running", message: "" } },
    }));
    render(<SetupWizard {...defaultProps} />);
    expect(screen.getByText(i18n.t("wizard.uninstalling.description"))).toBeInTheDocument();
  });

  it("falls back to EndpointStep for unknown/legacy step", () => {
    // 06-uat: the router default renders the install-first EndpointStep (Settings) for any
    // unknown/legacy step (incl. a stale persisted "welcome"/"server"/"checking"/"fetching"),
    // never a deleted component.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Object.assign(mockWizardState, makeWizardState({ step: "unknown_step" as any }));
    render(<SetupWizard {...defaultProps} />);
    expect(screen.getByTestId("endpoint-step")).toBeInTheDocument();
  });
});
