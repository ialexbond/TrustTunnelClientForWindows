import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { Sidebar } from "./Sidebar";
import type { SidebarPage } from "./Sidebar";

describe("Sidebar", () => {
  const defaultProps = {
    activePage: "server" as SidebarPage,
    onPageChange: vi.fn(),
    hasConfig: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("renders TrustTunnel logo icon", () => {
    const { container } = render(<Sidebar {...defaultProps} />);
    expect(container.querySelector("aside")).toBeInTheDocument();
  });

  it("renders all navigation items as buttons", () => {
    const { container } = render(<Sidebar {...defaultProps} />);
    // 7 nav items + about = 8 buttons (no theme/language)
    const buttons = container.querySelectorAll("button");
    expect(buttons.length).toBe(8);
  });

  it("calls onPageChange when a nav item is clicked", () => {
    const onPageChange = vi.fn();
    const { container } = render(<Sidebar {...defaultProps} onPageChange={onPageChange} />);
    const buttons = container.querySelectorAll("nav button");
    fireEvent.click(buttons[1]); // "control" item
    expect(onPageChange).toHaveBeenCalledWith("control");
  });

  it("disables items that require config when hasConfig is false", () => {
    const onPageChange = vi.fn();
    const { container } = render(
      <Sidebar {...defaultProps} hasConfig={false} onPageChange={onPageChange} />,
    );
    const navButtons = container.querySelectorAll("nav button");
    // Items requiring config: settings (idx 2), dashboard (idx 3), routing (idx 4), logs (idx 5)
    expect(navButtons[2]).toBeDisabled();
    expect(navButtons[3]).toBeDisabled();
    expect(navButtons[4]).toBeDisabled();
    expect(navButtons[5]).toBeDisabled();
    // Items NOT requiring config should be enabled
    expect(navButtons[0]).not.toBeDisabled(); // server
    expect(navButtons[1]).not.toBeDisabled(); // control
    expect(navButtons[6]).not.toBeDisabled(); // appSettings
  });

  it("does not call onPageChange for disabled items", () => {
    const onPageChange = vi.fn();
    const { container } = render(
      <Sidebar {...defaultProps} hasConfig={false} onPageChange={onPageChange} />,
    );
    const navButtons = container.querySelectorAll("nav button");
    fireEvent.click(navButtons[2]); // settings - disabled
    expect(onPageChange).not.toHaveBeenCalled();
  });

  it("active page button has distinct background", () => {
    const { container } = render(<Sidebar {...defaultProps} activePage="server" />);
    const navButtons = container.querySelectorAll("nav button");
    expect(navButtons[0].style.backgroundColor).toBe("var(--color-bg-active)");
    expect(navButtons[1].style.backgroundColor).toBe("transparent");
  });

  it("about button navigates to about page", () => {
    const onPageChange = vi.fn();
    const { container } = render(<Sidebar {...defaultProps} onPageChange={onPageChange} />);
    const bottomButtons = container.querySelectorAll("aside > div > div:last-child button");
    fireEvent.click(bottomButtons[0]); // about button
    expect(onPageChange).toHaveBeenCalledWith("about");
  });

  // ── Collapse / expand ──

  it("sidebar starts in collapsed state (no TrustTunnel text)", () => {
    render(<Sidebar {...defaultProps} />);
    expect(screen.queryByText("TrustTunnel")).not.toBeInTheDocument();
  });

  it("shows TrustTunnel text on mouse enter (expanded)", () => {
    render(<Sidebar {...defaultProps} />);
    const aside = screen.getByRole("complementary");
    fireEvent.mouseEnter(aside);
    expect(screen.getByText("TrustTunnel")).toBeInTheDocument();
  });

  it("shows nav labels when expanded", () => {
    render(<Sidebar {...defaultProps} />);
    const aside = screen.getByRole("complementary");
    fireEvent.mouseEnter(aside);
    expect(screen.getByText(i18n.t("tabs.installation"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("tabs.controlPanel"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("tabs.settings"))).toBeInTheDocument();
  });

  it("hides nav labels when collapsed after mouse leave", async () => {
    vi.useFakeTimers();
    render(<Sidebar {...defaultProps} />);
    const aside = screen.getByRole("complementary");
    fireEvent.mouseEnter(aside);
    expect(screen.getByText("TrustTunnel")).toBeInTheDocument();
    fireEvent.mouseLeave(aside);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByText("TrustTunnel")).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  // ── Disabled items styling ──

  it("disabled items have opacity-30 class", () => {
    const { container } = render(<Sidebar {...defaultProps} hasConfig={false} />);
    const navButtons = container.querySelectorAll("nav button");
    expect(navButtons[2].className).toContain("opacity-30");
    expect(navButtons[2].className).toContain("cursor-not-allowed");
  });

  it("enabled items do not have opacity-30 class", () => {
    const { container } = render(<Sidebar {...defaultProps} hasConfig={true} />);
    const navButtons = container.querySelectorAll("nav button");
    expect(navButtons[0].className).not.toContain("opacity-30");
  });

  // ── Active page styling ──

  it("about button has active background when activePage is about", () => {
    const { container } = render(<Sidebar {...defaultProps} activePage="about" />);
    const bottomButtons = container.querySelectorAll("aside > div > div:last-child button");
    expect(bottomButtons[0].style.backgroundColor).toBe("var(--color-bg-active)");
  });

  it("about button has transparent background when not active", () => {
    const { container } = render(<Sidebar {...defaultProps} activePage="server" />);
    const bottomButtons = container.querySelectorAll("aside > div > div:last-child button");
    expect(bottomButtons[0].style.backgroundColor).toBe("transparent");
  });

  // ── All nav items clickable when hasConfig ──

  it("all nav items are enabled when hasConfig is true", () => {
    const { container } = render(<Sidebar {...defaultProps} hasConfig={true} />);
    const navButtons = container.querySelectorAll("nav button");
    for (let i = 0; i < navButtons.length; i++) {
      expect(navButtons[i]).not.toBeDisabled();
    }
  });

  // ── Title attributes on collapsed sidebar ──

  it("nav buttons have title attributes when collapsed", () => {
    const { container } = render(<Sidebar {...defaultProps} />);
    const navButtons = container.querySelectorAll("nav button");
    expect(navButtons[0].getAttribute("title")).toBe(i18n.t("tabs.installation"));
  });

  it("nav buttons do not have title attributes when expanded", () => {
    const { container } = render(<Sidebar {...defaultProps} />);
    const aside = screen.getByRole("complementary");
    fireEvent.mouseEnter(aside);
    const navButtons = container.querySelectorAll("nav button");
    expect(navButtons[0].getAttribute("title")).toBeNull();
  });
});
