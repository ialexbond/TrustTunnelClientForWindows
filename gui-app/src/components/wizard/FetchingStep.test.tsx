import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { FetchingStep } from "./FetchingStep";
import { makeWizardState } from "./testHelpers";

describe("FetchingStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("renders fetching title and description", () => {
    const w = makeWizardState({ step: "fetching", isFetchMode: true });
    render(<FetchingStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.fetching.title"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("wizard.fetching.description"))).toBeInTheDocument();
  });

  it("renders loading spinner", () => {
    const w = makeWizardState({ step: "fetching", isFetchMode: true });
    const { container } = render(<FetchingStep {...w} />);
    expect(container.querySelector(".animate-spin")).toBeInTheDocument();
  });

  it("renders fetch steps with pending status", () => {
    const w = makeWizardState({ step: "fetching", isFetchMode: true, deploySteps: {} });
    const { container } = render(<FetchingStep {...w} />);
    const circles = container.querySelectorAll(".rounded-full");
    expect(circles.length).toBeGreaterThan(0);
  });

  it("renders step with progress status", () => {
    const w = makeWizardState({
      step: "fetching",
      isFetchMode: true,
      deploySteps: {
        connect: { step: "connect", status: "progress", message: "Connecting to server..." },
      },
    });
    render(<FetchingStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.steps.connect"))).toBeInTheDocument();
  });

  it("renders step with ok status", () => {
    const w = makeWizardState({
      step: "fetching",
      isFetchMode: true,
      deploySteps: {
        connect: { step: "connect", status: "ok", message: "Connected" },
      },
    });
    render(<FetchingStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.steps.connect"))).toBeInTheDocument();
  });

  it("renders step with error status", () => {
    const w = makeWizardState({
      step: "fetching",
      isFetchMode: true,
      deploySteps: {
        connect: { step: "connect", status: "error", message: "Timeout" },
      },
    });
    render(<FetchingStep {...w} />);
    expect(screen.getByText("Timeout")).toBeInTheDocument();
  });
});
