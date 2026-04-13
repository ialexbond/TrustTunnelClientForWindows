import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ErrorBanner } from "./ErrorBanner";

describe("ErrorBanner", () => {
  it("renders the error message", () => {
    render(<ErrorBanner message="Something went wrong" />);
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });

  it("renders an alert icon", () => {
    const { container } = render(<ErrorBanner message="Error" />);
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("shows dismiss button when onDismiss is provided", () => {
    const onDismiss = vi.fn();
    render(<ErrorBanner message="Error" onDismiss={onDismiss} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBe(1);
  });

  it("does not show dismiss button when onDismiss is not provided", () => {
    render(<ErrorBanner message="Error" />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("calls onDismiss when dismiss button is clicked", () => {
    const onDismiss = vi.fn();
    render(<ErrorBanner message="Error" onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("applies error severity classes by default", () => {
    const { container } = render(<ErrorBanner message="Error" />);
    const banner = container.firstChild as HTMLElement;
    expect(banner.className).toContain("bg-[var(--color-status-error-bg)]");
    expect(banner.className).toContain("text-[var(--color-status-error)]");
  });

  it("applies warning severity classes", () => {
    const { container } = render(<ErrorBanner message="Warning" severity="warning" />);
    const banner = container.firstChild as HTMLElement;
    expect(banner.className).toContain("bg-[var(--color-status-connecting-bg)]");
    expect(banner.className).toContain("text-[var(--color-status-connecting)]");
  });

  it("applies info severity classes", () => {
    const { container } = render(<ErrorBanner message="Info" severity="info" />);
    const banner = container.firstChild as HTMLElement;
    expect(banner.className).toContain("bg-[var(--color-status-info-bg)]");
    expect(banner.className).toContain("text-[var(--color-status-info)]");
  });

  it("displays message text within a span", () => {
    render(<ErrorBanner message="Test message content" />);
    const span = screen.getByText("Test message content");
    expect(span.tagName).toBe("SPAN");
  });
});
