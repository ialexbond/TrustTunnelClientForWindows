import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { StatusIndicator } from "./StatusIndicator";

describe("StatusIndicator", () => {
  it("renders with role=img and custom aria-label", () => {
    render(<StatusIndicator status="success" label="Online" />);
    expect(screen.getByRole("img", { name: "Online" })).toBeInTheDocument();
  });

  it("defaults aria-label to status value when no label prop", () => {
    render(<StatusIndicator status="warning" />);
    expect(screen.getByRole("img", { name: "warning" })).toBeInTheDocument();
  });

  it("adds animate-pulse class when pulse=true", () => {
    const { container } = render(<StatusIndicator status="success" pulse />);
    expect(container.firstChild).toHaveClass("animate-pulse");
  });

  it("does not have animate-pulse when pulse is not set", () => {
    const { container } = render(<StatusIndicator status="success" />);
    expect(container.firstChild).not.toHaveClass("animate-pulse");
  });

  it("forwards ref", () => {
    const ref = createRef<HTMLSpanElement>();
    render(<StatusIndicator status="neutral" ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLSpanElement);
  });

  it("renders as a span element", () => {
    const { container } = render(<StatusIndicator status="neutral" />);
    expect(container.firstChild?.nodeName).toBe("SPAN");
  });

  it("applies custom className", () => {
    const { container } = render(<StatusIndicator status="info" className="extra" />);
    expect(container.firstChild).toHaveClass("extra");
  });
});
