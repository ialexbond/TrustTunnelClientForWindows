import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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
});
