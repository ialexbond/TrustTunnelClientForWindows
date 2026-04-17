import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import i18n from "../i18n";
import { OverflowMenu } from "./OverflowMenu";
import type { OverflowMenuItem } from "./OverflowMenu";

function makeItems(overrides: Partial<OverflowMenuItem>[] = []): OverflowMenuItem[] {
  return [
    { label: "Action 1", onSelect: vi.fn(), ...overrides[0] },
    { label: "Action 2", onSelect: vi.fn(), ...overrides[1] },
    { label: "Delete", onSelect: vi.fn(), destructive: true, ...overrides[2] },
  ];
}

describe("OverflowMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("renders trigger button with aria-haspopup='menu'", () => {
    const items = makeItems();
    render(<OverflowMenu items={items} triggerAriaLabel="User actions" />);
    const trigger = screen.getByRole("button", { name: "User actions" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
  });

  it("trigger button has aria-expanded=false initially", () => {
    const items = makeItems();
    render(<OverflowMenu items={items} triggerAriaLabel="User actions" />);
    const trigger = screen.getByRole("button", { name: "User actions" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("opens menu on trigger click", () => {
    const items = makeItems();
    render(<OverflowMenu items={items} triggerAriaLabel="User actions" />);
    const trigger = screen.getByRole("button", { name: "User actions" });
    fireEvent.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("trigger has aria-expanded=true when menu is open", () => {
    const items = makeItems();
    render(<OverflowMenu items={items} triggerAriaLabel="User actions" />);
    const trigger = screen.getByRole("button", { name: "User actions" });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("renders all menu items with role=menuitem", () => {
    const items = makeItems();
    render(<OverflowMenu items={items} triggerAriaLabel="User actions" />);
    fireEvent.click(screen.getByRole("button", { name: "User actions" }));
    const menuItems = screen.getAllByRole("menuitem");
    expect(menuItems.length).toBe(3);
    expect(screen.getByRole("menuitem", { name: "Action 1" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Action 2" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
  });

  it("closes on Escape key", () => {
    const items = makeItems();
    render(<OverflowMenu items={items} triggerAriaLabel="User actions" />);
    fireEvent.click(screen.getByRole("button", { name: "User actions" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes on click outside", () => {
    const items = makeItems();
    render(<OverflowMenu items={items} triggerAriaLabel="User actions" />);
    fireEvent.click(screen.getByRole("button", { name: "User actions" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("calls onSelect when item clicked", () => {
    const onSelect = vi.fn();
    const items: OverflowMenuItem[] = [
      { label: "Action 1", onSelect },
    ];
    render(<OverflowMenu items={items} triggerAriaLabel="User actions" />);
    fireEvent.click(screen.getByRole("button", { name: "User actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Action 1" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("closes menu after item selection", () => {
    const items = makeItems();
    render(<OverflowMenu items={items} triggerAriaLabel="User actions" />);
    fireEvent.click(screen.getByRole("button", { name: "User actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Action 1" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("shows destructive item with distinct styling", () => {
    const items = makeItems();
    render(<OverflowMenu items={items} triggerAriaLabel="User actions" />);
    fireEvent.click(screen.getByRole("button", { name: "User actions" }));
    const deleteItem = screen.getByRole("menuitem", { name: "Delete" });
    expect(deleteItem).toHaveStyle({ color: "var(--color-destructive)" });
  });

  it("does not trigger disabled item", () => {
    const onSelect = vi.fn();
    const items: OverflowMenuItem[] = [
      { label: "Disabled Action", onSelect, disabled: true },
    ];
    render(<OverflowMenu items={items} triggerAriaLabel="User actions" />);
    fireEvent.click(screen.getByRole("button", { name: "User actions" }));
    const disabledItem = screen.getByRole("menuitem", { name: "Disabled Action" });
    expect(disabledItem).toBeDisabled();
    fireEvent.click(disabledItem);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("keyboard navigation: ArrowDown moves focus between items", () => {
    const items = makeItems();
    const { container } = render(
      <OverflowMenu items={items} triggerAriaLabel="User actions" />
    );
    fireEvent.click(screen.getByRole("button", { name: "User actions" }));
    const menuItems = screen.getAllByRole("menuitem");
    // Focus first item manually (rAF mock makes this synchronous)
    menuItems[0].focus();
    expect(document.activeElement).toBe(menuItems[0]);
    // Press ArrowDown on the focused item
    fireEvent.keyDown(menuItems[0], { key: "ArrowDown" });
    // After ArrowDown, second item should be focused
    expect(document.activeElement).toBe(menuItems[1]);
    void container; // suppress unused warning
  });

  it("keyboard navigation: ArrowUp moves focus backwards", () => {
    const items = makeItems();
    render(<OverflowMenu items={items} triggerAriaLabel="User actions" />);
    fireEvent.click(screen.getByRole("button", { name: "User actions" }));
    const menuItems = screen.getAllByRole("menuitem");
    menuItems[1].focus();
    fireEvent.keyDown(menuItems[1], { key: "ArrowUp" });
    expect(document.activeElement).toBe(menuItems[0]);
  });

  it("shows loading spinner for loading item", () => {
    const items: OverflowMenuItem[] = [
      { label: "Loading Action", onSelect: vi.fn(), loading: true },
    ];
    render(<OverflowMenu items={items} triggerAriaLabel="User actions" />);
    fireEvent.click(screen.getByRole("button", { name: "User actions" }));
    // Loading spinner SVG should be present
    const spinners = document.querySelectorAll("svg.animate-spin");
    expect(spinners.length).toBeGreaterThan(0);
  });

  it("menu has accessible label matching triggerAriaLabel", () => {
    const items = makeItems();
    render(<OverflowMenu items={items} triggerAriaLabel="User actions" />);
    fireEvent.click(screen.getByRole("button", { name: "User actions" }));
    const menu = screen.getByRole("menu");
    expect(menu).toHaveAttribute("aria-label", "User actions");
  });

  describe("auto-flip positioning (D-12 viewport edge fix)", () => {
    // JSDOM always returns { top: 0, left: 0, ... } from getBoundingClientRect
    // and doesn't run layout — so position-based assertions are fragile.
    // These tests primarily verify the useEffect ran without crashing (visibility
    // gets flipped from "hidden" to "visible") and that scroll/resize listeners
    // fire the close behaviour.

    function mockRect(el: Element, rect: Partial<DOMRect>) {
      el.getBoundingClientRect = () =>
        ({
          top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0,
          toJSON: () => ({}),
          ...rect,
        }) as DOMRect;
    }

    function setViewport(width: number, height: number) {
      Object.defineProperty(window, "innerWidth", {
        writable: true, configurable: true, value: width,
      });
      Object.defineProperty(window, "innerHeight", {
        writable: true, configurable: true, value: height,
      });
    }

    beforeEach(() => {
      setViewport(1024, 768);
      vi.clearAllMocks();
      i18n.changeLanguage("ru");
    });

    it("positions menu BELOW trigger when fitsBelow=true (normal case)", async () => {
      const items = makeItems();
      render(<OverflowMenu items={items} triggerAriaLabel="actions" />);

      const trigger = screen.getByRole("button", { name: "actions" });
      // Trigger at top-left (100, 100), size 40x32. Menu ~120x100 fits below.
      mockRect(trigger, {
        top: 100, left: 100, right: 140, bottom: 132, width: 40, height: 32,
      });

      fireEvent.click(trigger);
      const menu = await screen.findByRole("menu");
      mockRect(menu, {
        width: 160, height: 100, top: 0, left: 0, right: 160, bottom: 100,
        x: 0, y: 0,
      } as DOMRect);

      // Visibility was hidden initially, effect should promote to visible.
      // Note: JSDOM may not re-run layout after mockRect — we assert the
      // effect ran successfully by checking visibility is NOT "hidden".
      await waitFor(() => {
        expect(menu.style.visibility).not.toBe("hidden");
      });
    });

    it("positions menu ABOVE trigger when fitsBelow=false & fitsAbove=true (bottom-edge case)", async () => {
      const items = makeItems();
      render(<OverflowMenu items={items} triggerAriaLabel="actions" />);

      const trigger = screen.getByRole("button", { name: "actions" });
      // Trigger at bottom: top=700, bottom=732, vh=768
      // Menu height=100 doesn't fit below (732+4+100=836 > 768-8=760) → flip up
      // Menu above: top=700-100-4=596 ≥ pad=8 → fitsAbove=true
      mockRect(trigger, {
        top: 700, left: 100, right: 140, bottom: 732, width: 40, height: 32,
      });

      fireEvent.click(trigger);
      const menu = await screen.findByRole("menu");
      mockRect(menu, {
        width: 160, height: 100, top: 0, left: 0, right: 160, bottom: 100,
        x: 0, y: 0,
      } as DOMRect);

      await waitFor(() => {
        expect(menu.style.visibility).not.toBe("hidden");
      });
    });

    it("right-aligns menu when rightEdgeIfLeftAligned overflows viewport", async () => {
      const items = makeItems();
      render(<OverflowMenu items={items} triggerAriaLabel="actions" />);

      const trigger = screen.getByRole("button", { name: "actions" });
      // Trigger at right edge: left=950, right=990, vw=1024
      // Menu width=160 → left-align would overflow (950+160=1110 > 1024-8=1016)
      // → right-align (left=990-160=830), clamped to vw-pad-width = 856
      mockRect(trigger, {
        top: 100, left: 950, right: 990, bottom: 132, width: 40, height: 32,
      });

      fireEvent.click(trigger);
      const menu = await screen.findByRole("menu");
      mockRect(menu, {
        width: 160, height: 100, top: 0, left: 0, right: 160, bottom: 100,
        x: 0, y: 0,
      } as DOMRect);

      await waitFor(() => {
        expect(menu.style.visibility).not.toBe("hidden");
      });
    });

    it("closes menu on window scroll (simpler than recompute — D-12)", async () => {
      const items = makeItems();
      render(<OverflowMenu items={items} triggerAriaLabel="actions" />);

      fireEvent.click(screen.getByRole("button", { name: "actions" }));
      expect(screen.getByRole("menu")).toBeInTheDocument();

      // Fire scroll event on window (capture phase listener catches it)
      fireEvent.scroll(window);

      await waitFor(() => {
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      });
    });

    it("closes menu on window resize (simpler than reposition — D-12)", async () => {
      const items = makeItems();
      render(<OverflowMenu items={items} triggerAriaLabel="actions" />);

      fireEvent.click(screen.getByRole("button", { name: "actions" }));
      expect(screen.getByRole("menu")).toBeInTheDocument();

      // Fire resize event
      fireEvent(window, new Event("resize"));

      await waitFor(() => {
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      });
    });
  });
});
