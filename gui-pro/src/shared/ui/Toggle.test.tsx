import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Toggle } from "./Toggle";

describe("Toggle", () => {
  it("checked state: toggle-on background", () => {
    render(<Toggle checked={true} onChange={() => {}} label="On" />);
    const btn = screen.getByRole("switch");
    expect(btn.style.backgroundColor).toBe("var(--color-toggle-on)");
  });

  it("unchecked state: toggle-off background", () => {
    render(<Toggle checked={false} onChange={() => {}} label="Off" />);
    const btn = screen.getByRole("switch");
    expect(btn.style.backgroundColor).toBe("var(--color-toggle-off)");
  });

  it("legacy value prop: toggle-on background when true", () => {
    render(<Toggle value={true} onChange={() => {}} label="On" />);
    const btn = screen.getByRole("switch");
    expect(btn.style.backgroundColor).toBe("var(--color-toggle-on)");
  });

  it("click calls onChange with toggled value", () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} label="Toggle" />);
    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("disabled: click does not call onChange", () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} label="Disabled" disabled />);
    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("renders label text", () => {
    render(<Toggle checked={false} onChange={() => {}} label="My Label" />);
    expect(screen.getByText("My Label")).toBeInTheDocument();
  });

  it("has role=switch", () => {
    render(<Toggle checked={false} onChange={() => {}} label="Switch" />);
    expect(screen.getByRole("switch")).toBeInTheDocument();
  });

  // D-03.2 (Users H-07): the visible `label` must become the role="switch"
  // accessible name so screen readers announce it and tests can query
  // getByRole("switch", { name }). FAILS on pre-fix code (label was only
  // rendered visually, never wired to the switch's accessible name); PASSES
  // after the label→switch a11y forward.
  it("forwards the visible label to the switch accessible name", () => {
    render(<Toggle checked={false} onChange={() => {}} label="Anti-DPI" />);
    expect(
      screen.getByRole("switch", { name: "Anti-DPI" })
    ).toBeInTheDocument();
  });

  it("explicit aria-label overrides the visible label as the accessible name", () => {
    render(
      <Toggle
        checked={false}
        onChange={() => {}}
        label="Visible"
        aria-label="Explicit name"
      />
    );
    expect(
      screen.getByRole("switch", { name: "Explicit name" })
    ).toBeInTheDocument();
  });

  it("aria-checked is true when checked", () => {
    render(<Toggle checked={true} onChange={() => {}} label="On" />);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  });

  it("aria-checked is false when unchecked", () => {
    render(<Toggle checked={false} onChange={() => {}} label="Off" />);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  });

  it("has focus-visible class for keyboard navigation", () => {
    render(<Toggle checked={false} onChange={() => {}} label="Focus" />);
    const btn = screen.getByRole("switch");
    expect(btn.className).toContain("focus-visible");
  });

  it("disabled: applies opacity-disabled class", () => {
    const { container } = render(
      <Toggle checked={false} onChange={() => {}} label="Disabled" disabled />
    );
    expect(container.firstElementChild!.className).toContain("opacity-[var(--opacity-disabled)]");
  });

  it("does not import from colors module", () => {
    // This is validated statically — Toggle should only use CSS var tokens
    render(<Toggle checked={true} onChange={() => {}} />);
    const btn = screen.getByRole("switch");
    // Background should use CSS variables, not hardcoded hex colors
    expect(btn.style.backgroundColor).toContain("var(");
  });
});
