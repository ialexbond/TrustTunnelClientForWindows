import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { WelcomeStep } from "./WelcomeStep";
import { makeWizardState } from "./testHelpers";

describe("WelcomeStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("renders TrustTunnel VPN title", () => {
    const w = makeWizardState();
    render(<WelcomeStep {...w} />);
    expect(screen.getByText("TrustTunnel VPN")).toBeInTheDocument();
  });

  it("renders tagline and description", () => {
    const w = makeWizardState();
    render(<WelcomeStep {...w} />);
    // Tagline and description are in the same <p> separated by <br>, use regex
    expect(screen.getByText(new RegExp(i18n.t("wizard.welcome.tagline")))).toBeInTheDocument();
  });

  it("renders 3 action cards", () => {
    const w = makeWizardState();
    render(<WelcomeStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.welcome.setup_new"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("wizard.welcome.fetch_config"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("wizard.welcome.skip"))).toBeInTheDocument();
  });

  it("setup-new card navigates to server step", () => {
    const setWizardStep = vi.fn();
    const saveField = vi.fn();
    const w = makeWizardState({ setWizardStep, saveField });
    render(<WelcomeStep {...w} />);
    fireEvent.click(screen.getByText(i18n.t("wizard.welcome.setup_new")));
    expect(saveField).toHaveBeenCalledWith("wizardMode", "");
    expect(setWizardStep).toHaveBeenCalledWith("server");
  });

  it("fetch-config card sets fetch mode and navigates to server", () => {
    const setWizardStep = vi.fn();
    const saveField = vi.fn();
    const w = makeWizardState({ setWizardStep, saveField });
    render(<WelcomeStep {...w} />);
    fireEvent.click(screen.getByText(i18n.t("wizard.welcome.fetch_config")));
    expect(saveField).toHaveBeenCalledWith("wizardMode", "fetch");
    expect(setWizardStep).toHaveBeenCalledWith("server");
  });

  it("skip card calls handleSkip", () => {
    const handleSkip = vi.fn();
    const w = makeWizardState({ handleSkip });
    render(<WelcomeStep {...w} />);
    fireEvent.click(screen.getByText(i18n.t("wizard.welcome.skip")));
    expect(handleSkip).toHaveBeenCalledOnce();
  });

  it("shows system requirements section", () => {
    const w = makeWizardState();
    render(<WelcomeStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.welcome.requirements_header"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("wizard.welcome.requirement_linux"))).toBeInTheDocument();
  });
});
