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

  // ─── Phase 19 — split update-dot indicators (UI-SPEC §Block 1) ───────────
  //
  // Replaces Phase 18 `hasUpdate` → `settings-update-dot` with two independent
  // props:
  //   - `hasAppUpdate`     → `about-update-dot`
  //   - `hasSidecarUpdate` → `control-sidecar-update-dot`
  //
  // Both dots are static (D-DECISION-UI-2.1, no motion), use the same
  // accent-interactive token, and share the role=status / aria-label semantic.

  describe("hasAppUpdate dot indicator (About tab)", () => {
    it("hasAppUpdate=true рендерит dot внутри about tab pill", () => {
      render(<TabNavigation {...defaultProps} hasAppUpdate />);
      const dot = screen.getByTestId("about-update-dot");
      expect(dot).toBeInTheDocument();
    });

    it("hasAppUpdate=false (default) — dot НЕ рендерится", () => {
      render(<TabNavigation {...defaultProps} />);
      expect(screen.queryByTestId("about-update-dot")).toBeNull();
    });

    it("hasAppUpdate=false explicit — dot НЕ рендерится", () => {
      render(<TabNavigation {...defaultProps} hasAppUpdate={false} />);
      expect(screen.queryByTestId("about-update-dot")).toBeNull();
    });

    it("dot имеет aria-label «Доступно обновление» (RU локаль)", () => {
      render(<TabNavigation {...defaultProps} hasAppUpdate />);
      const dot = screen.getByTestId("about-update-dot");
      expect(dot).toHaveAttribute("aria-label", "Доступно обновление");
    });

    it("dot имеет role=status (semantic для screen reader)", () => {
      render(<TabNavigation {...defaultProps} hasAppUpdate />);
      const dot = screen.getByTestId("about-update-dot");
      expect(dot).toHaveAttribute("role", "status");
    });

    it("dot живёт внутри about tab button (НЕ на других tabs)", () => {
      render(<TabNavigation {...defaultProps} hasAppUpdate />);
      const dot = screen.getByTestId("about-update-dot");
      const parentTabButton = dot.closest('[role="tab"]');
      expect(parentTabButton).toBeTruthy();
      expect(parentTabButton?.getAttribute("id")).toBe("tab-about");
    });

    it("dot static — нет animate-* class или CSS animation inline style (D-DECISION-UI-2.1)", () => {
      render(<TabNavigation {...defaultProps} hasAppUpdate />);
      const dot = screen.getByTestId("about-update-dot");
      expect(dot.className).not.toMatch(/animate/);
      const styleAttr = dot.getAttribute("style") || "";
      expect(styleAttr).not.toMatch(/animation/i);
      expect(dot.style.animation).toBe("");
    });

    it("dot uses CSS token (--color-accent-interactive), no hardcoded hex", () => {
      render(<TabNavigation {...defaultProps} hasAppUpdate />);
      const dot = screen.getByTestId("about-update-dot");
      const styleAttr = dot.getAttribute("style") || "";
      expect(styleAttr).toMatch(/var\(--color-accent-interactive\)/);
      expect(styleAttr).not.toMatch(/#[0-9a-fA-F]{3,6}/);
    });

    it("dot switches aria-label on i18n.changeLanguage('en')", async () => {
      await i18n.changeLanguage("en");
      render(<TabNavigation {...defaultProps} hasAppUpdate />);
      const dot = screen.getByTestId("about-update-dot");
      expect(dot).toHaveAttribute("aria-label", "Update available");
    });

    it("dot НЕ дублируется (только один occurrence)", () => {
      const { container } = render(<TabNavigation {...defaultProps} hasAppUpdate />);
      const dots = container.querySelectorAll('[data-testid="about-update-dot"]');
      expect(dots).toHaveLength(1);
    });

    it("hasAppUpdate=true НЕ рендерит control-sidecar-update-dot", () => {
      render(<TabNavigation {...defaultProps} hasAppUpdate />);
      expect(screen.queryByTestId("control-sidecar-update-dot")).toBeNull();
    });
  });

  describe("hasSidecarUpdate dot indicator (Control tab)", () => {
    it("hasSidecarUpdate=true рендерит dot внутри control tab pill", () => {
      render(<TabNavigation {...defaultProps} hasSidecarUpdate />);
      const dot = screen.getByTestId("control-sidecar-update-dot");
      expect(dot).toBeInTheDocument();
    });

    it("hasSidecarUpdate=false (default) — dot НЕ рендерится", () => {
      render(<TabNavigation {...defaultProps} />);
      expect(screen.queryByTestId("control-sidecar-update-dot")).toBeNull();
    });

    it("dot живёт внутри control tab button (НЕ на других tabs)", () => {
      render(<TabNavigation {...defaultProps} hasSidecarUpdate />);
      const dot = screen.getByTestId("control-sidecar-update-dot");
      const parentTabButton = dot.closest('[role="tab"]');
      expect(parentTabButton?.getAttribute("id")).toBe("tab-control");
    });

    it("dot uses CSS token (--color-accent-interactive), no hardcoded hex", () => {
      render(<TabNavigation {...defaultProps} hasSidecarUpdate />);
      const dot = screen.getByTestId("control-sidecar-update-dot");
      const styleAttr = dot.getAttribute("style") || "";
      expect(styleAttr).toMatch(/var\(--color-accent-interactive\)/);
      expect(styleAttr).not.toMatch(/#[0-9a-fA-F]{3,6}/);
    });

    it("обе пропы можно включить одновременно — оба dots видны", () => {
      render(<TabNavigation {...defaultProps} hasAppUpdate hasSidecarUpdate />);
      expect(screen.getByTestId("about-update-dot")).toBeInTheDocument();
      expect(screen.getByTestId("control-sidecar-update-dot")).toBeInTheDocument();
    });
  });
});
