import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatCard } from "./StatCard";

describe("StatCard", () => {
  it("renders value and label", () => {
    render(<StatCard label="Download" value="1.24 MB/s" />);
    expect(screen.getByText("1.24 MB/s")).toBeInTheDocument();
    expect(screen.getByText("Download")).toBeInTheDocument();
  });

  it("shows Skeleton when loading=true", () => {
    const { container } = render(<StatCard label="Download" value="—" loading />);
    const skeletons = container.querySelectorAll("[aria-hidden='true']");
    expect(skeletons.length).toBeGreaterThanOrEqual(2);
  });

  it("does not show value text when loading", () => {
    render(<StatCard label="Download" value="1.24 MB/s" loading />);
    expect(screen.queryByText("1.24 MB/s")).not.toBeInTheDocument();
  });

  it("renders icon when provided", () => {
    render(<StatCard label="L" value="V" icon={<span data-testid="stat-icon" />} />);
    expect(screen.getByTestId("stat-icon")).toBeInTheDocument();
  });

  it("icon has aria-hidden=true", () => {
    const { container } = render(
      <StatCard label="L" value="V" icon={<span data-testid="stat-icon" />} />
    );
    const iconWrapper = container.querySelector("[aria-hidden='true']");
    expect(iconWrapper).toBeInTheDocument();
  });

  it("renders positive trend with + prefix", () => {
    render(<StatCard label="L" value="V" trend={12} />);
    expect(screen.getByText("+12%")).toBeInTheDocument();
  });

  it("renders negative trend with - prefix", () => {
    render(<StatCard label="L" value="V" trend={-5} />);
    expect(screen.getByText("-5%")).toBeInTheDocument();
  });

  it("hides trend when value is zero", () => {
    render(<StatCard label="L" value="V" trend={0} />);
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
  });

  it("hides trend when not provided", () => {
    const { container } = render(<StatCard label="L" value="V" />);
    // No trend element should exist
    expect(container.textContent).not.toContain("%");
  });

  it("applies custom className", () => {
    const { container } = render(<StatCard label="L" value="V" className="custom-class" />);
    expect(container.firstChild).toHaveClass("custom-class");
  });
});
