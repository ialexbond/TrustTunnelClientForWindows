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
    theme: "dark" as const,
    onThemeToggle: vi.fn(),
    language: "ru",
    onLanguageToggle: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("renders TrustTunnel logo icon", () => {
    const { container } = render(<Sidebar {...defaultProps} />);
    // Shield icon exists
    expect(container.querySelector("aside")).toBeInTheDocument();
  });

  it("renders all navigation items as buttons", () => {
    const { container } = render(<Sidebar {...defaultProps} />);
    // 7 nav items + about + language + theme = 10 buttons
    const buttons = container.querySelectorAll("button");
    expect(buttons.length).toBe(10);
  });

  it("calls onPageChange when a nav item is clicked", () => {
    const onPageChange = vi.fn();
    const { container } = render(<Sidebar {...defaultProps} onPageChange={onPageChange} />);
    // Click the second nav button (control)
    const buttons = container.querySelectorAll("nav button");
    fireEvent.click(buttons[1]); // "control" item
    expect(onPageChange).toHaveBeenCalledWith("control");
  });

  it("disables items that require config when hasConfig is false", () => {
    const onPageChange = vi.fn();
    const { container } = render(
      <Sidebar {...defaultProps} hasConfig={false} onPageChange={onPageChange} />,
    );
    // Settings requires config - find it by its disabled state
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
    // First button (server) should have active background
    expect(navButtons[0].style.backgroundColor).toBe("var(--color-bg-active)");
    // Second button (control) should be transparent
    expect(navButtons[1].style.backgroundColor).toBe("transparent");
  });

  it("calls onThemeToggle when theme button is clicked", () => {
    const onThemeToggle = vi.fn();
    const { container } = render(<Sidebar {...defaultProps} onThemeToggle={onThemeToggle} />);
    // Theme toggle is the last button in the bottom section
    const bottomButtons = container.querySelectorAll("aside > div > div:last-child button");
    // Last button in bottom section is theme
    fireEvent.click(bottomButtons[bottomButtons.length - 1]);
    expect(onThemeToggle).toHaveBeenCalledOnce();
  });

  it("calls onLanguageToggle when language button is clicked", () => {
    const onLanguageToggle = vi.fn();
    const { container } = render(<Sidebar {...defaultProps} onLanguageToggle={onLanguageToggle} />);
    // Language toggle is the second-to-last button in the bottom section
    const bottomButtons = container.querySelectorAll("aside > div > div:last-child button");
    fireEvent.click(bottomButtons[1]); // language button (after about)
    expect(onLanguageToggle).toHaveBeenCalledOnce();
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
    // Wait for the 300ms delay, wrapped in act since it triggers state update
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
    // Settings (idx 2) should be disabled with opacity
    expect(navButtons[2].className).toContain("opacity-30");
    expect(navButtons[2].className).toContain("cursor-not-allowed");
  });

  it("enabled items do not have opacity-30 class", () => {
    const { container } = render(<Sidebar {...defaultProps} hasConfig={true} />);
    const navButtons = container.querySelectorAll("nav button");
    // Server (idx 0) should not have opacity-30
    expect(navButtons[0].className).not.toContain("opacity-30");
  });

  // ── Theme toggle text ──

  it("shows Light text for dark theme when expanded", () => {
    render(<Sidebar {...defaultProps} theme="dark" />);
    const aside = screen.getByRole("complementary");
    fireEvent.mouseEnter(aside);
    expect(screen.getByText("Light")).toBeInTheDocument();
  });

  it("shows Dark text for light theme when expanded", () => {
    render(<Sidebar {...defaultProps} theme="light" />);
    const aside = screen.getByRole("complementary");
    fireEvent.mouseEnter(aside);
    expect(screen.getByText("Dark")).toBeInTheDocument();
  });

  // ── Language toggle text ──

  it("shows English when language is ru and expanded", () => {
    render(<Sidebar {...defaultProps} language="ru" />);
    const aside = screen.getByRole("complementary");
    fireEvent.mouseEnter(aside);
    expect(screen.getByText("English")).toBeInTheDocument();
  });

  it("shows Русский when language is en and expanded", () => {
    render(<Sidebar {...defaultProps} language="en" />);
    const aside = screen.getByRole("complementary");
    fireEvent.mouseEnter(aside);
    expect(screen.getByText("Русский")).toBeInTheDocument();
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
    // When collapsed, buttons should have title for tooltip
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
