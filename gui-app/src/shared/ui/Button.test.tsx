import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { createRef } from "react";
import { Button } from "./Button";

describe("Button", () => {
  it("renders children", () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole("button", { name: "Click me" })).toBeInTheDocument();
  });

  it("calls onClick when clicked", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Press</Button>);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("disabled state: button has disabled attr, onClick not called", () => {
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>No</Button>);
    const btn = screen.getByRole("button");
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("loading state: shows spinner and button is disabled", () => {
    render(<Button loading>Loading</Button>);
    const btn = screen.getByRole("button");
    expect(btn).toBeDisabled();
    // Loader2 renders an svg with animate-spin class
    const svg = btn.querySelector("svg");
    expect(svg).toBeInTheDocument();
    expect(svg!.classList.toString()).toContain("animate-spin");
  });

  it("renders primary variant without error", () => {
    const { container } = render(<Button variant="primary">P</Button>);
    expect(container.querySelector("button")).toBeInTheDocument();
  });

  it("renders secondary variant without error", () => {
    const { container } = render(<Button variant="secondary">S</Button>);
    expect(container.querySelector("button")).toBeInTheDocument();
  });

  it("renders danger variant without error", () => {
    const { container } = render(<Button variant="danger">D</Button>);
    expect(container.querySelector("button")).toBeInTheDocument();
  });

  it("renders ghost variant without error", () => {
    const { container } = render(<Button variant="ghost">G</Button>);
    expect(container.querySelector("button")).toBeInTheDocument();
  });

  it("applies sm size classes", () => {
    render(<Button size="sm">S</Button>);
    expect(screen.getByRole("button").className).toContain("h-8");
    expect(screen.getByRole("button").className).toContain("px-3");
  });

  it("applies md size classes", () => {
    render(<Button size="md">M</Button>);
    expect(screen.getByRole("button").className).toContain("px-4");
  });

  it("applies lg size classes", () => {
    render(<Button size="lg">L</Button>);
    expect(screen.getByRole("button").className).toContain("h-9");
    expect(screen.getByRole("button").className).toContain("px-5");
  });

  it("renders icon", () => {
    render(<Button icon={<span data-testid="btn-icon">+</span>}>Add</Button>);
    expect(screen.getByTestId("btn-icon")).toBeInTheDocument();
  });

  it("forwardRef works", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref}>Ref</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });
});
