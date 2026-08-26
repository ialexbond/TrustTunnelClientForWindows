import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InsetPanel } from "./InsetPanel";

/**
 * Behaviour + accessibility only. Nothing here asserts a Tailwind class, for the same reason
 * SettingsCard.test.tsx gives: the class list is an implementation detail that is retuned without
 * changing anything a user can perceive.
 *
 * WHY THIS FILE EXISTS AT ALL, when the component takes one prop and holds no state. The panel was
 * shipped with a banner saying a test could only re-state its own class list back to itself. That
 * is true of its APPEARANCE and false of its CONTRACT. This panel is the sanctioned replacement for
 * an emphasis device the owner rejected twice (the coloured left rail), so it is placed around
 * blocks that hold real controls — a queue editor, a read-failure banner with a retry button. Two
 * things must therefore stay true of it, and neither is visual:
 *
 *   1. It is TRANSPARENT TO THE ACCESSIBILITY TREE. A wrapper that quietly acquired a role, a
 *      label, an `aria-hidden` or a `tabindex` would change what a screen reader says about every
 *      block it wraps, and would do so silently — the pixels would be identical. A `<section>`
 *      instead of a `<div>`, or a stray `role="group"`, is a one-word edit that no visual review
 *      catches.
 *   2. It does not INTERPOSE between the user and what it wraps. Interactive children stay
 *      focusable, reachable by Tab in source order, and clickable — a wrapper that swallowed a
 *      click or trapped focus would break the very blocks it exists to frame.
 *
 * The one structural assertion below is deliberate and narrow: the panel must emit exactly one
 * element, because "how many nodes are between the card and its content" is the fact every
 * consumer's layout depends on.
 */
describe("InsetPanel", () => {
  it("renders its children", () => {
    render(
      <InsetPanel>
        <p>Содержимое панели</p>
      </InsetPanel>,
    );

    expect(screen.getByText("Содержимое панели")).toBeInTheDocument();
  });

  it("renders children in source order, so a wrapped list reads top to bottom", () => {
    render(
      <InsetPanel>
        <span>Первый</span>
        <span>Второй</span>
        <span>Третий</span>
      </InsetPanel>,
    );

    // textContent walks the DOM in document order, which is the order a screen reader reads and a
    // sighted user sees. Asserting the concatenation pins the order without pinning the markup.
    expect(screen.getByText("Первый").parentElement?.textContent).toBe("ПервыйВторойТретий");
  });

  it("adds no role, name or description of its own to the accessibility tree", () => {
    const { container } = render(
      <InsetPanel>
        <button type="button">Повторить</button>
      </InsetPanel>,
    );

    const panel = container.firstElementChild;
    expect(panel).not.toBeNull();
    // A generic container contributes no role. If this ever becomes a <section>, a <nav> or picks
    // up role="group", a screen reader starts announcing a landmark around every wrapped block.
    expect(panel).not.toHaveAttribute("role");
    expect(panel).not.toHaveAttribute("aria-label");
    expect(panel).not.toHaveAttribute("aria-labelledby");
    expect(panel).not.toHaveAttribute("aria-describedby");
    // The panel is decoration around real content; hiding it would hide the content with it.
    expect(panel).not.toHaveAttribute("aria-hidden");
    // Not a tab stop: the panel is not something a keyboard user operates, and an extra stop
    // before every framed block is a tax paid on every Tab press.
    expect(panel).not.toHaveAttribute("tabindex");
  });

  it("wraps its children in exactly one element", () => {
    const { container } = render(
      <InsetPanel>
        <p>Тело</p>
      </InsetPanel>,
    );

    expect(container.children).toHaveLength(1);
    // One node between the card and the content — consumers space themselves against this.
    expect(container.firstElementChild?.children).toHaveLength(1);
  });

  it("leaves an interactive child fully operable — the panel frames, it does not intercept", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();

    render(
      <InsetPanel>
        <button type="button" onClick={onClick}>
          Повторить
        </button>
      </InsetPanel>,
    );

    const button = screen.getByRole("button", { name: "Повторить" });

    // Reachable by keyboard: the panel introduces no stop before the button and no focus trap.
    await user.tab();
    expect(button).toHaveFocus();

    // And the click reaches the child rather than being swallowed by the wrapper.
    await user.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("keeps a child's own accessible name intact", () => {
    render(
      <InsetPanel>
        <button type="button" aria-label="Повторить чтение списка">
          Повторить
        </button>
      </InsetPanel>,
    );

    // The wrapper contributes nothing to the name computation of what it wraps: the child's
    // aria-label is what a screen reader announces, unprefixed and unaltered.
    expect(
      screen.getByRole("button", { name: "Повторить чтение списка" }),
    ).toBeInTheDocument();
  });
});
