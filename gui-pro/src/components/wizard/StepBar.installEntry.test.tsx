import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { StepBar } from "./StepBar";

/**
 * 06-uat: the install wizard is now a SINGLE flow — «настройки → установка». The
 * `installEntry` / `isFetchMode` props were removed from StepBar (SSH auth happens in the
 * Control Panel before the wizard opens, and the fetch flow is gone), so the bar always
 * shows exactly the two stages. This file pins that 2-step contract; assertions target the
 * RU step labels + the accessible name (behavior + a11y), never dot geometry/colors.
 */
describe("StepBar — single «настройки → установка» 2-step bar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("shows «настройки → установка» (server/checking labels absent)", () => {
    render(<StepBar step="endpoint" />);
    // Only the two stages are shown.
    expect(screen.getByText(i18n.t("wizard.progress.settings"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("wizard.progress.installation"))).toBeInTheDocument();
    // The removed server-connect + «проверка» labels must NOT appear.
    expect(screen.queryByText(i18n.t("wizard.progress.server"))).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t("wizard.progress.checking"))).not.toBeInTheDocument();
  });

  it("endpoint is the active first step of a 2-step bar (a11y «Шаг 1 из 2»)", () => {
    render(<StepBar step="endpoint" />);
    // endpoint is index 0 of the 2-step set → accessible name «Шаг 1 из 2».
    expect(screen.getByLabelText(/Шаг\s+1\s+из\s+2/)).toBeInTheDocument();
  });

  it("deploying is the final active step of the 2-step bar (a11y «Шаг 2 из 2»)", () => {
    render(<StepBar step="deploying" />);
    // deploying is index 1 of the 2-step set → accessible name «Шаг 2 из 2».
    expect(screen.getByLabelText(/Шаг\s+2\s+из\s+2/)).toBeInTheDocument();
  });
});
