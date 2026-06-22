import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { StepBar } from "./StepBar";

describe("StepBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  // 06-uat: the bar is a SINGLE «настройки → установка» 2-step flow. Legacy server/checking/
  // welcome/fetching steps render nothing (they are unreachable in the install-only wizard).
  it("returns null for welcome step", () => {
    const { container } = render(<StepBar step="welcome" />);
    expect(container.innerHTML).toBe("");
  });

  it("returns null for done step", () => {
    const { container } = render(<StepBar step="done" />);
    expect(container.innerHTML).toBe("");
  });

  it("returns null for error step", () => {
    const { container } = render(<StepBar step="error" />);
    expect(container.innerHTML).toBe("");
  });

  it("returns null for the legacy server step (unreachable in the install-only wizard)", () => {
    const { container } = render(<StepBar step="server" />);
    expect(container.innerHTML).toBe("");
  });

  it("returns null for the legacy checking step (unreachable in the install-only wizard)", () => {
    const { container } = render(<StepBar step="checking" />);
    expect(container.innerHTML).toBe("");
  });

  it("renders the 2-step install flow (настройки → установка)", () => {
    render(<StepBar step="endpoint" />);
    expect(screen.getByText(i18n.t("wizard.progress.settings"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("wizard.progress.installation"))).toBeInTheDocument();
    // The removed server/checking labels must NOT appear.
    expect(screen.queryByText(i18n.t("wizard.progress.server"))).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t("wizard.progress.checking"))).not.toBeInTheDocument();
  });

  // ── NOTE (D-03 softening, Plan 02) ──
  // The old loud numbered-circle markup ("1", "2", "✓" badges) was replaced by the
  // calm dot indicator. There are no longer numbered/checkmark glyphs to assert; active
  // progress is now expressed through the container aria-label ("Шаг {n} из {total}")
  // — the behavioral contract pinned in Wave-0. These assertions therefore target the
  // accessible name + step labels (behavior + a11y), never the dot geometry/colors.
  it("marks the active step's accessible position (endpoint → step 1 of 2)", () => {
    render(<StepBar step="endpoint" />);
    // endpoint is index 0 of the 2-step set → "Шаг 1 из 2".
    expect(screen.getByLabelText(/Шаг\s+1\s+из\s+2/)).toBeInTheDocument();
  });

  it("marks the final deploy step active (deploying → step 2 of 2)", () => {
    render(<StepBar step="deploying" />);
    // deploying is index 1 of the 2-step set → "Шаг 2 из 2".
    expect(screen.getByLabelText(/Шаг\s+2\s+из\s+2/)).toBeInTheDocument();
  });
});
