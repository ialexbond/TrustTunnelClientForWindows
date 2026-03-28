import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Badge } from "./Badge";

describe("Badge", () => {
  it("renders children text", () => {
    render(<Badge>Active</Badge>);
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("applies success variant colors", () => {
    render(<Badge variant="success">OK</Badge>);
    const el = screen.getByText("OK").closest("span")!;
    expect(el.style.backgroundColor).toBe("rgba(16, 185, 129, 0.15)");
    expect(el.style.color).toBe("var(--color-success-400)");
  });

  it("applies warning variant colors", () => {
    render(<Badge variant="warning">Warn</Badge>);
    const el = screen.getByText("Warn").closest("span")!;
    expect(el.style.backgroundColor).toBe("rgba(245, 158, 11, 0.15)");
    expect(el.style.color).toBe("var(--color-warning-400)");
  });

  it("applies danger variant colors", () => {
    render(<Badge variant="danger">Err</Badge>);
    const el = screen.getByText("Err").closest("span")!;
    expect(el.style.backgroundColor).toBe("rgba(239, 68, 68, 0.15)");
    expect(el.style.color).toBe("var(--color-danger-400)");
  });

  it("applies default variant colors", () => {
    render(<Badge>Default</Badge>);
    const el = screen.getByText("Default").closest("span")!;
    expect(el.style.backgroundColor).toBe("var(--color-bg-hover)");
    expect(el.style.color).toBe("var(--color-text-secondary)");
  });

  it("renders icon when provided", () => {
    render(<Badge icon={<span data-testid="icon">*</span>}>WithIcon</Badge>);
    expect(screen.getByTestId("icon")).toBeInTheDocument();
  });

  it("applies sm size classes", () => {
    const { container } = render(<Badge size="sm">Small</Badge>);
    const badge = container.firstElementChild!;
    expect(badge.className).toContain("text-[10px]");
  });

  it("applies md size classes", () => {
    const { container } = render(<Badge size="md">Medium</Badge>);
    const badge = container.firstElementChild!;
    expect(badge.className).toContain("text-[11px]");
  });
});
