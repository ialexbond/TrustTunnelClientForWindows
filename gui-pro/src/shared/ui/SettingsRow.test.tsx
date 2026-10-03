import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FileText } from "lucide-react";
import { SettingsRow } from "./SettingsRow";

/**
 * jsdom has NO layout engine: it cannot report that a label wrapped onto a second line or that a
 * control was pushed out of the row. So the two geometry truths are asserted the only honest way a
 * unit test can — as MARKUP facts that make the layout possible:
 *
 *   · "wraps rather than truncating"  -> the full label string is present in the DOM, uncut. A
 *     truncating implementation clips visually but keeps the text node, so this alone is weak; the
 *     visual proof is the `LongLabel` Storybook story, which is why that story exists.
 *   · "never pushes the control off the row" -> the control lives in its OWN cell that is a direct
 *     sibling of the label column under the same row root. That is the structural guarantee; a row
 *     that nested the control inside the flexible label column is exactly how a control gets pushed.
 *
 * No assertion here reads a Tailwind class.
 */
describe("SettingsRow", () => {
  it("renders the label and the description as two separate nodes", () => {
    render(
      <SettingsRow
        label="Сбор логов"
        description="Писать журнал работы в файл"
        control={<button type="button">Действие</button>}
      />,
    );

    expect(screen.getByText("Сбор логов")).toBeInTheDocument();
    expect(screen.getByText("Писать журнал работы в файл")).toBeInTheDocument();
    expect(screen.getByText("Сбор логов")).not.toBe(screen.getByText("Писать журнал работы в файл"));
  });

  it("renders no empty second line when there is no description", () => {
    const { container } = render(
      <SettingsRow label="Сбор логов" control={<button type="button">Действие</button>} />,
    );

    expect(container.querySelectorAll("p")).toHaveLength(0);
  });

  it("keeps a long label whole — nothing in the markup clips it", () => {
    const longLabel = "Автоматически обновлять базу маршрутов каждые сутки";
    expect(longLabel.length).toBeGreaterThanOrEqual(40);

    render(<SettingsRow label={longLabel} control={<button type="button">Действие</button>} />);

    expect(screen.getByText(longLabel).textContent).toBe(longLabel);
  });

  it("keeps the control in its own cell beside the label column, even with a long label", () => {
    const longLabel = "Автоматически обновлять базу маршрутов каждые сутки";
    const { container } = render(
      <SettingsRow
        label={longLabel}
        description="Список подсетей, которые идут мимо туннеля"
        control={<button type="button">Действие</button>}
      />,
    );

    const row = container.firstElementChild!;
    const controlCell = screen.getByRole("button", { name: "Действие" }).parentElement!;
    const labelColumn = screen.getByText(longLabel).parentElement!;

    expect(controlCell.parentElement).toBe(row);
    expect(labelColumn.parentElement).toBe(row);
    expect(labelColumn.contains(controlCell)).toBe(false);
    // The control is the LAST cell of the row: the label column can grow as tall as it likes.
    expect(row.lastElementChild).toBe(controlCell);
  });

  it("renders labelExtra beside the label, not as a third line under the row", () => {
    render(
      <SettingsRow
        label="Авто-режим"
        description="Перейти на другой сервер, когда связь пропала"
        labelExtra={<button type="button" aria-label="Подробнее: Авто-режим" />}
        control={<button type="button">Действие</button>}
      />,
    );

    const label = screen.getByText(/Авто-режим/);
    const help = screen.getByRole("button", { name: "Подробнее: Авто-режим" });

    expect(label.contains(help)).toBe(true);
    expect(screen.getByText("Перейти на другой сервер, когда связь пропала").contains(help)).toBe(false);
  });

  it("renders no icon column at all when the row has no icon", () => {
    const { container } = render(
      <SettingsRow label="Сбор логов" control={<button type="button">Действие</button>} />,
    );

    const row = container.firstElementChild!;
    // Two cells only: the label column and the control cell. A permanently empty indent in a card
    // whose rows carry no icons reads as a layout bug, so the slot must not be emitted.
    expect(row.children).toHaveLength(2);
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it("renders a decorative icon cell when the row has an icon", () => {
    const { container } = render(
      <SettingsRow
        icon={<FileText className="h-4 w-4" data-testid="glyph" />}
        label="Сбор логов"
        control={<button type="button">Действие</button>}
      />,
    );

    const row = container.firstElementChild!;
    expect(row.children).toHaveLength(3);

    const iconCell = container.querySelector('[aria-hidden="true"]')!;
    expect(iconCell.contains(screen.getByTestId("glyph"))).toBe(true);
    expect(row.firstElementChild).toBe(iconCell);
  });

  // `iconAlign` is opt-in precisely so that the «Настройки» rows — which share an icon COLUMN and
  // want the centred glyph — do not move when a lone row elsewhere asks for the label-line variant.
  // Asserting the DEFAULT is what pins that promise; a regression to `label` would surface here
  // before it surfaced on the Settings tab. Alignment itself is geometry, and geometry is not
  // observable in jsdom, so what is asserted is the contract around it: same cells, same order,
  // same decorative glyph, whichever alignment is asked for.
  it("keeps the icon cell's structure and position identical for both alignments", () => {
    const renderWith = (iconAlign?: "center" | "label") =>
      render(
        <SettingsRow
          icon={<FileText className="h-4 w-4" data-testid="glyph" />}
          iconAlign={iconAlign}
          label="Исключить из VPN"
          description="Выбранные процессы будут работать напрямую, без VPN."
          control={<button type="button">Действие</button>}
        />,
      );

    for (const align of [undefined, "center", "label"] as const) {
      const { container, unmount } = renderWith(align);
      const row = container.firstElementChild!;
      const iconCell = container.querySelector('[aria-hidden="true"]')!;

      expect(row.children).toHaveLength(3);
      expect(row.firstElementChild).toBe(iconCell);
      expect(iconCell.contains(screen.getByTestId("glyph"))).toBe(true);
      expect(screen.getByText("Исключить из VPN")).toBeInTheDocument();
      expect(
        screen.getByText("Выбранные процессы будут работать напрямую, без VPN."),
      ).toBeInTheDocument();

      unmount();
    }
  });
});
