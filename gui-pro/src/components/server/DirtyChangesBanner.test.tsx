import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { DirtyChangesBanner } from "./DirtyChangesBanner";

beforeEach(() => {
  i18n.changeLanguage("ru");
});

describe("DirtyChangesBanner", () => {
  it("returns null when changeCount is 0", () => {
    const { container } = render(<DirtyChangesBanner changeCount={0} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders count in copy when changeCount > 0", () => {
    render(<DirtyChangesBanner changeCount={3} />);
    // dirty_banner_label resolves to "У вас несохранённых изменений: 3"
    expect(screen.getByText(/3/)).toBeInTheDocument();
  });

  it("exposes the banner as a status region (announced to assistive tech)", () => {
    // [Phase 3 FG] Previously asserted `svg.lucide-triangle-alert` presence — a
    // CSS-coupled false green (D-04) tied to a lucide internal class name. The
    // banner's behavioral contract is that it surfaces as a live status region;
    // the icon is decorative (aria-hidden). Assert the role instead.
    render(<DirtyChangesBanner changeCount={1} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("renders Apply button and fires onApply", () => {
    const onApply = vi.fn();
    render(<DirtyChangesBanner changeCount={1} onApply={onApply} />);
    fireEvent.click(screen.getByText("Применить настройки"));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it("renders Discard button and fires onDiscard", () => {
    const onDiscard = vi.fn();
    render(<DirtyChangesBanner changeCount={1} onDiscard={onDiscard} />);
    fireEvent.click(screen.getByText("Отменить изменения"));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it("hides Apply button when onApply is not provided", () => {
    render(<DirtyChangesBanner changeCount={1} />);
    expect(screen.queryByText("Применить настройки")).toBeNull();
  });

  it("hides Discard button when onDiscard is not provided", () => {
    render(<DirtyChangesBanner changeCount={1} />);
    expect(screen.queryByText("Отменить изменения")).toBeNull();
  });

  it("renders the dirty-count message inside the status region (warning chrome)", () => {
    // [Phase 3 FG-2] Previously asserted the className contained the literal
    // tokens `color-warning-tint-08` / `color-warning-500` — a brittle CSS
    // coupling (D-04). A Phase-4 color-token refactor (rename / theme swap)
    // would silently void this check while the banner still works. Switch to
    // the behavioral contract: the warning chrome IS the status region, and it
    // carries the dirty-count message. We assert the message lives within the
    // role="status" element rather than inspecting class tokens.
    render(<DirtyChangesBanner changeCount={2} />);
    const status = screen.getByRole("status");
    expect(
      within(status).getByText(
        i18n.t("server.config.dirty_banner_label", { count: 2 }),
      ),
    ).toBeInTheDocument();
  });
});
