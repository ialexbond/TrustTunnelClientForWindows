import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HelpHint, helpHintLabel } from "./HelpHint";

/**
 * These tests are the whole reason the primitive exists. The shipped «?» was an `aria-hidden`
 * glyph inside a plain `<div>`: nothing to focus, so `Tooltip` never opened from the keyboard, and
 * the `aria-describedby` it forwards landed on a hidden node — while the hint carried sentences
 * that live nowhere else. Every assertion below fails against that shape.
 */
describe("HelpHint", () => {
  it("renders a real button carrying the supplied accessible name", () => {
    render(<HelpHint text="Скорость и пинг не измеряются" label="Подробнее: Авто-режим" />);

    const trigger = screen.getByRole("button", { name: "Подробнее: Авто-режим" });
    expect(trigger.tagName).toBe("BUTTON");
  });

  it("is reachable with Tab", async () => {
    const user = userEvent.setup();
    render(<HelpHint text="Скорость и пинг не измеряются" label="Подробнее: Авто-режим" />);

    await user.tab();

    expect(screen.getByRole("button", { name: "Подробнее: Авто-режим" })).toHaveFocus();
  });

  it("opens the tip on keyboard focus and exposes it as the button's description", async () => {
    const user = userEvent.setup();
    render(<HelpHint text="Скорость и пинг не измеряются" label="Подробнее: Авто-режим" />);

    const trigger = screen.getByRole("button", { name: "Подробнее: Авто-режим" });
    await user.tab();

    expect(await screen.findByRole("tooltip")).toHaveTextContent("Скорость и пинг не измеряются");
    expect(trigger).toHaveAccessibleDescription("Скорость и пинг не измеряются");
  });

  it("keeps the glyph decorative — it contributes nothing to the accessible name", () => {
    const { container } = render(<HelpHint text="Подсказка" label="Подробнее: Авто-режим" />);

    const trigger = screen.getByRole("button", { name: "Подробнее: Авто-режим" });
    // Exactly the label, with nothing appended by the icon.
    expect(trigger).toHaveAccessibleName("Подробнее: Авто-режим");

    const glyph = container.querySelector("svg");
    expect(glyph).not.toBeNull();
    expect(glyph).toHaveAttribute("aria-hidden", "true");
  });

  it("is type=button, so Enter and Space activate it without submitting a surrounding form", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <HelpHint text="Подсказка" label="Подробнее: Авто-режим" />
      </form>,
    );

    const trigger = screen.getByRole("button", { name: "Подробнее: Авто-режим" });
    expect(trigger).toHaveAttribute("type", "button");

    trigger.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("renders the label it is given verbatim — no Russian string is baked into the primitive", () => {
    render(<HelpHint text="Ping is not measured" label="More about: Auto mode" />);

    expect(screen.getByRole("button", { name: "More about: Auto mode" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Подробнее/ })).toBeNull();
  });
});

describe("helpHintLabel", () => {
  it("composes the accessible name from the row label", () => {
    expect(helpHintLabel("Авто-режим")).toBe("Подробнее: Авто-режим");
  });
});
