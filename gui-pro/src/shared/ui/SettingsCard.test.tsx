import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Settings } from "lucide-react";
import { SettingsCard } from "./SettingsCard";

/**
 * Behaviour + accessibility only. Nothing here asserts a Tailwind class: the class list is an
 * implementation detail that changes whenever the utility set is retuned, and a test pinned to it
 * fails on a refactor that changed nothing a user can perceive.
 *
 * The two things that ARE asserted beyond visible text are inline STYLE tokens — because the whole
 * point of the header chip is which token pair paints it, and the `-500` primitives (which fail
 * light-theme contrast, banked as A11Y-27-01) must never be substituted for the `-tint` / `-fg`
 * pair. Existing precedent for token-level assertions: Toggle.test.tsx.
 */
describe("SettingsCard", () => {
  it("renders the title, the description and the body", () => {
    render(
      <SettingsCard icon={<Settings className="h-4 w-4" />} title="Основные" description="Как приложение ведёт себя при запуске">
        <p>Тело карточки</p>
      </SettingsCard>,
    );

    expect(screen.getByRole("heading", { name: "Основные" })).toBeInTheDocument();
    expect(screen.getByText("Как приложение ведёт себя при запуске")).toBeInTheDocument();
    expect(screen.getByText("Тело карточки")).toBeInTheDocument();
  });

  it("renders no description line when there is no description", () => {
    const { container } = render(
      <SettingsCard icon={<Settings className="h-4 w-4" />} title="Основные">
        <span>Тело</span>
      </SettingsCard>,
    );

    // An empty <p> contributes nothing to textContent, so "no empty second line" can only be
    // asserted structurally: the header must not emit the paragraph node at all.
    expect(container.querySelectorAll("p")).toHaveLength(0);
  });

  it("keeps the header glyph decorative so it adds no accessible name", () => {
    const { container } = render(
      <SettingsCard icon={<Settings className="h-4 w-4" data-testid="glyph" />} title="Основные">
        <span>Тело</span>
      </SettingsCard>,
    );

    const chip = container.querySelector('[aria-hidden="true"]');
    expect(chip).not.toBeNull();
    expect(chip!.contains(screen.getByTestId("glyph"))).toBe(true);
    // The heading is the only accessible name in the header.
    expect(screen.getByRole("heading", { name: "Основные" })).toBeInTheDocument();
  });

  it("paints the accent chip from the accent tint/fg token pair, never a -500 primitive", () => {
    const { container } = render(
      <SettingsCard icon={<Settings className="h-4 w-4" />} title="Основные">
        <span>Тело</span>
      </SettingsCard>,
    );

    const chip = container.querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(chip.style.backgroundColor).toBe("var(--color-accent-tint-10)");
    expect(chip.style.color).toBe("var(--color-accent-fg)");
    expect(chip.getAttribute("style")).not.toContain("-500");
  });

  it("paints the warning chip from the warning tint/fg token pair", () => {
    const { container } = render(
      <SettingsCard icon={<Settings className="h-4 w-4" />} title="Раздел с предупреждающим тоном" variant="warning">
        <span>Тело</span>
      </SettingsCard>,
    );

    const chip = container.querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(chip.style.backgroundColor).toBe("var(--color-warning-tint-12)");
    expect(chip.style.color).toBe("var(--color-warning-fg)");
    expect(chip.getAttribute("style")).not.toContain("-500");
  });

  it("warning tints the header tile ONLY — nothing else in the card carries the warning family", () => {
    const { container } = render(
      <SettingsCard icon={<Settings className="h-4 w-4" />} title="Раздел с предупреждающим тоном" variant="warning">
        <span>Тело</span>
      </SettingsCard>,
    );

    const chip = container.querySelector('[aria-hidden="true"]') as HTMLElement;
    const warningPainted = Array.from(container.querySelectorAll<HTMLElement>("[style]")).filter((el) =>
      (el.getAttribute("style") ?? "").includes("warning"),
    );

    expect(warningPainted).toEqual([chip]);
    // The card shell itself is neutral: a warning card differs from an accent card in the chip only.
    expect(container.firstElementChild!.getAttribute("style") ?? "").not.toContain("warning");
  });
});
