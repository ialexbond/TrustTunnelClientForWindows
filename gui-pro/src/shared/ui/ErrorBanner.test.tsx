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

  it("applies error variant classes by default", () => {
    const { container } = render(<ErrorBanner message="Error" />);
    const banner = container.firstChild as HTMLElement;
    expect(banner.className).toContain("bg-[var(--color-status-error-bg)]");
    expect(banner.className).toContain("text-[var(--color-status-error)]");
  });

  it("applies warning variant classes", () => {
    const { container } = render(<ErrorBanner message="Warning" variant="warning" />);
    const banner = container.firstChild as HTMLElement;
    expect(banner.className).toContain("bg-[var(--color-status-connecting-bg)]");
    expect(banner.className).toContain("text-[var(--color-status-connecting)]");
  });

  it("applies info variant classes", () => {
    const { container } = render(<ErrorBanner message="Info" variant="info" />);
    const banner = container.firstChild as HTMLElement;
    expect(banner.className).toContain("bg-[var(--color-status-info-bg)]");
    expect(banner.className).toContain("text-[var(--color-status-info)]");
  });

  it("displays message text within a span", () => {
    render(<ErrorBanner message="Test message content" />);
    const span = screen.getByText("Test message content");
    expect(span.tagName).toBe("SPAN");
  });

  // F09 — the dismiss button's accessible name comes from the localized buttons.close
  // key, NOT a hardcoded English "Dismiss". The test i18n boots in English, so the
  // resolved label is «Close» (ru source «Закрыть»); the point is it flows through t().
  it("labels the dismiss button with the localized close text", () => {
    render(<ErrorBanner message="Error" onDismiss={vi.fn()} />);
    const dismiss = screen.getByRole("button");
    expect(dismiss).toHaveAccessibleName("Close");
    expect(dismiss).not.toHaveAccessibleName("Dismiss");
  });

  // F10 — error + warning interrupt assertively (role="alert"), info is polite
  // (role="status"), mirroring SnackBar.
  it("uses role=alert + aria-live=assertive for error", () => {
    const { container } = render(<ErrorBanner message="Error" variant="error" />);
    const banner = container.firstChild as HTMLElement;
    expect(banner).toHaveAttribute("role", "alert");
    expect(banner).toHaveAttribute("aria-live", "assertive");
  });

  it("uses role=alert + aria-live=assertive for warning", () => {
    const { container } = render(<ErrorBanner message="Warn" variant="warning" />);
    const banner = container.firstChild as HTMLElement;
    expect(banner).toHaveAttribute("role", "alert");
    expect(banner).toHaveAttribute("aria-live", "assertive");
  });

  it("uses role=status + aria-live=polite for info", () => {
    const { container } = render(<ErrorBanner message="Info" variant="info" />);
    const banner = container.firstChild as HTMLElement;
    expect(banner).toHaveAttribute("role", "status");
    expect(banner).toHaveAttribute("aria-live", "polite");
  });

  // The computed defaults are overridable: an explicit role / aria-live wins because
  // {...props} is spread after the defaults.
  it("lets an explicit role / aria-live prop override the computed default", () => {
    const { container } = render(
      <ErrorBanner message="Info" variant="error" role="status" aria-live="polite" />
    );
    const banner = container.firstChild as HTMLElement;
    expect(banner).toHaveAttribute("role", "status");
    expect(banner).toHaveAttribute("aria-live", "polite");
  });
});
