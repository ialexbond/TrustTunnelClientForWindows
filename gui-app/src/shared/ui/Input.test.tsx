import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Input } from "./Input";

describe("Input", () => {
  it("renders with placeholder", () => {
    render(<Input placeholder="Enter value" />);
    expect(screen.getByPlaceholderText("Enter value")).toBeInTheDocument();
  });

  it("controlled: value + onChange works", () => {
    const onChange = vi.fn();
    render(<Input value="hello" onChange={onChange} />);
    const input = screen.getByDisplayValue("hello");
    fireEvent.change(input, { target: { value: "world" } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("disabled state", () => {
    render(<Input disabled placeholder="disabled" />);
    expect(screen.getByPlaceholderText("disabled")).toBeDisabled();
  });

  it("applies error styling when error prop is set", () => {
    render(<Input error="Required field" placeholder="err" />);
    const input = screen.getByPlaceholderText("err");
    expect(input.className).toContain("ring-1");
    expect(input.className).toContain("ring-[var(--color-danger-500)]");
    expect(screen.getByText("Required field")).toBeInTheDocument();
  });

  it("passes extra HTML attributes (type, name)", () => {
    render(<Input type="email" name="user-email" placeholder="email" />);
    const input = screen.getByPlaceholderText("email");
    expect(input).toHaveAttribute("type", "email");
    expect(input).toHaveAttribute("name", "user-email");
  });
});
