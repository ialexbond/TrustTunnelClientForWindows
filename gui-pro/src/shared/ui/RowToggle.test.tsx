import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RowToggle } from "./RowToggle";

/**
 * The in-flight contract of the «Настройки» tab, asserted as behaviour: while a write is in flight
 * only THAT control is busy — it keeps its position, spins inside itself, the row does not dim, and
 * neighbours stay usable. Removing the handle or swapping the control for a standalone spinner is
 * the failure mode these tests exist to lock out: a control that disappears and reappears reads as
 * a second, unrelated thing going wrong.
 */
describe("RowToggle", () => {
  it("exposes the switch role with an accessible name, so it is addressable by name", () => {
    render(<RowToggle checked={false} onChange={() => {}} aria-label="Сбор логов" />);

    expect(screen.getByRole("switch", { name: "Сбор логов" })).toBeInTheDocument();
  });

  it("reports its position through aria-checked", () => {
    render(<RowToggle checked onChange={() => {}} aria-label="Сбор логов" />);

    expect(screen.getByRole("switch", { name: "Сбор логов" })).toHaveAttribute("aria-checked", "true");
  });

  it("clicking reports the toggled value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RowToggle checked={false} onChange={onChange} aria-label="Сбор логов" />);

    await user.click(screen.getByRole("switch", { name: "Сбор логов" }));

    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("busy: the control is still a switch — it is never replaced by a spinner", () => {
    render(<RowToggle checked onChange={() => {}} busy aria-label="Сбор логов" />);

    const control = screen.getByRole("switch", { name: "Сбор логов" });
    expect(control).toBeInTheDocument();
    // The activity indicator lives INSIDE the control.
    expect(control.querySelector("svg")).not.toBeNull();
  });

  it("idle: there is no activity indicator inside the control", () => {
    render(<RowToggle checked onChange={() => {}} aria-label="Сбор логов" />);

    expect(screen.getByRole("switch", { name: "Сбор логов" }).querySelector("svg")).toBeNull();
  });

  it("busy: keeps the position it was moved to and announces itself busy", () => {
    render(<RowToggle checked onChange={() => {}} busy aria-label="Сбор логов" />);

    const control = screen.getByRole("switch", { name: "Сбор логов" });
    expect(control).toHaveAttribute("aria-checked", "true");
    expect(control).toHaveAttribute("aria-busy", "true");
    expect(control).toBeDisabled();
  });

  it("busy: the press does not go through", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RowToggle checked onChange={onChange} busy aria-label="Сбор логов" />);

    await user.click(screen.getByRole("switch", { name: "Сбор логов" }));

    expect(onChange).not.toHaveBeenCalled();
  });

  it("busy: sibling controls stay enabled and keep working", async () => {
    const user = userEvent.setup();
    const onNeighbour = vi.fn();
    render(
      <div>
        <RowToggle checked onChange={() => {}} busy aria-label="Сбор логов" />
        <RowToggle checked={false} onChange={onNeighbour} aria-label="Автозапуск" />
      </div>,
    );

    const neighbour = screen.getByRole("switch", { name: "Автозапуск" });
    expect(neighbour).toBeEnabled();

    await user.click(neighbour);
    expect(onNeighbour).toHaveBeenCalledWith(true);
  });

  it("busy is NOT the disabled treatment: the row does not dim", () => {
    // jsdom has no layout and no cascade, so "does not dim" has exactly one observable here — the
    // opacity utility the shared Toggle applies for `disabled` and only for `disabled`. Same
    // precedent as Toggle.test.tsx. A dimmed row would say «сюда нельзя»; a write in flight means
    // «можно, но прямо сейчас идёт запись».
    const busy = render(<RowToggle checked onChange={() => {}} busy aria-label="Сбор логов" />);
    expect(busy.container.innerHTML).not.toContain("opacity-[var(--opacity-disabled)]");

    const off = render(<RowToggle checked onChange={() => {}} disabled aria-label="Автозапуск" />);
    expect(off.container.innerHTML).toContain("opacity-[var(--opacity-disabled)]");
  });

  it("disabled: the press does not go through", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RowToggle checked={false} onChange={onChange} disabled aria-label="Сбор логов" />);

    await user.click(screen.getByRole("switch", { name: "Сбор логов" }));

    expect(onChange).not.toHaveBeenCalled();
  });
});
