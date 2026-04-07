import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { SnackBar } from "./SnackBar";

describe("SnackBar", () => {
  let onShown: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    onShown = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing when messages array is empty", () => {
    const { container } = render(<SnackBar messages={[]} onShown={onShown} />);
    // SnackBar returns null when items is empty
    expect(container.innerHTML).toBe("");
  });

  it("shows a message from messages array", () => {
    render(<SnackBar messages={["Saved!"]} onShown={onShown} />);

    // After enter phase (30ms), item becomes visible
    act(() => {
      vi.advanceTimersByTime(50);
    });

    expect(screen.getByText("Saved!")).toBeInTheDocument();
  });

  it("shows multiple stacked messages", () => {
    render(
      <SnackBar messages={["First", "Second"]} onShown={onShown} />,
    );

    act(() => {
      vi.advanceTimersByTime(50);
    });

    expect(screen.getByText("First")).toBeInTheDocument();
    expect(screen.getByText("Second")).toBeInTheDocument();
  });

  it("calls onShown after messages are consumed", () => {
    render(<SnackBar messages={["Hello"]} onShown={onShown} />);

    // onShown is called via a 100ms timeout for each message
    act(() => {
      vi.advanceTimersByTime(150);
    });

    expect(onShown).toHaveBeenCalled();
  });

  it("auto-dismisses items after duration", () => {
    render(
      <SnackBar messages={["Bye"]} onShown={onShown} duration={1000} />,
    );

    // Make visible
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(screen.getByText("Bye")).toBeInTheDocument();

    // Advance past duration (1000ms) + exit animation (400ms)
    act(() => {
      vi.advanceTimersByTime(1500);
    });

    // After exit phase clears items, snackbar returns null
    expect(screen.queryByText("Bye")).not.toBeInTheDocument();
  });

  it("calls onShown for each message in batch", () => {
    render(
      <SnackBar messages={["A", "B", "C"]} onShown={onShown} />,
    );

    act(() => {
      vi.advanceTimersByTime(150);
    });

    // onShown called once per message in the batch
    expect(onShown).toHaveBeenCalledTimes(3);
  });
});
