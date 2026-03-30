import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Card } from "./Card";

describe("Card", () => {
  it("renders children", () => {
    render(<Card>Card content</Card>);
    expect(screen.getByText("Card content")).toBeInTheDocument();
  });

  it("applies custom className", () => {
    const { container } = render(<Card className="my-custom">Content</Card>);
    expect(container.firstElementChild!.className).toContain("my-custom");
  });

  it("has base card styling class (rounded border)", () => {
    const { container } = render(<Card>Styled</Card>);
    const el = container.firstElementChild!;
    expect(el.className).toContain("rounded-[var(--radius-xl)]");
    expect(el.className).toContain("border");
  });
});
