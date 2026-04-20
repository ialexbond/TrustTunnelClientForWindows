import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { StepBar } from "./StepBar";

describe("StepBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("returns null for welcome step", () => {
    const { container } = render(<StepBar step="welcome" isFetchMode={false} />);
    expect(container.innerHTML).toBe("");
  });

  it("returns null for done step", () => {
    const { container } = render(<StepBar step="done" isFetchMode={false} />);
    expect(container.innerHTML).toBe("");
  });

  it("returns null for error step", () => {
    const { container } = render(<StepBar step="error" isFetchMode={false} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders deploy mode steps (4 steps)", () => {
    render(<StepBar step="server" isFetchMode={false} />);
    expect(screen.getByText(i18n.t("wizard.progress.server"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("wizard.progress.checking"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("wizard.progress.settings"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("wizard.progress.installation"))).toBeInTheDocument();
  });

  it("renders fetch mode steps (3 steps)", () => {
    render(<StepBar step="server" isFetchMode={true} />);
    expect(screen.getByText(i18n.t("wizard.progress.server"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("wizard.progress.checking"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("wizard.progress.saving_config"))).toBeInTheDocument();
    // Should NOT have the settings/installation steps
    expect(screen.queryByText(i18n.t("wizard.progress.settings"))).not.toBeInTheDocument();
  });

  it("highlights active step (server)", () => {
    render(<StepBar step="server" isFetchMode={false} />);
    // Step 1 should be active and show "1"
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("shows checkmark for completed steps", () => {
    render(<StepBar step="endpoint" isFetchMode={false} />);
    // Steps before endpoint (server, checking) should be completed with checkmarks
    const checkmarks = screen.getAllByText("\u2713");
    expect(checkmarks.length).toBe(2);
  });

  it("highlights deploying step as active in deploy mode", () => {
    render(<StepBar step="deploying" isFetchMode={false} />);
    // Steps 1, 2, 3 should be checked, step 4 should be active
    const checkmarks = screen.getAllByText("\u2713");
    expect(checkmarks.length).toBe(3);
    expect(screen.getByText("4")).toBeInTheDocument();
  });
});
