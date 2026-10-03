import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StepProgress } from "./StepProgress";

// 5 fake steps that mirror the real MTPROTO install pipeline shape so the
// component exercises the same code paths (5 nodes + 4 connectors).
const STEPS = [
  { key: "download", label: "Download" },
  { key: "configure", label: "Configure" },
  { key: "secret", label: "Generate secret" },
  { key: "service", label: "Start service" },
  { key: "complete", label: "Complete" },
];

describe("StepProgress", () => {
  it("renders all step labels", () => {
    render(<StepProgress steps={STEPS} currentStep={0} status="active" />);

    for (const step of STEPS) {
      expect(screen.getByText(step.label)).toBeVisible();
    }
  });

  it("shows spinner icon for active step (MTPROTO-02)", () => {
    // Loader2 -> createLucideIcon("LoaderCircle", ...) -> .lucide-loader-circle
    const { container } = render(
      <StepProgress steps={STEPS} currentStep={1} status="active" />,
    );

    const spinners = container.querySelectorAll(".lucide-loader-circle");
    expect(spinners).toHaveLength(1);
    // Confirm the spinner is spinning (animate-spin class from Tailwind).
    expect(spinners[0].classList.contains("animate-spin")).toBe(true);
  });

  it("shows check icon for completed steps", () => {
    // currentStep=3 + status=active -> steps 0..2 are "done" (check icon).
    const { container } = render(
      <StepProgress steps={STEPS} currentStep={3} status="active" />,
    );

    const checks = container.querySelectorAll(".lucide-check");
    // 3 completed steps precede the active one.
    expect(checks).toHaveLength(3);
  });

  it("shows X icon for error step", () => {
    const { container } = render(
      <StepProgress steps={STEPS} currentStep={2} status="error" />,
    );

    const xIcons = container.querySelectorAll(".lucide-x");
    expect(xIcons).toHaveLength(1);
  });

  it("shows circle icon for pending steps", () => {
    // currentStep=0, status=active -> steps 1..4 are pending (circle icon).
    const { container } = render(
      <StepProgress steps={STEPS} currentStep={0} status="active" />,
    );

    const circles = container.querySelectorAll(".lucide-circle");
    expect(circles).toHaveLength(4);
  });

  it("renders connector lines between steps", () => {
    const { container } = render(
      <StepProgress steps={STEPS} currentStep={0} status="active" />,
    );

    // Connector = <div class="flex-1 h-0.5 mx-1"> rendered before every step
    // except the first. 5 steps -> 4 connectors.
    const connectors = container.querySelectorAll("div.flex-1.h-0\\.5");
    expect(connectors).toHaveLength(4);
  });
});
