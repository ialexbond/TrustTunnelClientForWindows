import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Checkbox } from "./Checkbox";

// A11Y-first suite (per naming.md + plan 18-06 Task 1): assert by ROLE, never by
// CSS class. The Checkbox is a role="checkbox" control whose accessible name comes
// from the visible `label` or an explicit `aria-label`.
describe("Checkbox", () => {
  it("renders role=checkbox with the accessible name from label", () => {
    render(<Checkbox checked={false} onChange={() => {}} label="Remove firewall" />);
    const box = screen.getByRole("checkbox", { name: "Remove firewall" });
    expect(box).toBeInTheDocument();
    expect(box).toHaveAttribute("aria-checked", "false");
  });

  it("reflects checked=true via aria-checked", () => {
    render(<Checkbox checked onChange={() => {}} label="On" />);
    expect(screen.getByRole("checkbox", { name: "On" })).toHaveAttribute("aria-checked", "true");
  });

  it("calls onChange with the NEXT value on click (false → true)", () => {
    const onChange = vi.fn();
    render(<Checkbox checked={false} onChange={onChange} label="Toggle me" />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Toggle me" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("calls onChange with the NEXT value on click (true → false)", () => {
    const onChange = vi.fn();
    render(<Checkbox checked onChange={onChange} label="Toggle me" />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Toggle me" }));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("does NOT toggle when disabled", () => {
    const onChange = vi.fn();
    render(<Checkbox checked={false} onChange={onChange} label="Locked" disabled />);
    const box = screen.getByRole("checkbox", { name: "Locked" });
    fireEvent.click(box);
    expect(onChange).not.toHaveBeenCalled();
    expect(box).toBeDisabled();
  });

  it("exposes the accessible name from aria-label when no visible label is given", () => {
    render(<Checkbox checked={false} onChange={() => {}} aria-label="Standalone name" />);
    expect(screen.getByRole("checkbox", { name: "Standalone name" })).toBeInTheDocument();
  });
});
