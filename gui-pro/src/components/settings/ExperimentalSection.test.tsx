import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { ExperimentalSection } from "./ExperimentalSection";
import { renderWithProviders as render } from "../../test/test-utils";

// Mock useFeatureToggles
const mockUpdate = vi.fn();
vi.mock("../../shared/hooks/useFeatureToggles", () => ({
  useFeatureToggles: () => ({
    toggles: { blockRouting: false, processFilter: false },
    update: mockUpdate,
  }),
}));

/**
 * Phase 28 (28-06): the section moved onto `SettingsCard` in its warning variant plus one
 * `SettingsRow`. The logic is unchanged — the assertions about the toggle are the originals.
 *
 * The two style assertions here are inline TOKENS, not Tailwind classes: which token pair paints
 * the header tile is the section's whole visual claim (it is the one warning tile on the tab), and
 * the `-500` primitives fail light-theme contrast, so substituting them must fail. Same precedent
 * as `SettingsCard.test.tsx`.
 */
describe("ExperimentalSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("renders experimental section title", () => {
    render(<ExperimentalSection />);
    expect(screen.getByText("Экспериментальные функции")).toBeInTheDocument();
  });

  it("renders description text", () => {
    render(<ExperimentalSection />);
    expect(screen.getByText("Функции в разработке. Могут быть нестабильны.")).toBeInTheDocument();
  });

  it("renders block routing toggle", () => {
    render(<ExperimentalSection />);
    expect(screen.getByText("Блокировка сайтов")).toBeInTheDocument();
    expect(screen.getByText("Показать блок блокировки в маршрутизации.")).toBeInTheDocument();
  });

  it("calls update exactly once with the new value when the row is toggled", () => {
    render(<ExperimentalSection />);
    fireEvent.click(screen.getByRole("switch", { name: "Блокировка сайтов" }));
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith("blockRouting", true);
  });

  it("paints the header tile from the WARNING tint/fg pair", () => {
    const { container } = render(<ExperimentalSection />);
    const chip = container.querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(chip.style.backgroundColor).toBe("var(--color-warning-tint-12)");
    expect(chip.style.color).toBe("var(--color-warning-fg)");
    expect(chip.getAttribute("style")).not.toContain("-500");
  });

  it("keeps the warning tone in the header tile only — the card body stays neutral", () => {
    const { container } = render(<ExperimentalSection />);
    const chip = container.querySelector('[aria-hidden="true"]') as HTMLElement;
    const warningPainted = Array.from(container.querySelectorAll<HTMLElement>("[style]")).filter(
      (element) => (element.getAttribute("style") ?? "").includes("warning"),
    );
    expect(warningPainted).toEqual([chip]);
  });

  // One row, so there is nothing to divide: a hairline inside this card would separate a row from
  // nothing.
  it("renders exactly one row and therefore no divider", () => {
    const { container } = render(<ExperimentalSection />);
    expect(screen.getAllByRole("switch")).toHaveLength(1);
    expect(container.querySelectorAll("hr, [role='separator']")).toHaveLength(0);
  });

  // The tab's pattern is ONE glyph per card, in the header tile. A second glyph on the single row
  // of a single-row card is clutter that names nothing the label does not already say.
  it("carries no per-row glyph — the only icon is the one in the header tile", () => {
    const { container } = render(<ExperimentalSection />);
    const glyphs = container.querySelectorAll("svg");
    expect(glyphs).toHaveLength(1);
    const chip = container.querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(chip.contains(glyphs[0])).toBe(true);
  });
});
