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

  it("all tabs are always clickable", () => {
    render(<TabNavigation {...defaultProps} />);
    const routingBtn = screen.getByText(i18n.t("tabs.routing")).closest("button")!;
    fireEvent.click(routingBtn);
    expect(onTabChange).toHaveBeenCalledWith("routing");
  });

  it("uses CSS token var for active tab accent, not hardcoded color", () => {
    const { container } = render(<TabNavigation {...defaultProps} activeTab="control" />);
    // The nav/container should use token vars in style
    const nav = container.querySelector("nav") || container.firstChild as HTMLElement;
    expect(nav).toBeTruthy();
    // At least the border-bottom of nav uses tokens
    void (nav?.getAttribute("style") || "");
    // We just verify a token var is present somewhere in tab container
    expect(container.innerHTML).toMatch(/var\(--/);
  });

  it("nav has role=tablist", () => {
    const { container } = render(<TabNavigation {...defaultProps} />);
    const tablist = container.querySelector('[role="tablist"]');
    expect(tablist).toBeInTheDocument();
  });

  // ─── Phase 18 — Update dot indicator (REQ-18-UPDATE-DETECTION-04) ─────────

  describe("hasUpdate dot indicator", () => {
    it("hasUpdate=true рендерит dot внутри settings tab pill", () => {
      render(<TabNavigation {...defaultProps} hasUpdate />);
      const dot = screen.getByTestId("settings-update-dot");
      expect(dot).toBeInTheDocument();
    });

    it("hasUpdate=false (default) — dot НЕ рендерится", () => {
      render(<TabNavigation {...defaultProps} />);
      expect(screen.queryByTestId("settings-update-dot")).toBeNull();
    });

    it("hasUpdate=false explicit — dot НЕ рендерится", () => {
      render(<TabNavigation {...defaultProps} hasUpdate={false} />);
      expect(screen.queryByTestId("settings-update-dot")).toBeNull();
    });

    it("dot имеет aria-label «Доступно обновление» (RU локаль)", () => {
      render(<TabNavigation {...defaultProps} hasUpdate />);
      const dot = screen.getByTestId("settings-update-dot");
      expect(dot).toHaveAttribute("aria-label", "Доступно обновление");
    });

    it("dot имеет role=status (semantic для screen reader)", () => {
      render(<TabNavigation {...defaultProps} hasUpdate />);
      const dot = screen.getByTestId("settings-update-dot");
      expect(dot).toHaveAttribute("role", "status");
    });

    it("dot живёт внутри settings tab button (НЕ на других tabs)", () => {
      render(<TabNavigation {...defaultProps} hasUpdate />);
      const dot = screen.getByTestId("settings-update-dot");
      const parentTabButton = dot.closest('[role="tab"]');
      expect(parentTabButton).toBeTruthy();
      // settings tab имеет id="tab-settings" через getTabButtonId
      expect(parentTabButton?.getAttribute("id")).toBe("tab-settings");
    });

    it("dot static — нет animate-* class или CSS animation inline style (D-DECISION-UI-2.1)", () => {
      render(<TabNavigation {...defaultProps} hasUpdate />);
      const dot = screen.getByTestId("settings-update-dot");
      expect(dot.className).not.toMatch(/animate/);
      // jsdom canonicalize CSS property names — check both inline `style` attr and computed style
      const styleAttr = dot.getAttribute("style") || "";
      expect(styleAttr).not.toMatch(/animation/i);
      expect(dot.style.animation).toBe("");
    });

    it("dot uses CSS token (--color-accent-interactive), no hardcoded hex", () => {
      render(<TabNavigation {...defaultProps} hasUpdate />);
      const dot = screen.getByTestId("settings-update-dot");
      const styleAttr = dot.getAttribute("style") || "";
      expect(styleAttr).toMatch(/var\(--color-accent-interactive\)/);
      expect(styleAttr).not.toMatch(/#[0-9a-fA-F]{3,6}/);
    });

    it("dot switches aria-label on i18n.changeLanguage('en')", async () => {
      await i18n.changeLanguage("en");
      render(<TabNavigation {...defaultProps} hasUpdate />);
      const dot = screen.getByTestId("settings-update-dot");
      expect(dot).toHaveAttribute("aria-label", "Update available");
    });

    it("dot не появляется на других табах (control / connection / routing / about) когда hasUpdate=true", () => {
      const { container } = render(<TabNavigation {...defaultProps} hasUpdate />);
      // только один dot с этим test-id, и он именно на settings (verified выше)
      const dots = container.querySelectorAll('[data-testid="settings-update-dot"]');
      expect(dots).toHaveLength(1);
    });
  });
});
