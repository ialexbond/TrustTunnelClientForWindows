import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { Tooltip } from "./Tooltip";

describe("Tooltip", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders children (trigger element)", () => {
    render(
      <Tooltip text="Help info">
        <button>Hover me</button>
      </Tooltip>
    );
    expect(screen.getByText("Hover me")).toBeInTheDocument();
  });

  it("does not show tooltip text initially", () => {
    render(
      <Tooltip text="Help info">
        <button>Hover me</button>
      </Tooltip>
    );
    expect(screen.queryByText("Help info")).not.toBeInTheDocument();
  });

  it("shows tooltip text on hover after delay", () => {
    render(
      <Tooltip text="Help info" delay={400}>
        <button>Hover me</button>
      </Tooltip>
    );

    const trigger = screen.getByText("Hover me").closest("div")!;
    fireEvent.mouseEnter(trigger);

    expect(screen.queryByText("Help info")).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(450);
    });

    expect(screen.getByText("Help info")).toBeInTheDocument();
  });

  it("hides tooltip on mouse leave", () => {
    render(
      <Tooltip text="Help info" delay={0}>
        <button>Hover me</button>
      </Tooltip>
    );

    const trigger = screen.getByText("Hover me").closest("div")!;

    fireEvent.mouseEnter(trigger);
    act(() => {
      vi.advanceTimersByTime(10);
    });
    expect(screen.getByText("Help info")).toBeInTheDocument();

    fireEvent.mouseLeave(trigger);
    expect(screen.queryByText("Help info")).not.toBeInTheDocument();
  });

  it("tooltip text matches the text prop", () => {
    render(
      <Tooltip text="Specific tooltip content" delay={0}>
        <span>Trigger</span>
      </Tooltip>
    );

    const trigger = screen.getByText("Trigger").closest("div")!;
    fireEvent.mouseEnter(trigger);

    act(() => {
      vi.advanceTimersByTime(10);
    });

    const tip = screen.getByText("Specific tooltip content");
    expect(tip).toBeInTheDocument();
    expect(tip.tagName).toBe("P");
  });

  it("cancels tooltip if mouse leaves before delay finishes", () => {
    render(
      <Tooltip text="Delayed tip" delay={500}>
        <span>Trigger</span>
      </Tooltip>
    );

    const trigger = screen.getByText("Trigger").closest("div")!;

    fireEvent.mouseEnter(trigger);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    fireEvent.mouseLeave(trigger);

    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(screen.queryByText("Delayed tip")).not.toBeInTheDocument();
  });

  it("uses z-[var(--z-tooltip)] above modal (not hardcoded, not below modal)", () => {
    render(
      <Tooltip text="Z-check" delay={0}>
        <span>Trigger</span>
      </Tooltip>
    );

    const trigger = screen.getByText("Trigger").closest("div")!;
    fireEvent.mouseEnter(trigger);

    act(() => {
      vi.advanceTimersByTime(10);
    });

    const tip = screen.getByText("Z-check").closest("div[class*='fixed']")!;
    // Tooltip must sit above Modal (z-modal=300). Dedicated --z-tooltip=450 token.
    expect(tip.className).toContain("z-[var(--z-tooltip)]");
    expect(tip.className).not.toContain("9500");
    expect(tip.className).not.toContain("z-[var(--z-dropdown)]");
  });
});
