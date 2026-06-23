import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Badge } from "./Badge";

// Phase-3 net rule: assert behavior / data-* / aria, never CSS class literals.
// Variant + pulse are asserted via the Badge's inert data-* hooks so the suite
// stays decoupled from the Tailwind presentation layer.
describe("Badge", () => {
  it("renders children text", () => {
    render(<Badge>Active</Badge>);
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("exposes the success variant", () => {
    render(<Badge variant="success">OK</Badge>);
    const el = screen.getByText("OK").closest("span")!;
    expect(el).toHaveAttribute("data-variant", "success");
  });

  it("exposes the warning variant", () => {
    render(<Badge variant="warning">Warn</Badge>);
    const el = screen.getByText("Warn").closest("span")!;
    expect(el).toHaveAttribute("data-variant", "warning");
  });

  it("exposes the danger variant", () => {
    render(<Badge variant="danger">Err</Badge>);
    const el = screen.getByText("Err").closest("span")!;
    expect(el).toHaveAttribute("data-variant", "danger");
  });

  it("defaults to the neutral variant", () => {
    render(<Badge>Default</Badge>);
    const el = screen.getByText("Default").closest("span")!;
    expect(el).toHaveAttribute("data-variant", "neutral");
  });

  it("exposes the dot variant and renders the dot indicator", () => {
    render(<Badge variant="dot">Offline</Badge>);
    const el = screen.getByText("Offline").closest("span")!;
    expect(el).toHaveAttribute("data-variant", "dot");
    // decorative dot indicator is present and hidden from assistive tech
    const dot = el.querySelector("span[aria-hidden]");
    expect(dot).toBeInTheDocument();
  });

  it("flags the pulse state when pulse prop is true", () => {
    render(<Badge pulse>Live</Badge>);
    const el = screen.getByText("Live").closest("span")!;
    expect(el).toHaveAttribute("data-pulse", "true");
  });

  it("does not flag the pulse state by default", () => {
    render(<Badge>Static</Badge>);
    const el = screen.getByText("Static").closest("span")!;
    expect(el).not.toHaveAttribute("data-pulse");
  });

  it("forwards ref correctly", () => {
    const { container } = render(<Badge>Ref</Badge>);
    expect(container.firstElementChild).toBeInTheDocument();
  });
});
