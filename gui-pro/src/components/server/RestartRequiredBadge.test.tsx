import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { RestartRequiredBadge } from "./RestartRequiredBadge";

beforeEach(() => {
  i18n.changeLanguage("ru");
});

describe("RestartRequiredBadge", () => {
  it("renders disrupt-high copy in Russian", () => {
    render(<RestartRequiredBadge level="disrupt-high" />);
    expect(screen.getByText("Прервёт активные подключения")).toBeInTheDocument();
  });

  it("renders disrupt-low copy in Russian", () => {
    render(<RestartRequiredBadge level="disrupt-low" />);
    expect(screen.getByText("Перезапустит сервис")).toBeInTheDocument();
  });

  it("has role=status for a11y", () => {
    render(<RestartRequiredBadge level="disrupt-high" />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("applies disrupt-high token classes", () => {
    const { container } = render(<RestartRequiredBadge level="disrupt-high" />);
    const badge = container.querySelector('[role="status"]');
    expect(badge?.className).toContain("color-danger-fg");
  });

  it("applies disrupt-low token classes", () => {
    const { container } = render(<RestartRequiredBadge level="disrupt-low" />);
    const badge = container.querySelector('[role="status"]');
    expect(badge?.className).toContain("color-warning-fg");
  });

  it("renders an AlertTriangle icon for disrupt-high", () => {
    const { container } = render(<RestartRequiredBadge level="disrupt-high" />);
    // lucide-react v0.468.x renders AlertTriangle as <svg class="lucide lucide-triangle-alert ...">
    expect(container.querySelector("svg.lucide-triangle-alert")).not.toBeNull();
  });

  it("renders a RefreshCw icon for disrupt-low", () => {
    const { container } = render(<RestartRequiredBadge level="disrupt-low" />);
    expect(container.querySelector("svg.lucide-refresh-cw")).not.toBeNull();
  });

  it("merges custom className", () => {
    const { container } = render(
      <RestartRequiredBadge level="disrupt-low" className="extra-class" />,
    );
    expect(container.querySelector(".extra-class")).toBeInTheDocument();
  });
});
