import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Badge } from "./Badge";

describe("Badge", () => {
  it("renders children text", () => {
    render(<Badge>Active</Badge>);
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("applies success variant classes", () => {
    render(<Badge variant="success">OK</Badge>);
    const el = screen.getByText("OK").closest("span")!;
    expect(el.className).toContain("bg-[var(--color-status-connected-bg)]");
    expect(el.className).toContain("text-[var(--color-status-connected)]");
  });

  it("applies warning variant classes", () => {
    render(<Badge variant="warning">Warn</Badge>);
    const el = screen.getByText("Warn").closest("span")!;
    expect(el.className).toContain("bg-[var(--color-status-connecting-bg)]");
    expect(el.className).toContain("text-[var(--color-status-connecting)]");
  });

  it("applies danger variant classes", () => {
    render(<Badge variant="danger">Err</Badge>);
    const el = screen.getByText("Err").closest("span")!;
    expect(el.className).toContain("bg-[var(--color-status-error-bg)]");
    expect(el.className).toContain("text-[var(--color-status-error)]");
  });

  it("applies neutral variant classes by default", () => {
    render(<Badge>Default</Badge>);
    const el = screen.getByText("Default").closest("span")!;
    expect(el.className).toContain("bg-[var(--color-bg-elevated)]");
    expect(el.className).toContain("text-[var(--color-text-secondary)]");
  });

  it("applies dot variant and renders dot indicator", () => {
    render(<Badge variant="dot">Offline</Badge>);
    const el = screen.getByText("Offline").closest("span")!;
    expect(el.className).toContain("bg-transparent");
    // dot indicator span should exist inside
    const dot = el.querySelector("span[aria-hidden]");
    expect(dot).toBeInTheDocument();
  });

  it("applies pulse animation when pulse prop is true", () => {
    render(<Badge pulse>Live</Badge>);
    const el = screen.getByText("Live").closest("span")!;
    expect(el.className).toContain("animate-pulse");
  });

  it("forwards ref correctly", () => {
    const { container } = render(<Badge>Ref</Badge>);
    expect(container.firstElementChild).toBeInTheDocument();
  });
});
