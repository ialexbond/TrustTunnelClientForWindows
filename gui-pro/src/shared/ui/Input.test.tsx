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
    expect(input.className).toContain("border-[var(--color-danger-500)]");
    expect(screen.getByText("Required field")).toBeInTheDocument();
  });

  it("passes extra HTML attributes (type, name)", () => {
    render(<Input type="email" name="user-email" placeholder="email" />);
    const input = screen.getByPlaceholderText("email");
    expect(input).toHaveAttribute("type", "email");
    expect(input).toHaveAttribute("name", "user-email");
  });

  it("renders helperText when provided", () => {
    render(<Input helperText="Helpful hint" placeholder="with helper" />);
    expect(screen.getByText("Helpful hint")).toBeInTheDocument();
  });

  it("does not render helperText when error is present", () => {
    render(
      <Input
        error="Error message"
        helperText="Helper message"
        placeholder="test"
      />
    );
    expect(screen.getByText("Error message")).toBeInTheDocument();
    expect(screen.queryByText("Helper message")).not.toBeInTheDocument();
  });

  it("shows clearable button when value is non-empty and clearable is true", () => {
    render(
      <Input
        clearable
        value="some text"
        onChange={vi.fn()}
        placeholder="clearable"
      />
    );
    expect(screen.getByRole("button", { name: /clear/i })).toBeInTheDocument();
  });

  it("does not show clearable button when value is empty", () => {
    render(
      <Input
        clearable
        value=""
        onChange={vi.fn()}
        placeholder="clearable empty"
      />
    );
    expect(screen.queryByRole("button", { name: /clear/i })).not.toBeInTheDocument();
  });

  it("clearable button calls onChange with empty string", () => {
    const onChange = vi.fn();
    render(
      <Input
        clearable
        value="some text"
        onChange={onChange}
        placeholder="clearable"
      />
    );
    const clearBtn = screen.getByRole("button", { name: /clear/i });
    fireEvent.click(clearBtn);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].target.value).toBe("");
  });

  it("error text rendered with error prop", () => {
    render(<Input error="Something went wrong" placeholder="test" />);
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });
});
