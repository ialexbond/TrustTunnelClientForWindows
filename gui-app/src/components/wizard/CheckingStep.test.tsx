import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { CheckingStep } from "./CheckingStep";
import { makeWizardState } from "./testHelpers";

describe("CheckingStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("renders spinner", () => {
    const w = makeWizardState({ step: "checking" });
    const { container } = render(<CheckingStep {...w} />);
    expect(container.querySelector(".animate-spin")).toBeInTheDocument();
  });

  it("renders checking title and description", () => {
    const w = makeWizardState({ step: "checking" });
    render(<CheckingStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.checking.title"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("wizard.checking.description"))).toBeInTheDocument();
  });

  it("renders cancel button", () => {
    const w = makeWizardState({ step: "checking" });
    render(<CheckingStep {...w} />);
    expect(screen.getByText(i18n.t("buttons.cancel"))).toBeInTheDocument();
  });

  it("calls cancelCheck on cancel button click", () => {
    const cancelCheck = vi.fn();
    const w = makeWizardState({ step: "checking", cancelCheck });
    render(<CheckingStep {...w} />);
    fireEvent.click(screen.getByText(i18n.t("buttons.cancel")));
    expect(cancelCheck).toHaveBeenCalledOnce();
  });
});
