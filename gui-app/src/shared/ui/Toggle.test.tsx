import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Toggle } from "./Toggle";

describe("Toggle", () => {
  it("checked state: toggle-on background", () => {
    render(<Toggle value={true} onChange={() => {}} label="On" />);
    const btn = screen.getByRole("button");
    expect(btn.style.backgroundColor).toBe("var(--color-toggle-on)");
  });

  it("unchecked state: toggle-off background", () => {
    render(<Toggle value={false} onChange={() => {}} label="Off" />);
    const btn = screen.getByRole("button");
    expect(btn.style.backgroundColor).toBe("var(--color-toggle-off)");
  });

  it("click calls onChange with toggled value", () => {
    const onChange = vi.fn();
    render(<Toggle value={false} onChange={onChange} label="Toggle" />);
    fireEvent.click(screen.getByRole("button"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("disabled: click does not call onChange", () => {
    const onChange = vi.fn();
    render(<Toggle value={false} onChange={onChange} label="Disabled" disabled />);
    fireEvent.click(screen.getByRole("button"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("renders label text", () => {
    render(<Toggle value={false} onChange={() => {}} label="My Label" />);
    expect(screen.getByText("My Label")).toBeInTheDocument();
  });
});
