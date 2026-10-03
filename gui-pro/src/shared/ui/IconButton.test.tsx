import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { IconButton } from "./IconButton";

/**
 * Regression guard for Phase-9 review findings fe-1/fe-2/a11y-1/a11y-2.
 *
 * The cluster of icon buttons in UsersSection (FileText/Settings/Trash) and the
 * Disconnect button in ServerTabs pass their resting tint and per-action hover
 * color through `className` (e.g. `text-[var(--color-text-secondary)]`,
 * `hover:text-[var(--color-destructive)]`). For those classes to take effect the
 * default muted color MUST live in the class chain (so a consumer className wins
 * via tailwind-merge / normal cascade) — NOT in an inline `style` attribute,
 * which would outrank every non-!important Tailwind utility incl. `:hover`.
 *
 * These tests assert the *behavioral* property (no inline color pinning + the
 * consumer color survives the merge while the default is dropped), not raw CSS
 * class strings for their own sake.
 */
describe("IconButton — color is class-driven, not inline (Phase-9 regression)", () => {
  it("does not pin the icon color via an inline style attribute", () => {
    render(<IconButton aria-label="probe" icon={<svg />} />);
    const btn = screen.getByRole("button", { name: "probe" });

    // The defect was `style={{ color: "var(--color-text-muted)" }}` on the
    // <button>. An inline color beats any Tailwind text-*/hover:text-* utility,
    // making consumer tint + hover affordances inert. The button must therefore
    // expose NO inline color, leaving the cascade to the class layer.
    expect(btn.style.color).toBe("");
  });

  it("lets a consumer color className override the muted default (tailwind-merge)", () => {
    render(
      <IconButton
        aria-label="tinted"
        icon={<svg />}
        className="text-[var(--color-text-secondary)] hover:text-[var(--color-destructive)]"
      />,
    );
    const btn = screen.getByRole("button", { name: "tinted" });

    // tailwind-merge must drop the conflicting muted default so the consumer's
    // resting tint applies, while preserving the hover affordance.
    expect(btn.className).toContain("text-[var(--color-text-secondary)]");
    expect(btn.className).toContain("hover:text-[var(--color-destructive)]");
    expect(btn.className).not.toContain("text-[var(--color-text-muted)]");
  });

  it("keeps the muted default when the consumer only adds a hover color", () => {
    render(
      <IconButton
        aria-label="hover-only"
        icon={<svg />}
        className="hover:text-[var(--color-destructive)]"
      />,
    );
    const btn = screen.getByRole("button", { name: "hover-only" });

    // No resting-color conflict here: muted stays as the base, the hover class
    // is additive. Because muted is now a class (not inline), the later-source
    // `:hover` rule wins → the glyph turns destructive-red on hover.
    expect(btn.style.color).toBe("");
    expect(btn.className).toContain("text-[var(--color-text-muted)]");
    expect(btn.className).toContain("hover:text-[var(--color-destructive)]");
  });
});
