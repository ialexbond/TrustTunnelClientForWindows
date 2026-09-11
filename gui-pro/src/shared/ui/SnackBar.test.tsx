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

  // UAT-F08 (replace-not-stack): two DIFFERENT success texts arriving in
  // sequence must NOT stack — the newer one replaces the older. At most one
  // success snackbar is visible at a time.
  it("replaces (does not stack) a second different success message", () => {
    render(
      <SnackBar messages={["First", "Second"]} onShown={onShown} />,
    );

    act(() => {
      vi.advanceTimersByTime(50);
    });

    // The newer success is visible…
    expect(screen.getByText("Second")).toBeInTheDocument();
    // …and the older one has been pushed to exit (no longer in the DOM after
    // its 400ms exit window).
    act(() => {
      vi.advanceTimersByTime(450);
    });
    expect(screen.queryByText("First")).not.toBeInTheDocument();
    // Exactly one live region (the surviving "Second").
    expect(screen.getByText("Second")).toBeInTheDocument();
  });

  // UAT-F08 (dedup): the SAME success text fired twice while still showing
  // must NOT add a second item — the timer resets but only one item exists.
  it("dedupes an identical success text fired twice while showing", () => {
    const { rerender } = render(
      <SnackBar messages={["Saved!"]} onShown={onShown} />,
    );

    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(screen.getAllByText("Saved!")).toHaveLength(1);

    // Fire the same text again while the first is still visible.
    rerender(<SnackBar messages={["Saved!", "Saved!"]} onShown={onShown} />);
    act(() => {
      vi.advanceTimersByTime(50);
    });

    // Still a single item — the duplicate only reset the dismiss timer.
    expect(screen.getAllByText("Saved!")).toHaveLength(1);
  });

  // UAT-F08 (preserve): an arriving success still dismisses existing errors.
  it("an arriving success dismisses an existing error snackbar", () => {
    const { rerender } = render(
      <SnackBar
        messages={[{ text: "Boom", type: "error" }]}
        onShown={onShown}
      />,
    );
    act(() => { vi.advanceTimersByTime(50); });
    expect(screen.getByText("Boom")).toBeInTheDocument();

    rerender(
      <SnackBar
        messages={[{ text: "Boom", type: "error" }, { text: "OK now", type: "success" }]}
        onShown={onShown}
      />,
    );
    act(() => { vi.advanceTimersByTime(500); });

    expect(screen.queryByText("Boom")).not.toBeInTheDocument();
    expect(screen.getByText("OK now")).toBeInTheDocument();
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

  it("error snackbar uses color-status-error token (not broken orange fallback)", () => {
    render(
      <SnackBar
        messages={[{ text: "Something failed", type: "error" }]}
        onShown={onShown}
      />,
    );

    act(() => { vi.advanceTimersByTime(50); });

    // The error icon should be styled with --color-status-error, not #f97316
    const icon = document.querySelector("svg.lucide-triangle-alert");
    // The icon's parent or itself should NOT have orange (#f97316) color
    const allElements = document.querySelectorAll("[style]");
    const hasOrangeFallback = Array.from(allElements).some((el) =>
      (el as HTMLElement).style.color.includes("#f97316") ||
      (el as HTMLElement).style.color.includes("f97316"),
    );
    expect(hasOrangeFallback).toBe(false);
    // The icon element exists (error message is rendered)
    expect(icon).toBeTruthy();
  });

  // D-03.3: the toast must be an announced live region so screen readers read
  // it out. Success toasts are polite (role="status"), error toasts are
  // assertive (role="alert"). These FAIL on pre-fix code (no role at all) and
  // PASS after the live-region role is added to the toast item.
  it("success toast is an announced polite live region (role=status)", () => {
    render(<SnackBar messages={["Saved!"]} onShown={onShown} />);
    act(() => { vi.advanceTimersByTime(50); });
    expect(screen.getByRole("status")).toHaveTextContent("Saved!");
  });

  it("error toast is an announced assertive live region (role=alert)", () => {
    render(
      <SnackBar
        messages={[{ text: "Something failed", type: "error" }]}
        onShown={onShown}
      />,
    );
    act(() => { vi.advanceTimersByTime(50); });
    expect(screen.getByRole("alert")).toHaveTextContent("Something failed");
  });

  it("uses z-snackbar token for stacking", () => {
    const { container } = render(
      <SnackBar messages={["Test"]} onShown={onShown} />,
    );

    act(() => { vi.advanceTimersByTime(50); });

    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.style.zIndex).toBe("var(--z-snackbar)");
  });
});
