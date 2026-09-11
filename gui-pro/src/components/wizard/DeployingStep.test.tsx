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

  // The hand-rolled progressbar div was swapped for the shared ProgressBar primitive,
  // which carries its own role="progressbar" + aria-valuenow/min/max. Assert the
  // accessible contract directly rather than CSS.
  it("renders the shared ProgressBar with the overall percent as aria-valuenow", () => {
    const w = makeWizardState({
      step: "deploying",
      // 1 of N steps done, none in-flight → a deterministic non-zero percent.
      deploySteps: {
        connect: { step: "connect", status: "ok", message: "Connected" },
      },
    });
    render(<DeployingStep {...w} />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    // aria-valuenow mirrors the computed overall percent (done/total * 100, rounded).
    const now = Number(bar.getAttribute("aria-valuenow"));
    expect(now).toBeGreaterThan(0);
    expect(now).toBeLessThanOrEqual(100);
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
    expect(screen.getByText(i18n.t("wizard.steps.connect"))).toBeInTheDocument();
  });

  it("renders step with ok status (checkmark)", () => {
    const w = makeWizardState({
      step: "deploying",
      deploySteps: {
        connect: { step: "connect", status: "ok", message: "Connected" },
      },
    });
    render(<DeployingStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.steps.connect"))).toBeInTheDocument();
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

  // #23 (06-uat): the cancelling phase label lives ON the action button (disabled +
  // spinner), not on a separate text line. The button is the SINGLE in-progress indicator.
  it("shows cancelling label ON the disabled action button when cancellingDeploy is true (#23)", () => {
    const w = makeWizardState({ step: "deploying", cancellingDeploy: true });
    render(<DeployingStep {...w} />);
    const btn = screen.getByRole("button", { name: i18n.t("wizard.deploying.cancelling") });
    expect(btn).toBeInTheDocument();
    // The button is disabled during cancel (no action possible mid-operation).
    expect(btn).toBeDisabled();
    // The plain «Отмена» cancel label is no longer shown (it became the cancelling label).
    expect(screen.queryByRole("button", { name: i18n.t("buttons.cancel") })).not.toBeInTheDocument();
  });

  // #23 (06-uat): during the post-deploy FINALIZE phase the «Завершаем настройку…» label
  // now lives ON the action button (disabled + spinner) — the standalone fix_16 <p> line
  // was REMOVED so there is exactly ONE in-progress indicator at any time.
  it("shows the finalizing label ON the disabled action button (no separate line) when finalizing (#23)", () => {
    const off = makeWizardState({ step: "deploying", finalizing: false });
    const { unmount } = render(<DeployingStep {...off} />);
    // Not finalizing → the button shows the plain cancel label, no finalizing text anywhere.
    expect(screen.queryByText(i18n.t("wizard.deploying.finalizing"))).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: i18n.t("buttons.cancel") })).toBeInTheDocument();
    unmount();

    const on = makeWizardState({ step: "deploying", finalizing: true });
    render(<DeployingStep {...on} />);
    // The finalizing label appears as the button name (single indicator), button disabled.
    const btn = screen.getByRole("button", { name: i18n.t("wizard.deploying.finalizing") });
    expect(btn).toBeInTheDocument();
    expect(btn).toBeDisabled();
  });

  // #23 (06-uat): exactly ONE in-progress indicator — the «Завершаем настройку…» text must
  // appear only inside the button, never as a standalone paragraph next to it.
  it("renders the finalizing text exactly once and inside the action button (#23)", () => {
    const w = makeWizardState({ step: "deploying", finalizing: true });
    render(<DeployingStep {...w} />);
    const matches = screen.getAllByText(i18n.t("wizard.deploying.finalizing"));
    expect(matches).toHaveLength(1);
    // The single occurrence is within the button element.
    expect(matches[0].closest("button")).not.toBeNull();
  });

  // cancel-lifecycle (06-review): once the terminal `done` step lands the install is complete
  // — nothing left to cancel. The button must LOCK into the disabled finalize state (no active
  // «Отмена» flash) until the screen flips to «Всё готово», even before the `finalizing` flag
  // is set / after it clears.
  it("locks the button to a disabled finishing state once the terminal done step is ok (no cancel flash)", () => {
    const w = makeWizardState({
      step: "deploying",
      finalizing: false,
      cancellingDeploy: false,
      deploySteps: {
        connect: { step: "connect", status: "ok", message: "ok" },
        done: { step: "done", status: "ok", message: "done" },
      },
    });
    render(<DeployingStep {...w} />);
    // The active «Отмена» affordance is gone…
    expect(screen.queryByRole("button", { name: i18n.t("buttons.cancel") })).not.toBeInTheDocument();
    // …the button shows the finalize label and is disabled.
    const btn = screen.getByRole("button", { name: i18n.t("wizard.deploying.finalizing") });
    expect(btn).toBeDisabled();
  });

  // ── Internal sentinels must not leak into the live tail (06-uat) ──
  // The configure step runs `test -f … && echo TT_EXISTS || echo TT_MISSING` existence
  // probes; those machine markers must NOT surface as the live log tail (they read as a raw
  // error code under the step). The most recent NON-sentinel info/warn line shows instead.
  it("hides TT_MISSING/TT_EXISTS sentinels from the live log tail", () => {
    const w = makeWizardState({
      step: "deploying",
      deploySteps: { configure: { step: "configure", status: "progress", message: "configure" } },
      deployLogs: [
        { level: "info", message: "Reading database ... 25%" },
        { level: "info", message: "CERT TT_MISSING" },
      ],
    });
    render(<DeployingStep {...w} />);
    expect(screen.queryByText("CERT TT_MISSING")).not.toBeInTheDocument();
    expect(screen.getByText("Reading database ... 25%")).toBeInTheDocument();
  });
});
