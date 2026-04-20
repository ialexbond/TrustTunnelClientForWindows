import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Accordion } from "./Accordion";

const items = [
  { id: "1", title: "First", content: <p>Content one</p> },
  { id: "2", title: "Second", content: <p>Content two</p> },
  { id: "3", title: "Third", content: <p>Content three</p> },
];

describe("Accordion", () => {
  it("renders all item headers", () => {
    render(<Accordion items={items} />);
    expect(screen.getByRole("button", { name: /First/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Second/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Third/i })).toBeInTheDocument();
  });

  it("all items closed by default (no defaultOpen)", () => {
    render(<Accordion items={items} />);
    expect(screen.getByText("Content one")).not.toBeVisible();
    expect(screen.getByText("Content two")).not.toBeVisible();
  });

  it("defaultOpen opens specified items", () => {
    render(<Accordion items={items} defaultOpen={["1"]} />);
    expect(screen.getByText("Content one")).toBeVisible();
    expect(screen.getByText("Content two")).not.toBeVisible();
  });

  it("clicking header expands the item", () => {
    render(<Accordion items={items} />);
    fireEvent.click(screen.getByRole("button", { name: /First/i }));
    expect(screen.getByText("Content one")).toBeVisible();
  });

  it("clicking open header collapses the item", () => {
    render(<Accordion items={items} defaultOpen={["1"]} />);
    fireEvent.click(screen.getByRole("button", { name: /First/i }));
    expect(screen.getByText("Content one")).not.toBeVisible();
  });

  it("multi-open: opening second does not close first", () => {
    render(<Accordion items={items} defaultOpen={["1"]} />);
    fireEvent.click(screen.getByRole("button", { name: /Second/i }));
    expect(screen.getByText("Content one")).toBeVisible();
    expect(screen.getByText("Content two")).toBeVisible();
  });

  it("single mode: opening second closes first", () => {
    render(<Accordion items={items} single defaultOpen={["1"]} />);
    expect(screen.getByText("Content one")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Second/i }));
    expect(screen.getByText("Content one")).not.toBeVisible();
    expect(screen.getByText("Content two")).toBeVisible();
  });

  it("aria-expanded reflects open state", () => {
    render(<Accordion items={items} defaultOpen={["1"]} />);
    const btn = screen.getByRole("button", { name: /First/i });
    expect(btn).toHaveAttribute("aria-expanded", "true");
    const btn2 = screen.getByRole("button", { name: /Second/i });
    expect(btn2).toHaveAttribute("aria-expanded", "false");
  });

  it("aria-hidden toggles on content region", () => {
    render(<Accordion items={items} defaultOpen={["1"]} />);
    const region = screen.getByRole("region", { name: /First/i });
    expect(region).toHaveAttribute("aria-hidden", "false");
    fireEvent.click(screen.getByRole("button", { name: /First/i }));
    expect(region).toHaveAttribute("aria-hidden", "true");
  });

  it("content has role=region with aria-labelledby", () => {
    render(<Accordion items={items} defaultOpen={["1"]} />);
    const region = screen.getByRole("region", { name: /First/i });
    expect(region).toHaveAttribute("aria-labelledby");
    expect(region).toHaveAttribute("role", "region");
  });
});
