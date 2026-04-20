import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Card, CardHeader } from "./Card";

describe("Card", () => {
  it("renders children", () => {
    render(<Card>Card content</Card>);
    expect(screen.getByText("Card content")).toBeInTheDocument();
  });

  it("applies custom className", () => {
    const { container } = render(<Card className="my-custom">Content</Card>);
    expect(container.firstElementChild!.className).toContain("my-custom");
  });

  it("uses var(--color-bg-surface) token class", () => {
    const { container } = render(<Card>Styled</Card>);
    const el = container.firstElementChild!;
    expect(el.className).toContain("bg-[var(--color-bg-surface)]");
  });

  it("uses var(--color-border) token class", () => {
    const { container } = render(<Card>Border</Card>);
    const el = container.firstElementChild!;
    expect(el.className).toContain("border-[var(--color-border)]");
  });

  it("uses var(--radius-lg) token class", () => {
    const { container } = render(<Card>Radius</Card>);
    const el = container.firstElementChild!;
    expect(el.className).toContain("rounded-[var(--radius-lg)]");
  });

  it("uses var(--shadow-sm) token class", () => {
    const { container } = render(<Card>Shadow</Card>);
    const el = container.firstElementChild!;
    expect(el.className).toContain("shadow-[var(--shadow-sm)]");
  });

  it("does not contain hardcoded hex colors", () => {
    const { container } = render(<Card>No hex</Card>);
    // style attribute should not have hex colors
    expect(container.firstElementChild!.getAttribute("style")).toBeNull();
  });

  it("applies hover border class when hover=true", () => {
    const { container } = render(<Card hover>Hover</Card>);
    expect(container.firstElementChild!.className).toContain(
      "hover:border-[var(--color-border-hover)]"
    );
  });
});

describe("CardHeader", () => {
  it("renders title", () => {
    render(<CardHeader title="My Card" />);
    expect(screen.getByText("My Card")).toBeInTheDocument();
  });

  it("renders description when provided", () => {
    render(<CardHeader title="Title" description="A description" />);
    expect(screen.getByText("A description")).toBeInTheDocument();
  });

  it("renders action slot", () => {
    render(<CardHeader title="Title" action={<button>Action</button>} />);
    expect(screen.getByText("Action")).toBeInTheDocument();
  });

  it("renders icon slot", () => {
    render(<CardHeader title="Title" icon={<span data-testid="icon">I</span>} />);
    expect(screen.getByTestId("icon")).toBeInTheDocument();
  });
});
