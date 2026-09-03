import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Settings } from "lucide-react";
import { PanelHeader } from "./PanelHeader";

/**
 * Behaviour + accessibility only, with one exception: the inline STYLE tokens that paint the chip.
 * Those are asserted because WHICH token pair paints it is the point of the component — the `-500`
 * primitives fail light-theme contrast (banked as A11Y-27-01) and must never be substituted for the
 * `-tint` / `-fg` pair. Nothing here asserts a Tailwind class.
 *
 * `SettingsCard.test.tsx` covers the same guarantees through the card that delegates here; these
 * tests cover the component directly, including the `action` branch the card does not use.
 */
describe("PanelHeader", () => {
  it("renders the title as a heading and the description under it", () => {
    render(
      <PanelHeader
        icon={<Settings className="h-4 w-4" />}
        title="Фильтрация по процессам"
        description="Управление VPN-маршрутизацией для отдельных приложений."
      />,
    );

    expect(screen.getByRole("heading", { name: "Фильтрация по процессам" })).toBeInTheDocument();
    expect(
      screen.getByText("Управление VPN-маршрутизацией для отдельных приложений."),
    ).toBeInTheDocument();
  });

  it("emits no description paragraph when there is no description", () => {
    const { container } = render(
      <PanelHeader icon={<Settings className="h-4 w-4" />} title="Основные" />,
    );

    // An empty <p> contributes nothing to textContent, so "no empty second line" can only be
    // asserted structurally: the header must not emit the paragraph node at all.
    expect(container.querySelectorAll("p")).toHaveLength(0);
  });

  it("keeps the chip decorative so the heading is the only accessible name", () => {
    const { container } = render(
      <PanelHeader
        icon={<Settings className="h-4 w-4" data-testid="glyph" />}
        title="Основные"
      />,
    );

    const chip = container.querySelector('[aria-hidden="true"]');
    expect(chip).not.toBeNull();
    expect(chip!.contains(screen.getByTestId("glyph"))).toBe(true);
    expect(screen.getByRole("heading", { name: "Основные" })).toBeInTheDocument();
  });

  it("paints the accent chip from the accent tint/fg pair, never a -500 primitive", () => {
    const { container } = render(
      <PanelHeader icon={<Settings className="h-4 w-4" />} title="Основные" />,
    );

    const chip = container.querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(chip.style.backgroundColor).toBe("var(--color-accent-tint-10)");
    expect(chip.style.color).toBe("var(--color-accent-fg)");
    expect(chip.getAttribute("style")).not.toContain("-500");
  });

  it("paints the warning chip from the warning tint/fg pair", () => {
    const { container } = render(
      <PanelHeader
        icon={<Settings className="h-4 w-4" />}
        title="Раздел с предупреждающим тоном"
        variant="warning"
      />,
    );

    const chip = container.querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(chip.style.backgroundColor).toBe("var(--color-warning-tint-12)");
    expect(chip.style.color).toBe("var(--color-warning-fg)");
    expect(chip.getAttribute("style")).not.toContain("-500");
  });

  it("renders an action alongside the title without disturbing title or description", () => {
    render(
      <PanelHeader
        icon={<Settings className="h-4 w-4" />}
        title="Геоданные"
        description="GeoIP и GeoSite базы."
        action={<span>Актуально</span>}
      />,
    );

    expect(screen.getByRole("heading", { name: "Геоданные" })).toBeInTheDocument();
    expect(screen.getByText("GeoIP и GeoSite базы.")).toBeInTheDocument();
    expect(screen.getByText("Актуально")).toBeInTheDocument();
  });
});
