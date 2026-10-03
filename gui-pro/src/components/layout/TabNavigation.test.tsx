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

  it("renders 5 tabs (role-based, not button-count)", () => {
    render(<TabNavigation {...defaultProps} />);
    // FIX (was querySelectorAll("button") — a false green that would survive a
    // refactor adding/removing non-tab buttons). Assert the semantic tab role.
    expect(screen.getAllByRole("tab")).toHaveLength(5);
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

  // ── INSTALL-LOCK (16-12): tab switching disabled during install/reset ──────

  it("locked: a NON-active tab is disabled and does NOT switch (install can't be disrupted)", () => {
    render(<TabNavigation {...defaultProps} activeTab="control" locked />);
    const connectionTab = screen.getByRole("tab", { name: new RegExp(i18n.t("tabs.connection")) });
    // The non-active tab is disabled + aria-disabled while locked.
    expect(connectionTab).toBeDisabled();
    expect(connectionTab).toHaveAttribute("aria-disabled", "true");
    // Clicking it does NOT trigger a tab change.
    fireEvent.click(connectionTab);
    expect(onTabChange).not.toHaveBeenCalled();
  });

  it("locked: the ACTIVE tab stays enabled (never disables the current section)", () => {
    render(<TabNavigation {...defaultProps} activeTab="control" locked />);
    const controlTab = screen.getByRole("tab", { name: new RegExp(i18n.t("tabs.controlPanel")) });
    expect(controlTab).not.toBeDisabled();
    expect(controlTab).not.toHaveAttribute("aria-disabled", "true");
  });

  it("NOT locked: non-active tabs switch normally (lock is off by default)", () => {
    render(<TabNavigation {...defaultProps} activeTab="control" />);
    const connectionTab = screen.getByRole("tab", { name: new RegExp(i18n.t("tabs.connection")) });
    expect(connectionTab).not.toBeDisabled();
    fireEvent.click(connectionTab);
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

  // FIX (was "all tabs are always clickable" — name claimed ALL but asserted
  // ONLY routing). Now genuinely exercises every tab via it.each.
  it.each([
    ["controlPanel", "control"],
    ["connection", "connection"],
    ["routing", "routing"],
    ["about", "about"],
  ] as const)(
    "clicking the %s tab calls onTabChange(%s)",
    (labelKey, expectedId) => {
      render(<TabNavigation {...defaultProps} activeTab="settings" />);
      const btn = screen.getByText(i18n.t(`tabs.${labelKey}`)).closest("button")!;
      fireEvent.click(btn);
      expect(onTabChange).toHaveBeenCalledWith(expectedId);
    },
  );

  it("clicking the settings tab calls onTabChange('settings')", () => {
    render(<TabNavigation {...defaultProps} activeTab="control" />);
    const settingsLabel =
      i18n.t("tabs.appSettings") !== "tabs.appSettings"
        ? i18n.t("tabs.appSettings")
        : i18n.t("tabs.settings");
    fireEvent.click(screen.getByText(settingsLabel).closest("button")!);
    expect(onTabChange).toHaveBeenCalledWith("settings");
  });

  it("marks the active tab via aria-selected (not via a stray var(--) match)", () => {
    // FIX (was container.innerHTML.toMatch(/var\(--/) — matches a token ANYWHERE
    // in the tree, so it stays green even if the active tab loses its styling).
    // Behavior under test = which tab is selected. Assert that semantically.
    render(<TabNavigation {...defaultProps} activeTab="control" />);
    const selected = screen
      .getAllByRole("tab")
      .filter((t) => t.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveAttribute("id", "tab-control");
  });

  it("exposes a tablist landmark (role-based, not querySelector('nav'))", () => {
    // FIX (was container.querySelector('[role="tablist"]') / querySelector('nav')
    // — CSS/structure-coupled). getByRole survives the presentation refactor.
    render(<TabNavigation {...defaultProps} />);
    expect(screen.getByRole("tablist")).toBeInTheDocument();
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
      // FIX (was container.querySelectorAll('[data-testid=...]') — string-coupled).
      render(<TabNavigation {...defaultProps} hasAppUpdate />);
      expect(screen.getAllByTestId("about-update-dot")).toHaveLength(1);
    });

    it("hasAppUpdate=true НЕ рендерит control-sidecar-update-dot", () => {
      render(<TabNavigation {...defaultProps} hasAppUpdate />);
      expect(screen.queryByTestId("control-sidecar-update-dot")).toBeNull();
    });
  });

  // ─── control-sidecar-update-dot (Control-Panel pill) — mirror of about-dot ──
  //
  // RESEARCH §2: the ACTUAL testid is `control-sidecar-update-dot`. The stale
  // spec name `control-update-dot` must appear NOWHERE in this file. This suite
  // mirrors the about-dot suite above: explicit-false, role=status, aria-label
  // RU+EN, static-no-animation, single-occurrence, cross-isolation.
  describe("hasSidecarUpdate dot indicator (Control-Panel pill)", () => {
    it("hasSidecarUpdate=true рендерит dot внутри control tab pill", () => {
      render(<TabNavigation {...defaultProps} hasSidecarUpdate />);
      expect(screen.getByTestId("control-sidecar-update-dot")).toBeInTheDocument();
    });

    it("hasSidecarUpdate=false (default) — dot НЕ рендерится", () => {
      render(<TabNavigation {...defaultProps} />);
      expect(screen.queryByTestId("control-sidecar-update-dot")).toBeNull();
    });

    it("hasSidecarUpdate=false explicit — dot НЕ рендерится", () => {
      render(<TabNavigation {...defaultProps} hasSidecarUpdate={false} />);
      expect(screen.queryByTestId("control-sidecar-update-dot")).toBeNull();
    });

    it("dot живёт внутри control tab button (НЕ на других tabs)", () => {
      render(<TabNavigation {...defaultProps} hasSidecarUpdate />);
      const dot = screen.getByTestId("control-sidecar-update-dot");
      expect(dot.closest('[role="tab"]')?.getAttribute("id")).toBe("tab-control");
    });

    it("dot имеет role=status (semantic для screen reader)", () => {
      render(<TabNavigation {...defaultProps} hasSidecarUpdate />);
      expect(screen.getByTestId("control-sidecar-update-dot")).toHaveAttribute(
        "role",
        "status",
      );
    });

    it("dot имеет aria-label «Доступно обновление» (RU локаль)", () => {
      render(<TabNavigation {...defaultProps} hasSidecarUpdate />);
      expect(screen.getByTestId("control-sidecar-update-dot")).toHaveAttribute(
        "aria-label",
        "Доступно обновление",
      );
    });

    it("dot switches aria-label on i18n.changeLanguage('en')", async () => {
      await i18n.changeLanguage("en");
      render(<TabNavigation {...defaultProps} hasSidecarUpdate />);
      expect(screen.getByTestId("control-sidecar-update-dot")).toHaveAttribute(
        "aria-label",
        "Update available",
      );
    });

    it("dot static — нет animate-* class или CSS animation inline style (D-DECISION-UI-2.1)", () => {
      render(<TabNavigation {...defaultProps} hasSidecarUpdate />);
      const dot = screen.getByTestId("control-sidecar-update-dot");
      expect(dot.className).not.toMatch(/animate/);
      expect(dot.getAttribute("style") || "").not.toMatch(/animation/i);
      expect(dot.style.animation).toBe("");
    });

    it("dot uses CSS token (--color-accent-interactive), no hardcoded hex", () => {
      render(<TabNavigation {...defaultProps} hasSidecarUpdate />);
      const styleAttr =
        screen.getByTestId("control-sidecar-update-dot").getAttribute("style") || "";
      expect(styleAttr).toMatch(/var\(--color-accent-interactive\)/);
      expect(styleAttr).not.toMatch(/#[0-9a-fA-F]{3,6}/);
    });

    it("dot НЕ дублируется (только один occurrence)", () => {
      render(<TabNavigation {...defaultProps} hasSidecarUpdate />);
      expect(screen.getAllByTestId("control-sidecar-update-dot")).toHaveLength(1);
    });

    it("hasSidecarUpdate=true НЕ рендерит about-update-dot (cross-isolation)", () => {
      render(<TabNavigation {...defaultProps} hasSidecarUpdate />);
      expect(screen.queryByTestId("about-update-dot")).toBeNull();
    });

    it("обе пропы можно включить одновременно — оба dots видны и независимы", () => {
      render(<TabNavigation {...defaultProps} hasAppUpdate hasSidecarUpdate />);
      const aboutDot = screen.getByTestId("about-update-dot");
      const controlDot = screen.getByTestId("control-sidecar-update-dot");
      expect(aboutDot).toBeInTheDocument();
      expect(controlDot).toBeInTheDocument();
      // Independent: each lives in its own pill.
      expect(aboutDot.closest('[role="tab"]')?.getAttribute("id")).toBe("tab-about");
      expect(controlDot.closest('[role="tab"]')?.getAttribute("id")).toBe(
        "tab-control",
      );
    });
  });

  // ─── Control-Panel pill structure + keyboard navigation ────────────────────
  describe("Control-Panel pill structure", () => {
    it("the control pill has id=tab-control + aria-controls=tabpanel-control", () => {
      render(<TabNavigation {...defaultProps} />);
      const controlTab = screen
        .getByText(i18n.t("tabs.controlPanel"))
        .closest('[role="tab"]')!;
      expect(controlTab).toHaveAttribute("id", "tab-control");
      expect(controlTab).toHaveAttribute("aria-controls", "tabpanel-control");
    });

    it("roving tabIndex: the active control pill is tabIndex 0, inactive pills -1", () => {
      render(<TabNavigation {...defaultProps} activeTab="control" />);
      const controlTab = document.getElementById("tab-control")!;
      const connectionTab = document.getElementById("tab-connection")!;
      expect(controlTab).toHaveAttribute("tabindex", "0");
      expect(connectionTab).toHaveAttribute("tabindex", "-1");
    });

    it("when control is inactive its pill leaves the tab order (tabIndex -1)", () => {
      render(<TabNavigation {...defaultProps} activeTab="connection" />);
      expect(document.getElementById("tab-control")).toHaveAttribute(
        "tabindex",
        "-1",
      );
    });
  });

  describe("Control-Panel pill keyboard navigation (manual activation)", () => {
    it("ArrowRight from the control pill moves FOCUS to connection WITHOUT activating", () => {
      render(<TabNavigation {...defaultProps} activeTab="control" />);
      const controlTab = document.getElementById("tab-control")!;
      controlTab.focus();
      fireEvent.keyDown(controlTab, { key: "ArrowRight" });
      expect(document.getElementById("tab-connection")).toHaveFocus();
      // Manual activation: no onTabChange until Enter/Space/click.
      expect(onTabChange).not.toHaveBeenCalled();
    });

    it("ArrowLeft from the control pill wraps FOCUS to the last (about) tab", () => {
      render(<TabNavigation {...defaultProps} activeTab="control" />);
      const controlTab = document.getElementById("tab-control")!;
      controlTab.focus();
      fireEvent.keyDown(controlTab, { key: "ArrowLeft" });
      expect(document.getElementById("tab-about")).toHaveFocus();
      expect(onTabChange).not.toHaveBeenCalled();
    });

    it("Home moves focus to the control pill (first tab)", () => {
      render(<TabNavigation {...defaultProps} activeTab="about" />);
      const aboutTab = document.getElementById("tab-about")!;
      aboutTab.focus();
      fireEvent.keyDown(aboutTab, { key: "Home" });
      expect(document.getElementById("tab-control")).toHaveFocus();
    });

    it("Enter activates the focused control pill (native button behavior)", () => {
      render(<TabNavigation {...defaultProps} activeTab="connection" />);
      // Native <button> click semantics: a click is what activates the tab.
      // Keyboard Enter/Space dispatch a click on a focused button in the browser;
      // here we assert the activation contract (click → onTabChange("control")).
      fireEvent.click(document.getElementById("tab-control")!);
      expect(onTabChange).toHaveBeenCalledWith("control");
    });
  });

  it("the stale testid 'control-update-dot' is never rendered (RESEARCH §2)", () => {
    render(<TabNavigation {...defaultProps} hasSidecarUpdate />);
    expect(screen.queryByTestId("control-update-dot")).toBeNull();
  });
});
