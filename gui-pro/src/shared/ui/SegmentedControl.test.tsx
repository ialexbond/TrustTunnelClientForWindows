import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SegmentedControl, type SegmentedOption } from "./SegmentedControl";

/**
 * The three Phase-27 blocking defects were ALL accessibility, and this control carried one of
 * them: the focus ring did not travel with the selection, so a second arrow press in the same
 * direction did nothing. 3410 passing tests said nothing about it, because not one of them pressed
 * the same arrow twice.
 *
 * So the assertions below are written against exactly that failure mode:
 *   · every arrow row is pressed REPEATEDLY, not once;
 *   · after every change the DOM focus is asserted to be on the newly selected option, not merely
 *     `aria-checked` — a roving tabindex that moves only `aria-checked` strands focus on a button
 *     that is no longer the tab stop, which is what makes the next press dead-end;
 *   · the two NEGATIVES (↑ and ↓) are asserted too, including that the event is not consumed —
 *     the group lives inside a vertically scrolling tab, and swallowing ↑/↓ would re-theme the
 *     whole app when the user only meant to scroll.
 */

const THEME_OPTIONS: SegmentedOption[] = [
  { value: "system", label: "Системная" },
  { value: "dark", label: "Тёмная" },
  { value: "light", label: "Светлая" },
];

/** A controlled host, because the truth under test is «selection AND focus move together». */
function Harness({
  seed = "system",
  onChange,
  options = THEME_OPTIONS,
  disabled = false,
}: {
  seed?: string;
  onChange?: (value: string) => void;
  options?: SegmentedOption[];
  disabled?: boolean;
}) {
  const [value, setValue] = useState(seed);
  return (
    <>
      <button type="button">before</button>
      <SegmentedControl
        options={options}
        value={value}
        onChange={(next) => {
          setValue(next);
          onChange?.(next);
        }}
        aria-label="Тема оформления"
        disabled={disabled}
      />
      <button type="button">after</button>
    </>
  );
}

const selected = () => screen.getByRole("radio", { checked: true });

describe("SegmentedControl", () => {
  it("is a radiogroup with an accessible name, and every option is a named radio", () => {
    render(<Harness />);

    expect(screen.getByRole("radiogroup", { name: "Тема оформления" })).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.getByRole("radio", { name: "Системная" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("radio", { name: "Тёмная" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("radio", { name: "Светлая" })).toHaveAttribute("aria-checked", "false");
  });

  it("is ONE tab stop: Tab lands on the selected option, the next Tab leaves the group", async () => {
    const user = userEvent.setup();
    render(<Harness seed="dark" />);

    screen.getByRole("button", { name: "before" }).focus();

    await user.tab();
    // Not the first option — the SELECTED one. The tab stop is derived from the selection.
    expect(screen.getByRole("radio", { name: "Тёмная" })).toHaveFocus();

    await user.tab();
    expect(screen.getByRole("button", { name: "after" })).toHaveFocus();
  });

  it("→ advances the selection AND the focus, five presses in a row", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    screen.getByRole("radio", { name: "Системная" }).focus();

    // The regression this test exists for: press the SAME arrow repeatedly. Stepping from the
    // event target's index instead of the selected index makes press #2 onward do nothing.
    const expectedSequence = ["Тёмная", "Светлая", "Системная", "Тёмная", "Светлая"];
    for (const expected of expectedSequence) {
      await user.keyboard("{ArrowRight}");
      expect(selected()).toHaveAccessibleName(expected);
      // Focus travels WITH the selection — otherwise two «this is current» pointers are on screen.
      expect(selected()).toHaveFocus();
    }

    expect(onChange).toHaveBeenCalledTimes(5);
    expect(onChange.mock.calls.map(([v]) => v)).toEqual([
      "dark",
      "light",
      "system",
      "dark",
      "light",
    ]);
  });

  it("← moves the selection back AND the focus, five presses in a row", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    screen.getByRole("radio", { name: "Системная" }).focus();

    const expectedSequence = ["Светлая", "Тёмная", "Системная", "Светлая", "Тёмная"];
    for (const expected of expectedSequence) {
      await user.keyboard("{ArrowLeft}");
      expect(selected()).toHaveAccessibleName(expected);
      expect(selected()).toHaveFocus();
    }
  });

  it("keeps exactly one option in the tab order, and it is the selected one", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    screen.getByRole("radio", { name: "Системная" }).focus();
    await user.keyboard("{ArrowRight}");

    const radios = screen.getAllByRole("radio");
    const tabbable = radios.filter((radio) => radio.getAttribute("tabindex") === "0");
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toHaveAccessibleName("Тёмная");
  });

  it("↑ and ↓ change nothing and are NOT consumed — the tab must keep scrolling", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    const first = screen.getByRole("radio", { name: "Системная" });
    first.focus();

    const upNotPrevented = fireEvent.keyDown(first, { key: "ArrowUp" });
    const downNotPrevented = fireEvent.keyDown(first, { key: "ArrowDown" });

    // fireEvent returns false when the handler called preventDefault. Both must come back true:
    // the group leaves the vertical arrows to the scroll container.
    expect(upNotPrevented).toBe(true);
    expect(downNotPrevented).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    expect(selected()).toHaveAccessibleName("Системная");
  });

  it("selects on click and reports the change once", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await user.click(screen.getByRole("radio", { name: "Светлая" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("light");
    expect(selected()).toHaveAccessibleName("Светлая");
  });

  it("does NOT report a change when the already-selected option is chosen again", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness seed="dark" onChange={onChange} />);

    await user.click(screen.getByRole("radio", { name: "Тёмная" }));
    await user.click(screen.getByRole("radio", { name: "Тёмная" }));

    expect(onChange).not.toHaveBeenCalled();
    expect(selected()).toHaveAccessibleName("Тёмная");
  });

  it("keeps a tab stop when `value` matches no option — the group never leaves the tab order", () => {
    render(<Harness seed="sepia-from-an-older-build" />);

    const radios = screen.getAllByRole("radio");
    expect(radios.filter((radio) => radio.getAttribute("tabindex") === "0")).toHaveLength(1);
    expect(radios.every((radio) => radio.getAttribute("aria-checked") === "false")).toBe(true);
  });

  it("disabled: every option is disabled and the arrows do nothing", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} disabled />);

    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).toBeDisabled();
    }

    fireEvent.keyDown(screen.getByRole("radio", { name: "Системная" }), { key: "ArrowRight" });
    await user.click(screen.getByRole("radio", { name: "Светлая" }));

    expect(onChange).not.toHaveBeenCalled();
    expect(selected()).toHaveAccessibleName("Системная");
  });

  it("renders an option's leading glyph without letting it into the accessible name", () => {
    render(
      <Harness
        options={[
          { value: "ru", label: "Русский" },
          {
            value: "en",
            label: "English",
            icon: <svg data-testid="en-glyph" aria-hidden="true" />,
          },
        ]}
        seed="ru"
      />,
    );

    expect(screen.getByTestId("en-glyph")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "English" })).toBeInTheDocument();
  });
});
