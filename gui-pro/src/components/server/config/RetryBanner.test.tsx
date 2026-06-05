import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import i18n from "../../../shared/i18n";
import { RetryBanner } from "./RetryBanner";

/**
 * Phase 3 safety-net (Stream 3) — first-ever characterization of RetryBanner.
 *
 * RetryBanner had ZERO tests before this net (RESEARCH §3 stream 3 — three
 * zero-test components). The component shows a partial-save failure message
 * (`role="alert"` / `aria-live="assertive"`) with a Retry button (which the
 * orchestrator wires to a second saveAll() invoke on the remaining files) and
 * an optional dismiss button.
 *
 * Behavior/aria only (D-04): assertions use role + `i18n.t(...)` — never class
 * selectors / snapshots. Tests pin CURRENT behavior against UNCHANGED
 * production code (D-06).
 */
describe("RetryBanner (Phase 3 characterization)", () => {
  beforeEach(() => {
    i18n.changeLanguage("ru");
    vi.clearAllMocks();
  });

  it("announces the partial-save error via role=alert with aria-live=assertive", () => {
    render(
      <RetryBanner
        failedFile="hosts"
        savedCount={1}
        totalCount={3}
        onRetry={vi.fn()}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });

  it("renders the partial_save_error copy with saved/total counts and the failed file name", () => {
    render(
      <RetryBanner
        failedFile="hosts"
        savedCount={1}
        totalCount={3}
        onRetry={vi.fn()}
      />,
    );
    const expected = i18n.t("server.config.partial_save_error", {
      n: 1,
      total: 3,
      file: "hosts.toml",
    });
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it("retry button fires onRetry (orchestrator triggers the second saveAll invoke)", () => {
    const onRetry = vi.fn();
    render(
      <RetryBanner
        failedFile="vpn"
        savedCount={0}
        totalCount={2}
        onRetry={onRetry}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("server.config.retry_save") }),
    );
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("hides the dismiss button when onDismiss is not provided", () => {
    render(
      <RetryBanner
        failedFile="vpn"
        savedCount={0}
        totalCount={2}
        onRetry={vi.fn()}
      />,
    );
    // Only the Retry action button is present; no cancel/close button.
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
  });

  it("shows the dismiss button and fires onDismiss when provided", () => {
    const onDismiss = vi.fn();
    render(
      <RetryBanner
        failedFile="vpn"
        savedCount={0}
        totalCount={2}
        onRetry={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    const dismissBtn = screen.getByRole("button", {
      name: i18n.t("buttons.cancel", { defaultValue: "Закрыть" }),
    });
    fireEvent.click(dismissBtn);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
