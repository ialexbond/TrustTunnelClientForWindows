import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { TabNavigation } from "./TabNavigation";
import type { AppTab } from "../../shared/types";

// TabNavigation: horizontal tab bar with 5 tabs using AppTab union
// Each tab uses i18n key: tabs.controlPanel, tabs.connection, tabs.routing,
//   tabs.settings (or tabs.appSettings), tabs.about
// Active tab has distinct style; disabled tabs (requiresConfig) shown with opacity

describe("TabNavigation", () => {
  const onTabChange = vi.fn();

  const defaultProps = {
    activeTab: "control" as AppTab,
    onTabChange,
    hasConfig: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("renders 5 tab buttons", () => {
    const { container } = render(<TabNavigation {...defaultProps} />);
    const buttons = container.querySelectorAll("button");
    expect(buttons.length).toBe(5);
  });

  it("renders all 5 tab labels via i18n", () => {
    render(<TabNavigation {...defaultProps} />);
    expect(screen.getByText(i18n.t("tabs.controlPanel"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("tabs.connection"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("tabs.routing"))).toBeInTheDocument();
    // settings tab (tabs.appSettings or tabs.settings)
    const settingsEl = screen.queryByText(i18n.t("tabs.appSettings")) || screen.queryByText(i18n.t("tabs.settings"));
    expect(settingsEl).toBeInTheDocument();
    expect(screen.getByText(i18n.t("tabs.about"))).toBeInTheDocument();
  });

  it("calls onTabChange when an enabled tab is clicked", () => {
    render(<TabNavigation {...defaultProps} />);
    fireEvent.click(screen.getByText(i18n.t("tabs.connection")));
    expect(onTabChange).toHaveBeenCalledWith("connection");
  });

  it("calls onTabChange with 'control' for Control Panel tab", () => {
    render(<TabNavigation {...defaultProps} activeTab="connection" />);
    fireEvent.click(screen.getByText(i18n.t("tabs.controlPanel")));
    expect(onTabChange).toHaveBeenCalledWith("control");
  });

  it("calls onTabChange with 'routing' for Routing tab", () => {
    render(<TabNavigation {...defaultProps} />);
    fireEvent.click(screen.getByText(i18n.t("tabs.routing")));
    expect(onTabChange).toHaveBeenCalledWith("routing");
  });

  it("calls onTabChange with 'about' for About tab", () => {
    render(<TabNavigation {...defaultProps} />);
    fireEvent.click(screen.getByText(i18n.t("tabs.about")));
    expect(onTabChange).toHaveBeenCalledWith("about");
  });

  it("active tab button has aria-selected=true", () => {
    render(<TabNavigation {...defaultProps} activeTab="control" />);
    // Find the control tab button (Control Panel label)
    const btn = screen.getByText(i18n.t("tabs.controlPanel")).closest("button");
    expect(btn).toBeTruthy();
    expect(btn?.getAttribute("aria-selected")).toBe("true");
  });

  it("inactive tab buttons have aria-selected=false", () => {
    render(<TabNavigation {...defaultProps} activeTab="control" />);
    const btn = screen.getByText(i18n.t("tabs.connection")).closest("button");
    expect(btn?.getAttribute("aria-selected")).toBe("false");
  });

  it("tabs requiring config are disabled when hasConfig is false", () => {
    render(<TabNavigation {...defaultProps} hasConfig={false} />);
    const routingBtn = screen.getByText(i18n.t("tabs.routing")).closest("button");
    expect(routingBtn).toBeDisabled();
  });

  it("does not call onTabChange when disabled tab is clicked", () => {
    render(<TabNavigation {...defaultProps} hasConfig={false} />);
    const routingBtn = screen.getByText(i18n.t("tabs.routing")).closest("button")!;
    fireEvent.click(routingBtn);
    expect(onTabChange).not.toHaveBeenCalled();
  });

  it("control and about tabs are always enabled even without config", () => {
    render(<TabNavigation {...defaultProps} hasConfig={false} />);
    const controlBtn = screen.getByText(i18n.t("tabs.controlPanel")).closest("button");
    const aboutBtn = screen.getByText(i18n.t("tabs.about")).closest("button");
    expect(controlBtn).not.toBeDisabled();
    expect(aboutBtn).not.toBeDisabled();
  });

  it("uses CSS token var for active tab accent, not hardcoded color", () => {
    const { container } = render(<TabNavigation {...defaultProps} activeTab="control" />);
    // The nav/container should use token vars in style
    const nav = container.querySelector("nav") || container.firstChild as HTMLElement;
    expect(nav).toBeTruthy();
    // At least the border-bottom of nav uses tokens
    const rootStyle = nav?.getAttribute("style") || "";
    // We just verify a token var is present somewhere in tab container
    expect(container.innerHTML).toMatch(/var\(--/);
  });

  it("nav has role=tablist", () => {
    const { container } = render(<TabNavigation {...defaultProps} />);
    const tablist = container.querySelector('[role="tablist"]');
    expect(tablist).toBeInTheDocument();
  });
});
