import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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

  it("renders an AlertTriangle icon (lucide-react svg)", () => {
    const { container } = render(<DirtyChangesBanner changeCount={1} />);
    // lucide-react v0.468.x renders AlertTriangle as <svg class="lucide lucide-triangle-alert ...">
    const icon = container.querySelector("svg.lucide-triangle-alert");
    expect(icon).not.toBeNull();
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

  it("uses warning chrome (status warning bg + warning border)", () => {
    const { container } = render(<DirtyChangesBanner changeCount={1} />);
    const banner = container.firstChild as HTMLElement | null;
    expect(banner?.className).toContain("color-warning-tint-08");
    expect(banner?.className).toContain("color-warning-500");
  });
});
